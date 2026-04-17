import { Injectable } from '@angular/core';
import type { AdoPbi } from './sprint-data';

const ADO_BASE  = 'http://localhost:3333';
const ORG       = 'my-org';
const PROJECT   = 'my-project';
const HOURS_PER_DAY = 6;

// ── Colour palette (deterministyczny hash z ID) ───────────────────────────────
const PALETTE = [
  '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6',
  '#EC4899', '#EF4444', '#06B6D4', '#84CC16',
];

function colorForId(id: number): string {
  return PALETTE[id % PALETTE.length];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractId(url: string): number {
  return parseInt(url.split('/').pop()!, 10);
}

/** Zaokrąglenie do najbliższych 0.5 dnia (minimum 0.5) */
function hoursToDays(hours: number): number {
  return Math.max(0.5, Math.round((hours / HOURS_PER_DAY) * 2) / 2);
}

function isDevTask(item: any): boolean {
  const type = item.fields['System.WorkItemType'] as string;
  const tags = (item.fields['System.Tags'] as string ?? '').toLowerCase();
  return type === 'Task' && (tags.includes('frontend') || tags.includes('backend'));
}

function roleFromTags(tags: string): string {
  const t = tags.toLowerCase();
  if (t.includes('frontend')) return 'Frontend';
  if (t.includes('backend'))  return 'Backend';
  return 'Dev';
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchJson(url: string, options?: RequestInit): Promise<any> {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`ADO fetch failed: ${res.status} ${url}`);
  return res.json();
}

async function fetchItems(ids: number[]): Promise<any[]> {
  if (!ids.length) return [];
  const url = `${ADO_BASE}/${ORG}/${PROJECT}/_apis/wit/workitems?ids=${ids.join(',')}&$expand=relations&api-version=7.1`;
  const data = await fetchJson(url);
  return data.value as any[];
}

// ── Main mapper ───────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class AdoService {

  /**
   * Pobiera PBI + Bug z bieżącego sprintu i mapuje je na AdoPbi[].
   * Fazy budowane są z subtasków z tagiem `frontend` lub `backend`,
   * czas w godzinach (RemainingWork ÷ 6 = dni).
   */
  async fetchSprintItems(users: { id: string; name: string }[]): Promise<AdoPbi[]> {
    // 1. WIQL — lista ID PBI/Bugów sprintu
    const wiqlBody = {
      query: `SELECT [System.Id] FROM WorkItems
              WHERE [System.TeamProject] = '${PROJECT}'
                AND [System.WorkItemType] IN ('User Story','Bug')
                AND [System.State] <> 'Closed'`,
    };
    const wiqlResult = await fetchJson(
      `${ADO_BASE}/${ORG}/${PROJECT}/_apis/wit/wiql?api-version=7.1`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wiqlBody) },
    );
    const pbiIds: number[] = wiqlResult.workItems.map((w: any) => w.id);
    if (!pbiIds.length) return [];

    // 2. Pobierz PBI z relacjami
    const pbiItems = await fetchItems(pbiIds);

    // 3. Zbierz ID wszystkich subtasków
    const taskIds = pbiItems.flatMap(pbi =>
      (pbi.relations ?? [])
        .filter((r: any) => r.rel === 'System.LinkTypes.Hierarchy-Forward')
        .map((r: any) => extractId(r.url))
    );

    // 4. Pobierz subtaski
    const taskItems = await fetchItems(taskIds);
    const taskMap   = new Map<number, any>(taskItems.map(t => [t.id, t]));

    // 5. Mapuj PBI → AdoPbi
    const nameToId = new Map(users.map(u => [u.name.toLowerCase(), u.id]));

    function resolveAssignee(displayName: string): string {
      return nameToId.get((displayName ?? '').toLowerCase()) ?? 'unassigned';
    }

    const result: AdoPbi[] = pbiItems.map(pbi => {
      const fields    = pbi.fields;
      const type      = fields['System.WorkItemType'] === 'Bug' ? 'Bug' : 'Story';
      const priority  = fields['Microsoft.VSTS.Common.Priority'] ?? 3;

      // Predecessor links (Dependency-Reverse = "depends on")
      const dependsOn: string[] = (pbi.relations ?? [])
        .filter((r: any) => r.rel === 'System.LinkTypes.Dependency-Reverse')
        .map((r: any) => String(extractId(r.url)));

      // Subtaski dev (frontend/backend), w kolejności ID (stack rank)
      const devTasks = (pbi.relations ?? [])
        .filter((r: any) => r.rel === 'System.LinkTypes.Hierarchy-Forward')
        .map((r: any) => taskMap.get(extractId(r.url)))
        .filter((t: any) => t && isDevTask(t));

      let phases: AdoPbi['phases'];

      if (devTasks.length) {
        phases = devTasks.map((t: any) => ({
          assigneeId: resolveAssignee(t.fields['System.AssignedTo']?.displayName ?? ''),
          days:       hoursToDays(t.fields['Microsoft.VSTS.Scheduling.RemainingWork'] ?? 6),
          role:       roleFromTags(t.fields['System.Tags'] ?? ''),
        }));
      } else {
        // Brak subtasków — jedna faza z danych PBI
        phases = [{
          assigneeId: resolveAssignee(fields['System.AssignedTo']?.displayName ?? ''),
          days:       1,
          role:       'Dev',
        }];
      }

      return {
        id:       String(pbi.id),
        title:    fields['System.Title'] as string,
        color:    colorForId(pbi.id),
        priority: priority as number,
        type,
        phases,
        dependsOn: dependsOn.length ? dependsOn : undefined,
      };
    });

    return result;
  }
}

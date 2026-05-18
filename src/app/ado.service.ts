import { Injectable } from '@angular/core';
import type { AdoPbi, SprintUser } from './sprint-data';

export interface AdoIteration {
  name:       string;
  path:       string;
  startDate:  Date | null;
  finishDate: Date | null;
}

export interface AdoFetchResult {
  pbis: AdoPbi[];
  users: SprintUser[];
  testers: SprintUser[];
  iteration: AdoIteration | null;
}

const ADO_BASE  = '/api/ado';
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

function isTask(item: any): boolean {
  return item.fields['System.WorkItemType'] === 'Task';
}

function roleFromTags(tags: string): string {
  const t = tags.toLowerCase();
  if (t.includes('frontend')) return 'Frontend';
  if (t.includes('backend'))  return 'Backend';
  return 'Dev';
}

function slugifyUser(displayName: string): string {
  const slug = displayName
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'unassigned';
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchJson(url: string, options?: RequestInit): Promise<any> {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`ADO fetch failed: ${res.status} ${url}`);
  return res.json();
}

async function fetchItems(ids: number[]): Promise<any[]> {
  if (!ids.length) return [];
  const url = `${ADO_BASE}/workitems?ids=${ids.join(',')}&$expand=relations`;
  const data = await fetchJson(url);
  return data.value as any[];
}

// ── Main mapper ───────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class AdoService {

  /**
   * Pobiera PBI/Story/Bug z bieżącego sprintu i mapuje na AdoPbi[].
   * Jedna faza per PBI, assignee z `System.AssignedTo` na PBI, czas:
   *   - jeśli `Microsoft.VSTS.Scheduling.Effort` jest ustawione → użyj go jako dni (capped 0.5-10)
   *   - inaczej 1 dzień
   * Tasków NIE pobieramy — daje to czysty widok "jedna karta per PBI per assignee" do daily.
   * Zwraca union istniejących userów + odkrytych z ADO (display name → slug id).
   */
  async fetchSprintItems(users: SprintUser[]): Promise<AdoFetchResult> {
    // Equolegle: iteration metadata + WIQL
    const [iterationRaw, wiqlResult] = await Promise.all([
      fetchJson(`${ADO_BASE}/iteration`).catch(() => null),
      fetchJson(
        `${ADO_BASE}/wiql`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      ),
    ]);

    const iteration: AdoIteration | null = iterationRaw ? {
      name:       iterationRaw.name,
      path:       iterationRaw.path,
      startDate:  iterationRaw.startDate  ? new Date(iterationRaw.startDate)  : null,
      finishDate: iterationRaw.finishDate ? new Date(iterationRaw.finishDate) : null,
    } : null;

    const qaTesterNames: Set<string> = new Set(
      (iterationRaw?.qaTesters ?? []).map((s: string) => s.toLowerCase()),
    );

    const pbiIds: number[] = (wiqlResult.workItems ?? []).map((w: any) => w.id);
    if (!pbiIds.length) return { pbis: [], users, testers: [], iteration };

    const pbiItems = await fetchItems(pbiIds);

    // Pobierz dzieci-Taski żeby zsumować RemainingWork per PBI
    const taskIds: number[] = pbiItems.flatMap(pbi =>
      (pbi.relations ?? [])
        .filter((r: any) => r.rel === 'System.LinkTypes.Hierarchy-Forward')
        .map((r: any) => extractId(r.url))
    );
    const taskItems = taskIds.length ? await fetchItems(taskIds) : [];
    const taskMap   = new Map<number, any>(taskItems.map(t => [t.id, t]));

    const usersById   = new Map(users.map(u => [u.id, u]));
    const usersByName = new Map(users.map(u => [u.name.toLowerCase(), u]));
    const testersById = new Map<string, SprintUser>();

    function resolveAssignee(rawName: string | undefined): string {
      const name = (rawName ?? '').trim();
      if (!name) return 'unassigned';
      // Dedykowani QA testerzy z env — nie lądują w dev swimlane.
      if (qaTesterNames.has(name.toLowerCase())) return 'qa-' + slugifyUser(name);
      const existing = usersByName.get(name.toLowerCase());
      if (existing) return existing.id;
      const id = slugifyUser(name);
      const user: SprintUser = { id, name };
      usersById.set(id, user);
      usersByName.set(name.toLowerCase(), user);
      return id;
    }

    function resolveTester(rawName: string | undefined): { id: string; name: string } | undefined {
      const name = (rawName ?? '').trim();
      if (!name) return undefined;
      // Tylko testerzy z listy sprintowej (ADO_QA_TESTERS env). Custom.QATester w ADO
      // może wskazywać kogoś spoza zespołu — ignorujemy żeby nie tworzyć fałszywej swimlane.
      if (!qaTesterNames.has(name.toLowerCase())) return undefined;
      const id = 'qa-' + slugifyUser(name);
      if (!testersById.has(id)) testersById.set(id, { id, name });
      return { id, name };
    }

    function effortToDays(effort: number | undefined): number {
      if (typeof effort !== 'number' || effort <= 0) return 1;
      return Math.min(10, Math.max(0.5, effort));
    }

    function openChildTasksFor(pbi: any): any[] {
      const childIds = (pbi.relations ?? [])
        .filter((r: any) => r.rel === 'System.LinkTypes.Hierarchy-Forward')
        .map((r: any) => extractId(r.url));
      const out: any[] = [];
      for (const id of childIds) {
        const t = taskMap.get(id);
        if (!t) continue;
        if (t.fields['System.WorkItemType'] !== 'Task') continue;
        const rw = t.fields['Microsoft.VSTS.Scheduling.RemainingWork'];
        if (typeof rw === 'number' && rw > 0) out.push(t);
      }
      return out;
    }

    const pbis: AdoPbi[] = pbiItems.map(pbi => {
      const fields    = pbi.fields;
      const type      = fields['System.WorkItemType'] === 'Bug' ? 'Bug' : 'Story';
      const priority  = fields['Microsoft.VSTS.Common.Priority'] ?? 3;

      const dependsOn: string[] = (pbi.relations ?? [])
        .filter((r: any) => r.rel === 'System.LinkTypes.Dependency-Reverse')
        .map((r: any) => String(extractId(r.url)));

      // Granularność task — jedna faza per otwarty Task (RemainingWork > 0).
      // Taski przypisane do dedykowanych QA-testerów pomijamy (są reprezentowane
      // przez QA card per PBI). Brak otwartych dev-Tasków → fallback z PBI.
      const openTasks = openChildTasksFor(pbi);
      const devTasks = openTasks.filter(t => {
        const name = t.fields['System.AssignedTo']?.displayName;
        return !name || !qaTesterNames.has(String(name).toLowerCase());
      });
      const phases: AdoPbi['phases'] = devTasks.length
        ? devTasks.map(t => {
            const hours = t.fields['Microsoft.VSTS.Scheduling.RemainingWork'] as number;
            return {
              assigneeId: resolveAssignee(t.fields['System.AssignedTo']?.displayName),
              days:       hoursToDays(hours),   // 0.5 increments — do layoutu (snapowanie do sprintDays)
              hours,                            // surowe godziny — do wizualnej szerokości karty
              role:       roleFromTags(t.fields['System.Tags'] ?? ''),
              title:      t.fields['System.Title'] as string,
            };
          })
        : [{
            // Brak otwartych dev tasków = PBI w code review / QA / done.
            // Pokazujemy jako minimalną kartkę (0.5 d) — min-width i tak zrobi
            // ją czytelną, ale nie kradnie 8 dni kalendarza.
            assigneeId: resolveAssignee(fields['System.AssignedTo']?.displayName),
            days:       0.5,
            role:       'Dev',
          }];

      const tester = resolveTester(fields['Custom.QATester']?.displayName);

      return {
        id:       String(pbi.id),
        title:    fields['System.Title'] as string,
        color:    colorForId(pbi.id),
        priority: priority as number,
        type,
        phases,
        dependsOn:    dependsOn.length ? dependsOn : undefined,
        qaTesterId:   tester?.id,
        qaTesterName: tester?.name,
        state:        fields['System.State'] as string | undefined,
      };
    });

    return {
      pbis,
      users:   Array.from(usersById.values()),
      testers: Array.from(testersById.values()),
      iteration,
    };
  }
}

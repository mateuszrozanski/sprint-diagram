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

/**
 * Zaokrąglenie W GÓRĘ do najbliższych 0.5 dnia (minimum 0.5).
 * Ceil (nie round!) — 7h to >1 dzień pracy, musi zająć 2 dni layoutu, inaczej
 * następna faza tego samego deva nachodzi na poprzednią.
 */
function hoursToDays(hours: number): number {
  return Math.max(0.5, Math.ceil((hours / HOURS_PER_DAY) * 2) / 2);
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

/**
 * Aktywność z `Microsoft.VSTS.Common.Activity` (standardowe pole ADO Task) —
 * typowe wartości: Development, Testing, Documentation, Design, Deployment,
 * Requirements. Fallback: tag-based role.
 */
function activityFromTask(task: any): string {
  const activity = task.fields?.['Microsoft.VSTS.Common.Activity'];
  if (typeof activity === 'string' && activity.trim()) return activity.trim();
  const tagRole = roleFromTags(task.fields?.['System.Tags'] ?? '');
  if (tagRole !== 'Dev') return tagRole;
  return 'Development';
}

export function slugifyUser(displayName: string): string {
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

    const qaTesterOriginals: string[] = ((iterationRaw?.qaTesters ?? []) as string[])
      .map((s: string) => s.trim())
      .filter(Boolean);
    const qaTesterNames: Set<string> = new Set(qaTesterOriginals.map(s => s.toLowerCase()));

    // Devs from env (ADO_DEVS). Exclude anyone już w qaTesters — promotion do QA
    // overrules ADO_DEVS, inaczej osoba ma dwie swimlane (dev + QA).
    const seededDevs: { id: string; name: string }[] = ((iterationRaw?.devs ?? []) as string[])
      .map(name => name.trim())
      .filter(name => !!name && !qaTesterNames.has(name.toLowerCase()))
      .map(name => ({ id: slugifyUser(name), name }));

    // Testers from env (ADO_QA_TESTERS) — sub-lanes pojawiają się niezależnie od
    // Custom.QATester ustawionego na PBI. Bez tego osoba w qaTesters ale bez
    // Custom.QATester pasującego do żadnego PBI nie miała sub-lane.
    const seededTesters: { id: string; name: string }[] = qaTesterOriginals.map(name => ({
      id: 'qa-' + slugifyUser(name),
      name,
    }));

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

    // Merge: caller-passed users + ADO_DEVS env seed (qa-tester names już
    // odfiltrowane wyżej). Devs z env idą jako baseline, nawet jeśli nie mają
    // tasków w bieżącym sprincie.
    const allBaselineUsers = [...users, ...seededDevs]
      .filter(u => !qaTesterNames.has(u.name.toLowerCase()));
    const usersById   = new Map(allBaselineUsers.map(u => [u.id, u]));
    const usersByName = new Map(allBaselineUsers.map(u => [u.name.toLowerCase(), u]));
    const testersById = new Map<string, SprintUser>(seededTesters.map(t => [t.id, t]));

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

    const pbis: AdoPbi[] = pbiItems.map((pbi): AdoPbi | null => {
      const fields    = pbi.fields;
      const type      = fields['System.WorkItemType'] === 'Bug' ? 'Bug' : 'Story';
      const priority  = fields['Microsoft.VSTS.Common.Priority'] ?? 3;

      const dependsOn: string[] = (pbi.relations ?? [])
        .filter((r: any) => r.rel === 'System.LinkTypes.Dependency-Reverse')
        .map((r: any) => String(extractId(r.url)));

      // Granularność task — jedna faza per otwarty Task (RemainingWork > 0).
      // Taski QA-testerów też idą jako phases (z assigneeId='qa-...') — wpadną
      // do QA sub-lane przez testerIndex w sprint-ado.ts.
      const openTasks = openChildTasksFor(pbi);
      const devTasks = openTasks;

      // ── Grupowanie tasków po (activity, assignee) ─────────────────────
      // Zamiast 1 karty per task (kompletnie nieczytelne przy 5-10 tasków),
      // grupujemy taski o tej samej aktywności (Development/Testing/Design)
      // i tym samym dev-ie w JEDNĄ kartę. Hours = suma. Jeśli dwóch devów
      // robi Development tego samego PBI → dwie karty "Development".
      type Group = { activity: string; assigneeId: string; hours: number; titles: string[] };
      const groupMap = new Map<string, Group>();
      for (const t of devTasks) {
        const activity   = activityFromTask(t);
        const assigneeId = resolveAssignee(t.fields['System.AssignedTo']?.displayName);
        const hours      = t.fields['Microsoft.VSTS.Scheduling.RemainingWork'] as number;
        const key        = `${activity}|${assigneeId}`;
        const existing   = groupMap.get(key);
        const title      = t.fields['System.Title'] as string;
        if (existing) {
          existing.hours += hours;
          existing.titles.push(title);
        } else {
          groupMap.set(key, { activity, assigneeId, hours, titles: [title] });
        }
      }

      const groups = [...groupMap.values()];

      // Numerowanie kolejnych wystąpień tej samej aktywności w PBI:
      // 1×Development → "Development"; 2×Development → "Development", "Development 2"; itd.
      const activityCount = new Map<string, number>();
      const activitySeen  = new Map<string, number>();
      for (const g of groups) {
        activityCount.set(g.activity, (activityCount.get(g.activity) ?? 0) + 1);
      }
      const labeledGroups = groups.map(g => {
        const seen = (activitySeen.get(g.activity) ?? 0) + 1;
        activitySeen.set(g.activity, seen);
        const total = activityCount.get(g.activity) ?? 1;
        const suffix = total > 1 ? ` ${seen}` : '';
        return { ...g, label: `${g.activity}${suffix}` };
      });

      // Brak otwartych dev tasków → PBI nie renderujemy. RemainingWork=0 oznacza
      // że praca dev jest zrobiona; pokazywanie OriginalEstimate/Effort byłoby
      // mylące (board pokazywałby godziny które już są spalone).
      if (!labeledGroups.length) return null;

      const phases: AdoPbi['phases'] = labeledGroups.map(g => ({
        assigneeId:       g.assigneeId,
        days:             hoursToDays(g.hours),
        hours:            g.hours,
        role:             g.activity,
        title:            g.titles.length > 1
                            ? `${g.label} (${g.titles.length} tasks)`
                            : g.label,
        groupTaskTitles:  g.titles,
      }));

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
    }).filter((p): p is AdoPbi => p !== null);

    return {
      pbis,
      users:   Array.from(usersById.values()),
      testers: Array.from(testersById.values()),
      iteration,
    };
  }
}

import { Injectable } from '@angular/core';
import type { AdoPbi, SprintUser } from './sprint-data';
import { CALENDAR_SLOTS, categorizeState } from './sprint-data';

export interface AdoIteration {
  id?:        string;
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
  /** sprintDay numbers (1-10) per userId, kiedy dev jest off. */
  daysOffByUserId: Map<string, Set<number>>;
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
  /** GET /api/ado/pat-info → ile dni do wygaśnięcia PAT (lub null gdy env brak). */
  async fetchPatInfo(): Promise<{ expiry: string | null; daysLeft: number | null }> {
    try {
      return await fetchJson(`${ADO_BASE}/pat-info`, { cache: 'no-store' });
    } catch {
      return { expiry: null, daysLeft: null };
    }
  }

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
      id:         iterationRaw.id,
      name:       iterationRaw.name,
      path:       iterationRaw.path,
      startDate:  iterationRaw.startDate  ? new Date(iterationRaw.startDate)  : null,
      finishDate: iterationRaw.finishDate ? new Date(iterationRaw.finishDate) : null,
    } : null;

    const qaTesterOriginals: string[] = ((iterationRaw?.qaTesters ?? []) as string[])
      .map((s: string) => s.trim())
      .filter(Boolean);
    const qaTesterNames: Set<string> = new Set(qaTesterOriginals.map(s => s.toLowerCase()));

    // Capacity fetch — daysOff per team member. Fire-and-catch: brak iter id /
    // brak permissions → pusta mapa, board renderuje bez per-dev off bandów.
    const daysOffByUserId = new Map<string, Set<number>>();
    // Porównanie po dacie YYYY-MM-DD (string) zamiast po timestamp — ADO zwraca
    // ISO z "T00:00:00Z" (UTC), `slot.date` to local time. W timezone +02:00
    // local Tue 00:00 = UTC Mon 22:00 < ADO UTC Tue 00:00 → mismatch. Stringi
    // wyciętej daty (YYYY-MM-DD) są timezone-independent jeśli używamy konsystentnie.
    const toIsoDate = (d: Date): string => {
      // Local-date YYYY-MM-DD (nie toISOString który konwertuje na UTC).
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    if (iteration?.id) {
      try {
        // cache:'no-store' — Vercel/browser cache zwraca 304 z pustym body
        // przy condition-request, frontend dostaje null → daysOff puste.
        const capRaw = await fetchJson(`${ADO_BASE}/capacities?iterationId=${iteration.id}`, { cache: 'no-store' });
        // Endpoint może zwracać `value` (legacy) lub `teamMembers` (nowsze). Bierzemy oba.
        const entries = capRaw.value ?? capRaw.teamMembers ?? [];
        for (const entry of entries) {
          const name = entry.teamMember?.displayName as string | undefined;
          if (!name) continue;
          const isQa = qaTesterNames.has(name.toLowerCase());
          const userId = isQa ? 'qa-' + slugifyUser(name) : slugifyUser(name);
          const offDays = new Set<number>();
          for (const range of (entry.daysOff ?? [])) {
            if (!range.start || !range.end) continue;
            // ADO zwraca ISO UTC ("2026-05-26T00:00:00Z"). Wyciągamy YYYY-MM-DD
            // bezpośrednio ze stringa — pomijamy timezone shenanigans.
            const startStr = String(range.start).slice(0, 10);
            const endStr   = String(range.end).slice(0, 10);
            for (const slot of CALENDAR_SLOTS) {
              if (slot.sprintDay === null) continue;
              const slotStr = toIsoDate(slot.date);
              if (slotStr >= startStr && slotStr <= endStr) offDays.add(slot.sprintDay);
            }
          }
          if (offDays.size) daysOffByUserId.set(userId, offDays);
        }
      } catch (err) {
        console.warn('[AdoService] capacity fetch failed (non-fatal)', err);
      }
    }

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
    if (!pbiIds.length) return { pbis: [], users, testers: [], iteration, daysOffByUserId };

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

    /** Zamknięte taski w sprincie: state = done-category, ClosedDate w sprincie.
     *  Zwraca też hours (CompletedWork lub OriginalEstimate) i closedDay (1-10).
     *  Bez closedDate (np. zamknięty wcześniej w prehistorii) → odrzucane. */
    function closedChildTasksInSprint(pbi: any): { task: any; hours: number; closedDay: number }[] {
      const childIds = (pbi.relations ?? [])
        .filter((r: any) => r.rel === 'System.LinkTypes.Hierarchy-Forward')
        .map((r: any) => extractId(r.url));
      const out: { task: any; hours: number; closedDay: number }[] = [];
      for (const id of childIds) {
        const t = taskMap.get(id);
        if (!t) continue;
        if (t.fields['System.WorkItemType'] !== 'Task') continue;
        const cat = categorizeState(t.fields['System.State']);
        if (cat !== 'done') continue;
        // Date kiedy task został zamknięty/zrobiony — preferujemy ClosedDate, fallback ResolvedDate / StateChangeDate.
        const closedIso: string | undefined =
          t.fields['Microsoft.VSTS.Common.ClosedDate']
          ?? t.fields['Microsoft.VSTS.Common.ResolvedDate']
          ?? t.fields['System.StateChangeDate'];
        if (!closedIso) continue;
        const closedDate = new Date(closedIso);
        // Mapuj na sprintDay przez kalendarz. Closed poza sprintem → skip.
        const closedYmd = closedIso.slice(0, 10);
        let sprintDay: number | null = null;
        for (const slot of CALENDAR_SLOTS) {
          if (slot.sprintDay === null) continue;
          const slotYmd = `${slot.date.getFullYear()}-${String(slot.date.getMonth()+1).padStart(2,'0')}-${String(slot.date.getDate()).padStart(2,'0')}`;
          if (slotYmd === closedYmd) { sprintDay = slot.sprintDay; break; }
        }
        if (sprintDay === null) {
          // Closed dokładnie w weekend → mapuj na najbliższy working day wstecz (Friday).
          // Bez tego task zamknięty w piątek wieczór z ClosedDate=sobota wypadał z board.
          const day = closedDate.getDay();
          if (day === 0 || day === 6) {
            // szukamy poprzedniego working day w slotach
            for (let i = CALENDAR_SLOTS.length - 1; i >= 0; i--) {
              const slot = CALENDAR_SLOTS[i];
              if (slot.sprintDay === null) continue;
              if (slot.date <= closedDate) { sprintDay = slot.sprintDay; break; }
            }
          }
        }
        if (sprintDay === null) continue;
        const completed = t.fields['Microsoft.VSTS.Scheduling.CompletedWork'] as number | undefined;
        const orig      = t.fields['Microsoft.VSTS.Scheduling.OriginalEstimate'] as number | undefined;
        const hours = (typeof completed === 'number' && completed > 0) ? completed
                    : (typeof orig === 'number' && orig > 0) ? orig
                    : 1;
        out.push({ task: t, hours, closedDay: sprintDay });
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
      // Plus oddzielne grupy dla closed tasków w sprincie — żeby na koniec sprintu
      // widzieć co już zrobione (ghost cards na pozycji ClosedDate).
      const openTasks = openChildTasksFor(pbi);
      const closedTasks = closedChildTasksInSprint(pbi);

      // ── Grupowanie tasków po (activity, assignee) ─────────────────────
      // Closed grupowane oddzielnie po (activity, assignee, closedDay) — każdy dzień
      // zamknięcia to osobna ghost karta na timeline, inaczej kilka closed z różnych
      // dni stworzyłoby jedną wielką w średniej pozycji.
      type Group = { activity: string; assigneeId: string; hours: number; titles: string[]; closedDay?: number };
      const groupMap = new Map<string, Group>();
      for (const t of openTasks) {
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
      for (const { task: t, hours, closedDay } of closedTasks) {
        const activity   = activityFromTask(t);
        const assigneeId = resolveAssignee(t.fields['System.AssignedTo']?.displayName);
        const key        = `closed|${activity}|${assigneeId}|${closedDay}`;
        const existing   = groupMap.get(key);
        const title      = t.fields['System.Title'] as string;
        if (existing) {
          existing.hours += hours;
          existing.titles.push(title);
        } else {
          groupMap.set(key, { activity, assigneeId, hours, titles: [title], closedDay });
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
        isClosed:         g.closedDay !== undefined,
        closedDay:        g.closedDay,
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
      daysOffByUserId,
    };
  }
}

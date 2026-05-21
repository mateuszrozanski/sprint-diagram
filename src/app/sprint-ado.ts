import { ADO_MOCK_PBIS, CALENDAR_SLOTS, INCOMING_BUGS_MOCK, USERS, type AdoPbi, type PBI, categorizeState } from './sprint-data';
import type { DiagramNode, DiagramEdge } from './sprint-data';
import { L, getSprintDayOffset, getSlotXOffset, getSlotWidth, getQaWidth, getEffectiveQaWidth, getEffectivePbiWidth, nearestWorkingSprintDay, skipNonWorkingX, getTodayXOffset } from './layout';
import { widthForHours } from './card-width';

// ── Holiday-aware day helpers ────────────────────────────────────────────────

/** Returns the next sprint day that is not a holiday (holidays are skipped). */
function nextWorkingDay(day: number): number {
  while (day <= 10) {
    const slot = CALENDAR_SLOTS.find(s => s.sprintDay === day);
    if (slot && !slot.isHoliday) return day;
    day++;
  }
  return day;
}

/**
 * Tight px-pack — żadnych dziur w wierszu deva. Phases siedzą flush jedna za
 * drugą. Weekend/holiday są przeskakiwane przez `skipNonWorkingX` ale tylko
 * gdy cursor wpada w non-working slot — bez sztucznego push do następnego dnia
 * gdy phase "nie mieści się" w pozostałym budżecie current day.
 *
 * Konsekwencja: phase może wizualnie przekraczać day-boundary w środku dnia.
 * To okej — day grid w nagłówku jest referencyjny, nie strict bin.
 */
function placePhase(cursorX: number, phaseWidth: number): { placedX: number; nextCursor: number } {
  const x = skipNonWorkingX(cursorX);
  return { placedX: x, nextCursor: x + phaseWidth };
}

/**
 * Computes the end sprint day after working `workDays` non-holiday days
 * starting from `startDay`. Holidays are skipped (the card visually spans them).
 */
function computeEndDay(startDay: number, workDays: number): number {
  let day = startDay;
  let worked = 0;
  while (worked < workDays) {
    const slot = CALENDAR_SLOTS.find(s => s.sprintDay === day);
    if (slot && !slot.isHoliday) worked++;
    if (worked < workDays) day++;
    if (day > 10) break;
  }
  return day;
}

// ── Topological sort ────────────────────────────────────────────────────────
/**
 * Sort PBIs so that every item's dependencies appear before it.
 * Within the same dependency level, bugs go first then stories, both sorted by priority.
 */
function topoSort(items: AdoPbi[]): AdoPbi[] {
  const map = new Map(items.map(p => [p.id, p]));
  const visited = new Set<string>();
  const result: AdoPbi[] = [];

  // Process in priority order so that among equal topo-levels the order is deterministic
  const byPriority = [...items].sort((a, b) =>
    a.priority !== b.priority ? a.priority - b.priority :
    a.type === 'Bug' && b.type !== 'Bug' ? -1 :
    b.type === 'Bug' && a.type !== 'Bug' ?  1 : 0
  );

  function visit(pbi: AdoPbi) {
    if (visited.has(pbi.id)) return;
    for (const depId of pbi.dependsOn ?? []) {
      const dep = map.get(depId);
      if (dep) visit(dep);
    }
    visited.add(pbi.id);
    result.push(pbi);
  }

  for (const pbi of byPriority) visit(pbi);
  return result;
}

// ── Main build function ─────────────────────────────────────────────────────
/**
 * Transform planned ADO work items into ng-diagram nodes + edges.
 *
 * Auto-layout (greedy, per developer):
 *   • Topological order (dependencies before dependents), then priority asc, bugs first
 *   • Each dev's phases placed sequentially; phase[i+1] waits for phase[i] to end
 *   • Cross-PBI constraint: first phase of a dependent PBI starts after the last phase
 *     of every PBI it `dependsOn`
 *
 * Returns assigneeMap and depsMap instead of mutating globals.
 */
export function buildNodesFromAdo(
  items: AdoPbi[] = ADO_MOCK_PBIS,
  users: { id: string; name: string }[] = USERS,
  testers: { id: string; name: string }[] = [],
): {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  assigneeMap: Map<string, string>;
  depsMap: Map<string, string[]>;
  /** Ile lanes ma każdy dev po scheduling. Dev z 1 lane = standardowa wysokość. */
  lanesPerDev: Map<string, number>;
  /** Top Y (px) dev/tester row. Liczone cumulatywnie po `users` order, potem testers. */
  rowYMap: Map<string, number>;
  /** Wysokość (px) dev/tester row = BASE_H × lanes. */
  rowHMap: Map<string, number>;
} {
  const testerIndex = new Map(testers.map((t, i) => [t.id, i]));
  const assigneeMap = new Map<string, string>();
  const depsMap     = new Map<string, string[]>();

  // Px-based packing per dev. Karta zajmuje TYLKO tyle px ile godzin × proporcja,
  // bez zaokrąglania do całego dnia.
  // Day 1 sprintu = planowanie + retro, devs nie pracują. Phases startują od day 2:
  // FIRST_X = LABEL_W + DAY_W.
  const FIRST_X = L.LABEL_W + L.DAY_W;
  // Multi-lane per dev: każdy dev ma N lanes, każda z własnym cursor X. First-fit
  // alokacja — phase ląduje w pierwszej lane gdzie cursor <= jej start. Jeśli żadna
  // → spawn nowej lane (push 0). lanes[0] istnieje dla każdego deva od początku
  // żeby standardowe sekwencyjne pakowanie się nie zmieniło gdy nie ma parallel.
  const laneCursorsPerDev = new Map<string, number[]>(users.map(u => [u.id, [FIRST_X]]));
  const pbiLastEndPx = new Map<string, number>();
  const phaseEndPx   = new Map<string, number>();
  // "Dziś" jako absolutny px (LABEL_W + offset) — phases State=inDev/blocked
  // startują od max(todayX, depEnd, lane.cursor). null = sprint poza dziś.
  const todayOffset = getTodayXOffset();
  const todayX = todayOffset !== null ? L.LABEL_W + todayOffset : null;

  interface PhaseLayout {
    id: string;
    parentId: string;
    parentColor: string;
    parentType: 'Story' | 'Bug';
    title: string;
    parentTitle?: string;
    role: string;
    assigneeId: string;
    startDay: number;
    endDay: number;
    phaseIdx: number;
    totalPhases: number;
    isHalfDay: boolean;
    isParallel: boolean;
    x: number;
    width: number;
    laneIdx: number;
  }

  const allPhases: PhaseLayout[] = [];
  const sorted = topoSort(items);

  // ── 1) Buduj phase stubs (id + deps + metadata) ─────────────────────────
  interface PhaseStub {
    id: string;
    pbi: AdoPbi;
    phaseIdx: number;
    assigneeId: string;
    hours: number | undefined;
    isParallel: boolean;
    isHalfDay: boolean;
    role: string;
    title: string;
    parentTitle?: string;
    deps: Set<string>;
    /** Kategoria stanu (z phase.state lub PBI.state) — driveruje schedule:
     *  inDev/blocked → karta przyklejona do todayX (już się dzieje).
     *  Reszta → standardowy pack od cursor. */
    stateCat: ReturnType<typeof categorizeState>;
  }

  const stubs: PhaseStub[] = [];
  const stubById = new Map<string, PhaseStub>();

  for (const pbi of sorted) {
    for (let i = 0; i < pbi.phases.length; i++) {
      const phase = pbi.phases[i];
      const phaseId = `${pbi.id}-p${i}`;
      const isParallel = !!phase.parallel;

      // Intra-PBI handoff: faza Testing czeka na inne aktywności tego PBI.
      // Wykrywamy po roli (typ taska w ADO: Microsoft.VSTS.Common.Activity),
      // nie po assignee — Testing task może być przypisany do dev-a (nie tylko
      // QA), a wtedy assigneeId nie zaczyna się od `qa-` i bez tego Testing
      // szedłby równolegle / przed Development.
      // Skanujemy WSZYSTKIE phases (nie tylko j<i), bo ADO child task order
      // bywa losowy — Testing może wrócić przed Development → idx=0, deps=[].
      const deps = new Set<string>();
      const isTestingRole = phase.role === 'Testing';
      if (!isParallel && isTestingRole) {
        for (let j = 0; j < pbi.phases.length; j++) {
          if (j === i) continue;
          if (pbi.phases[j].role !== phase.role) {
            deps.add(`${pbi.id}-p${j}`);
          }
        }
      }

      // depsMap exposed downstream (handoff edges, drag service).
      depsMap.set(phaseId, [...deps]);
      assigneeMap.set(phaseId, phase.assigneeId);

      const stub: PhaseStub = {
        id: phaseId,
        pbi,
        phaseIdx: i,
        assigneeId: phase.assigneeId,
        hours: phase.hours,
        isParallel,
        isHalfDay: phase.days === 0.5,
        role: phase.role,
        title: phase.title ?? pbi.title,
        parentTitle: phase.title ? pbi.title : undefined,
        deps,
        stateCat: categorizeState(phase.state ?? pbi.state),
      };
      stubs.push(stub);
      stubById.set(phaseId, stub);
    }
  }

  // ── 2) List scheduling z lane allocation ────────────────────────────────
  // Round picks phase ready (deps scheduled) z najwcześniejszym możliwym startem,
  // szuka first-fit lane u jej deva. Jeśli żadna istniejąca lane nie pasuje (lane
  // cursor > start) → spawn nowej lane. Tym samym phases State=inDev tego samego
  // deva (wszystkie startują od todayX) lądują w równoległych lanes.
  const scheduledX = new Map<string, number>();
  const scheduledEndX = new Map<string, number>();
  const scheduledLaneIdx = new Map<string, number>();
  const pending = new Set<string>(stubs.map(s => s.id));

  /** Minimalny start phase: max(deps, FIRST_X, todayX gdy in-progress). */
  function minStartFor(stub: PhaseStub, depEnd: number): number {
    let start = Math.max(depEnd, FIRST_X);
    if (todayX !== null && (stub.stateCat === 'inDev' || stub.stateCat === 'blocked')) {
      // Phase already in progress → kotwica do "dziś". Nie wcześniej (już się dzieje),
      // nie później (deps i tak są pewnie spełnione bo już pracuje).
      start = Math.max(start, todayX);
    }
    return start;
  }

  /** Lane allocator. Spawn nowej lane gdy:
   *  B) phase state=inDev/blocked (ADO mówi "robi się teraz"), LUB
   *  C) phase ready PRZED today (start < todayX) ALE lane 0 zajęta dalej niż
   *     today (lanes[0] > todayX) — dev "ciągnie" coś dłużej niż powinien,
   *     fresh ready phase nie musi czekać → wskakuje obok.
   *  Inaczej: sekwencyjny pack lane 0 (bump start do lanes[0]).
   *  Bez tego (czysty first-fit) każda phase z start<lanes[0] spawnowała lane
   *  → wszyscy parallel. */
  function placeInLane(stub: PhaseStub, start: number, width: number): { laneIdx: number; placedX: number; endX: number } {
    const lanes = laneCursorsPerDev.get(stub.assigneeId) ?? [FIRST_X];
    if (!laneCursorsPerDev.has(stub.assigneeId)) {
      laneCursorsPerDev.set(stub.assigneeId, lanes);
    }
    const isInProgress = stub.stateCat === 'inDev' || stub.stateCat === 'blocked';
    const collisionAfterToday = todayX !== null && start < todayX && lanes[0] > todayX;
    const canSpawn = isInProgress || collisionAfterToday;
    let laneIdx: number;
    let effectiveStart = start;
    if (canSpawn) {
      // C: bump start do todayX, żeby spawned card nie startowała w przeszłości.
      if (collisionAfterToday && todayX !== null) effectiveStart = Math.max(start, todayX);
      // First-fit. Brak fitującej → spawn.
      laneIdx = lanes.findIndex(c => c <= effectiveStart);
      if (laneIdx === -1) {
        laneIdx = lanes.length;
        lanes.push(FIRST_X);
      }
    } else {
      // Sekwencyjny pack na lane 0.
      laneIdx = 0;
      effectiveStart = Math.max(start, lanes[0]);
    }
    const { placedX } = placePhase(Math.max(lanes[laneIdx], effectiveStart), width);
    const effW = getEffectivePbiWidth(placedX, width);
    const endX = placedX + effW;
    lanes[laneIdx] = endX;
    return { laneIdx, placedX, endX };
  }

  while (pending.size > 0) {
    // Intra-PBI handoff JEST respektowany: Testing dla PBI X nie może startować
    // przed końcem Development X. Cross-PBI deps NIE blokują (wizualne tylko).
    const ready: { stub: PhaseStub; start: number }[] = [];
    for (const id of pending) {
      const stub = stubById.get(id)!;
      let depsReady = true;
      let depEnd = 0;
      for (const dId of stub.deps) {
        if (!scheduledEndX.has(dId)) { depsReady = false; break; }
        depEnd = Math.max(depEnd, scheduledEndX.get(dId)!);
      }
      if (!depsReady) continue;
      ready.push({ stub, start: minStartFor(stub, depEnd) });
    }

    if (!ready.length) {
      // Dep cycle / orphan — bezpieczny fallback: schedule remaining w lane 0.
      console.warn('[layout] dep cycle, scheduling remaining flatly');
      for (const id of pending) {
        const stub = stubById.get(id)!;
        const start = minStartFor(stub, 0);
        const w = widthForHours(stub.hours);
        const { laneIdx, placedX, endX } = placeInLane(stub, start, w);
        scheduledX.set(id, placedX);
        scheduledEndX.set(id, endX);
        scheduledLaneIdx.set(id, laneIdx);
      }
      break;
    }

    // Tiebreak: start ASC, bug-before-story, priority ASC, then parent topo (sorted index).
    const pbiOrder = new Map(sorted.map((p, idx) => [p.id, idx]));
    ready.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      if (a.stub.pbi.type !== b.stub.pbi.type) {
        return a.stub.pbi.type === 'Bug' ? -1 : 1;
      }
      if (a.stub.pbi.priority !== b.stub.pbi.priority) {
        return a.stub.pbi.priority - b.stub.pbi.priority;
      }
      return (pbiOrder.get(a.stub.pbi.id) ?? 0) - (pbiOrder.get(b.stub.pbi.id) ?? 0);
    });

    const winner = ready[0];
    const w = widthForHours(winner.stub.hours);
    const { laneIdx, placedX, endX } = placeInLane(winner.stub, winner.start, w);
    scheduledX.set(winner.stub.id, placedX);
    scheduledEndX.set(winner.stub.id, endX);
    scheduledLaneIdx.set(winner.stub.id, laneIdx);
    pending.delete(winner.stub.id);
  }

  // ── 2.5) Lanes per dev/tester + cumulative row Y ────────────────────────
  // BASE_H = "atomowa" wysokość 1 lane (= dawne L.ROW_H). Dev z 1 lane → BASE_H.
  // Dev z 3 lanes → BASE_H × 3 = trzy karty obok siebie w pionie w tym samym
  // wierszu deva. Incoming nadal jako pojedynczy row na samej górze.
  const BASE_H = L.ROW_H;
  const lanesPerDev = new Map<string, number>();
  for (const u of users) {
    const lanes = laneCursorsPerDev.get(u.id);
    lanesPerDev.set(u.id, Math.max(1, lanes?.length ?? 1));
  }
  // Testerzy też mogą mieć multi-lane (QA tester pracuje nad 2 PBI naraz w testing
  // phase). Lane cursors są w `laneCursorsPerDev` z assigneeId `qa-<slug>`.
  for (const t of testers) {
    const lanes = laneCursorsPerDev.get(t.id);
    lanesPerDev.set(t.id, Math.max(1, lanes?.length ?? 1));
  }

  // Row Y/H: incoming (BASE_H) na górze, potem devs cumulatywnie, potem testers.
  const rowYMap = new Map<string, number>();
  const rowHMap = new Map<string, number>();
  let cumY = L.HEADER_H + BASE_H; // skip incoming row (BASE_H high)
  for (const u of users) {
    const h = BASE_H * lanesPerDev.get(u.id)!;
    rowYMap.set(u.id, cumY);
    rowHMap.set(u.id, h);
    cumY += h;
  }
  for (const t of testers) {
    const h = BASE_H * lanesPerDev.get(t.id)!;
    rowYMap.set(t.id, cumY);
    rowHMap.set(t.id, h);
    cumY += h;
  }

  // ── 3) Materializuj PhaseLayout z policzonymi x/width ───────────────────
  for (const stub of stubs) {
    const x = scheduledX.get(stub.id)!;
    const w = widthForHours(stub.hours);
    const endX = scheduledEndX.get(stub.id)!;
    phaseEndPx.set(stub.id, endX);

    const startDay = nearestWorkingSprintDay(x - L.LABEL_W);
    const endDay   = nearestWorkingSprintDay(endX - L.LABEL_W - 1);

    allPhases.push({
      id:          stub.id,
      parentId:    stub.pbi.id,
      parentColor: stub.pbi.color,
      parentType:  stub.pbi.type,
      title:       stub.title,
      parentTitle: stub.parentTitle,
      role:        stub.role,
      assigneeId:  stub.assigneeId,
      startDay,
      endDay,
      phaseIdx:    stub.phaseIdx,
      totalPhases: stub.pbi.phases.length,
      isHalfDay:   stub.isHalfDay,
      isParallel:  stub.isParallel,
      x,
      width:       w,
      laneIdx:     scheduledLaneIdx.get(stub.id) ?? 0,
    });

    const prevPbiEnd = pbiLastEndPx.get(stub.pbi.id) ?? 0;
    if (endX > prevPbiEnd) pbiLastEndPx.set(stub.pbi.id, endX);
  }

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];

  for (const pl of allPhases) {
    // assignee może być dev (users[]) ALBO QA tester ('qa-...' w testerIndex).
    const testerSubIdx = testerIndex.get(pl.assigneeId);
    const isQaPhase = testerSubIdx !== undefined;
    const userIdx = isQaPhase ? -1 : users.findIndex(u => u.id === pl.assigneeId);
    // Unknown assignee — skip rendering (else card lądowałaby na y=0 = header
    // row razem z innymi orphan-ami → visual stack overlap).
    if (!isQaPhase && userIdx < 0) {
      console.warn(`[buildNodesFromAdo] unknown assignee ${pl.assigneeId} for phase ${pl.id}, skipping`);
      continue;
    }
    // Top Y dev/tester row z policzonej mapy + laneIdx × BASE_H żeby parallel
    // phases tego samego deva lądowały w pionie pod sobą (zamiast push X).
    const rowTopY = rowYMap.get(pl.assigneeId);
    if (rowTopY === undefined) {
      console.warn(`[buildNodesFromAdo] no rowYMap entry for ${pl.assigneeId}, skipping`);
      continue;
    }
    const laneY = rowTopY + pl.laneIdx * BASE_H;

    const pbiObj: PBI = {
      id:              pl.id,
      title:           pl.title,
      color:           pl.parentColor,
      primaryAssignee: pl.assigneeId,
      collaborators:   [],
      startDay:        pl.startDay,
      endDay:          pl.endDay,
      dependencies:    depsMap.get(pl.id) ?? [],
    };

    // Szerokość przez `widthForHours` (testowany) — patrz card-width.ts.
    const parentPbi = items.find(p => p.id === pl.parentId);
    const phaseHours = parentPbi?.phases[pl.phaseIdx]?.hours;
    const groupTaskTitles = parentPbi?.phases[pl.phaseIdx]?.groupTaskTitles ?? [];
    // Phase-level state ma pierwszeństwo nad PBI-level — task może być Blocked
    // nawet jeśli PBI jest In Development, i chcemy widzieć blokadę na karcie.
    const phaseState = parentPbi?.phases[pl.phaseIdx]?.state ?? parentPbi?.state;

    nodes.push({
      id:       pl.id,
      type:     'pbi',
      zOrder:   10,
      position: {
        x: pl.x,
        y: laneY + Math.round((BASE_H - L.NODE_H) / 2),
      },
      autoSize: false,
      size:     { width: pl.width, height: L.NODE_H },
      data: {
        ...pbiObj,
        width:           pl.width,
        height:          L.NODE_H,
        displayId:       pl.parentId,
        parentTitle:     pl.parentTitle,
        phaseRole:       pl.role,
        phaseHours:      phaseHours,
        groupTaskTitles: groupTaskTitles,
        isBugType:       pl.parentType === 'Bug',
        phaseIdx:        pl.phaseIdx,
        totalPhases:     pl.totalPhases,
        state:           phaseState,
      },
    });


    // QA edge from every phase → qa-{pbiId}
    edges.push({
      id:         `qa-edge-${pl.id}`,
      type:       'qa',
      zOrder:     5,
      source:     pl.id,
      sourcePort: 'qa',
      target:     `qa-${pl.parentId}`,
      targetPort: 'qa-in',
      data:       { edgeType: 'qa', pbiIds: [pl.parentId] },
    });

    // Handoff edge: sequential phases only
    if (pl.phaseIdx > 0 && !pl.isParallel) {
      const prevId = `${pl.parentId}-p${pl.phaseIdx - 1}`;
      edges.push({
        id:         `handoff-${prevId}-${pl.id}`,
        type:       'handoff',
        zOrder:     5,
        source:     prevId,
        sourcePort: 'out',
        target:     pl.id,
        targetPort: 'in',
        data:       { edgeType: 'handoff', color: pl.parentColor, pbiIds: [pl.parentId] },
      });
    }
  }

  // One QA node per PBI, positioned at the rightmost phase
  const pbiGroups = new Map<string, PhaseLayout[]>();
  for (const pl of allPhases) {
    if (!pbiGroups.has(pl.parentId)) pbiGroups.set(pl.parentId, []);
    pbiGroups.get(pl.parentId)!.push(pl);
  }

  // Sprint right edge — żeby QA cards nie wychodziły poza widoczny sprint.
  let sprintEndX = L.LABEL_W;
  for (const slot of CALENDAR_SLOTS) {
    sprintEndX += slot.isWeekend ? L.WKND_W : L.DAY_W;
  }
  const qaMaxStartX = Math.max(L.LABEL_W, sprintEndX - getQaWidth());

  for (const [pbiId, phases] of pbiGroups) {
    // Najbardziej-w-prawo faza (px-based) — QA card siada tuż za nią.
    const rightmost = phases.reduce((best, p) => (p.x + p.width) > (best.x + best.width) ? p : best);
    const pbi = items.find(p => p.id === pbiId);
    // QA card lądunje w row testera (z rowYMap). Bez testera → fallback do row
    // pierwszego z `testers` lub tuż za ostatnim devem.
    const testerId = pbi?.qaTesterId ?? testers[0]?.id;
    const qaRowTopY = testerId !== undefined ? rowYMap.get(testerId) : undefined;
    const qaRowTop = qaRowTopY ?? cumY; // cumY = po wszystkich devach/testerach
    let qaX = skipNonWorkingX(rightmost.x + rightmost.width + L.PAD);
    // Clamp do sprint right edge — jak dev phases przekraczają sprint, QA i tak
    // zostaje w ramach widoku. (Kilka QA cards może się przy granicy zachodzić —
    // to wizualny sygnał "PBI nie zmieści się w sprincie".)
    if (qaX > qaMaxStartX) qaX = qaMaxStartX;
    nodes.push({
      id:       `qa-${pbiId}`,
      type:     'qa-task',
      zOrder:   10,
      position: {
        x: qaX,
        y: qaRowTop + Math.round((BASE_H - L.NODE_H) / 2),
      },
      autoSize: false,
      size:     { width: Math.max(getQaWidth(), 120), height: L.NODE_H },
      data: {
        pbiId,
        pbiTitle:   pbi?.title ?? '',
        testerName: pbi?.qaTesterName ?? '',
        color:      rightmost.parentColor,
        endDay:     rightmost.endDay,
        width:      Math.max(getQaWidth(), 120),
        height:     L.NODE_H,
      },
    });
  }

  // Separate QA nodes that landed on the same x within the same row
  const qaNodes = nodes.filter(n => n.type === 'qa-task');
  const qaByRow = new Map<number, typeof qaNodes>();
  for (const n of qaNodes) {
    const key = Math.round(n.position.y);
    if (!qaByRow.has(key)) qaByRow.set(key, []);
    qaByRow.get(key)!.push(n);
  }
  for (const row of qaByRow.values()) {
    row.sort((a, b) => a.position.x - b.position.x);
    for (let i = 1; i < row.length; i++) {
      const prev = row[i - 1];
      const curr = row[i];
      let minX = prev.position.x + getEffectiveQaWidth(prev.position.x, getQaWidth()) + L.PAD;
      if (minX > qaMaxStartX) minX = qaMaxStartX; // nigdy poza sprint right edge
      if (curr.position.x < minX) curr.position = { ...curr.position, x: minX };
    }
  }

  // Cross-PBI dependency edges (dashed blue, last phase → first phase of dependent)
  for (const pbi of sorted) {
    if (!pbi.dependsOn?.length) continue;
    const firstPhaseId = `${pbi.id}-p0`;
    for (const depId of pbi.dependsOn) {
      const depPbi = sorted.find(p => p.id === depId);
      if (!depPbi) continue;
      const lastPhaseId = `${depId}-p${depPbi.phases.length - 1}`;
      edges.push({
        id:         `dep-${lastPhaseId}-${firstPhaseId}`,
        type:       'dep',
        zOrder:     5,
        source:     lastPhaseId,
        sourcePort: 'out',
        target:     firstPhaseId,
        targetPort: 'in',
        data:       { edgeType: 'dep', pbiIds: [depId, pbi.id] },
      });
    }
  }

  // Defensywny anti-overlap sweep — KAŻDA karta (PBI + QA-task anchor) w tej
  // samej **lane** (a nie tylko w dev-row) pushowana w prawo aż brak nakładania.
  // Klucz = position.y zaokrąglony do BASE_H, bo każda lane ma deterministyczny
  // top Y = rowTopY + laneIdx × BASE_H.
  const cardsByLane = new Map<number, DiagramNode[]>();
  for (const n of nodes) {
    if (n.type !== 'pbi' && n.type !== 'qa-task') continue;
    const key = Math.round(n.position.y / BASE_H);
    if (!cardsByLane.has(key)) cardsByLane.set(key, []);
    cardsByLane.get(key)!.push(n);
  }
  for (const row of cardsByLane.values()) {
    row.sort((a, b) => a.position.x - b.position.x);
    for (let i = 1; i < row.length; i++) {
      const prev = row[i - 1];
      const curr = row[i];
      const prevBaseW = (prev.data['width'] as number) ?? (prev.size?.width as number) ?? 200;
      const prevEffW = getEffectivePbiWidth(prev.position.x, prevBaseW);
      const minX = prev.position.x + prevEffW + L.PAD;
      if (curr.position.x < minX) {
        curr.position = { ...curr.position, x: minX };
      }
    }
  }

  return { nodes, edges, assigneeMap, depsMap, lanesPerDev, rowYMap, rowHMap };
}

// ── Incoming bugs ───────────────────────────────────────────────────────────
/**
 * Build unassigned bug nodes placed in the incoming lane.
 * These are loaded separately (during daily standup) and dragged to dev lanes by the PM.
 *
 * Returns assigneeMap and depsMap instead of mutating globals.
 */
export function buildIncomingBugs(bugs: AdoPbi[] = INCOMING_BUGS_MOCK): {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  assigneeMap: Map<string, string>;
  depsMap: Map<string, string[]>;
} {
  const assigneeMap = new Map<string, string>();
  const depsMap     = new Map<string, string[]>();

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];

  const incomingY = L.HEADER_H + Math.round((L.ROW_H - L.NODE_H) / 2);
  let x = L.LABEL_W + L.PAD;

  for (const bug of bugs) {
    const phase   = bug.phases[0];
    const phaseId = `${bug.id}-p0`;
    const isHalfDay = phase.days === 0.5;
    const width   = isHalfDay
      ? Math.round(L.DAY_W / 2) - 2 * L.PAD
      : phase.days * L.DAY_W - 2 * L.PAD;

    assigneeMap.set(phaseId, 'unassigned');
    depsMap.set(phaseId, []);

    nodes.push({
      id:       phaseId,
      type:     'pbi',
      zOrder:   10,
      position: { x, y: incomingY },
      autoSize: false,
      size:     { width, height: L.NODE_H },
      data: {
        id:              phaseId,
        displayId:       bug.id,
        title:           bug.title,
        color:           bug.color,
        primaryAssignee: 'unassigned',
        collaborators:   [],
        startDay:        1,
        endDay:          phase.days,
        dependencies:    [],
        width,
        height:          L.NODE_H,
        phaseRole:       phase.role,
        isBugType:       true,
        phaseIdx:        0,
        totalPhases:     1,
      },
    });

    // Park QA node next to the bug in the incoming row
    const qaId = `qa-${bug.id}`;
    nodes.push({
      id:       qaId,
      type:     'qa-task',
      zOrder:   10,
      position: { x: x + width + L.PAD, y: incomingY },
      autoSize: false,
      size:     { width: getQaWidth(), height: L.NODE_H },
      data: {
        pbiId:  bug.id,
        color:  bug.color,
        endDay: phase.days,
        width:  getQaWidth(),
        height: L.NODE_H,
      },
    });


    edges.push({
      id:         `qa-edge-${phaseId}`,
      type:       'qa',
      zOrder:     5,
      source:     phaseId,
      sourcePort: 'qa',
      target:     qaId,
      targetPort: 'qa-in',
      data:       { edgeType: 'qa' },
    });

    // Leave space: bug card + qa card + gap
    x += width + getQaWidth() + 3 * L.PAD + 16;
  }

  return { nodes, edges, assigneeMap, depsMap };
}

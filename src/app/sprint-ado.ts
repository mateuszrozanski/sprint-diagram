import { ADO_MOCK_PBIS, CALENDAR_SLOTS, INCOMING_BUGS_MOCK, USERS, type AdoPbi, type PBI } from './sprint-data';
import type { DiagramNode, DiagramEdge } from './sprint-data';
import { L, getSprintDayOffset, getSlotXOffset, getSlotWidth, getQaWidth, getEffectiveQaWidth, getEffectivePbiWidth, nearestWorkingSprintDay, skipNonWorkingX } from './layout';
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
} {
  const testerIndex = new Map(testers.map((t, i) => [t.id, i]));
  const assigneeMap = new Map<string, string>();
  const depsMap     = new Map<string, string[]>();

  // Px-based packing per dev. Karta zajmuje TYLKO tyle px ile godzin × proporcja,
  // bez zaokrąglania do całego dnia.
  // Day 1 sprintu = planowanie + retro, devs nie pracują. Phases startują od day 2:
  // FIRST_X = LABEL_W + DAY_W.
  const FIRST_X = L.LABEL_W + L.DAY_W;
  const devCursorPx  = new Map<string, number>(users.map(u => [u.id, FIRST_X]));
  const pbiLastEndPx = new Map<string, number>();
  const phaseEndPx   = new Map<string, number>();

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
  }

  const stubs: PhaseStub[] = [];
  const stubById = new Map<string, PhaseStub>();

  for (const pbi of sorted) {
    for (let i = 0; i < pbi.phases.length; i++) {
      const phase = pbi.phases[i];
      const phaseId = `${pbi.id}-p${i}`;
      const isParallel = !!phase.parallel;

      // Intra-PBI handoff: TYLKO faza Testing czeka na inne aktywności tego PBI.
      // Devs (Development/Design/Backend/Frontend itd.) NIGDY na nic nie czekają —
      // pakowani ciasno w swoich wierszach. Cross-PBI deps wyłącznie wizualne.
      const deps = new Set<string>();
      const isTesterPhase = phase.assigneeId.startsWith('qa-');
      if (!isParallel && isTesterPhase) {
        for (let j = 0; j < i; j++) {
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
      };
      stubs.push(stub);
      stubById.set(phaseId, stub);
    }
  }

  // ── 2) List scheduling: zawsze pickuj phase ready (deps zaplanowane) ────
  // z najwcześniejszym możliwym startem. Wypełnia dziury w dev-cursors zamiast
  // sztywnego trzymania PBI-by-PBI loopa (który zostawiał Aleksandrowi 5-day
  // gap po cross-PBI zależności od kogoś innego).
  const scheduledX = new Map<string, number>();
  const scheduledEndX = new Map<string, number>();
  const pending = new Set<string>(stubs.map(s => s.id));

  while (pending.size > 0) {
    // Intra-PBI handoff JEST respektowany: Testing dla PBI X nie może startować
    // przed końcem Development X. Cross-PBI deps NIE blokują (wizualne tylko).
    // Tester czeka, ale w międzyczasie może wziąć Testing innego PBI — list
    // scheduling przepicka tę fazę, której deps są ready i start najmniejszy.
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
      const devStart = devCursorPx.get(stub.assigneeId) ?? FIRST_X;
      const start = Math.max(devStart, depEnd, FIRST_X);
      ready.push({ stub, start });
    }

    if (!ready.length) {
      // Dep cycle / orphan — bezpieczny fallback: schedule remaining w cursorze.
      console.warn('[layout] dep cycle, scheduling remaining flatly');
      for (const id of pending) {
        const stub = stubById.get(id)!;
        const dev = devCursorPx.get(stub.assigneeId) ?? FIRST_X;
        const w = widthForHours(stub.hours);
        const { placedX } = placePhase(dev, w);
        const effW = getEffectivePbiWidth(placedX, w);
        scheduledX.set(id, placedX);
        scheduledEndX.set(id, placedX + effW);
        devCursorPx.set(stub.assigneeId, placedX + effW);
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
    const { placedX } = placePhase(winner.start, w);
    // VISUAL width = baseW + weekend slots inside span. devCursor MUSI advanceować
    // o effW, inaczej następna faza wyląduje "w środku" weekendu poprzedniej karty
    // i nakłada się na nią po pobraniu.
    const effW = getEffectivePbiWidth(placedX, w);
    scheduledX.set(winner.stub.id, placedX);
    scheduledEndX.set(winner.stub.id, placedX + effW);
    devCursorPx.set(winner.stub.assigneeId, placedX + effW);
    pending.delete(winner.stub.id);
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
    const rowIdxForY = isQaPhase
      ? users.length + 1 + (testerSubIdx as number)
      : (userIdx + 1);

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

    nodes.push({
      id:       pl.id,
      type:     'pbi',
      zOrder:   10,
      position: {
        x: pl.x,
        y: L.HEADER_H + rowIdxForY * L.ROW_H + Math.round((L.ROW_H - L.NODE_H) / 2),
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
        state:           parentPbi?.state,
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
    const testerSubRow = pbi?.qaTesterId
      ? (testerIndex.get(pbi.qaTesterId) ?? 0)
      : 0;
    const qaRowIndex = users.length + 1 + testerSubRow;
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
        y: L.HEADER_H + qaRowIndex * L.ROW_H + Math.round((L.ROW_H - L.NODE_H) / 2),
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

  // Defensywny anti-overlap sweep — KAŻDA karta (PBI + QA-task anchor) w tym
  // samym wierszu pushowana w prawo aż brak nakładania. effW uwzględnia weekend
  // extension. NACZELNA REGUŁA: żadna karta nie nakłada się na inną.
  const cardsByRow = new Map<number, DiagramNode[]>();
  for (const n of nodes) {
    if (n.type !== 'pbi' && n.type !== 'qa-task') continue;
    const key = Math.round(n.position.y / L.ROW_H);
    if (!cardsByRow.has(key)) cardsByRow.set(key, []);
    cardsByRow.get(key)!.push(n);
  }
  for (const row of cardsByRow.values()) {
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

  return { nodes, edges, assigneeMap, depsMap };
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

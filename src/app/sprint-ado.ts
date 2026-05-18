import { ADO_MOCK_PBIS, CALENDAR_SLOTS, INCOMING_BUGS_MOCK, USERS, type AdoPbi, type PBI } from './sprint-data';
import type { DiagramNode, DiagramEdge } from './sprint-data';
import { L, getSprintDayOffset, getQaWidth, getEffectiveQaWidth, nearestWorkingSprintDay, skipNonWorkingX } from './layout';
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
  // bez zaokrąglania do całego dnia. 4h = 240px (~70% kolumny), 7h = 420px (~1.25
  // kolumny). Wymiar zgodny z `widthForHours()`.
  const FIRST_X = L.LABEL_W + L.PAD;
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

  for (const pbi of sorted) {
    // Cross-PBI constraint: faza zacznie się dopiero po końcu wszystkich zależnych PBI.
    const dependsOnEndPx = (pbi.dependsOn ?? []).reduce((max, depId) =>
      Math.max(max, pbiLastEndPx.get(depId) ?? 0), 0
    );

    let prevSeqEndPx = dependsOnEndPx; // tylko sequential phases podbijają tę wartość

    for (let i = 0; i < pbi.phases.length; i++) {
      const phase      = pbi.phases[i];
      const phaseId    = `${pbi.id}-p${i}`;
      const assignee   = phase.assigneeId;
      const isHalfDay  = phase.days === 0.5;
      const isParallel = !!phase.parallel;

      const w = widthForHours(phase.hours);

      const devCursor  = devCursorPx.get(assignee) ?? FIRST_X;
      const chainStart = isParallel ? FIRST_X : (prevSeqEndPx > 0 ? prevSeqEndPx + L.PAD : FIRST_X);
      let x = Math.max(devCursor, chainStart);
      // Jeśli x trafia w weekend/holiday, przeskocz do najbliższego working dnia.
      x = skipNonWorkingX(x);

      const endX = x + w;

      devCursorPx.set(assignee, endX + L.PAD);
      if (!isParallel) prevSeqEndPx = endX;
      phaseEndPx.set(phaseId, endX);

      // Display-only sprintDay (na podstawie kolumny w której wypada x).
      const startDay = nearestWorkingSprintDay(x - L.LABEL_W);
      const endDay   = nearestWorkingSprintDay(endX - L.LABEL_W - 1);

      assigneeMap.set(phaseId, assignee);

      // Parallel phases have no handoff dep; sequential phases chain normally
      const deps: string[] = [];
      if (!isParallel) {
        if (i > 0) {
          deps.push(`${pbi.id}-p${i - 1}`);
        } else if (pbi.dependsOn?.length) {
          for (const depId of pbi.dependsOn) {
            const depPbi = sorted.find(p => p.id === depId);
            if (depPbi) deps.push(`${depId}-p${depPbi.phases.length - 1}`);
          }
        }
      }
      depsMap.set(phaseId, deps);

      allPhases.push({
        id:          phaseId,
        parentId:    pbi.id,
        parentColor: pbi.color,
        parentType:  pbi.type,
        title:       phase.title ?? pbi.title,
        parentTitle: phase.title ? pbi.title : undefined,
        role:        phase.role,
        assigneeId:  assignee,
        startDay,
        endDay,
        phaseIdx:    i,
        totalPhases: pbi.phases.length,
        isHalfDay,
        isParallel,
        x,
        width:       w,
      });
    }

    // pbiLastEndPx = najbardziej-w-prawo koniec dowolnej fazy PBI (incl. parallel)
    const pbiPhases = allPhases.filter(p => p.parentId === pbi.id);
    pbiLastEndPx.set(pbi.id, Math.max(...pbiPhases.map(p => p.x + p.width)));
  }

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];

  for (const pl of allPhases) {
    const userIdx = users.findIndex(u => u.id === pl.assigneeId);

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

    nodes.push({
      id:       pl.id,
      type:     'pbi',
      zOrder:   10,
      // Px-pack layout — pozycja przepisana z PhaseLayout.x (cursor px per dev).
      position: {
        x: pl.x,
        y: L.HEADER_H + (userIdx + 1) * L.ROW_H + Math.round((L.ROW_H - L.NODE_H) / 2),
      },
      data: {
        ...pbiObj,
        width:       pl.width,
        height:      L.NODE_H,
        displayId:   pl.parentId,
        parentTitle: pl.parentTitle,
        phaseRole:   pl.role,
        phaseHours:  phaseHours,
        isBugType:   pl.parentType === 'Bug',
        phaseIdx:    pl.phaseIdx,
        totalPhases: pl.totalPhases,
        state:       parentPbi?.state,
        // hasComment: dynamicznie podpinamy z app.component przez updateNodes po loadComments
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
      data:       { edgeType: 'qa' },
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
        data:       { edgeType: 'handoff', color: pl.parentColor },
      });
    }
  }

  // One QA node per PBI, positioned at the rightmost phase
  const pbiGroups = new Map<string, PhaseLayout[]>();
  for (const pl of allPhases) {
    if (!pbiGroups.has(pl.parentId)) pbiGroups.set(pl.parentId, []);
    pbiGroups.get(pl.parentId)!.push(pl);
  }

  for (const [pbiId, phases] of pbiGroups) {
    // Najbardziej-w-prawo faza (px-based) — QA card siada tuż za nią.
    const rightmost = phases.reduce((best, p) => (p.x + p.width) > (best.x + best.width) ? p : best);
    const pbi = items.find(p => p.id === pbiId);
    const testerSubRow = pbi?.qaTesterId
      ? (testerIndex.get(pbi.qaTesterId) ?? 0)
      : 0;
    const qaRowIndex = users.length + 1 + testerSubRow;
    const qaX = skipNonWorkingX(rightmost.x + rightmost.width + L.PAD);
    nodes.push({
      id:       `qa-${pbiId}`,
      type:     'qa-task',
      zOrder:   10,
      position: {
        x: qaX,
        y: L.HEADER_H + qaRowIndex * L.ROW_H + Math.round((L.ROW_H - L.NODE_H) / 2),
      },
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
      const minX = prev.position.x + getEffectiveQaWidth(prev.position.x, getQaWidth()) + L.PAD;
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
        data:       { edgeType: 'dep' },
      });
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

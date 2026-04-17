import type { DiagramNode, NodeUpdate } from './sprint-data';
import { L, getEffectivePbiWidth, getEffectiveQaWidth, getQaWidth, skipNonWorkingX } from './layout';

/** Developer row index (0…users.length-1) for a phase node; -1 if unassigned. */
function getRowIndex(
  nodeId: string,
  liveAssignee: ReadonlyMap<string, string>,
  users: { id: string }[],
): number {
  return users.findIndex(u => u.id === liveAssignee.get(nodeId));
}

// ── BFS helpers ────────────────────────────────────────────────────────────

/** Returns all phase IDs that (transitively) depend on any of sourceIds. */
export function transitiveDependents(
  sourceIds: string[],
  liveDeps: ReadonlyMap<string, string[]>,
): Set<string> {
  const result  = new Set<string>();
  const visited = new Set(sourceIds);
  const queue   = [...sourceIds];
  while (queue.length) {
    const id = queue.shift()!;
    for (const [nodeId, deps] of liveDeps) {
      if (deps.includes(id) && !visited.has(nodeId)) {
        visited.add(nodeId);
        result.add(nodeId);
        queue.push(nodeId);
      }
    }
  }
  return result;
}

// ── QA helpers ────────────────────────────────────────────────────────────

/**
 * For every PBI touched by `updates`, reposition its QA node (qa-{pbiId})
 * flush to the rightmost phase of that PBI across the whole diagram.
 */
export function syncQaNodes(
  updates: NodeUpdate[],
  allNodes: DiagramNode[],
  getById: (id: string) => DiagramNode | null,
): void {
  // Build live position map: model positions overridden by pending updates
  const posMap = new Map<string, { x: number; width: number }>();
  for (const n of allNodes) {
    if (n.type !== 'pbi') continue;
    posMap.set(n.id, { x: n.position.x, width: n.data['width'] as number });
  }
  for (const u of updates) {
    const p = posMap.get(u.id);
    if (!p) continue;
    if (u.position?.x !== undefined) p.x = u.position.x;
    if (u.data?.['width'] !== undefined) p.width = u.data['width'] as number;
  }

  // Find which pbiIds have a phase touched by updates
  const touchedPbiIds = new Set<string>();
  for (const u of updates) {
    if (!u.position && !u.data?.['width']) continue;
    const n = getById(u.id);
    if (n?.type === 'pbi') touchedPbiIds.add(n.data['displayId'] as string);
  }

  // For each touched pbiId, find rightmost phase and reposition its QA node
  for (const pbiId of touchedPbiIds) {
    if (!pbiId) continue;
    const qaId   = `qa-${pbiId}`;
    const qaNode = getById(qaId);
    if (!qaNode) continue;

    let maxRight = -Infinity;
    for (const n of allNodes) {
      if (n.type !== 'pbi' || n.data['displayId'] !== pbiId) continue;
      const p = posMap.get(n.id);
      if (!p) continue;
      maxRight = Math.max(maxRight, p.x + p.width);
    }
    if (maxRight === -Infinity) continue;

    const newQaX = skipNonWorkingX(maxRight + L.PAD);
    const ui = updates.findIndex(u => u.id === qaId);
    if (ui >= 0) updates[ui].position!.x = newQaX;
    else         updates.push({ id: qaId, position: { x: newQaX, y: qaNode.position.y } });
  }
}

/**
 * Push QA nodes apart if any overlap within the same row (same Y bucket).
 * Reads current positions from allNodes then applies pending updates on top.
 */
export function resolveQaCollisions(
  updates: NodeUpdate[],
  allNodes: DiagramNode[],
): void {
  const posMap = new Map<string, { x: number; y: number }>();
  for (const n of allNodes) {
    if (n.type === 'qa-task') posMap.set(n.id, { x: n.position.x, y: n.position.y });
  }
  for (const u of updates) {
    if (posMap.has(u.id) && u.position) posMap.set(u.id, { ...posMap.get(u.id)!, ...u.position });
  }

  const baseQaW = getQaWidth();
  const byRow = new Map<number, [string, { x: number; y: number }][]>();
  for (const [id, pos] of posMap) {
    const rowKey = Math.round(pos.y / L.ROW_H);
    if (!byRow.has(rowKey)) byRow.set(rowKey, []);
    byRow.get(rowKey)!.push([id, pos]);
  }

  for (const rowNodes of byRow.values()) {
    rowNodes.sort((a, b) => a[1].x - b[1].x);
    for (let i = 1; i < rowNodes.length; i++) {
      const [, prev]       = rowNodes[i - 1];
      const [currId, curr] = rowNodes[i];
      const minX = prev.x + getEffectiveQaWidth(prev.x, baseQaW) + L.PAD;
      if (curr.x < minX) {
        rowNodes[i] = [currId, { ...curr, x: minX }];
        const ui = updates.findIndex(u => u.id === currId);
        if (ui >= 0) updates[ui].position!.x = minX;
        else         updates.push({ id: currId, position: { x: minX, y: curr.y } });
      }
    }
  }
}

// ── Collision resolution ───────────────────────────────────────────────────

interface Pos { x: number; baseW: number; effW: number; y: number; rowIdx: number }

/**
 * After computing intended moves in `updates`, scan every developer row
 * left-to-right and push any overlapping nodes to the right.
 * When a node is pushed, its transitive dependents move by the same delta.
 *
 * @param updates       Pending position/data changes (mutated in place).
 * @param allNodes      Snapshot of modelService.nodes().
 * @param getById       modelService.getNodeById.
 * @param liveAssignee  Current assignee map.
 * @param liveDeps      Current dependency map.
 * @param users         Current user list (determines row count and index).
 */
export function resolveCollisions(
  updates: NodeUpdate[],
  allNodes: DiagramNode[],
  getById: (id: string) => DiagramNode | null,
  liveAssignee: ReadonlyMap<string, string>,
  liveDeps: ReadonlyMap<string, string[]>,
  users: { id: string }[],
): void {
  // ── Build position map (model + pending overrides) ──────────────────────
  const posMap = new Map<string, Pos>();

  for (const n of allNodes) {
    if (n.type !== 'pbi') continue;
    const ri = getRowIndex(n.id, liveAssignee, users);
    if (ri < 0) continue;
    const baseW = n.data['width'] as number;
    posMap.set(n.id, {
      x:      n.position.x,
      baseW,
      effW:   getEffectivePbiWidth(n.position.x, baseW),
      y:      n.position.y,
      rowIdx: ri,
    });
  }

  for (const u of updates) {
    const p = posMap.get(u.id);
    if (!p) continue;
    if (u.position?.x !== undefined) {
      p.x    = u.position.x;
      p.effW = getEffectivePbiWidth(p.x, p.baseW);
    }
    if (u.data?.['width'] !== undefined) {
      p.baseW = u.data['width'] as number;
      p.effW  = getEffectivePbiWidth(p.x, p.baseW);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  const upsert = (id: string, x: number, y: number) => {
    const i = updates.findIndex(u => u.id === id);
    if (i >= 0) updates[i].position = { x, y: updates[i].position?.y ?? y };
    else        updates.push({ id, position: { x, y } });
  };

  const upsertQa = (pbiId: string, delta: number) => {
    const qaId = `qa-${pbiId}`;
    const qa   = getById(qaId);
    if (!qa) return;
    const i    = updates.findIndex(u => u.id === qaId);
    const base = i >= 0 ? updates[i].position?.x ?? qa.position.x : qa.position.x;
    if (i >= 0) updates[i].position = { x: base + delta, y: updates[i].position?.y ?? qa.position.y };
    else        updates.push({ id: qaId, position: { x: base + delta, y: qa.position.y } });
  };

  // ── Per-row left-to-right sweep ─────────────────────────────────────────
  for (let row = 0; row < users.length; row++) {
    const nodes = [...posMap.entries()]
      .filter(([, p]) => p.rowIdx === row)
      .sort((a, b) => a[1].x - b[1].x);

    for (let i = 1; i < nodes.length; i++) {
      const [, prev]       = nodes[i - 1];
      const [currId, curr] = nodes[i];
      const minX = prev.x + prev.effW + L.PAD;
      if (curr.x >= minX) continue;

      const delta  = minX - curr.x;
      const toPush = new Set([currId, ...transitiveDependents([currId], liveDeps)]);

      for (const pid of toPush) {
        const pp = posMap.get(pid);
        if (!pp) continue;
        pp.x    += delta;
        pp.effW  = getEffectivePbiWidth(pp.x, pp.baseW);
        upsert(pid, pp.x, pp.y);
        upsertQa(pid, delta);
      }

      curr.x    = minX;
      curr.effW = getEffectivePbiWidth(minX, curr.baseW);
    }
  }
}

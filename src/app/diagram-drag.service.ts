import { Injectable, inject } from '@angular/core';
import { NgDiagramModelService } from 'ng-diagram';
import type { DiagramNode, NodeUpdate } from './sprint-data';
import { L, getEffectivePbiWidth } from './layout';
import { transitiveDependents, syncQaNodes, resolveQaCollisions } from './sprint-utils';
import { SprintService } from './sprint.service';
import { SprintDataStoreService } from './sprint-data-store.service';

type DragNode = { id: string; type?: string; position: { x: number; y: number } };

/**
 * Encapsulates all drag-related state and logic for the sprint diagram.
 * Must be provided at the AppComponent level (same injector as provideNgDiagram()).
 */
@Injectable()
export class DiagramDragService {
  private readonly modelService = inject(NgDiagramModelService);
  private readonly sprint       = inject(SprintService);
  private readonly dataStore    = inject(SprintDataStoreService);

  private dragOrigins   = new Map<string, { x: number; y: number }>();
  private activeDragIds: string[] = [];
  private cascadeIds    = new Set<string>();

  /**
   * Set to true during programmatic model updates to suppress re-entrant
   * selectionMoved events emitted by ng-diagram.
   */
  updating = false;

  /** Live preview podczas drag — pokazuje ile dni przesunięcia. */
  dragPreview = { active: false, dx: 0, cascadingCount: 0, draggedTitle: '' };

  private allNodes()           { return this.modelService.nodes() as DiagramNode[]; }
  private nodeById(id: string) { return this.modelService.getNodeById(id) as DiagramNode | null; }

  /**
   * Single-card drag drop INTO another card's bounds w tym samym wierszu →
   * swap pozycji (PBI reorder bez konieczności dwóch dragów).
   * Detekcja: center dragged karty mieści się w bounds static-a.
   */
  private tryDropSwap(
    dragged: DragNode,
    updates: NodeUpdate[],
    allNodes: DiagramNode[],
    draggedIds: ReadonlySet<string>,
  ): void {
    const draggedNode = this.nodeById(dragged.id);
    if (!draggedNode) return;
    const draggedUpdate = updates.find(u => u.id === dragged.id);
    const dX = draggedUpdate?.position?.x ?? dragged.position.x;
    const dY = draggedUpdate?.position?.y ?? dragged.position.y;
    const dW = (draggedUpdate?.size?.width
              ?? draggedUpdate?.data?.['width'] as number
              ?? draggedNode.data['width'] as number) ?? 200;
    const centerX = dX + dW / 2;
    const rowKey = Math.round(dY / L.ROW_H);

    let target: DiagramNode | null = null;
    for (const n of allNodes) {
      if (n.type !== 'pbi' || draggedIds.has(n.id)) continue;
      const nRowKey = Math.round(n.position.y / L.ROW_H);
      if (nRowKey !== rowKey) continue;
      const w = (n.data['width'] as number) ?? 200;
      if (centerX >= n.position.x && centerX <= n.position.x + w) {
        target = n;
        break;
      }
    }
    if (!target) return;

    // Swap: dragged ↔ target.
    const origin = this.dragOrigins.get(dragged.id);
    if (!origin) return;
    if (draggedUpdate) {
      draggedUpdate.position = { x: target.position.x, y: target.position.y };
    } else {
      updates.push({ id: dragged.id, position: { x: target.position.x, y: target.position.y } });
    }
    updates.push({ id: target.id, position: { x: origin.x, y: origin.y } });
  }

  /**
   * Anti-overlap dla dragged cards z TEMPORALNYM kierunkiem:
   * - Static card która ORYGINALNIE była PO dragged (origin.x większe) jest
   *   pushowana w prawo gdy dragged na nią nachodzi.
   * - Static card która oryginalnie była PRZED dragged zostaje na miejscu —
   *   user celowo przesunął późniejszą kartę i nie chce ruszać wcześniejszych.
   * Push może kaskadować (s pushed → kolejne staticy z większymi origin też mogą
   * być pushowane).
   */
  private pushDraggedOutOfStatic(
    updates: NodeUpdate[],
    allNodes: DiagramNode[],
    draggedIds: ReadonlySet<string>,
  ): void {
    // baseW = data.width (proporcjonalne do godzin). effW = po doliczeniu weekend
    // slotów w span (renderowana szerokość). Overlap check używa effW żeby karta
    // przechodząca przez weekend nie nachodziła na sąsiada.
    type Pos = { x: number; y: number; baseW: number; effW: number; isDragged: boolean; originX: number };
    const posMap = new Map<string, Pos>();
    for (const n of allNodes) {
      if (n.type !== 'pbi') continue;
      const origin = this.dragOrigins.get(n.id);
      const baseW = (n.data['width'] as number) ?? 200;
      posMap.set(n.id, {
        x: n.position.x,
        y: n.position.y,
        baseW,
        effW: getEffectivePbiWidth(n.position.x, baseW),
        isDragged: draggedIds.has(n.id),
        originX: origin?.x ?? n.position.x,
      });
    }
    for (const u of updates) {
      const p = posMap.get(u.id);
      if (!p) continue;
      if (u.position?.x !== undefined) p.x = u.position.x;
      if (u.position?.y !== undefined) p.y = u.position.y;
      if (u.size?.width !== undefined) p.baseW = u.size.width;
      if (u.data?.['width'] !== undefined) p.baseW = u.data['width'] as number;
      p.effW = getEffectivePbiWidth(p.x, p.baseW);
    }
    const byRow = new Map<number, [string, Pos][]>();
    for (const [id, p] of posMap) {
      const rowKey = Math.round(p.y / L.ROW_H);
      if (!byRow.has(rowKey)) byRow.set(rowKey, []);
      byRow.get(rowKey)!.push([id, p]);
    }
    const writeUpdate = (id: string, p: Pos) => {
      const u = updates.find(uu => uu.id === id);
      if (u) {
        if (u.position) u.position = { ...u.position, x: p.x };
        else            u.position = { x: p.x, y: p.y };
      } else {
        updates.push({ id, position: { x: p.x, y: p.y } });
      }
    };
    const pushB = (bId: string, b: Pos, aEnd: number) => {
      b.x = aEnd + L.PAD;
      b.effW = getEffectivePbiWidth(b.x, b.baseW);
      writeUpdate(bId, b);
    };
    for (const row of byRow.values()) {
      let globalChanged = true;
      let safety = 0;
      while (globalChanged && safety++ < 100) {
        globalChanged = false;
        row.sort((a, b) => a[1].x - b[1].x);
        for (let i = 0; i < row.length - 1; i++) {
          const [, a] = row[i];
          const [bId, b] = row[i + 1];
          const aEnd = a.x + a.effW; // używamy effW, żeby weekend slots wewnątrz span'a były wliczone
          if (aEnd + L.PAD <= b.x) continue;
          if (b.isDragged && !a.isDragged) {
            pushB(bId, b, aEnd); globalChanged = true;
          } else if (!b.isDragged && a.isDragged) {
            if (b.originX >= a.originX) { pushB(bId, b, aEnd); globalChanged = true; }
          } else if (a.isDragged && b.isDragged) {
            pushB(bId, b, aEnd); globalChanged = true;
          } else {
            if (b.originX >= a.originX) { pushB(bId, b, aEnd); globalChanged = true; }
          }
        }
      }
    }
  }

  /** liveDeps przefiltrowane do tylko intra-PBI handoff-ów (Development → Testing).
   *  Cross-PBI deps są pomijane — wizualne tylko, nie cascadują w drag/resize. */
  private intraPbiDeps(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [phaseId, deps] of this.sprint.liveDeps) {
      const phasePbi = this.nodeById(phaseId)?.data?.['displayId'] as string | undefined;
      if (!phasePbi) continue;
      const intra = deps.filter(d => {
        const depPbi = this.nodeById(d)?.data?.['displayId'] as string | undefined;
        return depPbi === phasePbi;
      });
      if (intra.length) out.set(phaseId, intra);
    }
    return out;
  }
  private users()              { return this.dataStore.users(); }

  // ── 1. Drag started ────────────────────────────────────────────────────────

  onDragStarted(event: { nodes: DragNode[] }): void {
    this.dragOrigins.clear();
    for (const n of this.allNodes()) {
      if (n.type === 'pbi' || n.type === 'qa-task') {
        this.dragOrigins.set(n.id, { x: n.position.x, y: n.position.y });
      }
    }
    this.activeDragIds = event.nodes.filter(n => n.type === 'pbi').map(n => n.id);
    // Drag-cascade ograniczamy do tego samego PBI (handoff: Development → Testing).
    // Cross-PBI deps NIE pociągają niczego — user explicitly drag-uje konkretną
    // kartę i nie chce ruszać niezależnych prac innych devów.
    const draggedPbiIds = new Set(
      this.activeDragIds
        .map(id => this.nodeById(id)?.data?.['displayId'] as string | undefined)
        .filter((v): v is string => !!v),
    );
    const allCascade = transitiveDependents(this.activeDragIds, this.sprint.liveDeps);
    this.cascadeIds = new Set(
      [...allCascade].filter(id => {
        const dispId = this.nodeById(id)?.data?.['displayId'] as string | undefined;
        return dispId !== undefined && draggedPbiIds.has(dispId);
      }),
    );

    const draggedFirst = event.nodes.find(n => n.type === 'pbi');
    const draggedNode  = draggedFirst ? this.nodeById(draggedFirst.id) : null;
    this.dragPreview = {
      active: true,
      dx: 0,
      cascadingCount: this.cascadeIds.size,
      draggedTitle: (draggedNode?.data?.['title'] as string) ?? draggedFirst?.id ?? '',
    };
  }

  // ── 2. During drag: cascade dx to dependents ───────────────────────────────
  //    No collision resolution here — that would block leftward movement.

  onSelectionMoved(event: { nodes: DragNode[] }): void {
    if (this.updating) return;

    const movedPbis = event.nodes.filter(n => n.type === 'pbi' && this.activeDragIds.includes(n.id));
    if (movedPbis.length === 0) return;

    const origin = this.dragOrigins.get(movedPbis[0].id);
    if (!origin) return;

    const dx = movedPbis[0].position.x - origin.x;
    if (dx === 0) return;
    this.dragPreview.dx = dx;

    const updates: NodeUpdate[] = [];
    const movedQaIds = new Set<string>();

    // QA nodes of dragged PBIs follow their card
    for (const n of movedPbis) {
      if (this.sprint.liveAssignee.get(n.id) === 'unassigned') continue;
      const pbiId = this.nodeById(n.id)?.data?.['displayId'] as string ?? n.id;
      const qaId  = `qa-${pbiId}`;
      if (movedQaIds.has(qaId)) continue;
      movedQaIds.add(qaId);
      const qaOrigin = this.dragOrigins.get(qaId);
      if (qaOrigin) updates.push({ id: qaId, position: { x: qaOrigin.x + dx, y: qaOrigin.y } });
    }

    // QA tasks linked via manually drawn qa edges
    for (const n of movedPbis) {
      const qaId = this.sprint.liveQaLinks.get(n.id);
      if (!qaId || movedQaIds.has(qaId)) continue;
      movedQaIds.add(qaId);
      const qaOrigin = this.dragOrigins.get(qaId);
      if (qaOrigin) updates.push({ id: qaId, position: { x: qaOrigin.x + dx, y: qaOrigin.y } });
    }

    // Cascade dx to all downstream phases
    for (const depId of this.cascadeIds) {
      const depOrigin = this.dragOrigins.get(depId);
      if (!depOrigin) continue;
      updates.push({ id: depId, position: { x: depOrigin.x + dx, y: this.rowSnapY(this.rowIndexOf(depId)) } });

      const depPbiId = this.nodeById(depId)?.data?.['displayId'] as string ?? depId;
      const qaId     = `qa-${depPbiId}`;
      if (movedQaIds.has(qaId)) continue;
      movedQaIds.add(qaId);
      const qaOrigin = this.dragOrigins.get(qaId);
      if (qaOrigin) updates.push({ id: qaId, position: { x: qaOrigin.x + dx, y: qaOrigin.y } });
    }

    if (updates.length > 0) {
      this.updating = true;
      this.modelService.updateNodes(updates);
      this.updating = false;
    }
  }

  // ── 3. Drag ended: snap, reassign, or assign incoming bug ─────────────────

  onDragEnded(event: { nodes: DragNode[] }): void {
    const updates: NodeUpdate[] = [];

    for (const node of event.nodes) {
      if (node.type !== 'pbi') continue;
      const currentNode = this.nodeById(node.id);
      if (!currentNode) continue;

      if (this.sprint.liveAssignee.get(node.id) === 'unassigned') {
        this.handleIncomingBugDrop(node, currentNode, updates);
      } else {
        this.handleRegularPbiDrop(node, currentNode, updates);
      }
    }

    // Clamp dragged QA nodes: cannot start before last phase of its PBI ends
    for (const node of event.nodes) {
      if (node.type !== 'qa-task') continue;
      const pbiId   = node.id.replace(/^qa-/, '');
      let   phases  = this.allNodes().filter(n => n.type === 'pbi' && (n.data?.['displayId'] as string) === pbiId);
      if (!phases.length) {
        for (const [pId, qId] of this.sprint.liveQaLinks) {
          if (qId === node.id) { const p = this.nodeById(pId); if (p) phases = [p]; break; }
        }
      }
      if (!phases.length) continue;
      const minX    = Math.max(...phases.map(n => n.position.x + (n.data?.['width'] as number ?? 0))) + L.PAD;
      const current = updates.find(u => u.id === node.id);
      const currentX = current?.position?.x ?? node.position.x;
      if (currentX < minX) {
        if (current) current.position!.x = minX;
        else         updates.push({ id: node.id, position: { x: minX, y: node.position.y } });
      }
    }

    const allNodes = this.allNodes();
    const getById  = (id: string) => this.nodeById(id);

    const primaryDragged = event.nodes.filter(n => n.type === 'pbi');
    const draggedIds = new Set<string>([
      ...primaryDragged.map(n => n.id),
      ...this.cascadeIds,
    ]);

    // Swap intent: pojedyncza dragged karta (no cascade), drop CENTER nad środkiem
    // static karty w tym samym wierszu → swap pozycji zamiast push. Ułatwia reorder
    // PBI na swimlane bez ręcznego dwukrotnego dragu.
    if (primaryDragged.length === 1 && this.cascadeIds.size === 0) {
      this.tryDropSwap(primaryDragged[0], updates, allNodes, draggedIds);
    }

    this.pushDraggedOutOfStatic(updates, allNodes, draggedIds);

    syncQaNodes(updates, allNodes, getById);
    resolveQaCollisions(updates, allNodes);

    if (updates.length > 0) {
      this.updating = true;
      this.modelService.updateNodes(updates);
      this.updating = false;
    }
    this.dragPreview = { active: false, dx: 0, cascadingCount: 0, draggedTitle: '' };
  }

  // ── Undo ──────────────────────────────────────────────────────────────────

  undoAssignment(): void {
    const snapshot = this.sprint.consumeUndoSnapshot();
    if (!snapshot) return;
    this.sprint.liveAssignee.set(snapshot.bugPhaseId, 'unassigned');
    this.updating = true;
    this.modelService.updateNodes(snapshot.nodes);
    this.updating = false;
  }

  // ── Private: drop handlers ────────────────────────────────────────────────

  private handleIncomingBugDrop(
    node: DragNode,
    currentNode: DiagramNode,
    updates: NodeUpdate[],
  ): void {
    const centerY = node.position.y + L.NODE_H / 2;
    // Multi-lane aware lookup zamiast floor((y-H)/ROW_H) — devIdx bywał błędny
    // dla devów poniżej kogoś z parallel lanes.
    const devIdx  = centerY < L.HEADER_H + L.ROW_H ? -1 : this.yToRowIndex(centerY);

    if (devIdx >= 0 && devIdx < this.users().length) {
      const newAssignee = this.users()[devIdx].id;
      const bugWidth    = currentNode.data['width'] as number;

      this.snapshotForUndo(node.id, devIdx, node.position.x, bugWidth);
      this.sprint.liveAssignee.set(node.id, newAssignee);
      updates.push({
        id:       node.id,
        position: { x: node.position.x, y: this.rowSnapY(devIdx) },
        data:     { ...currentNode.data, primaryAssignee: newAssignee },
      });
      this.pushOverlappingPbis(node.id, node.position.x, bugWidth, devIdx, updates);
      this.placeBugQa(node.id, node.position.x, bugWidth, updates);
    } else {
      // Snapped back to incoming row
      updates.push({
        id:       node.id,
        position: { x: node.position.x, y: L.HEADER_H + Math.round((L.ROW_H - L.NODE_H) / 2) },
      });
    }
  }

  private handleRegularPbiDrop(
    node: DragNode,
    currentNode: DiagramNode,
    updates: NodeUpdate[],
  ): void {
    const centerY = node.position.y + L.NODE_H / 2;

    // Row 0 = incoming (BASE_H wysoka, zaczyna się na HEADER_H) → park bez assignee.
    if (centerY < L.HEADER_H + L.ROW_H) {
      this.sprint.liveAssignee.set(node.id, 'unassigned');
      const incomingY = L.HEADER_H + Math.round((L.ROW_H - L.NODE_H) / 2);
      updates.push({
        id:       node.id,
        position: { x: node.position.x, y: incomingY },
        data:     { ...currentNode.data, primaryAssignee: 'unassigned', collaborators: [] },
      });
      return;
    }

    const targetRow  = this.yToRowIndex(centerY);
    const currentRow = this.rowIndexOf(node.id);
    const snapY      = this.rowSnapY(targetRow);

    if (targetRow !== currentRow) {
      const newAssignee = this.users()[targetRow]?.id;
      if (newAssignee) {
        this.sprint.liveAssignee.set(node.id, newAssignee);
        updates.push({
          id:       node.id,
          position: { x: node.position.x, y: snapY },
          data:     { ...currentNode.data, primaryAssignee: newAssignee, collaborators: [] },
        });
        return;
      }
    }
    updates.push({ id: node.id, position: { x: node.position.x, y: snapY } });
  }

  // ── Private: helpers ──────────────────────────────────────────────────────

  private snapshotForUndo(bugPhaseId: string, devIdx: number, bugX: number, bugWidth: number): void {
    const targetAssignee = this.users()[devIdx].id;
    const bugRight       = bugX + bugWidth;

    const ids = new Set<string>([bugPhaseId]);
    for (const n of this.allNodes()) {
      if (n.type !== 'pbi' || n.id === bugPhaseId) continue;
      if (this.sprint.liveAssignee.get(n.id) !== targetAssignee) continue;
      const nw = n.data['width'] as number;
      if (n.position.x < bugRight && n.position.x + nw > bugX) {
        ids.add(n.id);
        for (const dep of transitiveDependents([n.id], this.sprint.liveDeps)) ids.add(dep);
      }
    }

    const snapshotNodes: NodeUpdate[] = [];
    const snapshotQaIds = new Set<string>();
    for (const id of ids) {
      const n = this.nodeById(id);
      if (n) snapshotNodes.push({ id, position: { ...n.position }, data: n.data ? { ...n.data } : undefined });
      const qaId = `qa-${n?.data?.['displayId'] as string ?? id}`;
      if (!snapshotQaIds.has(qaId)) {
        const qa = this.nodeById(qaId);
        if (qa) { snapshotNodes.push({ id: qaId, position: { ...qa.position } }); snapshotQaIds.add(qaId); }
      }
    }

    const displayId = this.nodeById(bugPhaseId)?.data?.['displayId'] as string ?? bugPhaseId;
    this.sprint.saveUndoSnapshot({ bugPhaseId, label: displayId, nodes: snapshotNodes });
  }

  private pushOverlappingPbis(
    bugId: string, bugX: number, bugWidth: number, devIdx: number, updates: NodeUpdate[],
  ): void {
    const targetAssignee = this.users()[devIdx].id;
    const bugRight       = bugX + bugWidth;
    let maxDx = 0;
    const overlapping: string[] = [];

    for (const n of this.allNodes()) {
      if (n.type !== 'pbi' || n.id === bugId) continue;
      if (this.sprint.liveAssignee.get(n.id) !== targetAssignee) continue;
      const nw = n.data['width'] as number;
      if (n.position.x < bugRight && n.position.x + nw > bugX) {
        overlapping.push(n.id);
        maxDx = Math.max(maxDx, bugRight + L.PAD - n.position.x);
      }
    }

    if (maxDx <= 0) return;

    for (const phaseId of new Set([...overlapping, ...transitiveDependents(overlapping, this.sprint.liveDeps)])) {
      const n = this.nodeById(phaseId);
      if (!n) continue;
      updates.push({ id: phaseId, position: { x: n.position.x + maxDx, y: n.position.y } });
    }
  }

  private placeBugQa(bugId: string, bugX: number, _bugWidth: number, updates: NodeUpdate[]): void {
    const bugNode = this.nodeById(bugId);
    if (!bugNode) return;
    const qaId   = `qa-${bugNode.data['displayId'] as string}`;
    const qaNode = this.nodeById(qaId);
    if (!qaNode) return;
    // QA row top z rowYMap (pierwszy tester); brak testerów → po wszystkich devach.
    const rowY = this.sprint.rowYMap();
    let qaTop: number | undefined;
    for (const [uid, y] of rowY) {
      if (uid.startsWith('qa-')) { qaTop = y; break; }
    }
    const qaY = (qaTop ?? L.HEADER_H + (this.users().length + 1) * L.ROW_H)
      + Math.round((L.ROW_H - L.NODE_H) / 2);
    updates.push({ id: qaId, position: { x: bugX + (bugNode.data['width'] as number), y: qaY } });
  }

  private yToRowIndex(y: number): number {
    // Z multi-lane per dev wysokości row są zmienne — szukamy po `rowYMap` /
    // `rowHMap` zamiast floor((y-H)/ROW_H), bo ten ostatni przy 3-lane Aleksandra
    // zwracał błędny devIdx dla każdego deva poniżej.
    const users = this.users();
    const rowY = this.sprint.rowYMap();
    const rowH = this.sprint.rowHMap();
    for (let i = 0; i < users.length; i++) {
      const uid = users[i].id;
      const top = rowY.get(uid);
      if (top === undefined) continue;
      const h = rowH.get(uid) ?? L.ROW_H;
      if (y >= top && y < top + h) return i;
    }
    // Fallback — pierwszy lub ostatni dev w zależności od y.
    if (!users.length) return -1;
    return y < L.HEADER_H + L.ROW_H ? 0 : users.length - 1;
  }

  private rowIndexOf(nodeId: string): number {
    return this.users().findIndex(u => u.id === this.sprint.liveAssignee.get(nodeId));
  }

  /** Top Y of dev row (lane 0). Karta ląduje w środku BASE_H, niezależnie ile
   *  lanes ma dev w sumie — drag idzie do lane 0 deva (parallel-aware drop to
   *  inny temat, na razie zachowujemy single-lane drop). */
  private rowSnapY(devIdx: number): number {
    const userId = this.users()[devIdx]?.id;
    const top = userId ? this.sprint.rowYMap().get(userId) : undefined;
    if (top !== undefined) return top + Math.round((L.ROW_H - L.NODE_H) / 2);
    return L.HEADER_H + (devIdx + 1) * L.ROW_H + Math.round((L.ROW_H - L.NODE_H) / 2);
  }
}

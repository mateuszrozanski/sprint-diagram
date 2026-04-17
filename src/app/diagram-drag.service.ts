import { Injectable, inject } from '@angular/core';
import { NgDiagramModelService } from 'ng-diagram';
import type { DiagramNode, NodeUpdate } from './sprint-data';
import { L } from './layout';
import { transitiveDependents, resolveCollisions, syncQaNodes, resolveQaCollisions } from './sprint-utils';
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

  private allNodes()           { return this.modelService.nodes() as DiagramNode[]; }
  private nodeById(id: string) { return this.modelService.getNodeById(id) as DiagramNode | null; }
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
    this.cascadeIds    = transitiveDependents(this.activeDragIds, this.sprint.liveDeps);
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
    resolveCollisions(updates, allNodes, getById, this.sprint.liveAssignee, this.sprint.liveDeps, this.users());
    syncQaNodes(updates, allNodes, getById);
    resolveQaCollisions(updates, allNodes);

    if (updates.length > 0) {
      this.updating = true;
      this.modelService.updateNodes(updates);
      this.updating = false;
    }
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
    const devIdx  = Math.floor((centerY - L.HEADER_H) / L.ROW_H) - 1;

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
    const centerY    = node.position.y + L.NODE_H / 2;
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
    const qaY = L.HEADER_H + (this.users().length + 1) * L.ROW_H + Math.round((L.ROW_H - L.NODE_H) / 2);
    updates.push({ id: qaId, position: { x: bugX + (bugNode.data['width'] as number), y: qaY } });
  }

  private yToRowIndex(y: number): number {
    const rawRow = Math.floor((y - L.HEADER_H) / L.ROW_H);
    return Math.max(0, Math.min(this.users().length - 1, rawRow - 1));
  }

  private rowIndexOf(nodeId: string): number {
    return this.users().findIndex(u => u.id === this.sprint.liveAssignee.get(nodeId));
  }

  private rowSnapY(devIdx: number): number {
    return L.HEADER_H + (devIdx + 1) * L.ROW_H + Math.round((L.ROW_H - L.NODE_H) / 2);
  }
}

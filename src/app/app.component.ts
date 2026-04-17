import { AfterViewInit, Component, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  NgDiagramComponent,
  NgDiagramEdgeTemplateMap,
  NgDiagramNodeTemplateMap,
  NgDiagramViewportService,
  NgDiagramModelService,
  initializeModel,
  provideNgDiagram,
  type NgDiagramConfig,
  type EdgeDrawnEvent,
} from 'ng-diagram';

import type { DiagramNode } from './sprint-data';
import { buildNodesFromAdo, buildIncomingBugs } from './sprint-ado';
import { L, getTotalWidth } from './layout';
import { resolveQaCollisions } from './sprint-utils';
import type { NodeUpdate } from './sprint-data';
import { SwimlaneComponent }         from './nodes/swimlane.component';
import { PbiNodeComponent }           from './nodes/pbi-node.component';
import { QaTaskComponent }            from './nodes/qa-task.component';
import { DepEdgeComponent }           from './nodes/dep-edge.component';
import { SprintService }              from './sprint.service';
import { SprintDataStoreService }     from './sprint-data-store.service';
import { SprintEditorPanelComponent } from './editor/sprint-editor-panel.component';
import { DiagramDragService }         from './diagram-drag.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [NgDiagramComponent, SprintEditorPanelComponent, FormsModule],
  // DiagramDragService must be in the same injector as provideNgDiagram()
  // so it can inject NgDiagramModelService.
  providers: [provideNgDiagram(), DiagramDragService],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements AfterViewInit {
  private readonly viewportService = inject(NgDiagramViewportService);
  private readonly modelService    = inject(NgDiagramModelService);
  protected readonly sprint        = inject(SprintService);
  protected readonly dataStore     = inject(SprintDataStoreService);
  protected readonly drag          = inject(DiagramDragService);

  protected readonly editorOpen   = signal(false);
  protected readonly selectedNode = signal<DiagramNode | null>(null);
  protected readonly nodeTitle    = signal('');
  protected readonly nodeColor    = signal('#6366f1');

  private loadedNodeIds: string[]    = [];
  private loadedEdgeIds: string[]    = [];
  private loadedBugNodeIds: string[] = [];
  private loadedBugEdgeIds: string[] = [];
  private manualCounter = 0;

  readonly nodeTemplateMap = new NgDiagramNodeTemplateMap([
    ['swimlane', SwimlaneComponent],
    ['pbi',      PbiNodeComponent],
    ['qa-task',  QaTaskComponent],
  ]);
  readonly edgeTemplateMap = new NgDiagramEdgeTemplateMap([
    ['dep',     DepEdgeComponent],
    ['handoff', DepEdgeComponent],
    ['qa',      DepEdgeComponent],
  ]);

  readonly model = initializeModel({ nodes: this.buildLanes(), edges: [] });

  readonly diagramConfig = signal<NgDiagramConfig>({
    linking: {
      portSnapDistance: 60,
      validateConnection: (source: any, sourcePort: any, target: any, targetPort: any) => {
        console.log('[validateConnection]', {
          sourceType: source?.type, sourceId: source?.id,
          sourcePortId: sourcePort?.id,
          targetType: target?.type, targetId: target?.id,
          targetPortId: targetPort?.id,
        });
        if (!source || !target) return false;
        if (source.id === target.id) return false;
        // dep: pbi out → pbi (different displayId)
        if (source.type === 'pbi' && target.type === 'pbi' && sourcePort?.id === 'out') {
          return source.data?.['displayId'] !== target.data?.['displayId'];
        }
        // qa: pbi qa → qa-task
        if (source.type === 'pbi' && target.type === 'qa-task' && sourcePort?.id === 'qa') {
          return true;
        }
        return false;
      },
      finalEdgeDataBuilder: (edge: any) => {
        const isQa = edge.sourcePort === 'qa';
        return {
          ...edge,
          type:   isQa ? 'qa'  : 'dep',
          zOrder: 20,
          data:   { edgeType: isQa ? 'qa' : 'dep' },
        };
      },
    },
  });

  ngAfterViewInit(): void { setTimeout(() => this.fitView(), 100); }
  fitView(): void {
    this.viewportService.zoomToFit({ padding: 20 });
  }

  onSelectionChanged(event: any): void {
    const node = event.selectedNodes?.[0] ?? null;
    if (node?.type === 'pbi' || node?.type === 'qa-task') {
      this.selectedNode.set(node as DiagramNode);
      this.nodeTitle.set((node.data?.['title'] ?? node.data?.['pbiId'] ?? '') as string);
      this.nodeColor.set((node.data?.['color'] ?? '#6366f1') as string);
    } else {
      this.selectedNode.set(null);
    }
  }

  applyNodeTitle(title: string): void {
    const node = this.selectedNode();
    if (!node) return;
    this.modelService.updateNodes([{ id: node.id, data: { ...node.data, title } }]);
  }

  applyNodeColor(color: string): void {
    const node = this.selectedNode();
    if (!node) return;
    this.modelService.updateNodes([{ id: node.id, data: { ...node.data, color } }]);
  }

  onSelectionRemoved(event: { deletedNodes: any[]; deletedEdges: any[] }): void {
    for (const edge of event.deletedEdges ?? []) {
      // Remove from tracking list
      const idx = this.loadedEdgeIds.indexOf(edge.id);
      if (idx !== -1) this.loadedEdgeIds.splice(idx, 1);

      const edgeType = edge.data?.['edgeType'] as string | undefined;

      // Clean up liveDeps for dep/handoff edges: source was a dep of target
      if ((edgeType === 'dep' || edgeType === 'handoff') && edge.source && edge.target) {
        const deps = this.sprint.liveDeps.get(edge.target) ?? [];
        const updated = deps.filter((d: string) => d !== edge.source);
        if (updated.length !== deps.length) this.sprint.liveDeps.set(edge.target, updated);
      }

      // Clean up liveQaLinks for qa edges
      if (edgeType === 'qa' && edge.source) {
        if (this.sprint.liveQaLinks.get(edge.source) === edge.target) {
          this.sprint.liveQaLinks.delete(edge.source);
        }
      }
    }
  }

  onEdgeDrawn(event: EdgeDrawnEvent): void {
    if (event.sourcePort === 'out' && event.targetPort === 'in') {
      const targetDeps = this.sprint.liveDeps.get(event.target.id) ?? [];
      if (!targetDeps.includes(event.source.id)) {
        this.sprint.liveDeps.set(event.target.id, [...targetDeps, event.source.id]);
      }
    }

    if (event.sourcePort === 'qa') {
      const pbi    = event.source as any;
      const qaNode = event.target as any;

      this.sprint.liveQaLinks.set(pbi.id, qaNode.id);

      const minX = pbi.position.x + (pbi.data?.['width'] ?? 0) + L.PAD;
      const updates: NodeUpdate[] = [];
      if (qaNode.position.x < minX) {
        updates.push({ id: qaNode.id, position: { x: minX, y: qaNode.position.y } });
      }
      if (updates.length > 0) {
        resolveQaCollisions(updates, this.modelService.nodes() as DiagramNode[]);
        this.modelService.updateNodes(updates);
      }
    }

    this.loadedEdgeIds.push(event.edge.id);
  }

  addManualPbi(): void {
    const id      = `manual-pbi-${++this.manualCounter}`;
    const users   = this.dataStore.users();
    const y       = L.HEADER_H + Math.round((L.ROW_H - L.NODE_H) / 2);
    const node: DiagramNode = {
      id, type: 'pbi', zOrder: 10,
      position: { x: L.LABEL_W + L.PAD, y },
      data: {
        id, displayId: id, title: 'New PBI',
        color: '#6366f1',
        primaryAssignee: '',
        collaborators: [], dependencies: [],
        startDay: 1, endDay: 1,
        width: L.DAY_W - 2 * L.PAD, height: L.NODE_H,
        phaseRole: '', isBugType: false, phaseIdx: 0, totalPhases: 1,
      },
    };
    this.sprint.liveAssignee.set(id, 'unassigned');
    this.sprint.liveDeps.set(id, []);
    this.loadedNodeIds.push(id);
    this.modelService.addNodes([node]);
  }

  addManualQaTask(): void {
    const id    = `manual-qa-${++this.manualCounter}`;
    const users = this.dataStore.users();
    const y     = L.HEADER_H + (users.length + 1) * L.ROW_H + Math.round((L.ROW_H - L.NODE_H) / 2);
    const node: DiagramNode = {
      id, type: 'qa-task', zOrder: 10,
      position: { x: L.LABEL_W + L.PAD, y },
      data: {
        pbiId: id, color: '#6366f1',
        endDay: 1,
        width: L.DAY_W - 2 * L.PAD, height: L.NODE_H,
      },
    };
    this.loadedNodeIds.push(id);
    this.modelService.addNodes([node]);
  }

  rebuildSprint(): void {
    this.resetDiagram();
    this.loadFromAdo();
  }

  // ── Sprint load / reset ───────────────────────────────────────────────────

  async loadFromAdo(): Promise<void> {
    if (this.sprint.isLoading()) return;
    this.sprint.isLoading.set(true);

    await new Promise<void>(r => setTimeout(r, 1200));

    const pbis = this.dataStore.pbis();
    const { nodes, edges, assigneeMap, depsMap } = buildNodesFromAdo(pbis, this.dataStore.users());
    this.sprint.applyMaps(assigneeMap, depsMap);

    this.loadedNodeIds = nodes.map(n => n.id);
    this.loadedEdgeIds = edges.map(e => e.id);

    this.modelService.addNodes(nodes);
    this.modelService.addEdges(edges);

    this.sprint.loadedStats.set({
      stories:  pbis.filter(p => p.type === 'Story').length,
      bugs:     pbis.filter(p => p.type === 'Bug').length,
      incoming: 0,
    });

    this.sprint.isLoading.set(false);
    this.sprint.isLoaded.set(true);
  }

  resetDiagram(): void {
    this.resetBugs();
    if (this.loadedNodeIds.length) this.modelService.deleteNodes(this.loadedNodeIds);
    if (this.loadedEdgeIds.length) this.modelService.deleteEdges(this.loadedEdgeIds);
    this.loadedNodeIds = [];
    this.loadedEdgeIds = [];
    this.sprint.clearState();
    this.sprint.isLoaded.set(false);
    this.sprint.loadedStats.set({ stories: 0, bugs: 0, incoming: 0 });
    this.sprint.clearUndo();
  }

  // ── Incoming bug load / reset ─────────────────────────────────────────────

  async loadIncomingBugs(): Promise<void> {
    if (this.sprint.isBugsLoading() || this.sprint.isBugsLoaded()) return;
    this.sprint.isBugsLoading.set(true);

    await new Promise<void>(r => setTimeout(r, 600));

    const bugs = this.dataStore.incomingBugs();
    const { nodes, edges, assigneeMap, depsMap } = buildIncomingBugs(bugs);
    this.sprint.applyMaps(assigneeMap, depsMap);

    this.loadedBugNodeIds = nodes.map(n => n.id);
    this.loadedBugEdgeIds = edges.map(e => e.id);

    this.modelService.addNodes(nodes);
    this.modelService.addEdges(edges);

    this.sprint.loadedStats.update(s => ({ ...s, incoming: bugs.length }));

    this.sprint.isBugsLoading.set(false);
    this.sprint.isBugsLoaded.set(true);
  }

  resetBugs(): void {
    if (!this.sprint.isBugsLoaded()) return;
    const allBugIds  = [...this.loadedBugNodeIds];
    const bugEdgeIds = [...this.loadedBugEdgeIds];

    if (allBugIds.length)  this.modelService.deleteNodes(allBugIds);
    if (bugEdgeIds.length) this.modelService.deleteEdges(bugEdgeIds);

    for (const id of allBugIds) {
      this.sprint.liveAssignee.delete(id);
      this.sprint.liveDeps.delete(id);
    }

    this.loadedBugNodeIds = [];
    this.loadedBugEdgeIds = [];
    this.sprint.isBugsLoaded.set(false);
    this.sprint.loadedStats.update(s => ({ ...s, incoming: 0 }));
    this.sprint.clearUndo();
  }

  // ── Lane builder ──────────────────────────────────────────────────────────

  private buildLanes(): DiagramNode[] {
    const totalW = getTotalWidth();
    const users  = this.dataStore.users();

    const lane = (id: string, y: number, data: Record<string, unknown>): DiagramNode => ({
      id, type: 'swimlane', zOrder: 0, position: { x: 0, y }, data, draggable: false,
    });

    return [
      lane('hdr',           0,                                       { isHeader: true,  width: totalW, height: L.HEADER_H }),
      lane('lane-incoming', L.HEADER_H,                              { label: '📥 Incoming', width: totalW, height: L.ROW_H, isIncoming: true }),
      ...users.map((user, i) =>
        lane(`lane-${user.id}`, L.HEADER_H + (i + 1) * L.ROW_H,    { label: user.name, width: totalW, height: L.ROW_H })
      ),
      lane('lane-qa', L.HEADER_H + (users.length + 1) * L.ROW_H,   { label: 'QA / Testing', width: totalW, height: L.ROW_H, isQA: true }),
    ];
  }
}

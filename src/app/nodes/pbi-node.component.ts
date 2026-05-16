import { Component, computed, ElementRef, inject, input } from '@angular/core';
import { NgDiagramNodeTemplate, NgDiagramPortComponent, NgDiagramModelService, NgDiagramViewportService } from 'ng-diagram';
import { CALENDAR_SLOTS } from '../sprint-data';
import type { DiagramNode, NodeUpdate } from '../sprint-data';
import { L, getPbiNonWorkingZones, getEffectivePbiWidth, skipNonWorkingX } from '../layout';
import { transitiveDependents, resolveCollisions, syncQaNodes, resolveQaCollisions } from '../sprint-utils';
import { SprintService } from '../sprint.service';
import { SprintDataStoreService } from '../sprint-data-store.service';

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

@Component({
  selector: 'app-pbi-node',
  standalone: true,
  imports: [NgDiagramPortComponent],
  templateUrl: './pbi-node.component.html',
  styleUrl: './pbi-node.component.css',
})
export class PbiNodeComponent implements NgDiagramNodeTemplate {
  // ng-diagram passes `SimpleNode<object>` which is incompatible with our DiagramNode type.
  // `any` is required here — the library's InputSignal generic is not covariant.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node = input.required<any>();

  private readonly modelService    = inject(NgDiagramModelService);
  private readonly viewportService = inject(NgDiagramViewportService);
  private readonly elRef           = inject(ElementRef);
  private readonly sprint          = inject(SprintService);
  private readonly dataStore       = inject(SprintDataStoreService);

  protected color     = computed(() => this.node().data['color']    as string);
  protected height    = computed(() => this.node().data['height']   as number);
  protected hasDeps   = computed(() => (this.node().data['dependencies'] as string[]).length > 0);
  protected isBug     = computed(() => !!this.node().data['isBugType']);
  protected displayId = computed(() => (this.node().data['displayId'] || this.node().data['id']) as string);
  protected phaseRole = computed(() => this.node().data['phaseRole'] as string | undefined);

  /** Card width stretched to skip over any holidays within its span. */
  protected effectiveWidth = computed(() =>
    getEffectivePbiWidth(
      this.node().position.x,
      this.node().data['width'] as number,
    )
  );

  /** Card background: solid in working zones, hatching in non-working zones. */
  protected cardBackground = computed(() => {
    const zones = this.nonWorkingZones();
    if (zones.length === 0) return '#252526';

    const stripe = 'repeating-linear-gradient(-45deg, transparent 0px, transparent 5px, rgba(0,0,0,0.55) 5px, rgba(0,0,0,0.55) 8px)';
    const tint   = 'linear-gradient(rgba(0,0,0,0.22), rgba(0,0,0,0.22))';

    const layers: string[] = [];
    for (const zone of zones) {
      const pos = `${zone.left}px 0 / ${zone.width}px 100% no-repeat`;
      layers.push(`${stripe} ${pos}`, `${tint} ${pos}`);
    }
    layers.push('#252526');
    return layers.join(', ');
  });

  protected assignees = computed(() => [
    this.node().data['primaryAssignee'] as string,
    ...(this.node().data['collaborators'] as string[]),
  ]);

  protected dateRange = computed(() => {
    const s = this.node().data['startDay'] as number;
    const e = this.node().data['endDay']   as number;
    return `${this.slotLabel(s)} – ${this.slotLabel(e)}`;
  });

  protected nonWorkingZones = computed(() =>
    getPbiNonWorkingZones(
      this.node().position.x,
      this.effectiveWidth(),
    )
  );

  protected userName(uid: string): string {
    return this.dataStore.users().find(u => u.id === uid)?.name ?? uid;
  }

  protected initials(uid: string): string {
    return (this.dataStore.users().find(u => u.id === uid)?.name ?? uid)
      .split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2);
  }

  private slotLabel(day: number): string {
    const s = CALENDAR_SLOTS.find(c => c.sprintDay === day);
    if (!s) return `D${day}`;
    return `${MON[s.date.getMonth()]} ${s.date.getDate()}`;
  }

  // ── Resize ────────────────────────────────────────────────────────────────

  onResizeStart(event: PointerEvent): void {
    event.stopPropagation();
    event.preventDefault();

    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startW = this.node().data['width'] as number;
    const minW   = L.DAY_W - 2 * L.PAD;
    const zoom   = this.viewportService.scale();

    const calcW = (clientX: number) => Math.max(minW, startW + (clientX - startX) / zoom);

    const onMove = (e: Event) => {
      const newW = calcW((e as PointerEvent).clientX);
      const n    = this.node();
      this.modelService.updateNodes([{ id: n.id, position: n.position, data: { ...n.data, width: newW } }]);
    };

    const onUp = (e: Event) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup',   onUp);
      handle.releasePointerCapture((e as PointerEvent).pointerId);

      const newW    = calcW((e as PointerEvent).clientX);
      const nodeId  = this.node().id;
      const n       = this.node();
      const users   = this.dataStore.users();

      const updates: NodeUpdate[] = [{ id: nodeId, position: n.position, data: { ...n.data, width: newW } }];

      const nodeById = (id: string) => this.modelService.getNodeById(id) as DiagramNode | null;
      const allNodes = this.modelService.nodes() as DiagramNode[];

      const delta = newW - startW;
      if (delta !== 0) {
        for (const depId of transitiveDependents([nodeId], this.sprint.liveDeps)) {
          const dep = nodeById(depId);
          if (!dep) continue;
          updates.push({ id: depId, position: { x: dep.position.x + delta, y: dep.position.y } });
        }
      }

      resolveCollisions(updates, allNodes, nodeById, this.sprint.liveAssignee, this.sprint.liveDeps, users);
      syncQaNodes(updates, allNodes, nodeById);
      resolveQaCollisions(updates, allNodes);
      this.modelService.updateNodes(updates);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup',   onUp);
  }
}

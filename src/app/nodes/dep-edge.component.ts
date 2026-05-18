import { Component, computed, inject, input } from '@angular/core';
import { NgDiagramBaseEdgeComponent, NgDiagramEdgeTemplate } from 'ng-diagram';
import { UiBusService } from '../ui-bus.service';

@Component({
  selector: 'app-dep-edge',
  standalone: true,
  imports: [NgDiagramBaseEdgeComponent],
  templateUrl: './dep-edge.component.html',
})
export class DepEdgeComponent implements NgDiagramEdgeTemplate {
  edge = input.required<any>();

  private readonly uiBus = inject(UiBusService);

  /** Czy krawędź łączy karty z aktualnego scope (wszystkie pbiIds w highlighted set). */
  protected isScopeHighlighted = computed(() => {
    const set = this.uiBus.highlightedPbiIds();
    if (!set || set.size === 0) return false;
    const ids = (this.edge().data?.['pbiIds'] as string[] | undefined) ?? [];
    if (!ids.length) return false;
    return ids.every(id => set.has(id));
  });

  protected stroke = computed(() => {
    const scope    = this.isScopeHighlighted();
    const selected = this.edge().selected;
    const type     = this.edge().data?.['edgeType'];

    if (scope) return '#ffb74d'; // pomarańczowy = w scope

    const alpha    = selected ? 'ff' : '99';

    if (type === 'qa')      return `#13a10e${selected ? 'cc' : '30'}`;
    if (type === 'handoff') {
      const color: string = this.edge().data?.['color'] ?? '#0078d4';
      return `${color}${alpha}`;
    }
    return `#0078d4${alpha}`;
  });

  protected strokeWidth = computed(() => {
    if (this.isScopeHighlighted()) return 3.5;
    return this.edge().selected ? 3 : (this.edge().data?.['edgeType'] === 'handoff' ? 2.5 : 2);
  });

  protected dasharray = computed(() => {
    const type = this.edge().data?.['edgeType'];
    if (type === 'handoff') return '';
    if (type === 'qa')      return '5 4';
    return '8 4';
  });
}

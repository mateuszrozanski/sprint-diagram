import { Component, computed, input } from '@angular/core';
import { NgDiagramBaseEdgeComponent, NgDiagramEdgeTemplate } from 'ng-diagram';

@Component({
  selector: 'app-dep-edge',
  standalone: true,
  imports: [NgDiagramBaseEdgeComponent],
  templateUrl: './dep-edge.component.html',
})
export class DepEdgeComponent implements NgDiagramEdgeTemplate {
  edge = input.required<any>();

  protected stroke = computed(() => {
    const selected = this.edge().selected;
    const type     = this.edge().data?.['edgeType'];
    const alpha    = selected ? 'ff' : '99';

    if (type === 'qa')      return `#13a10e${selected ? 'cc' : '30'}`;
    if (type === 'handoff') {
      const color: string = this.edge().data?.['color'] ?? '#0078d4';
      return `${color}${alpha}`;
    }
    return `#0078d4${alpha}`;
  });

  protected strokeWidth = computed(() =>
    this.edge().selected ? 3 : (this.edge().data?.['edgeType'] === 'handoff' ? 2.5 : 2)
  );

  protected dasharray = computed(() => {
    const type = this.edge().data?.['edgeType'];
    if (type === 'handoff') return '';
    if (type === 'qa')      return '5 4';
    return '8 4';
  });
}

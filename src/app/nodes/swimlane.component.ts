import { Component, computed, input } from '@angular/core';
import { NgDiagramNodeTemplate } from 'ng-diagram';
import { CALENDAR_SLOTS, SPRINT_START } from '../sprint-data';
import { L, getTotalWidth, getNonWorkingZones } from '../layout';

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmt  = (d: Date) => `${MON[d.getMonth()]} ${d.getDate()}`;

@Component({
  selector: 'app-swimlane',
  standalone: true,
  host: { style: 'pointer-events: none; display: block;' },
  templateUrl: './swimlane.component.html',
  styleUrl: './swimlane.component.css',
})
export class SwimlaneComponent implements NgDiagramNodeTemplate {
  node = input.required<any>();

  protected readonly slots           = CALENDAR_SLOTS;
  protected readonly nonWorkingZones = getNonWorkingZones();
  protected readonly totalW          = getTotalWidth();
  protected readonly headerH         = L.HEADER_H;
  protected readonly rowH            = L.ROW_H;
  protected readonly labelW          = L.LABEL_W;
  protected readonly dayW            = L.DAY_W;
  protected readonly wkndW           = L.WKND_W;
  protected readonly w2SepX          = 5 * L.DAY_W + 2 * L.WKND_W;

  protected readonly isQA       = computed(() => !!this.node().data['isQA']);
  protected readonly isHeader   = computed(() => !!this.node().data['isHeader']);
  protected readonly isIncoming = computed(() => !!this.node().data['isIncoming']);
  /** Per-row day-off bandy (capacity z ADO). Liczone w app.component.buildLanes,
   *  bo zależą od userId tej lane. */
  protected readonly dayOffZones = computed(() =>
    (this.node().data['dayOffZones'] as { left: number; width: number }[] | undefined) ?? []
  );

  /** Trophy dla Alicji — wygrała ostatni hackaton w kat. Best Business Value. */
  protected readonly showTrophy = computed(() => {
    const label = String(this.node().data['label'] ?? '').toLowerCase();
    return label.includes('alicja');
  });

  protected readonly dateRange = (() => {
    const end = new Date(SPRINT_START);
    end.setDate(end.getDate() + 11);
    return `${fmt(SPRINT_START)} – ${fmt(end)}`;
  })();

  protected fmt = fmt;
}

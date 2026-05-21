import { Component, computed, input } from '@angular/core';
import { NgDiagramNodeTemplate } from 'ng-diagram';
import { CALENDAR_SLOTS, SPRINT_START } from '../sprint-data';
import { L, getTotalWidth, getNonWorkingZones, getTodayXOffset } from '../layout';

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
  protected readonly labelW          = L.LABEL_W;

  // Wysokość row z `data.height` przekazane przez factory — bo dev z parallel
  // phases ma row > L.ROW_H. Fallback do L.ROW_H dla bezpiecznego pierwszego
  // renderu kiedy data.height jeszcze nie jest ustawione.
  protected readonly rowH = computed(() => (this.node().data['height'] as number) ?? L.ROW_H);
  protected readonly dayW            = L.DAY_W;
  protected readonly wkndW           = L.WKND_W;
  protected readonly w2SepX          = 5 * L.DAY_W + 2 * L.WKND_W;
  // Px offset (od początku lane-body, czyli już za LABEL_W) gdzie wypada "dziś".
  // null gdy sprint jeszcze się nie zaczął lub już się skończył — wtedy nie
  // renderujemy linii w ogóle.
  protected readonly todayX          = getTodayXOffset();

  protected readonly isQA       = computed(() => !!this.node().data['isQA']);
  protected readonly isHeader   = computed(() => !!this.node().data['isHeader']);
  protected readonly isIncoming = computed(() => !!this.node().data['isIncoming']);

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

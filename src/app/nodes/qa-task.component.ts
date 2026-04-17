import { Component, computed, input } from '@angular/core';
import { NgDiagramNodeTemplate, NgDiagramPortComponent } from 'ng-diagram';
import { CALENDAR_SLOTS } from '../sprint-data';
import { getEffectiveQaWidth } from '../layout';

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

@Component({
  selector: 'app-qa-task',
  standalone: true,
  imports: [NgDiagramPortComponent],
  templateUrl: './qa-task.component.html',
  styleUrl: './qa-task.component.css',
})
export class QaTaskComponent implements NgDiagramNodeTemplate {
  node = input.required<any>();

  protected color  = computed(() => this.node().data['color'] as string);
  protected height = computed(() => this.node().data['height'] as number);

  /** Reactive width: extends for any non-working slot (holiday or weekend) within the card's span. */
  protected width = computed(() =>
    getEffectiveQaWidth(this.node().position.x, this.node().data['width'] as number)
  );

  protected fromLabel = computed(() => {
    const day = this.node().data['endDay'] as number;
    const s = CALENDAR_SLOTS.find(c => c.sprintDay === day);
    if (!s) return `Day ${day}`;
    return `${s.dayName} ${MON[s.date.getMonth()]} ${s.date.getDate()}`;
  });
}

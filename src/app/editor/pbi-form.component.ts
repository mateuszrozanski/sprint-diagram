import { Component, computed, inject, input, OnInit, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SprintDataStoreService } from '../sprint-data-store.service';
import type { AdoPbi } from '../sprint-data';

function randomColor(): string {
  const h = Math.floor(Math.random() * 360);
  return hslToHex(h, 70, 55);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export interface PbiFormValue {
  id: string;
  title: string;
  color: string;
  type: 'Story' | 'Bug';
  priority: number;
  phases: { assigneeId: string; days: number; role: string; parallel: boolean }[];
  dependsOn: string[];
}

@Component({
  selector: 'app-pbi-form',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './pbi-form.component.html',
  styleUrl: './pbi-form.component.css',
})
export class PbiFormComponent implements OnInit {
  private readonly store = inject(SprintDataStoreService);

  /** PBI to edit; null = create new */
  readonly existing = input<AdoPbi | null>(null);
  readonly saved    = output<AdoPbi>();
  readonly cancelled = output<void>();

  protected readonly allPbis = computed(() => this.store.pbis());
  protected readonly users   = computed(() => this.store.users());

  protected form: PbiFormValue = this.emptyForm();

  ngOnInit() {
    const pbi = this.existing();
    if (pbi) {
      this.form = {
        id:        pbi.id,
        title:     pbi.title,
        color:     pbi.color,
        type:      pbi.type,
        priority:  pbi.priority,
        phases:    pbi.phases.map(p => ({ ...p, parallel: !!p.parallel })),
        dependsOn: [...(pbi.dependsOn ?? [])],
      };
    }
  }

  protected addPhase() {
    this.form.phases.push({ assigneeId: this.users()[0]?.id ?? 'unassigned', days: 1, role: 'Dev', parallel: false });
  }

  protected removePhase(i: number) {
    this.form.phases.splice(i, 1);
  }

  protected toggleDep(pbiId: string) {
    const idx = this.form.dependsOn.indexOf(pbiId);
    if (idx >= 0) this.form.dependsOn.splice(idx, 1);
    else          this.form.dependsOn.push(pbiId);
  }

  protected hasDep(pbiId: string) {
    return this.form.dependsOn.includes(pbiId);
  }

  protected randomizeColor() {
    this.form.color = randomColor();
  }

  protected otherPbis = computed(() =>
    this.allPbis().filter(p => p.id !== this.form.id && p.type === 'Story')
  );

  protected submit() {
    if (!this.form.id.trim() || !this.form.title.trim() || this.form.phases.length === 0) return;
    const pbi: AdoPbi = {
      id:        this.form.id.trim(),
      title:     this.form.title.trim(),
      color:     this.form.color,
      type:      this.form.type,
      priority:  this.form.priority,
      phases:    this.form.phases.map(p => ({
        assigneeId: p.assigneeId,
        days:       p.days,
        role:       p.role,
        ...(p.parallel ? { parallel: true } : {}),
      })),
      ...(this.form.dependsOn.length ? { dependsOn: [...this.form.dependsOn] } : {}),
    };
    this.saved.emit(pbi);
  }

  protected cancel() {
    this.cancelled.emit();
  }

  private emptyForm(): PbiFormValue {
    return {
      id:        '',
      title:     '',
      color:     randomColor(),
      type:      'Story',
      priority:  2,
      phases:    [{ assigneeId: '', days: 1, role: 'Dev', parallel: false }],
      dependsOn: [],
    };
  }
}

import { Injectable, signal } from '@angular/core';
import type { DiagramNode } from './sprint-data';

/**
 * Lekka magistrala signal-based żeby card-komponenty mogły zażądać otwarcia
 * details panelu w app.component bez tightly-coupled outputów przez ng-diagram.
 */
@Injectable({ providedIn: 'root' })
export class UiBusService {
  readonly openDetailsForNode = signal<DiagramNode | null>(null);

  /** displayId głównego PBI (target) — wpisywane przez kliknięcie ⊙ na karcie. */
  readonly highlightedPbiId = signal<string | null>(null);

  /**
   * Set wszystkich displayId które powinny być podświetlone (target + powiązane
   * cross-PBI deps + QA). Ustawiane przez `app.component` na podstawie
   * `highlightedPbiId` + dependency graph.
   */
  readonly highlightedPbiIds = signal<ReadonlySet<string> | null>(null);

  toggleHighlight(pbiId: string): void {
    this.highlightedPbiId.set(this.highlightedPbiId() === pbiId ? null : pbiId);
  }
}

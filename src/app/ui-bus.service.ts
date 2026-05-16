import { Injectable, signal } from '@angular/core';
import type { DiagramNode } from './sprint-data';

/**
 * Lekka magistrala signal-based żeby card-komponenty mogły zażądać otwarcia
 * details panelu w app.component bez tightly-coupled outputów przez ng-diagram.
 */
@Injectable({ providedIn: 'root' })
export class UiBusService {
  readonly openDetailsForNode = signal<DiagramNode | null>(null);
}

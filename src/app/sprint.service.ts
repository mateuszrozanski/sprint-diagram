import { Injectable, signal } from '@angular/core';
import type { NodeUpdate, SprintStats, UndoSnapshot } from './sprint-data';

@Injectable({ providedIn: 'root' })
export class SprintService {
  readonly liveAssignee = new Map<string, string>();
  readonly liveDeps     = new Map<string, string[]>();
  readonly liveQaLinks  = new Map<string, string>(); // pbiNodeId → qaNodeId

  readonly isLoading     = signal(false);
  readonly isLoaded      = signal(false);
  readonly loadedStats   = signal<SprintStats>({ stories: 0, bugs: 0, incoming: 0 });
  readonly isBugsLoading = signal(false);
  readonly isBugsLoaded  = signal(false);
  readonly undoLabel     = signal<string | null>(null);

  /** Days off per dev/tester (z ADO capacity). Mapuje userId → set sprintDay (1-10)
   *  kiedy dev jest off. Scheduler skipuje te dni dla danego deva, swimlane renderuje
   *  szare bandy per row. */
  readonly daysOffByUserId = signal<Map<string, Set<number>>>(new Map());

  private undoSnapshot: UndoSnapshot | null = null;

  applyMaps(assigneeMap: Map<string, string>, depsMap: Map<string, string[]>): void {
    for (const [k, v] of assigneeMap) this.liveAssignee.set(k, v);
    for (const [k, v] of depsMap)     this.liveDeps.set(k, v);
  }

  clearState(): void {
    this.liveAssignee.clear();
    this.liveDeps.clear();
    this.liveQaLinks.clear();
  }

  saveUndoSnapshot(snapshot: UndoSnapshot): void {
    this.undoSnapshot = snapshot;
    this.undoLabel.set(snapshot.label);
  }

  consumeUndoSnapshot(): UndoSnapshot | null {
    const s = this.undoSnapshot;
    this.undoSnapshot = null;
    this.undoLabel.set(null);
    return s;
  }

  clearUndo(): void {
    this.undoSnapshot = null;
    this.undoLabel.set(null);
  }
}

import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SprintDataStoreService } from '../sprint-data-store.service';
import { PbiFormComponent } from './pbi-form.component';
import type { AdoPbi, SprintUser } from '../sprint-data';

type Tab = 'pbis' | 'team';

@Component({
  selector: 'app-sprint-editor-panel',
  standalone: true,
  imports: [FormsModule, PbiFormComponent],
  templateUrl: './sprint-editor-panel.component.html',
  styleUrl: './sprint-editor-panel.component.css',
})
export class SprintEditorPanelComponent {
  private readonly store = inject(SprintDataStoreService);

  readonly rebuild = output<void>();

  protected readonly tab     = signal<Tab>('pbis');
  protected readonly editing = signal<AdoPbi | null | 'new'>(null);

  protected readonly pbis    = computed(() => this.store.pbis());
  protected readonly stories = computed(() => this.store.stories());
  protected readonly bugs    = computed(() => this.store.bugs());
  protected readonly users   = computed(() => this.store.users());

  // ── PBI actions ───────────────────────────────────────────────────────────

  protected newPbi()           { this.editing.set('new'); }
  protected editPbi(p: AdoPbi) { this.editing.set(p); }

  protected deletePbi(id: string) {
    this.store.deletePbi(id);
  }

  protected savePbi(pbi: AdoPbi) {
    const isNew = this.editing() === 'new';
    isNew ? this.store.addPbi(pbi) : this.store.updatePbi(pbi);
    this.editing.set(null);
  }

  protected get editingPbi(): AdoPbi | null {
    const e = this.editing();
    return e && e !== 'new' ? e : null;
  }

  // ── User actions ──────────────────────────────────────────────────────────

  protected newUserName = '';
  protected newUserId   = '';

  protected addUser() {
    const id   = this.newUserId.trim().toLowerCase().replace(/\s+/g, '-');
    const name = this.newUserName.trim();
    if (!id || !name) return;
    this.store.addUser({ id, name });
    this.newUserId   = '';
    this.newUserName = '';
  }

  protected updateUserName(user: SprintUser, event: Event) {
    this.store.updateUser({ ...user, name: (event.target as HTMLInputElement).value });
  }

  protected deleteUser(id: string) {
    this.store.deleteUser(id);
  }

  // ── Rebuild ───────────────────────────────────────────────────────────────

  protected triggerRebuild() {
    this.rebuild.emit();
  }
}

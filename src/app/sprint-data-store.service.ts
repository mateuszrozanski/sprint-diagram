import { Injectable, signal, computed } from '@angular/core';
import { ADO_MOCK_PBIS, INCOMING_BUGS_MOCK, USERS } from './sprint-data';
import type { AdoPbi, SprintUser } from './sprint-data';

const LS_PBIS  = 'sprint_pbis';
const LS_BUGS  = 'sprint_bugs';
const LS_USERS = 'sprint_users';

function load<T>(key: string, fallback: T[]): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

@Injectable({ providedIn: 'root' })
export class SprintDataStoreService {
  readonly pbis         = signal<AdoPbi[]>(load(LS_PBIS,  ADO_MOCK_PBIS));
  readonly incomingBugs = signal<AdoPbi[]>(load(LS_BUGS,  INCOMING_BUGS_MOCK));
  readonly users        = signal<SprintUser[]>(load(LS_USERS, USERS));

  readonly stories  = computed(() => this.pbis().filter(p => p.type === 'Story'));
  readonly bugs     = computed(() => this.pbis().filter(p => p.type === 'Bug'));

  // ── PBIs ──────────────────────────────────────────────────────────────────

  addPbi(pbi: AdoPbi): void {
    this.pbis.update(list => [...list, pbi]);
    save(LS_PBIS, this.pbis());
  }

  updatePbi(updated: AdoPbi): void {
    this.pbis.update(list => list.map(p => p.id === updated.id ? updated : p));
    save(LS_PBIS, this.pbis());
  }

  deletePbi(id: string): void {
    this.pbis.update(list => list.filter(p => p.id !== id));
    save(LS_PBIS, this.pbis());
  }

  // ── Incoming bugs ─────────────────────────────────────────────────────────

  addIncomingBug(bug: AdoPbi): void {
    this.incomingBugs.update(list => [...list, bug]);
    save(LS_BUGS, this.incomingBugs());
  }

  updateIncomingBug(updated: AdoPbi): void {
    this.incomingBugs.update(list => list.map(b => b.id === updated.id ? updated : b));
    save(LS_BUGS, this.incomingBugs());
  }

  deleteIncomingBug(id: string): void {
    this.incomingBugs.update(list => list.filter(b => b.id !== id));
    save(LS_BUGS, this.incomingBugs());
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  addUser(user: SprintUser): void {
    this.users.update(list => [...list, user]);
    save(LS_USERS, this.users());
  }

  updateUser(updated: SprintUser): void {
    this.users.update(list => list.map(u => u.id === updated.id ? updated : u));
    save(LS_USERS, this.users());
  }

  deleteUser(id: string): void {
    this.users.update(list => list.filter(u => u.id !== id));
    save(LS_USERS, this.users());
  }

  resetToDefaults(): void {
    this.pbis.set([...ADO_MOCK_PBIS]);
    this.incomingBugs.set([...INCOMING_BUGS_MOCK]);
    this.users.set([...USERS]);
    save(LS_PBIS,  this.pbis());
    save(LS_BUGS,  this.incomingBugs());
    save(LS_USERS, this.users());
  }
}

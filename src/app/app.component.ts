import { AfterViewInit, Component, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  NgDiagramComponent,
  NgDiagramEdgeTemplateMap,
  NgDiagramNodeTemplateMap,
  NgDiagramViewportService,
  NgDiagramModelService,
  NgDiagramSelectionService,
  initializeModel,
  provideNgDiagram,
  type NgDiagramConfig,
  type EdgeDrawnEvent,
} from 'ng-diagram';

import type { DiagramNode } from './sprint-data';
import { setSprintCalendar, SPRINT_START, SPRINT_DAYS } from './sprint-data';

function countWorkingDays(start: Date, finish: Date): number {
  let count = 0;
  const d = new Date(start);
  d.setHours(0, 0, 0, 0);
  const end = new Date(finish);
  end.setHours(0, 0, 0, 0);
  while (d <= end) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}
import { buildNodesFromAdo, buildIncomingBugs } from './sprint-ado';
import { widthForHours } from './card-width';
import { L, getTotalWidth } from './layout';
import { resolveQaCollisions } from './sprint-utils';
import type { NodeUpdate } from './sprint-data';
import { SwimlaneComponent }         from './nodes/swimlane.component';
import { PbiNodeComponent }           from './nodes/pbi-node.component';
import { QaTaskComponent }            from './nodes/qa-task.component';
import { DepEdgeComponent }           from './nodes/dep-edge.component';
import { SprintService }              from './sprint.service';
import { SprintDataStoreService }     from './sprint-data-store.service';
import { SprintEditorPanelComponent } from './editor/sprint-editor-panel.component';
import { DiagramDragService }         from './diagram-drag.service';
import { AdoService, slugifyUser }    from './ado.service';
import { UiBusService }                from './ui-bus.service';
import { effect }                       from '@angular/core';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [NgDiagramComponent, SprintEditorPanelComponent, FormsModule],
  // DiagramDragService must be in the same injector as provideNgDiagram()
  // so it can inject NgDiagramModelService.
  providers: [provideNgDiagram(), DiagramDragService],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements AfterViewInit {
  private readonly viewportService  = inject(NgDiagramViewportService);
  private readonly selectionService = inject(NgDiagramSelectionService);
  private readonly modelService    = inject(NgDiagramModelService);
  protected readonly sprint        = inject(SprintService);
  protected readonly dataStore     = inject(SprintDataStoreService);
  protected readonly drag          = inject(DiagramDragService);
  private   readonly adoService    = inject(AdoService);
  private   readonly uiBus         = inject(UiBusService);

  // Po toggle scope-highlight na karcie (uiBus.highlightedPbiId) — liczymy
  // wszystkie powiązane displayId (cross-PBI deps w obie strony) i wystawiamy
  // na uiBus.highlightedPbiIds, żeby każdy pbi-node / qa-task mógł sprawdzić
  // czy do siebie należy.
  private readonly _scopeHighlightEffect = effect(() => {
    const target = this.uiBus.highlightedPbiId();
    if (!target) {
      this.uiBus.highlightedPbiIds.set(null);
      return;
    }
    this.uiBus.highlightedPbiIds.set(this.computeRelatedPbiIds(target));
  });

  private computeRelatedPbiIds(pbiId: string): Set<string> {
    const related = new Set<string>([pbiId]);
    const nodes = this.modelService.nodes() as DiagramNode[];
    const phaseToPbi = new Map<string, string>();
    for (const n of nodes) {
      if (n.type !== 'pbi') continue;
      phaseToPbi.set(n.id, n.data?.['displayId'] as string);
    }
    const targetPhases: string[] = [];
    for (const [phaseId, pId] of phaseToPbi) {
      if (pId === pbiId) targetPhases.push(phaseId);
    }
    const reverseDeps = new Map<string, string[]>();
    for (const [phaseId, deps] of this.sprint.liveDeps) {
      for (const d of deps) {
        if (!reverseDeps.has(d)) reverseDeps.set(d, []);
        reverseDeps.get(d)!.push(phaseId);
      }
    }
    const queue = [...targetPhases];
    const seen = new Set<string>(targetPhases);
    while (queue.length) {
      const cur = queue.shift()!;
      const next = [...(this.sprint.liveDeps.get(cur) ?? []), ...(reverseDeps.get(cur) ?? [])];
      for (const n of next) {
        if (seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
        const pid = phaseToPbi.get(n);
        if (pid) related.add(pid);
      }
    }
    return related;
  }

  // Reagujemy na żądanie z karty (przycisk ⓘ) — otwieramy details panel.
  private readonly _openDetailsEffect = effect(() => {
    const node = this.uiBus.openDetailsForNode();
    if (!node) return;
    this.selectedNode.set(node as DiagramNode);
    this.nodeTitle.set((node.data?.['title'] ?? node.data?.['pbiId'] ?? '') as string);
    this.nodeColor.set((node.data?.['color'] ?? '#6366f1') as string);
    this.detailsPanelPos.set(null);
    setTimeout(() => this.positionPanelNearNode(node.id), 0);
    // Reset signal żeby ten sam node mógł być re-openowany.
    setTimeout(() => this.uiBus.openDetailsForNode.set(null), 50);
  });

  protected readonly editorOpen   = signal(false);
  protected readonly currentSprint   = signal<{ name: string; startDate: string | null; finishDate: string | null } | null>(null);
  protected readonly selectedNode    = signal<DiagramNode | null>(null);

  // ── Mode (Live vs What-if) ──────────────────────────────────────────────────
  protected readonly mode            = signal<'live' | 'whatif'>('live');
  protected readonly whatifAgeMin    = signal<number | null>(null);
  protected readonly scenarios       = signal<string[]>([]);
  protected readonly showScenarios   = signal(false);
  protected readonly liveStateCache  = signal<any | null>(null);

  protected isLive(): boolean { return this.mode() === 'live'; }

  protected async startWhatIf(): Promise<void> {
    this.mode.set('whatif');
    this.logAudit('Started what-if scenario');
  }

  protected async backToLive(): Promise<void> {
    if (!confirm('Discard local changes and return to ADO live data?')) return;
    try {
      await fetch('/api/state?mode=whatif', { method: 'DELETE' });
    } catch {}
    this.mode.set('live');
    await this.restoreFromServer();
    this.logAudit('Back to live ADO state');
  }

  protected async saveCurrentScenario(): Promise<void> {
    const name = prompt('Nazwa scenariusza (a-z, 0-9, -, _, space, max 64 znaki):');
    if (!name) return;
    const cleaned = name.trim().replace(/[^a-zA-Z0-9 _-]/g, '');
    if (!cleaned) { alert('Nieprawidłowa nazwa'); return; }
    const state = this.snapshotState();
    try {
      const res = await fetch(`/api/state?save-scenario=${encodeURIComponent(cleaned)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      if (res.ok) {
        this.logAudit(`Saved scenario: ${cleaned}`);
        await this.refreshScenarioList();
        alert(`Zapisano scenariusz: ${cleaned}`);
      }
    } catch (err) {
      console.warn('[scenario save] failed', err);
    }
  }

  protected async refreshScenarioList(): Promise<void> {
    try {
      const res = await fetch('/api/state?scenarios=list');
      const { scenarios } = await res.json();
      this.scenarios.set(scenarios ?? []);
    } catch {}
  }

  protected async toggleScenarios(): Promise<void> {
    const showing = !this.showScenarios();
    this.showScenarios.set(showing);
    if (showing) await this.refreshScenarioList();
  }

  protected async loadScenario(name: string): Promise<void> {
    try {
      const res = await fetch(`/api/state?scenario=${encodeURIComponent(name)}`);
      const { state } = await res.json();
      if (!state) { alert('Scenariusz nieznaleziony'); return; }
      this.mode.set('whatif');
      await this.applyStateToBoard(state);
      this.showScenarios.set(false);
      this.logAudit(`Loaded scenario: ${name}`);
    } catch {}
  }

  protected async deleteScenario(name: string): Promise<void> {
    if (!confirm(`Usunąć scenariusz "${name}"?`)) return;
    try {
      await fetch(`/api/state?scenario=${encodeURIComponent(name)}`, { method: 'DELETE' });
      await this.refreshScenarioList();
      this.logAudit(`Deleted scenario: ${name}`);
    } catch {}
  }

  private async applyStateToBoard(state: any): Promise<void> {
    const laneIds = new Set(
      (this.modelService.nodes() as DiagramNode[]).filter(n => n.type === 'swimlane').map(n => n.id),
    );
    if (this.loadedNodeIds.length) this.modelService.deleteNodes(this.loadedNodeIds);
    if (this.loadedEdgeIds.length) this.modelService.deleteEdges(this.loadedEdgeIds);
    if (Array.isArray(state.users))   this.dataStore.setUsers(state.users);
    if (Array.isArray(state.testers)) this.testers.set(state.testers);
    if (state.sprint?.startISO && state.sprint?.days) {
      const [y, m, d2] = state.sprint.startISO.split('-').map(Number);
      setSprintCalendar(new Date(y, m - 1, d2), state.sprint.days);
    }
    if (state.sprint?.iteration) this.currentSprint.set(state.sprint.iteration);
    // Override z env (ADO_QA_TESTERS / ADO_DEVS) zanim zbudujemy lanes — żeby
    // testerzy/devy promoted w env od razu pojawili się jako lane labels, bez
    // race condition gdzie cache pokazuje stary skład.
    await this.refreshIterationData();
    this.rebuildLanes();
    const restoredNodes = (state.nodes ?? []).filter((n: any) => !laneIds.has(n.id));
    const restoredEdges = state.edges ?? [];
    // Stale widths/heights — saved state może pochodzić z poprzedniej formuły
    // widthForHours/NODE_H. Liczymy poprawne wartości z `phaseHours` zanim wrzucimy
    // do modelu, żeby karty nie nakładały się na siebie.
    // Plus `autoSize: false` + `size` — bez tego ng-diagram NodeSizeDirective dla
    // custom node type resetuje inline width i wszystkie karty mają jednolitą
    // (content-based) szerokość. Saved state nie ma tych pól.
    for (const n of restoredNodes) {
      if (!n.data) continue;
      if (n.type === 'pbi') {
        const hours = n.data['phaseHours'] as number | undefined;
        n.data.width  = widthForHours(hours);
        n.data.height = L.NODE_H;
        n.autoSize = false;
        n.size = { width: n.data.width, height: L.NODE_H };
      } else if (n.type === 'qa-task') {
        n.data.height = L.NODE_H;
        n.autoSize = false;
        n.size = { width: n.data.width ?? 328, height: L.NODE_H };
      }
    }
    this.modelService.addNodes(restoredNodes);
    this.modelService.addEdges(restoredEdges);
    this.loadedNodeIds = restoredNodes.map((n: any) => n.id);
    this.loadedEdgeIds = restoredEdges.map((e: any) => e.id);
    this.applyCommentBadgesToNodes();
    this.markWhatIfDiff();
    this.sprint.isLoaded.set(true);
  }

  /** Po what-if loadzie — porównanie do liveStateCache i oznaczenie diffów. */
  private markWhatIfDiff(): void {
    const live = this.liveStateCache();
    if (!live?.nodes) return;
    const livePosMap = new Map<string, any>();
    for (const n of live.nodes) livePosMap.set(n.id, n);
    const updates: NodeUpdate[] = [];
    for (const n of this.modelService.nodes() as DiagramNode[]) {
      if (n.type !== 'pbi' && n.type !== 'qa-task') continue;
      const liveNode = livePosMap.get(n.id);
      if (!liveNode) continue;
      const movedX = Math.abs((n.position.x ?? 0) - (liveNode.position?.x ?? 0)) > 1;
      const movedY = Math.abs((n.position.y ?? 0) - (liveNode.position?.y ?? 0)) > 1;
      const resized = (n.data?.['width'] ?? 0) !== (liveNode.data?.['width'] ?? 0);
      const isModified = movedX || movedY || resized;
      if (!!n.data?.['whatifModified'] !== isModified) {
        updates.push({ id: n.id, data: { ...n.data, whatifModified: isModified } });
      }
    }
    if (updates.length) this.modelService.updateNodes(updates);
  }

  // ── Audit log ───────────────────────────────────────────────────────────────
  protected readonly auditEntries = signal<{ ts: string; who: string; what: string; cardId?: string }[]>([]);
  protected readonly showAudit    = signal(false);

  protected async toggleAuditLog(): Promise<void> {
    const showing = !this.showAudit();
    this.showAudit.set(showing);
    if (showing) {
      try {
        const res = await fetch('/api/audit');
        const { entries } = await res.json();
        this.auditEntries.set(entries ?? []);
      } catch {}
    }
  }

  private logAudit(what: string, cardId?: string, before?: string, after?: string): void {
    // Fire and forget — nie blokujemy UI.
    fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ who: localStorage.getItem('sprint_who') ?? 'anon', what, cardId, before, after }),
    }).catch(() => {});
  }

  /** Pozwala useremu wpisać swoje imię raz na browser (gdzieś w details panelu lub topbarze). */
  protected setMyName(name: string): void {
    if (!name?.trim()) return;
    localStorage.setItem('sprint_who', name.trim().slice(0, 64));
  }
  protected myName(): string {
    return localStorage.getItem('sprint_who') ?? '';
  }

  // ── Snapshot browser ────────────────────────────────────────────────────────
  protected readonly snapshotList   = signal<string[]>([]);
  protected readonly showSnapshots  = signal(false);
  protected readonly viewingSnapshot = signal<string | null>(null);

  async toggleSnapshotBrowser(): Promise<void> {
    const showing = !this.showSnapshots();
    this.showSnapshots.set(showing);
    if (showing && this.snapshotList().length === 0) {
      try {
        const res = await fetch('/api/state?snapshots=list');
        const { days } = await res.json();
        this.snapshotList.set(days ?? []);
      } catch {}
    }
  }

  async loadSnapshotByDate(date: string): Promise<void> {
    try {
      const res = await fetch(`/api/state?snapshot=${date}`);
      const { state } = await res.json();
      if (!state) {
        alert('Brak snapshotu z tego dnia.');
        return;
      }
      // Replace current state from snapshot (jak restore)
      const laneIds = new Set(
        (this.modelService.nodes() as DiagramNode[])
          .filter(n => n.type === 'swimlane').map(n => n.id),
      );
      if (this.loadedNodeIds.length) this.modelService.deleteNodes(this.loadedNodeIds);
      if (this.loadedEdgeIds.length) this.modelService.deleteEdges(this.loadedEdgeIds);
      if (Array.isArray(state.users))   this.dataStore.setUsers(state.users);
      if (Array.isArray(state.testers)) this.testers.set(state.testers);
      if (state.sprint?.startISO && state.sprint?.days) {
        const [y, m, d2] = state.sprint.startISO.split('-').map(Number);
        setSprintCalendar(new Date(y, m - 1, d2), state.sprint.days);
      }
      this.rebuildLanes();
      const restoredNodes = (state.nodes ?? []).filter((n: any) => !laneIds.has(n.id));
      const restoredEdges = state.edges ?? [];
      this.modelService.addNodes(restoredNodes);
      this.modelService.addEdges(restoredEdges);
      this.loadedNodeIds = restoredNodes.map((n: any) => n.id);
      this.loadedEdgeIds = restoredEdges.map((e: any) => e.id);
      this.viewingSnapshot.set(date);
      this.showSnapshots.set(false);
      this.sprint.isLoaded.set(true);
    } catch (err) {
      console.warn('[snapshot] load failed', err);
    }
  }

  async returnToCurrent(): Promise<void> {
    this.viewingSnapshot.set(null);
    await this.restoreFromServer();
  }

  // ── Comments per card ───────────────────────────────────────────────────────
  protected readonly comments      = signal<Record<string, { text: string; author: string; updatedAt: string }>>({});
  protected readonly editingComment = signal<string>('');

  private async loadComments(): Promise<void> {
    try {
      const res = await fetch('/api/comments');
      if (!res.ok) return;
      const { comments } = await res.json();
      this.comments.set(comments ?? {});
      this.applyCommentBadgesToNodes();
    } catch {}
  }

  private applyCommentBadgesToNodes(): void {
    const c = this.comments();
    const all = this.modelService.nodes() as DiagramNode[];
    const updates: NodeUpdate[] = [];
    for (const n of all) {
      if (n.type !== 'pbi') continue;
      const id = (n.data?.['displayId'] ?? n.id) as string;
      const has = !!c[id]?.text;
      if (!!n.data?.['hasComment'] !== has) {
        updates.push({ id: n.id, data: { ...n.data, hasComment: has } });
      }
    }
    if (updates.length) this.modelService.updateNodes(updates);
  }

  protected commentForSelected(): { text: string; author: string; updatedAt: string } | null {
    const node = this.selectedNode();
    if (!node) return null;
    const id = (node.data?.['displayId'] ?? node.data?.['pbiId'] ?? node.id) as string;
    return this.comments()[id] ?? null;
  }

  protected async saveComment(): Promise<void> {
    const node = this.selectedNode();
    if (!node) return;
    const cardId = (node.data?.['displayId'] ?? node.data?.['pbiId'] ?? node.id) as string;
    const text = this.editingComment().trim();
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId, text, author: 'team' }),
      });
      if (res.ok) {
        await this.loadComments();
        this.applyCommentBadgesToNodes();
        this.logAudit(text ? 'added comment' : 'removed comment', cardId);
      }
    } catch {}
  }

  protected startEditingComment(): void {
    const existing = this.commentForSelected();
    this.editingComment.set(existing?.text ?? '');
  }

  // ── Auto-refresh nowych bugów ───────────────────────────────────────────────
  protected readonly newBugsCount = signal(0);
  private knownPbiIds = new Set<string>();
  private bugPollTimer: ReturnType<typeof setInterval> | null = null;

  private startBugPolling(): void {
    if (this.bugPollTimer) return;
    // Co 5 min sprawdzaj czy są nowe karty.
    this.bugPollTimer = setInterval(() => this.checkForNewBugs(), 5 * 60 * 1000);
  }

  private startAdoAutoRefresh(): void {
    // Co 10 min w tle: tylko jak jesteśmy w live mode i są dane.
    setInterval(() => {
      if (this.isLive() && this.sprint.isLoaded()) {
        this.loadFromAdo().catch(() => {});
      }
    }, 10 * 60 * 1000);
  }

  private async checkForNewBugs(): Promise<void> {
    if (!this.sprint.isLoaded()) return;
    try {
      const wiqlRes = await fetch('/api/ado/wiql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!wiqlRes.ok) return;
      const data = await wiqlRes.json();
      const currentIds = new Set<string>((data.workItems ?? []).map((w: any) => String(w.id)));
      let newCount = 0;
      for (const id of currentIds) if (!this.knownPbiIds.has(id)) newCount++;
      if (newCount > 0) {
        this.newBugsCount.set(newCount);
      }
    } catch (err) { console.warn('[bug poll]', err); }
  }

  protected dismissNewBugsBanner(): void {
    this.newBugsCount.set(0);
    // Po dismiss zaznacz aktualnych jako "known".
    this.knownPbiIds = new Set(this.dataStore.pbis().map(p => p.id));
  }

  // ── Yesterday → today diff ──────────────────────────────────────────────────
  protected readonly showDiff      = signal(false);
  protected readonly diffSummary   = signal<{ changed: number; closed: number; added: number; reEstimated: number } | null>(null);
  private yesterdayStateCache: any = null;

  async toggleDiff(): Promise<void> {
    if (this.showDiff()) {
      this.showDiff.set(false);
      this.diffSummary.set(null);
      this.clearDiffHighlights();
      return;
    }
    // Pobierz wczorajszy (lub najstarszy dostępny) snapshot.
    try {
      const listRes = await fetch('/api/state?snapshots=list');
      const { days } = await listRes.json();
      if (!days?.length) {
        this.diffSummary.set({ changed: 0, closed: 0, added: 0, reEstimated: 0 });
        this.showDiff.set(true);
        return;
      }
      // Wybierz wczorajszy lub najświeższy z dostępnych <today.
      const today = new Date().toISOString().slice(0, 10);
      const yesterdayKey = days.find((d: string) => d < today) ?? days[0];
      const snapRes = await fetch(`/api/state?snapshot=${yesterdayKey}`);
      const { state } = await snapRes.json();
      this.yesterdayStateCache = state;
      this.computeDiff(state);
      this.showDiff.set(true);
    } catch (err) {
      console.warn('[diff] failed', err);
    }
  }

  private computeDiff(yesterday: any): void {
    if (!yesterday?.nodes) return;
    const todayNodes = this.modelService.nodes() as DiagramNode[];
    const yesterdayMap = new Map<string, any>();
    for (const n of yesterday.nodes) yesterdayMap.set(n.id, n);

    let changed = 0, closed = 0, added = 0, reEstimated = 0;
    const updates: NodeUpdate[] = [];
    for (const n of todayNodes) {
      if (n.type !== 'pbi' && n.type !== 'qa-task') continue;
      const yNode = yesterdayMap.get(n.id);
      if (!yNode) {
        added++;
        updates.push({ id: n.id, data: { ...n.data, diffFlag: 'added' } });
        continue;
      }
      const yState = yNode.data?.['state'] as string | undefined;
      const tState = n.data?.['state'] as string | undefined;
      const yHours = yNode.data?.['phaseHours'] as number | undefined;
      const tHours = n.data?.['phaseHours'] as number | undefined;
      const isDone = (s?: string) => this.cat(s) === 'done' || this.cat(s) === 'stage';
      if (tState !== yState && isDone(tState) && !isDone(yState)) {
        closed++;
        updates.push({ id: n.id, data: { ...n.data, diffFlag: 'closed' } });
      } else if (tState !== yState) {
        changed++;
        updates.push({ id: n.id, data: { ...n.data, diffFlag: 'changed' } });
      } else if (typeof tHours === 'number' && typeof yHours === 'number' && tHours > yHours) {
        reEstimated++;
        updates.push({ id: n.id, data: { ...n.data, diffFlag: 'reEstimated', diffHoursDelta: tHours - yHours } });
      }
    }
    if (updates.length) this.modelService.updateNodes(updates);
    this.diffSummary.set({ changed, closed, added, reEstimated });
  }

  private clearDiffHighlights(): void {
    const all = this.modelService.nodes() as DiagramNode[];
    const updates: NodeUpdate[] = [];
    for (const n of all) {
      if (!n.data?.['diffFlag']) continue;
      const d = { ...n.data };
      delete d['diffFlag'];
      delete d['diffHoursDelta'];
      updates.push({ id: n.id, data: d });
    }
    if (updates.length) this.modelService.updateNodes(updates);
  }

  // ── Filters ─────────────────────────────────────────────────────────────────
  protected readonly filterAssignee = signal<string | null>(null); // assignee id (slug) lub null = all
  protected readonly hideDone       = signal(false);
  protected readonly onlyBlocked    = signal(false);

  protected toggleAssigneeFilter(id: string): void {
    this.filterAssignee.set(this.filterAssignee() === id ? null : id);
    this.applyFiltersToNodes();
  }
  protected toggleHideDone(): void {
    this.hideDone.set(!this.hideDone());
    this.applyFiltersToNodes();
  }
  protected toggleOnlyBlocked(): void {
    this.onlyBlocked.set(!this.onlyBlocked());
    this.applyFiltersToNodes();
  }
  protected async onNodeDragStarted(event: any): Promise<void> {
    if (this.isLive()) {
      // Live mode = read-only. Drag jest blokowany przez automatyczny exit-what-if,
      // ale żeby drag w ogóle ruszył w ng-diagram, musimy przejść w what-if mode
      // PRZED tym dragiem. UX: pierwszy drag automatycznie wchodzi w what-if.
      this.mode.set('whatif');
    }
    this.drag.onDragStarted(event);
  }

  protected daysFromDx(dx: number): string {
    const days = dx / L.DAY_W;
    const sign = days > 0 ? '+' : '';
    return `${sign}${days.toFixed(1)}`;
  }

  protected initialsOf(name: string): string {
    return name.split(' ').map(p => p[0]).filter(Boolean).join('').toUpperCase().slice(0, 2);
  }

  protected clearFilters(): void {
    this.filterAssignee.set(null);
    this.hideDone.set(false);
    this.onlyBlocked.set(false);
    this.applyFiltersToNodes();
  }

  private applyFiltersToNodes(): void {
    const fa = this.filterAssignee();
    const hd = this.hideDone();
    const ob = this.onlyBlocked();
    const all = this.modelService.nodes() as DiagramNode[];
    const updates: NodeUpdate[] = [];
    for (const n of all) {
      if (n.type !== 'pbi' && n.type !== 'qa-task') continue;
      const cat = this.cat(n.data?.['state'] as string | undefined);
      const matchesAssignee = !fa || n.data?.['primaryAssignee'] === fa;
      const matchesDone     = !hd || (cat !== 'done' && cat !== 'stage');
      const matchesBlocked  = !ob || cat === 'blocked';
      const visible = matchesAssignee && matchesDone && matchesBlocked;
      const newOpacity = visible ? 1 : 0.15;
      if ((n.data?.['filterOpacity'] ?? 1) !== newOpacity) {
        updates.push({ id: n.id, data: { ...n.data, filterOpacity: newOpacity } });
      }
    }
    if (updates.length) this.modelService.updateNodes(updates);
  }

  /** % effortu zrobionego — done states / total. */
  protected readonly sprintEffortPct = computed(() => {
    const pbis = this.dataStore.pbis();
    if (!pbis.length) return 0;
    let totalH = 0, doneH = 0;
    for (const p of pbis) {
      for (const ph of p.phases) {
        const h = (ph as any).hours ?? ph.days * 6;
        totalH += h;
        const cat = (p as any).state ? this.cat((p as any).state) : 'unknown';
        if (cat === 'done' || cat === 'stage' || cat === 'qaTest' || cat === 'qaOwner') doneH += h;
      }
    }
    return totalH ? Math.round((doneH / totalH) * 100) : 0;
  });

  /** % czasu sprintu który już minął. */
  protected readonly sprintTimePct = computed(() => {
    const cs = this.currentSprint();
    if (!cs?.startDate || !cs?.finishDate) return 0;
    const start = new Date(cs.startDate).getTime();
    const end = new Date(cs.finishDate).getTime();
    const now = Date.now();
    if (now <= start) return 0;
    if (now >= end)   return 100;
    return Math.round(((now - start) / (end - start)) * 100);
  });

  protected readonly sprintBehind = computed(() =>
    this.sprintEffortPct() < this.sprintTimePct() - 5
  );

  /** Inline category fn — DRY z stateAccentColor logic. */
  private cat(s: string | undefined): string {
    if (!s) return 'unknown';
    const x = s.toLowerCase();
    if (x.includes('blocked'))                return 'blocked';
    if (/^0?9|closed|resolved|done/.test(x))  return 'done';
    if (x.startsWith('08')) return 'stage';
    if (x.startsWith('07.'))return 'qaOwner';
    if (x.startsWith('07')) return 'qaTest';
    if (x.startsWith('06')) return 'qaDeploy';
    if (x.startsWith('05')) return 'review';
    if (x.startsWith('04')) return 'inDev';
    return 'new';
  }
  protected readonly detailsPanelPos = signal<{ x: number; y: number } | null>(null);
  protected readonly copyLinkOk      = signal(false);
  private lastClickCoords: { x: number; y: number } | null = null;
  protected readonly nodeTitle    = signal('');
  protected readonly nodeColor    = signal('#6366f1');

  private loadedNodeIds: string[]    = [];
  private loadedEdgeIds: string[]    = [];
  private loadedBugNodeIds: string[] = [];
  private loadedBugEdgeIds: string[] = [];
  private manualCounter = 0;

  readonly nodeTemplateMap = new NgDiagramNodeTemplateMap([
    ['swimlane', SwimlaneComponent],
    ['pbi',      PbiNodeComponent],
    ['qa-task',  QaTaskComponent],
  ]);
  readonly edgeTemplateMap = new NgDiagramEdgeTemplateMap([
    ['dep',     DepEdgeComponent],
    ['handoff', DepEdgeComponent],
    ['qa',      DepEdgeComponent],
  ]);

  readonly testers = signal<{ id: string; name: string }[]>([]);

  readonly model = initializeModel({ nodes: this.buildLanes(), edges: [] });

  readonly diagramConfig = signal<NgDiagramConfig>({
    linking: {
      portSnapDistance: 60,
      validateConnection: (source: any, sourcePort: any, target: any, targetPort: any) => {
        console.log('[validateConnection]', {
          sourceType: source?.type, sourceId: source?.id,
          sourcePortId: sourcePort?.id,
          targetType: target?.type, targetId: target?.id,
          targetPortId: targetPort?.id,
        });
        if (!source || !target) return false;
        if (source.id === target.id) return false;
        // dep: pbi out → pbi (different displayId)
        if (source.type === 'pbi' && target.type === 'pbi' && sourcePort?.id === 'out') {
          return source.data?.['displayId'] !== target.data?.['displayId'];
        }
        // qa: pbi qa → qa-task
        if (source.type === 'pbi' && target.type === 'qa-task' && sourcePort?.id === 'qa') {
          return true;
        }
        return false;
      },
      finalEdgeDataBuilder: (edge: any) => {
        const isQa = edge.sourcePort === 'qa';
        return {
          ...edge,
          type:   isQa ? 'qa'  : 'dep',
          zOrder: 5,
          data:   { edgeType: isQa ? 'qa' : 'dep' },
        };
      },
    },
  });

  ngAfterViewInit(): void {
    this.restoreFromServer();
    this.startAutoSave();
    this.startBugPolling();
    this.startAdoAutoRefresh();
    this.loadComments();
    document.addEventListener('click', this.outsideClickCapture, true);
  }

  private outsideClickCapture = (e: MouseEvent) => {
    if (!this.selectedNode()) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('.node-details-panel')) return;            // klik w panel → zostaje
    if (target.closest('.pbi-card, .qa-card, app-pbi-node, app-qa-task')) return;  // klik w kartę → switch obsługuje onSelectionChanged
    this.closeDetails();
  };

  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSavedJson = '';

  private snapshotState() {
    return {
      version:  1,
      users:    this.dataStore.users(),
      testers:  this.testers(),
      sprint:   {
        startISO: this.sprintStartISO(),
        days:     this.sprintDays(),
        iteration: this.currentSprint(),
      },
      nodes:    this.modelService.nodes(),
      edges:    this.modelService.edges(),
    };
  }

  private async saveStateToServer(): Promise<void> {
    // W LIVE mode nic nie zapisujemy — live to read-only copy ADO.
    if (this.isLive()) return;
    const state = this.snapshotState();
    const json = JSON.stringify(state);
    if (json === this.lastSavedJson) return;
    try {
      const res = await fetch('/api/state?mode=whatif', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    json,
      });
      if (res.ok) {
        this.lastSavedJson = json;
        this.markWhatIfDiff();
      }
    } catch (err) {
      console.warn('[state] save failed', err);
    }
  }

  private startAutoSave(): void {
    setInterval(() => {
      if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = setTimeout(() => this.saveStateToServer(), 100);
    }, 2000);
  }

  private sprintStartISO(): string {
    const d = SPRINT_START;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private sprintDays(): number {
    return SPRINT_DAYS;
  }

  /**
   * Lightweight fetch iteration metadata (qaTesters / devs lists z env) i
   * override testers + users baseline. NIE woła `rebuildLanes()` — caller
   * powinien zrobić to po, używając już zaktualizowanych signal-i. Inaczej
   * cache→env→cache race tworzy migotanie / brak label-i.
   */
  private async refreshIterationData(): Promise<void> {
    try {
      const res = await fetch('/api/ado/iteration');
      if (!res.ok) return;
      const it = await res.json();

      const qaTesterNames = ((it.qaTesters ?? []) as string[]).map(s => s.trim()).filter(Boolean);
      const seededTesters = qaTesterNames.map(name => ({ id: 'qa-' + slugifyUser(name), name }));
      this.testers.set(seededTesters);

      const devNames = ((it.devs ?? []) as string[]).map(s => s.trim()).filter(Boolean);
      const existing = this.dataStore.users();
      // Remove devs z `existing` którzy są teraz testerami — inaczej Damian
      // siedział w obu lanach (dev + QA) → wizualnie podwójny label.
      const testerIds = new Set(seededTesters.map(t => t.id));
      const existingTrimmed = existing.filter(u => !testerIds.has('qa-' + u.id));
      const ids = new Set(existingTrimmed.map(u => u.id));
      const merged = [...existingTrimmed];
      for (const name of devNames) {
        const id = slugifyUser(name);
        if (testerIds.has('qa-' + id)) continue; // nie wracaj testera do dev list
        if (!ids.has(id)) { merged.push({ id, name }); ids.add(id); }
      }
      this.dataStore.setUsers(merged);
    } catch (err) {
      console.warn('[refreshIterationData] failed', err);
    }
  }

  private async restoreFromServer(): Promise<void> {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) return;
      const { live, whatif, whatifAgeSec } = await res.json();
      if (!live) return;

      this.liveStateCache.set(live);

      // What-if jest świeży (<4h)? Załaduj go i ustaw mode='whatif'.
      // Inaczej: ignoruj stary what-if, ładuj live, mode='live'.
      const useWhatIf = whatif && whatifAgeSec !== null && whatifAgeSec < 4 * 60 * 60;
      const stateToApply = useWhatIf ? whatif : live;
      this.mode.set(useWhatIf ? 'whatif' : 'live');
      this.whatifAgeMin.set(whatifAgeSec !== null ? Math.round(whatifAgeSec / 60) : null);

      await this.applyStateToBoard(stateToApply);
      this.lastSavedJson = JSON.stringify(this.snapshotState());

      // W live mode po pokazaniu cache'a ładujemy świeże dane z ADO, żeby
      // nadpisać ewentualnie nieaktualne pozycje/szerokości (formuła layoutu
      // mogła się zmienić od ostatniego zapisu live cache na serwerze).
      // Whatif mode pominięty — `applyStateToBoard` już zrobił `refreshIterationData`
      // przed buildem lanes, więc env-seeded testers/devs są na miejscu.
      if (!useWhatIf) {
        this.loadFromAdo().catch(() => {});
      }
    } catch (err) {
      console.warn('[state] restore failed', err);
    }
  }

  fitView(): void {
    this.viewportService.zoomToFit({ padding: 20 });
  }

  onSelectionChanged(_event: any): void {
    // Click w kartę = tylko selekcja w ng-diagram (potrzebne do dragu).
    // Details panel otwiera tylko przycisk ⓘ na karcie (przez UiBusService).
  }

  /** Zamknij panel + zdeseleckuj kartę w ng-diagram (żeby kolejny klik znów selekcjonował). */
  private closeDetails(): void {
    this.selectedNode.set(null);
    this.detailsPanelPos.set(null);
    try { this.selectionService.deselectAll(); } catch {}
  }

  /** Wrapper dostępny z template (private nie jest widoczny). */
  protected closeDetailsFromTemplate(): void { this.closeDetails(); }


  private positionPanelNearNode(nodeId: string): void {
    // ng-diagram renderuje nodes z `id` HTML lub `data-node-id`. Próbujemy oba.
    const el =
      document.querySelector(`[data-node-id="${nodeId}"]`) ??
      document.getElementById(nodeId) ??
      document.querySelector(`[data-id="${nodeId}"]`);
    if (!el || !(el instanceof HTMLElement)) {
      this.detailsPanelPos.set({ x: 16, y: 80 });
      return;
    }
    const rect = el.getBoundingClientRect();
    const PANEL_W = 340;
    const PANEL_H_MAX = 420;
    const margin = 14;
    // Domyślnie na prawo od karty; jak nie ma miejsca → na lewo; jak też nie → poniżej.
    let x = rect.right + margin;
    let y = rect.top;
    if (x + PANEL_W > window.innerWidth - 12) {
      x = rect.left - PANEL_W - margin;
    }
    if (x < 12) {
      x = Math.max(12, rect.left);
      y = rect.bottom + margin;
    }
    y = Math.min(Math.max(12, y), window.innerHeight - PANEL_H_MAX - 12);
    this.detailsPanelPos.set({ x, y });
  }

  protected copyAdoLink(): void {
    const url = this.adoUrlForSelected();
    if (url === '#') return;
    navigator.clipboard.writeText(url).then(() => {
      this.copyLinkOk.set(true);
      setTimeout(() => this.copyLinkOk.set(false), 1500);
    }).catch(() => {});
  }

  protected groupedTaskTitlesForSelected(): string[] {
    const node = this.selectedNode();
    if (!node) return [];
    const raw = node.data?.['groupTaskTitles'];
    return Array.isArray(raw) ? raw as string[] : [];
  }

  protected assigneeNameForSelected(): string {
    const node = this.selectedNode();
    if (!node) return '';
    const uid = node.data?.['primaryAssignee'] as string | undefined;
    if (!uid) return 'Unassigned';
    return this.dataStore.users().find(u => u.id === uid)?.name ?? uid;
  }

  /** Day kiedy ostatnia faza tego PBI się kończy (kiedy QA może wziąć kartę). */
  protected etaToQaForSelected(): string {
    const node = this.selectedNode();
    if (!node || node.type !== 'pbi') return '';
    const pbiId = node.data?.['displayId'] as string | undefined;
    if (!pbiId) return '';
    const allNodes = this.modelService.nodes() as DiagramNode[];
    const phases = allNodes.filter(n => n.type === 'pbi' && (n.data?.['displayId'] as string) === pbiId);
    if (!phases.length) return '';
    const maxEnd = Math.max(...phases.map(p => (p.data?.['endDay'] as number) ?? 0));
    if (!maxEnd) return '';
    return `D${maxEnd}`;
  }

  protected adoUrlForSelected(): string {
    const node = this.selectedNode();
    if (!node) return '#';
    const id = (node.data?.['displayId'] ?? node.data?.['pbiId']) as string | undefined;
    if (!id) return '#';
    // ADO_ORG i ADO_PROJECT są publiczne (są w URL-u team boarda), wystarczy hardkod
    return `https://dev.azure.com/pwc-us-tax-tech/Mezzanine/_workitems/edit/${id}`;
  }

  applyNodeTitle(title: string): void {
    const node = this.selectedNode();
    if (!node) return;
    this.modelService.updateNodes([{ id: node.id, data: { ...node.data, title } }]);
  }

  applyNodeColor(color: string): void {
    const node = this.selectedNode();
    if (!node) return;
    this.modelService.updateNodes([{ id: node.id, data: { ...node.data, color } }]);
  }

  onSelectionRemoved(event: { deletedNodes: any[]; deletedEdges: any[] }): void {
    for (const edge of event.deletedEdges ?? []) {
      // Remove from tracking list
      const idx = this.loadedEdgeIds.indexOf(edge.id);
      if (idx !== -1) this.loadedEdgeIds.splice(idx, 1);

      const edgeType = edge.data?.['edgeType'] as string | undefined;

      // Clean up liveDeps for dep/handoff edges: source was a dep of target
      if ((edgeType === 'dep' || edgeType === 'handoff') && edge.source && edge.target) {
        const deps = this.sprint.liveDeps.get(edge.target) ?? [];
        const updated = deps.filter((d: string) => d !== edge.source);
        if (updated.length !== deps.length) this.sprint.liveDeps.set(edge.target, updated);
      }

      // Clean up liveQaLinks for qa edges
      if (edgeType === 'qa' && edge.source) {
        if (this.sprint.liveQaLinks.get(edge.source) === edge.target) {
          this.sprint.liveQaLinks.delete(edge.source);
        }
      }
    }
  }

  onEdgeDrawn(event: EdgeDrawnEvent): void {
    if (event.sourcePort === 'out' && event.targetPort === 'in') {
      const targetDeps = this.sprint.liveDeps.get(event.target.id) ?? [];
      if (!targetDeps.includes(event.source.id)) {
        this.sprint.liveDeps.set(event.target.id, [...targetDeps, event.source.id]);
      }
    }

    if (event.sourcePort === 'qa') {
      const pbi    = event.source as any;
      const qaNode = event.target as any;

      this.sprint.liveQaLinks.set(pbi.id, qaNode.id);

      const minX = pbi.position.x + (pbi.data?.['width'] ?? 0) + L.PAD;
      const updates: NodeUpdate[] = [];
      if (qaNode.position.x < minX) {
        updates.push({ id: qaNode.id, position: { x: minX, y: qaNode.position.y } });
      }
      if (updates.length > 0) {
        resolveQaCollisions(updates, this.modelService.nodes() as DiagramNode[]);
        this.modelService.updateNodes(updates);
      }
    }

    this.loadedEdgeIds.push(event.edge.id);
  }

  addManualPbi(): void {
    const id      = `manual-pbi-${++this.manualCounter}`;
    const users   = this.dataStore.users();
    const y       = L.HEADER_H + Math.round((L.ROW_H - L.NODE_H) / 2);
    const node: DiagramNode = {
      id, type: 'pbi', zOrder: 10,
      position: { x: L.LABEL_W + L.PAD, y },
      data: {
        id, displayId: id, title: 'New PBI',
        color: '#6366f1',
        primaryAssignee: '',
        collaborators: [], dependencies: [],
        startDay: 1, endDay: 1,
        width: L.DAY_W - 2 * L.PAD, height: L.NODE_H,
        phaseRole: '', isBugType: false, phaseIdx: 0, totalPhases: 1,
      },
    };
    this.sprint.liveAssignee.set(id, 'unassigned');
    this.sprint.liveDeps.set(id, []);
    this.loadedNodeIds.push(id);
    this.modelService.addNodes([node]);
  }

  addManualQaTask(): void {
    const id    = `manual-qa-${++this.manualCounter}`;
    const users = this.dataStore.users();
    const y     = L.HEADER_H + (users.length + 1) * L.ROW_H + Math.round((L.ROW_H - L.NODE_H) / 2);
    const node: DiagramNode = {
      id, type: 'qa-task', zOrder: 10,
      position: { x: L.LABEL_W + L.PAD, y },
      data: {
        pbiId: id, color: '#6366f1',
        endDay: 1,
        width: L.DAY_W - 2 * L.PAD, height: L.NODE_H,
      },
    };
    this.loadedNodeIds.push(id);
    this.modelService.addNodes([node]);
  }

  rebuildSprint(): void {
    this.resetDiagram();
    this.loadFromAdo();
  }

  // ── Sprint load / reset ───────────────────────────────────────────────────

  // Ustaw na true żeby pobierać z mock ADO serwera (localhost:3333)
  // Ustaw na false żeby używać hardcoded mocków z sprint-data.ts
  private readonly useAdo = true;

  async loadFromAdo(): Promise<void> {
    if (this.sprint.isLoading()) return;
    this.sprint.isLoading.set(true);

    let pbis    = this.dataStore.pbis();
    let users   = this.dataStore.users();
    let testers: { id: string; name: string }[] = this.testers();

    if (this.useAdo) {
      try {
        const result = await this.adoService.fetchSprintItems([]);
        pbis    = result.pbis;
        users   = result.users;
        testers = result.testers;
        this.dataStore.setUsers(users);
        this.testers.set(testers);
        this.knownPbiIds = new Set(pbis.map(p => p.id));
        this.newBugsCount.set(0);
        this.logAudit(`Reloaded from ADO — ${pbis.length} work items`);
        // Reload = wracamy do LIVE mode i zapisujemy świeży ADO state jako live.
        this.mode.set('live');
        // Usuwamy starszy what-if (był relevantny dla poprzedniego ADO state).
        try { await fetch('/api/state?mode=whatif', { method: 'DELETE' }); } catch {}

        if (result.iteration?.startDate && result.iteration.finishDate) {
          const days = countWorkingDays(result.iteration.startDate, result.iteration.finishDate);
          setSprintCalendar(result.iteration.startDate, days);
        }
        if (result.iteration) {
          this.currentSprint.set({
            name: result.iteration.name,
            startDate: result.iteration.startDate ? result.iteration.startDate.toISOString() : null,
            finishDate: result.iteration.finishDate ? result.iteration.finishDate.toISOString() : null,
          });
        }

        this.rebuildLanes();
      } catch (err) {
        console.error('[AdoService] fetch failed, falling back to mock data', err);
      }
    } else {
      await new Promise<void>(r => setTimeout(r, 1200));
    }

    const { nodes, edges, assigneeMap, depsMap } = buildNodesFromAdo(pbis, users, testers);
    this.sprint.applyMaps(assigneeMap, depsMap);

    // Sprzątamy poprzednio dodane PBI/QA/edges przed wrzuceniem nowych.
    // Bez tego drugi+ call do loadFromAdo robił stack duplikatów na tych samych ID-kach.
    if (this.loadedNodeIds.length) this.modelService.deleteNodes(this.loadedNodeIds);
    if (this.loadedEdgeIds.length) this.modelService.deleteEdges(this.loadedEdgeIds);

    this.loadedNodeIds = nodes.map(n => n.id);
    this.loadedEdgeIds = edges.map(e => e.id);

    this.modelService.addNodes(nodes);
    this.modelService.addEdges(edges);

    this.sprint.loadedStats.set({
      stories:  pbis.filter(p => p.type === 'Story').length,
      bugs:     pbis.filter(p => p.type === 'Bug').length,
      incoming: 0,
    });

    this.sprint.isLoading.set(false);
    this.sprint.isLoaded.set(true);

    // Po wczytaniu z ADO — zapisz świeży state jako LIVE (źródło prawdy).
    if (this.mode() === 'live') {
      const fresh = this.snapshotState();
      this.liveStateCache.set(fresh);
      this.lastSavedJson = JSON.stringify(fresh);
      fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(fresh),
      }).catch(err => console.warn('[state] live save failed', err));
    }
  }

  resetDiagram(): void {
    this.resetBugs();
    if (this.loadedNodeIds.length) this.modelService.deleteNodes(this.loadedNodeIds);
    if (this.loadedEdgeIds.length) this.modelService.deleteEdges(this.loadedEdgeIds);
    this.loadedNodeIds = [];
    this.loadedEdgeIds = [];
    this.sprint.clearState();
    this.sprint.isLoaded.set(false);
    this.sprint.loadedStats.set({ stories: 0, bugs: 0, incoming: 0 });
    this.sprint.clearUndo();
    // Wyczyść też shared state w Redis i ostatni zapisany snapshot, żeby restore
    // przy następnym otwarciu nie wciągnął starych danych.
    this.lastSavedJson = '';
    fetch('/api/state', { method: 'DELETE' }).catch(() => {});
  }

  // ── Incoming bug load / reset ─────────────────────────────────────────────

  async loadIncomingBugs(): Promise<void> {
    if (this.sprint.isBugsLoading() || this.sprint.isBugsLoaded()) return;
    this.sprint.isBugsLoading.set(true);

    await new Promise<void>(r => setTimeout(r, 600));

    const bugs = this.dataStore.incomingBugs();
    const { nodes, edges, assigneeMap, depsMap } = buildIncomingBugs(bugs);
    this.sprint.applyMaps(assigneeMap, depsMap);

    this.loadedBugNodeIds = nodes.map(n => n.id);
    this.loadedBugEdgeIds = edges.map(e => e.id);

    this.modelService.addNodes(nodes);
    this.modelService.addEdges(edges);

    this.sprint.loadedStats.update(s => ({ ...s, incoming: bugs.length }));

    this.sprint.isBugsLoading.set(false);
    this.sprint.isBugsLoaded.set(true);
  }

  resetBugs(): void {
    if (!this.sprint.isBugsLoaded()) return;
    const allBugIds  = [...this.loadedBugNodeIds];
    const bugEdgeIds = [...this.loadedBugEdgeIds];

    if (allBugIds.length)  this.modelService.deleteNodes(allBugIds);
    if (bugEdgeIds.length) this.modelService.deleteEdges(bugEdgeIds);

    for (const id of allBugIds) {
      this.sprint.liveAssignee.delete(id);
      this.sprint.liveDeps.delete(id);
    }

    this.loadedBugNodeIds = [];
    this.loadedBugEdgeIds = [];
    this.sprint.isBugsLoaded.set(false);
    this.sprint.loadedStats.update(s => ({ ...s, incoming: 0 }));
    this.sprint.clearUndo();
  }

  // ── Lane builder ──────────────────────────────────────────────────────────

  private rebuildLanes(): void {
    const existing = this.modelService.nodes() as DiagramNode[];
    const laneIds = existing
      .filter(n => n.type === 'swimlane')
      .map(n => n.id);
    if (laneIds.length) this.modelService.deleteNodes(laneIds);
    this.modelService.addNodes(this.buildLanes());
  }

  private buildLanes(): DiagramNode[] {
    const totalW = getTotalWidth();
    const users  = this.dataStore.users();

    const lane = (id: string, y: number, data: Record<string, unknown>): DiagramNode => ({
      id, type: 'swimlane', zOrder: 0, position: { x: 0, y }, data, draggable: false,
    });

    const testers = this.testers();
    // Jeśli mamy testerów z ADO → po jednej sub-lane per tester. Inaczej fallback do jednej generycznej QA.
    const qaLanes: DiagramNode[] = testers.length
      ? testers.map((t, i) =>
          lane(`lane-${t.id}`, L.HEADER_H + (users.length + 1 + i) * L.ROW_H,
            { label: `QA · ${t.name}`, width: totalW, height: L.ROW_H, isQA: true }))
      : [lane('lane-qa', L.HEADER_H + (users.length + 1) * L.ROW_H,
          { label: 'QA / Testing', width: totalW, height: L.ROW_H, isQA: true })];

    return [
      lane('hdr',           0,                                       { isHeader: true,  width: totalW, height: L.HEADER_H, sprintName: this.currentSprint()?.name ?? 'Sprint' }),
      lane('lane-incoming', L.HEADER_H,                              { label: 'Incoming', width: totalW, height: L.ROW_H, isIncoming: true }),
      ...users.map((user, i) =>
        lane(`lane-${user.id}`, L.HEADER_H + (i + 1) * L.ROW_H,    { label: user.name, width: totalW, height: L.ROW_H })
      ),
      ...qaLanes,
    ];
  }
}

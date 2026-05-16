export interface PBI {
  id: string;
  title: string;
  color: string;
  primaryAssignee: string;
  collaborators: string[];
  startDay: number;
  endDay: number;
  dependencies: string[];
}

/** Shape of a work item loaded from Azure DevOps */
export interface AdoPbi {
  id: string;
  title: string;
  color: string;
  priority: number;        // 1 = highest
  type: 'Story' | 'Bug';
  /** Ordered list of work phases; handed off from one assignee to the next */
  phases: { assigneeId: string; days: number; role: string; parallel?: boolean; title?: string; hours?: number }[];
  /** PBI IDs that must fully complete before this PBI can start */
  dependsOn?: string[];
  /** QA tester id (slugified display name) — z `Custom.QATester` w ADO */
  qaTesterId?: string;
  qaTesterName?: string;
  /** Raw state z `System.State` ADO — np. "04 - In Development", "97.1 - Blocked DEV" */
  state?: string;
}

/** Skategoryzowane state'y dla wizualizacji. */
export type StateCategory =
  | 'new'        // 01 - New, 03 - Committed
  | 'inDev'      // 04 - In Development
  | 'review'    // 05 - In Code Review
  | 'qaDeploy'  // 06.x - Deployed to QA
  | 'qaTest'    // 07 - In QA testing
  | 'qaOwner'   // 07.x - QA With Owner
  | 'stage'     // 08 - Ready for Stage Migration
  | 'done'       // 09+, Closed, Resolved
  | 'blocked'   // 97.x - Blocked*
  | 'unknown';

export function categorizeState(state: string | undefined): StateCategory {
  if (!state) return 'unknown';
  const s = state.toLowerCase();
  if (s.includes('blocked'))                       return 'blocked';
  if (/^0?9|closed|resolved|done/.test(s))         return 'done';
  if (s.startsWith('08'))                          return 'stage';
  if (s.startsWith('07.'))                         return 'qaOwner';
  if (s.startsWith('07'))                          return 'qaTest';
  if (s.startsWith('06'))                          return 'qaDeploy';
  if (s.startsWith('05'))                          return 'review';
  if (s.startsWith('04'))                          return 'inDev';
  if (/^0?1|^0?2|^0?3/.test(s))                    return 'new';
  return 'unknown';
}

/** Kolor akcent-bara karty wg kategorii state'u (overlay nad parent color). */
export function stateAccentColor(cat: StateCategory): string {
  switch (cat) {
    case 'blocked':  return '#ef4444';   // czerwony
    case 'inDev':    return '#eab308';   // żółty
    case 'review':   return '#a855f7';   // fioletowy
    case 'qaDeploy': return '#06b6d4';   // cyjan
    case 'qaTest':   return '#3b82f6';   // niebieski
    case 'qaOwner':  return '#8b5cf6';   // jasny fiolet
    case 'stage':    return '#10b981';   // zielony
    case 'done':     return '#22c55e';   // jasnozielony
    case 'new':      return '#94a3b8';   // szary
    default:         return '#666666';
  }
}

export function stateLabel(cat: StateCategory): string {
  switch (cat) {
    case 'blocked':  return '🚫 Blocked';
    case 'inDev':    return 'In Dev';
    case 'review':   return 'Review';
    case 'qaDeploy': return 'Deployed QA';
    case 'qaTest':   return 'In QA';
    case 'qaOwner':  return 'QA (Owner)';
    case 'stage':    return 'Ready Stage';
    case 'done':     return 'Done';
    case 'new':      return 'New';
    default:         return '';
  }
}

export interface SprintUser {
  id: string;
  name: string;
}

export let SPRINT_DAYS = 10;

// Sprint start — mutowalny przez setSprintCalendar() po fetchu z ADO.
// Default: Monday April 6, 2026.
export const SPRINT_START = new Date(2026, 3, 6);

/**
 * Custom (non-weekend) holidays during the sprint. ISO date strings YYYY-MM-DD.
 */
export const HOLIDAYS: Set<string> = new Set();

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface CalendarSlot {
  isWeekend: boolean;
  isHoliday: boolean;
  isNonWorking: boolean;
  dayName: string;
  date: Date;
  sprintDay: number | null;
}

/**
 * Calendar slots — wypełnione przez computeCalendarSlots(), mutowane in-place
 * przez setSprintCalendar(). Trzymamy ten sam array reference, żeby komponenty
 * cache'ujące `CALENDAR_SLOTS` (np. swimlane.component) widziały nowe daty
 * przy najbliższym re-renderze po rebuildLanes().
 */
export const CALENDAR_SLOTS: CalendarSlot[] = [];

function computeCalendarSlots(): CalendarSlot[] {
  const slots: CalendarSlot[] = [];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // 2-tygodniowy sprint: 12 calendar slots (Mon-Fri, Sat-Sun, Mon-Fri).
  // Dla innej długości — dynamicznie generujemy slots aż uzbieramy SPRINT_DAYS roboczych.
  let sprintDay = 1;
  let offset    = 0;
  while (sprintDay <= SPRINT_DAYS) {
    const d         = new Date(SPRINT_START);
    d.setDate(SPRINT_START.getDate() + offset);
    const dow       = d.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = !isWeekend && HOLIDAYS.has(toIso(d));
    slots.push({
      isWeekend,
      isHoliday,
      isNonWorking: isWeekend || isHoliday,
      dayName: dayNames[dow],
      date: d,
      sprintDay: (isWeekend || isHoliday) ? null : sprintDay,
    });
    if (!isWeekend && !isHoliday) sprintDay++;
    offset++;
  }
  return slots;
}

CALENDAR_SLOTS.push(...computeCalendarSlots());

/**
 * Re-init kalendarza sprintu — woła się po fetchu z ADO (`/api/ado/iteration`).
 * Mutuje SPRINT_START in-place i nadpisuje CALENDAR_SLOTS bez zmiany array ref.
 */
export function setSprintCalendar(start: Date, days: number, holidays?: Iterable<string>): void {
  SPRINT_START.setFullYear(start.getFullYear(), start.getMonth(), start.getDate());
  SPRINT_START.setHours(0, 0, 0, 0);
  SPRINT_DAYS = Math.max(1, Math.floor(days));
  HOLIDAYS.clear();
  if (holidays) for (const h of holidays) HOLIDAYS.add(h);
  const fresh = computeCalendarSlots();
  CALENDAR_SLOTS.splice(0, CALENDAR_SLOTS.length, ...fresh);
}

export const USERS: SprintUser[] = [
  { id: 'anna',   name: 'Alice K.' },
  { id: 'bartek', name: 'Bob M.' },
  { id: 'celina', name: 'Carol P.' },
  { id: 'dawid',  name: 'David W.' },
];

/**
 * Mock ADO sprint backlog.
 *
 * Cross-PBI dependency chain:
 *   PBI-101 (Auth) ──→ PBI-102 (Payments)
 *                  ──→ PBI-104 (User Profile)
 *                  ──→ PBI-105 (Notifications)
 *
 * Bugs are independent of each other and of stories.
 */
export const ADO_MOCK_PBIS: AdoPbi[] = [
  // ── Priority 1 ────────────────────────────────────────────
  {
    id: 'PBI-101',
    title: 'User Authentication',
    color: '#3B82F6',
    priority: 1,
    type: 'Story',
    phases: [
      { assigneeId: 'anna',   days: 2, role: 'Backend' },   // D1-D2
      { assigneeId: 'bartek', days: 2, role: 'Frontend' },
    ],
  },
  {
    id: 'BUG-201',
    title: 'Login crash on iOS 17',
    color: '#FF4444',
    priority: 1,
    type: 'Bug',
    phases: [{ assigneeId: 'bartek', days: 0.5, role: 'Fix' }],
  },
  // ── Priority 2 ────────────────────────────────────────────
  {
    id: 'PBI-103',
    title: 'Product Catalog',
    color: '#F59E0B',
    priority: 2,
    type: 'Story',
    phases: [
      { assigneeId: 'celina', days: 3, role: 'Frontend' },  // D1-D3
      { assigneeId: 'dawid',  days: 2, role: 'Backend' },   // D2-D3 → D5-D6 (spans weekend)
    ],
  },
  {
    id: 'BUG-202',
    title: 'Payment timeout on slow 3G',
    color: '#FF6B35',
    priority: 2,
    type: 'Bug',
    phases: [{ assigneeId: 'dawid', days: 0.5, role: 'Fix' }],
  },
  {
    id: 'PBI-102',
    title: 'Payment Integration',
    color: '#10B981',
    priority: 2,
    type: 'Story',
    dependsOn: ['PBI-101'],
    phases: [
      { assigneeId: 'dawid',  days: 2, role: 'Backend' },
      { assigneeId: 'bartek', days: 2, role: 'Frontend' },
    ],
  },
  // ── Priority 3 ────────────────────────────────────────────
  {
    id: 'PBI-104',
    title: 'User Profile & Settings',
    color: '#8B5CF6',
    priority: 3,
    type: 'Story',
    dependsOn: ['PBI-101'],
    phases: [
      { assigneeId: 'anna',   days: 1, role: 'Backend' },
      { assigneeId: 'celina', days: 2, role: 'Frontend' },
    ],
  },
  {
    id: 'PBI-105',
    title: 'Notification Service',
    color: '#EC4899',
    priority: 3,
    type: 'Story',
    dependsOn: ['PBI-101'],
    phases: [
      { assigneeId: 'anna', days: 3, role: 'Backend' },
    ],
  },
];

/**
 * Mock incoming bugs that surface during the sprint (daily standup).
 * These arrive as unassigned — the PM picks a dev during the meeting.
 */
export const INCOMING_BUGS_MOCK: AdoPbi[] = [
  {
    id: 'BUG-301',
    title: 'Cart items disappear on refresh',
    color: '#FF4444',
    priority: 1,
    type: 'Bug',
    phases: [{ assigneeId: 'unassigned', days: 0.5, role: 'Fix' }],
  },
  {
    id: 'BUG-302',
    title: 'Profile photo upload fails on iOS',
    color: '#FF6B35',
    priority: 2,
    type: 'Bug',
    phases: [{ assigneeId: 'unassigned', days: 0.5, role: 'Fix' }],
  },
  {
    id: 'BUG-303',
    title: 'Search returns wrong results after filter',
    color: '#F59E0B',
    priority: 2,
    type: 'Bug',
    phases: [{ assigneeId: 'unassigned', days: 0.5, role: 'Fix' }],
  },
];

// Diagram model types
export interface DiagramPosition { x: number; y: number }

export interface DiagramNode {
  id: string;
  type: string;
  zOrder?: number;
  position: DiagramPosition;
  data: Record<string, unknown>;
  selected?: boolean;
  draggable?: boolean;
}

export interface DiagramEdge {
  id: string;
  type: string;
  zOrder?: number;
  routing?: string;
  source: string;
  sourcePort?: string;
  target: string;
  targetPort?: string;
  data: Record<string, unknown>;
}

export interface NodeUpdate {
  id: string;
  position?: DiagramPosition;
  data?: Record<string, unknown>;
}

export interface SprintStats { stories: number; bugs: number; incoming: number }

export interface UndoSnapshot {
  bugPhaseId: string;
  label: string;
  nodes: NodeUpdate[];
}

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
  phases: { assigneeId: string; days: number; role: string; parallel?: boolean }[];
  /** PBI IDs that must fully complete before this PBI can start */
  dependsOn?: string[];
}

export interface SprintUser {
  id: string;
  name: string;
}

export const SPRINT_DAYS = 10;

// Sprint starts on Monday April 6, 2026
export const SPRINT_START = new Date(2026, 3, 6);

/**
 * Custom (non-weekend) holidays during the sprint.
 */
export const HOLIDAYS: ReadonlySet<string> = new Set([]);

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 12 calendar slots: Mon–Fri W1, Sat–Sun, Mon–Fri W2 */
export interface CalendarSlot {
  isWeekend: boolean;
  isHoliday: boolean;
  /** true when the slot cannot be worked (weekend OR holiday) */
  isNonWorking: boolean;
  dayName: string;
  date: Date;
  sprintDay: number | null; // 1-10 for work days, null for weekends
}

export const CALENDAR_SLOTS: CalendarSlot[] = (() => {
  const slots: CalendarSlot[] = [];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const offsets  = [0,1,2,3,4, 5,6, 7,8,9,10,11];
  let sprintDay  = 1;
  for (const offset of offsets) {
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
      sprintDay: isWeekend ? null : sprintDay++,
    });
  }
  return slots;
})();

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

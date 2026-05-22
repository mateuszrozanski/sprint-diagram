import { CALENDAR_SLOTS, type PBI } from './sprint-data';

// ── Per-slot x helpers ───────────────────────────────────────────────────────

/** Cumulative x offset (within the grid area, after LABEL_W) for slot[index]. */
export function getSlotXOffset(slotIndex: number): number {
  let x = 0;
  for (let i = 0; i < slotIndex; i++) {
    x += CALENDAR_SLOTS[i].isWeekend ? L.WKND_W : L.DAY_W;
  }
  return x;
}

export function getSlotWidth(slotIndex: number): number {
  return CALENDAR_SLOTS[slotIndex].isWeekend ? L.WKND_W : L.DAY_W;
}

/**
 * Returns {left, width} pairs (in the grid coordinate space, after LABEL_W)
 * for every non-working day in the sprint calendar.
 */
export function getNonWorkingZones(): { left: number; width: number }[] {
  return CALENDAR_SLOTS
    .map((slot, i) => ({ slot, i }))
    .filter(({ slot }) => slot.isNonWorking)
    .map(({ i }) => ({ left: getSlotXOffset(i), width: getSlotWidth(i) }));
}

/**
 * Per-user day-off zones — `{left, width}` dla każdego sprintDay z `daysOff`.
 * Pomija weekend/holiday slots (już są w `getNonWorkingZones`), żeby nie renderować
 * dwóch nakładających się bandów. Pusty input → pusta tablica.
 */
export function getDayOffZones(daysOff: Set<number> | undefined): { left: number; width: number }[] {
  if (!daysOff || daysOff.size === 0) return [];
  const zones: { left: number; width: number }[] = [];
  for (let i = 0; i < CALENDAR_SLOTS.length; i++) {
    const slot = CALENDAR_SLOTS[i];
    if (slot.sprintDay === null) continue;
    if (slot.isNonWorking) continue;
    if (!daysOff.has(slot.sprintDay)) continue;
    zones.push({ left: getSlotXOffset(i), width: getSlotWidth(i) });
  }
  return zones;
}

/**
 * Returns {left, width} pairs (relative to the card's left edge)
 * for each non-working day column that overlaps with this PBI.
 */
export function getPbiNonWorkingZones(
  cardX: number,
  cardWidth: number,
): { left: number; width: number }[] {
  const cardRight = cardX + cardWidth;
  const zones: { left: number; width: number }[] = [];

  for (let i = 0; i < CALENDAR_SLOTS.length; i++) {
    if (!CALENDAR_SLOTS[i].isNonWorking) continue;
    const slotLeft  = L.LABEL_W + getSlotXOffset(i);
    const slotRight = slotLeft  + getSlotWidth(i);
    const oLeft  = Math.max(slotLeft,  cardX)    - cardX;
    const oRight = Math.min(slotRight, cardRight) - cardX;
    if (oRight > oLeft) zones.push({ left: oLeft, width: oRight - oLeft });
  }
  return zones;
}

export const L = {
  HEADER_H: 68,
  LABEL_W:  160,
  ROW_H:    180,
  DAY_W:    340,
  WKND_W:   80,
  NODE_H:   140,
  PAD:      6,
};

/**
 * X offset (from the start of the day-grid area, i.e. after LABEL_W)
 * for a given sprint day (1–10).
 */
export function getSprintDayOffset(day: number): number {
  if (day <= 5) return (day - 1) * L.DAY_W;
  return 5 * L.DAY_W + 2 * L.WKND_W + (day - 6) * L.DAY_W;
}

/**
 * Odwrotność `getSprintDayOffset` — z px (offsetu od LABEL_W) wyciąga
 * sprintDay kolumny, w której ten px wypada. Dla weekendów zwraca null.
 */
export function pxToSprintDay(offsetFromLabel: number): number | null {
  if (offsetFromLabel < 0) return null;
  let acc = 0;
  for (let i = 0; i < CALENDAR_SLOTS.length; i++) {
    const w = CALENDAR_SLOTS[i].isWeekend ? L.WKND_W : L.DAY_W;
    if (offsetFromLabel < acc + w) return CALENDAR_SLOTS[i].sprintDay;
    acc += w;
  }
  return CALENDAR_SLOTS[CALENDAR_SLOTS.length - 1]?.sprintDay ?? null;
}

/**
 * Najbliższy sprintDay (working day) dla danego x px od LABEL_W. Jeśli x trafia
 * w weekend/holiday → najbliższy następny working day.
 */
export function nearestWorkingSprintDay(offsetFromLabel: number): number {
  const direct = pxToSprintDay(offsetFromLabel);
  if (direct !== null) return direct;
  // weekend → idziemy w prawo do najbliższego working day
  let acc = 0;
  for (let i = 0; i < CALENDAR_SLOTS.length; i++) {
    const w = CALENDAR_SLOTS[i].isWeekend ? L.WKND_W : L.DAY_W;
    acc += w;
    if (acc > offsetFromLabel && CALENDAR_SLOTS[i].sprintDay !== null) {
      return CALENDAR_SLOTS[i].sprintDay as number;
    }
  }
  return 1;
}

export function getPbiPosition(pbi: PBI, userIndex: number) {
  return {
    x: L.LABEL_W + getSprintDayOffset(pbi.startDay) + L.PAD,
    y: L.HEADER_H + (userIndex + 1) * L.ROW_H + Math.round((L.ROW_H - L.NODE_H) / 2),
  };
}

/** Width of a PBI node spanning from startDay to endDay (weekends included if crossing). */
export function getPbiWidth(pbi: PBI): number {
  const startX = getSprintDayOffset(pbi.startDay);
  const endX   = getSprintDayOffset(pbi.endDay) + L.DAY_W;
  return endX - startX - 2 * L.PAD;
}

export function getQaPosition(pbi: PBI, userCount: number, testerSubRow = 0) {
  // Layout rows: header(0) + incoming(1) + devs(2..N+1) + QA-sub-lanes(N+2..)
  const qaRowIndex = userCount + 1 + testerSubRow;
  return {
    x: L.LABEL_W + getSprintDayOffset(pbi.endDay) + L.PAD,
    y: L.HEADER_H + qaRowIndex * L.ROW_H + Math.round((L.ROW_H - L.NODE_H) / 2),
  };
}

export function getQaWidth(): number {
  return L.DAY_W - 2 * L.PAD;
}

export function getUserIndex(userId: string, users: { id: string }[]): number {
  return users.findIndex(u => u.id === userId);
}

export function getEffectivePbiWidth(cardX: number, baseWidth: number): number {
  let width = baseWidth;
  const used = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    const cardRight = cardX + width;
    for (let i = 0; i < CALENDAR_SLOTS.length; i++) {
      if (!CALENDAR_SLOTS[i].isNonWorking || used.has(i)) continue;
      const slotLeft = L.LABEL_W + getSlotXOffset(i);
      if (slotLeft >= cardX && slotLeft < cardRight) {
        width += getSlotWidth(i);
        used.add(i);
        changed = true;
      }
    }
  }
  return width;
}

/**
 * If x falls within a non-working slot (holiday or weekend), advance it to
 * the right edge of that slot. Iterates to handle back-to-back non-working slots.
 */
export function skipNonWorkingX(x: number): number {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < CALENDAR_SLOTS.length; i++) {
      if (!CALENDAR_SLOTS[i].isNonWorking) continue;
      const slotLeft  = L.LABEL_W + getSlotXOffset(i);
      const slotRight = slotLeft + getSlotWidth(i);
      if (x >= slotLeft && x < slotRight) {
        x = slotRight;
        changed = true;
        break;
      }
    }
  }
  return x;
}

/**
 * Wariant `skipNonWorkingX` świadomy days-off konkretnego deva. Push w prawo gdy
 * x wpada w global non-working slot (weekend/holiday) LUB w user-off slot.
 * `daysOff` to set sprintDay numbers (1-10) gdy ten dev jest off.
 * Bez daysOff (lub pusty set) zachowuje się identycznie jak `skipNonWorkingX`.
 */
export function skipNonWorkingXForUser(x: number, daysOff?: Set<number>): number {
  if (!daysOff || daysOff.size === 0) return skipNonWorkingX(x);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < CALENDAR_SLOTS.length; i++) {
      const slot = CALENDAR_SLOTS[i];
      const isUserOff = slot.sprintDay !== null && daysOff.has(slot.sprintDay);
      if (!slot.isNonWorking && !isUserOff) continue;
      const slotLeft  = L.LABEL_W + getSlotXOffset(i);
      const slotRight = slotLeft + getSlotWidth(i);
      if (x >= slotLeft && x < slotRight) {
        x = slotRight;
        changed = true;
        break;
      }
    }
  }
  return x;
}

/**
 * Width of a QA card extended by every non-working slot (holiday OR weekend)
 * whose left edge falls within the card's current visual span.
 */
export function getEffectiveQaWidth(cardX: number, baseWidth: number): number {
  let width = baseWidth;
  const used = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    const cardRight = cardX + width;
    for (let i = 0; i < CALENDAR_SLOTS.length; i++) {
      if (!CALENDAR_SLOTS[i].isNonWorking || used.has(i)) continue;
      const slotLeft = L.LABEL_W + getSlotXOffset(i);
      if (slotLeft >= cardX && slotLeft < cardRight) {
        width += getSlotWidth(i);
        used.add(i);
        changed = true;
      }
    }
  }
  return width;
}

export function getTotalWidth(): number {
  return L.LABEL_W + 10 * L.DAY_W + 2 * L.WKND_W;
}

export function getTotalHeight(userCount: number): number {
  return L.HEADER_H + (userCount + 2) * L.ROW_H; // incoming + devs + QA
}

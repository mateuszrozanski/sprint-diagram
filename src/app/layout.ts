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
  LABEL_W:  148,
  ROW_H:    148,
  DAY_W:    210,
  WKND_W:   64,
  NODE_H:   92,
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

export function getQaPosition(pbi: PBI, userCount: number) {
  const qaRowIndex = userCount + 1; // incoming(0) + devs(1..N) + QA(N+1)
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

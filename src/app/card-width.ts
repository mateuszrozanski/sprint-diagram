/**
 * Card width formula — wyciągnięte z `sprint-ado.ts` do testowalnej funkcji.
 *
 * Zasada (uzgodnione z PO):
 *   • `MIN_WIDTH` to baseline — najmniejszy task ma tyle pikseli (musi być czytelny).
 *   • Powyżej baseline szerokość rośnie proporcjonalnie do godzin: `hours * PX_PER_HOUR`.
 *   • Cap do dnia kalendarza — `widthForHours(hours)` nigdy nie przekracza
 *     `spanDays * DAY_W - 2*PAD`, żeby karty nie nachodziły na sąsiednie kolumny.
 *   • Cap na `MAX_WIDTH` żeby super-long taski nie wylatywały poza sprint.
 */

// Lokalne stałe (duplikat z layout.ts) — moduł celowo standalone do testów.
const DAY_W         = 340;
const PAD           = 6;
const HOURS_PER_DAY = 6;

export const CARD_WIDTH = {
  MIN_WIDTH:    220,   // żeby ZAWSZE zmieścił się top row: ID + BUG + hours + avatar + ⓘ
  PX_PER_HOUR:  60,    // ≈ DAY_W (340) / 6h-roboczych — 6h task ≈ 1 dzień kalendarza
  MAX_WIDTH:    3000,
} as const;

/**
 * Span w pełnych dniach kalendarza dla zadania o danej liczbie godzin.
 * Musi pasować do `computeEndDay()` w sprint-ado.ts — tam workDays=0.5
 * skutkuje 1-dniowym spanem (day++ włącza się dopiero gdy worked < workDays).
 */
function spanDays(hours: number): number {
  // Ceil — musi pasować do `hoursToDays` w ado.service.ts (ceil, nie round).
  // 7h → 1.5d span (czyli 2 dni layoutu po `computeEndDay`).
  const halfDays = Math.max(0.5, Math.ceil((hours / HOURS_PER_DAY) * 2) / 2);
  return Math.ceil(halfDays);
}

export function widthForHours(hours: number | undefined): number {
  if (typeof hours !== 'number' || hours <= 0) return CARD_WIDTH.MIN_WIDTH;
  const proportional = hours * CARD_WIDTH.PX_PER_HOUR;
  const dayCap       = spanDays(hours) * DAY_W - 2 * PAD;
  return Math.min(
    CARD_WIDTH.MAX_WIDTH,
    Math.max(CARD_WIDTH.MIN_WIDTH, Math.min(proportional, dayCap)),
  );
}

/**
 * Liczba linii potrzebnych żeby zmieścić tytuł w karcie o danej szerokości.
 * Przybliżenie — 11px font, ~6.2px/char średnio.
 */
export function linesForTitle(titleLen: number, cardWidth: number): number {
  const usableWidth = Math.max(50, cardWidth - 20);
  const charsPerLine = Math.max(8, Math.floor(usableWidth / 6.2));
  return Math.max(1, Math.ceil(titleLen / charsPerLine));
}

/** Wysokość karty na podstawie najdłuższego tytułu i parent-title. */
export function heightForCard(titleLen: number, parentTitleLen: number, cardWidth: number): number {
  const titleLines  = Math.min(8, linesForTitle(titleLen, cardWidth));
  const parentLines = parentTitleLen > 0 ? Math.min(2, linesForTitle(parentTitleLen, cardWidth)) : 0;
  // konkretne wymiary z CSS: 11px font, line-height 1.3 → ~14.5px/line.
  // header 24 + title (lines × 15) + parent (lines × 14) + meta 16 + padding 10
  return 24 + titleLines * 15 + (parentLines ? parentLines * 14 + 4 : 0) + 16 + 10;
}

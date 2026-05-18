/**
 * Card width formula — testowalna, standalone.
 *
 * Zasada (uzgodnione z PO):
 *   • `MIN_WIDTH` to baseline — najmniejszy task ma tyle pikseli (musi być
 *     czytelny). Hours badge na karcie pokazuje faktyczne godziny niezależnie
 *     od wizualnej szerokości.
 *   • Skala: 6h roboczych ≈ DAY_W (340px). Czyli `PX_PER_HOUR = DAY_W /
 *     HOURS_PER_DAY = 56.67px/h`. 4h → ~227px (67% kolumny), 12h → ~680px
 *     (2 kolumny).
 *   • Cap na `MAX_WIDTH` żeby super-long taski nie wylatywały poza sprint.
 */

// Lokalne stałe (duplikat z layout.ts / ado.service.ts) — moduł celowo
// standalone do `scripts/test-card-width.mjs`.
const DAY_W         = 340;
const HOURS_PER_DAY = 6;

export const CARD_WIDTH = {
  MIN_WIDTH:    220,                       // żeby zmieścił się top row ikon
  PX_PER_HOUR:  DAY_W / HOURS_PER_DAY,    // 56.67 — exact ratio
  MAX_WIDTH:    3000,
} as const;

export function widthForHours(hours: number | undefined): number {
  if (typeof hours !== 'number' || hours <= 0) return CARD_WIDTH.MIN_WIDTH;
  const proportional = Math.round(hours * CARD_WIDTH.PX_PER_HOUR);
  return Math.min(CARD_WIDTH.MAX_WIDTH, Math.max(CARD_WIDTH.MIN_WIDTH, proportional));
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
  return 24 + titleLines * 15 + (parentLines ? parentLines * 14 + 4 : 0) + 16 + 10;
}

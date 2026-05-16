/**
 * Card width formula — wyciągnięte z `sprint-ado.ts` do testowalnej funkcji.
 *
 * Zasada (uzgodnione z PO):
 *   • `MIN_WIDTH` to baseline — najmniejszy task ma tyle pikseli (musi być czytelny).
 *   • Powyżej baseline szerokość rośnie proporcjonalnie do godzin: `hours * PX_PER_HOUR`.
 *   • Cap na `MAX_WIDTH` żeby super-long taski nie wylatywały poza sprint.
 */

export const CARD_WIDTH = {
  MIN_WIDTH:    120,
  PX_PER_HOUR:  60,    // ≈ DAY_W (340) / 6h-roboczych — 6h task ≈ 1 dzień kalendarza
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
  // konkretne wymiary z CSS: 11px font, line-height 1.3 → ~14.5px/line.
  // header 24 + title (lines × 15) + parent (lines × 14) + meta 16 + padding 10
  return 24 + titleLines * 15 + (parentLines ? parentLines * 14 + 4 : 0) + 16 + 10;
}

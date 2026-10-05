/*
 * Windowed rendering for the thumbnail grid.
 *
 * The grid stays a CSS grid — the only thing we virtualise is *which* cells
 * exist in the DOM. Two spacers (one before the window, one after) hold the
 * scroll height, so the scrollbar keeps its true proportions while only a
 * screenful of cards is ever mounted.
 *
 * All of the arithmetic lives in pure functions so it can be exercised
 * headlessly; the DOM touch-points are one-liners at the bottom.
 */

/**
 * Fixed height of a card's caption/meta block, in px.
 *
 * Both lines are always present — the meta line swaps its text rather than
 * appearing and disappearing — so this is a constant and the grid rhythm never
 * shifts when the search box is used. Retune it together with .ib-caption and
 * .ib-meta in styles.css; a mismatch shows up as cards clipped at the bottom.
 */
export const CARD_CHROME_HEIGHT = 38;
/** Rows rendered above/below the viewport to hide scroll seams. */
export const OVERSCAN_ROWS = 2;

export interface GridMetrics {
  /** Number of full columns the available width fits. */
  columns: number;
  /** Exact width of one cell, after distributing the leftover space. */
  colWidth: number;
  /** Height of a card, chrome included. */
  cardHeight: number;
  /** Vertical distance between two rows (card + gap). */
  rowHeight: number;
  rows: number;
  /** Total scrollable height of the item area, excluding edge padding. */
  totalHeight: number;
}

export interface GridWindow {
  /** First item index to render, inclusive. */
  start: number;
  /** Last item index to render, exclusive. */
  end: number;
  /** Spacer height before the rendered chunk. */
  topPad: number;
  /** Spacer height after the rendered chunk. */
  bottomPad: number;
}

export interface MetricsOptions {
  availableWidth: number;
  itemCount: number;
  thumbSize: number;
  gap: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function computeMetrics(o: MetricsOptions): GridMetrics {
  const gap = Math.max(0, o.gap);
  const thumb = Math.max(24, o.thumbSize);
  const width = Math.max(thumb, o.availableWidth);

  // At least one column even in a pathologically narrow pane.
  const columns = Math.max(1, Math.floor((width + gap) / (thumb + gap)));
  const colWidth = (width - (columns - 1) * gap) / columns;

  const chrome = CARD_CHROME_HEIGHT;
  const cardHeight = colWidth + chrome;
  const rowHeight = cardHeight + gap;
  const rows = Math.max(0, Math.ceil(o.itemCount / columns));

  return {
    columns,
    colWidth,
    cardHeight,
    rowHeight,
    rows,
    totalHeight: rows === 0 ? 0 : rows * rowHeight - gap,
  };
}

/**
 * Which items to mount for a given scroll position. Indices are clamped to
 * the item count so callers can slice without checking bounds.
 */
export function computeWindow(
  m: GridMetrics,
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = OVERSCAN_ROWS
): GridWindow {
  if (itemCount === 0 || m.rows === 0 || m.rowHeight <= 0) {
    return { start: 0, end: 0, topPad: 0, bottomPad: 0 };
  }

  const firstRow = Math.floor(Math.max(0, scrollTop) / m.rowHeight) - overscan;
  const visibleRows = Math.ceil(Math.max(0, viewportHeight) / m.rowHeight) + overscan * 2;
  const lastRow = firstRow + Math.max(1, visibleRows);

  const startRow = clamp(firstRow, 0, m.rows - 1);
  const endRow = clamp(lastRow, startRow + 1, m.rows);

  const start = startRow * m.columns;
  const end = Math.min(itemCount, endRow * m.columns);

  return {
    start,
    end,
    topPad: startRow * m.rowHeight,
    bottomPad: Math.max(0, m.totalHeight - (endRow * m.rowHeight - m.rowHeight + m.cardHeight)),
  };
}

/** True when the item count is worth the bookkeeping of windowing. */
export function shouldVirtualize(itemCount: number, threshold: number): boolean {
  return itemCount >= Math.max(50, threshold);
}

// ------------------------------------------------------------------ DOM side

/** Box padding, or zeros when the style engine is unavailable. */
function paddingOf(el: HTMLElement): [number, number, number, number] {
  if (typeof getComputedStyle !== "function") return [0, 0, 0, 0];
  const style = getComputedStyle(el);
  return [
    parseFloat(style.paddingTop) || 0,
    parseFloat(style.paddingRight) || 0,
    parseFloat(style.paddingBottom) || 0,
    parseFloat(style.paddingLeft) || 0,
  ];
}

/** Usable inner width of a scroll container, padding excluded. */
export function innerWidth(el: HTMLElement): number {
  const [, pr, , pl] = paddingOf(el);
  // clientWidth is 0 in headless DOM; fall back to the box it would occupy.
  const width = el.clientWidth || el.getBoundingClientRect().width;
  return Math.max(0, width - pl - pr);
}

export function innerHeight(el: HTMLElement): number {
  const [pt, , pb] = paddingOf(el);
  const height = el.clientHeight || el.getBoundingClientRect().height;
  return Math.max(0, height - pt - pb);
}

/**
 * Pin the grid to an exact column count and row height so the DOM matches
 * `GridMetrics` — without this the browser's own auto-fill would place cards
 * at a different rhythm than the spacers assume.
 *
 * The row height is deliberately NOT rounded. `computeWindow` derives the
 * spacers from the same fractional `rowHeight`, so rounding here alone made
 * every row drift by the rounding error: at row 500 the spacer and the real
 * layout disagreed by ~150px, which is a whole screenful of misalignment in a
 * large folder. It also shaved 0.3px off every tile's height, which is enough
 * to stop the squares being square.
 */
export function applyMetrics(gridEl: HTMLElement, m: GridMetrics): void {
  gridEl.style.gridTemplateColumns = `repeat(${m.columns}, minmax(0, 1fr))`;
  gridEl.style.gridAutoRows = `${m.cardHeight}px`;
}

/** A full-width spacer that reserves scroll height for unrendered rows. */
export function makeSpacer(cls: string, height: number): HTMLElement {
  const el = document.createElement("div");
  el.className = `ib-vpad ${cls}`;
  el.style.height = `${Math.max(0, Math.round(height))}px`;
  el.setAttribute("aria-hidden", "true");
  // A grid row is as tall as its tallest cell; span every column and be empty.
  el.style.gridColumn = "1 / -1";
  return el;
}

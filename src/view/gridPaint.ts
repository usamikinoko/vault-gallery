/* Painter for the thumbnail grid: full render, or only the visible window. */

import type { GridItem } from "../types";
import {
  applyMetrics,
  computeMetrics,
  computeWindow,
  innerHeight,
  innerWidth,
  makeSpacer,
  shouldVirtualize,
} from "../virtualGrid";
import type { ViewPart } from "./viewTypes";

export const GRID_GAP = 12;

export interface GridPaintPart {
  /** Mount the cards for the current scroll window. `force` skips the memo. */
  paint(force: boolean): void;
  /** Re-measure after a size change; the column count is our math, not CSS's. */
  repaintForSize(): void;
  /** Coalesce scroll-driven repaints into one per frame. */
  schedulePaint(): void;
  measureViewport(): void;
  renderAll(subcaption: boolean): void;
  renderItem(index: number, subcaption: boolean): void;
  /** Trim the thumbnail queue to the cards that are actually on screen. */
  retainThumbs(): void;
}

export const gridPaintPart: ViewPart<GridPaintPart> = {
  paint(force: boolean): void {
    const count = this.items.length;
    const virtual = shouldVirtualize(count, this.plugin.settings.virtualThreshold);
    const subcaption = this.query.length > 0;

    if (!virtual) {
      this.gridEl.removeClass("is-virtual");
      this.gridEl.style.gridTemplateColumns = "";
      this.gridEl.style.gridAutoRows = "";
      if (
        !force &&
        this.renderedWindow &&
        this.renderedWindow.start === 0 &&
        this.renderedWindow.end === count
      ) {
        return;
      }
      this.renderAll(subcaption);
      this.metrics = null;
      this.renderedWindow = { start: 0, end: count, topPad: 0, bottomPad: 0 };
      this.retainThumbs();
      return;
    }

    // The viewport is measured on resize, not per frame: `innerWidth` reads
    // computed style and forces a layout flush, and doing that inside the
    // scroll rAF is a synchronous reflow per frame — the exact cost this
    // windowing exists to avoid.
    if (!this.viewport.valid) this.measureViewport();

    const metrics = computeMetrics({
      availableWidth: this.viewport.width,
      itemCount: count,
      thumbSize: this.plugin.settings.thumbnailSize,
      gap: GRID_GAP,
    });
    this.metrics = metrics;
    this.gridEl.addClass("is-virtual");
    applyMetrics(this.gridEl, metrics);

    const win = computeWindow(metrics, count, this.wrapEl.scrollTop, this.viewport.height);
    if (
      !force &&
      this.renderedWindow &&
      win.start === this.renderedWindow.start &&
      win.end === this.renderedWindow.end
    ) {
      return;
    }

    // Rows that scroll in one row at a time used to cost a full teardown:
    // every card in the window was destroyed and rebuilt, re-creating two img
    // elements, five listeners and a drag target each — for the 36 cards that
    // did not change. Cards still inside the new window are now reattached
    // (moving a node does not re-decode its image); only the entering rows are
    // built from scratch.
    const keep = new Map<number, HTMLElement>();
    for (const [i, el] of this.itemEls) {
      if (i >= win.start && i < win.end) keep.set(i, el);
    }
    this.itemEls = keep;
    this.gridEl.empty();

    if (win.topPad > 0) this.gridEl.appendChild(makeSpacer("ib-vpad-top", win.topPad));
    for (let i = win.start; i < win.end; i++) {
      const existing = keep.get(i);
      if (existing) this.gridEl.appendChild(existing);
      else this.renderItem(i, subcaption);
    }
    if (win.bottomPad > 0) this.gridEl.appendChild(makeSpacer("ib-vpad-bottom", win.bottomPad));
    this.renderedWindow = win;
    this.retainThumbs();
  },

  /**
   * Coalesce scroll-driven repaints into one per frame.
   *
   * Calling `paint` straight from the scroll handler runs a layout read plus a
   * batch of DOM writes for every scroll event — at 120 Hz that is up to 120
   * layout passes a second, all of them discarded except the last.
   */
  schedulePaint(): void {
    if (this.paintFrame) return;
    // `requestAnimationFrame` is missing in some headless contexts, so the
    // timer is the fallback rather than a second code path.
    const schedule =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: () => void) => window.setTimeout(cb, 16);
    this.paintFrame = schedule(() => {
      this.paintFrame = 0;
      this.paint(false);
    }) as unknown as number;
  },

  repaintForSize(): void {
    this.viewport.valid = false;
    this.renderedWindow = null;
    this.paint(true);
  },

  measureViewport(): void {
    const width = innerWidth(this.wrapEl);
    const height = innerHeight(this.wrapEl);
    // Zero means "not laid out yet" (or a headless DOM), not "no room": mark
    // the measurement invalid so the next paint tries again.
    this.viewport = {
      width: width || this.plugin.settings.thumbnailSize,
      height,
      valid: width > 0 && height > 0,
    };
  },

  renderAll(subcaption: boolean): void {
    this.gridEl.empty();
    this.itemEls.clear();
    for (let i = 0; i < this.items.length; i++) this.renderItem(i, subcaption);
  },

  /**
   * The thumbnail queue only works for cards that are mounted. Fast scrolling
   * past a thousand images would otherwise queue a thousand full decodes for
   * tiles the user already scrolled past; this drops the stale ones so the
   * queue stays as small as the viewport.
   */
  retainThumbs(): void {
    const thumbs = this.plugin.thumbs;
    if (!thumbs || this.itemEls.size === 0) return;
    const keep = new Set<string>();
    for (const [index, el] of this.itemEls) {
      if (!el.isConnected) continue;
      const it = this.items[index];
      if (!it) continue;
      if (it.kind === "image") keep.add(it.entry.path);
      else if (this.plugin.settings.folderPreview) {
        for (const cover of it.node.coverImages) keep.add(cover.path);
      }
    }
    thumbs.retain(keep);
  },

  renderItem(index: number, subcaption: boolean): void {
    const item: GridItem = this.items[index];
    const el =
      item.kind === "folder"
        ? this.renderFolderCard(item.node)
        : this.renderImageCard(item.entry, subcaption);
    if (el) {
      this.itemEls.set(index, el);
      el.setAttr("data-index", String(index));
    }
  },
};

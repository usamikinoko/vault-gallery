/* Grid keyboard navigation: arrows, Home/End, Enter, Space, F2, Delete, Esc. */

import type { ViewPart } from "./viewTypes";

export interface KeyboardPart {
  onKeyDown(e: KeyboardEvent): void;
  moveFocus(delta: number, e: KeyboardEvent): void;
  setFocus(index: number, e?: KeyboardEvent): void;
  ensureVisible(index: number): void;
  applyFocusClass(): void;
  activateFocused(): void;
  toggleFocused(): void;
  renameFocused(): void;
}

export const keyboardPart: ViewPart<KeyboardPart> = {
  onKeyDown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    const cols = this.metrics?.columns ?? 1;

    switch (e.key) {
      case "ArrowRight":
        this.moveFocus(1, e);
        break;
      case "ArrowLeft":
        this.moveFocus(-1, e);
        break;
      case "ArrowDown":
        this.moveFocus(cols, e);
        break;
      case "ArrowUp":
        this.moveFocus(-cols, e);
        break;
      case "Home":
        this.setFocus(0, e);
        break;
      case "End":
        this.setFocus(this.items.length - 1, e);
        break;
      case "Enter":
        this.activateFocused();
        break;
      case " ":
        e.preventDefault();
        this.toggleFocused();
        break;
      case "Escape":
        if (this.selection.size > 0) {
          this.selection.clear();
          this.anchor = null;
          this.syncSelectionClasses();
          this.renderSelectionBar();
        } else if (this.query) {
          this.query = "";
          if (this.searchEl) this.searchEl.value = "";
          this.renderGrid({ resetScroll: true });
        }
        break;
      case "Delete":
      case "Backspace":
        if (this.selection.size > 0) {
          e.preventDefault();
          void this.deleteSelection();
        }
        break;
      case "F2":
        this.renameFocused();
        break;
      default:
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
          e.preventDefault();
          this.selectAll();
        }
    }
  },

  moveFocus(delta: number, e: KeyboardEvent): void {
    e.preventDefault();
    const start = this.focusIndex < 0 ? (delta > 0 ? -delta : 0) : this.focusIndex;
    this.setFocus(start + delta, e);
  },

  setFocus(index: number, e?: KeyboardEvent): void {
    if (this.items.length === 0) return;
    e?.preventDefault();
    const clamped = Math.max(0, Math.min(this.items.length - 1, index));
    this.focusIndex = clamped;
    this.ensureVisible(clamped);
    this.applyFocusClass();
  },

  ensureVisible(index: number): void {
    const el = this.itemEls.get(index);
    if (el) {
      if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
      return;
    }
    // Outside the rendered window: jump the scroll position and re-render.
    if (this.metrics) {
      const row = Math.floor(index / this.metrics.columns);
      this.wrapEl.scrollTop = row * this.metrics.rowHeight;
      this.renderedWindow = null;
      this.paint(true);
    }
  },

  applyFocusClass(): void {
    for (const [i, el] of this.itemEls) el.toggleClass("is-focused", i === this.focusIndex);
  },

  activateFocused(): void {
    const item = this.items[this.focusIndex];
    if (!item) return;
    if (item.kind === "folder") this.enter(item.node.path);
    else this.openDetail(item.entry.path);
  },

  toggleFocused(): void {
    const item = this.items[this.focusIndex];
    if (!item || item.kind !== "image") return;
    this.toggleSelect(item.entry.path);
    this.applyFocusClass();
  },

  renameFocused(): void {
    const item = this.items[this.focusIndex];
    if (!item || item.kind !== "image") return;
    this.promptRename(item.entry);
  },
};

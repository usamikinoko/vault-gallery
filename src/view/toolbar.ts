/* The search / filter / sort / zoom strip above the grid. */

import { Notice, setIcon } from "obsidian";
import type { RefFilter, SortKey } from "../types";
import type { ViewPart } from "./viewTypes";

const SORT_OPTIONS: Array<[SortKey, string]> = [
  ["name", "文件名"],
  ["mtime", "修改时间"],
  ["ctime", "创建时间"],
  ["size", "文件大小"],
  ["custom", "自定义顺序"],
];

const REF_FILTER_OPTIONS: Array<[RefFilter, string]> = [
  ["all", "全部图片"],
  ["unreferenced", "仅未引用"],
  ["referenced", "仅已引用"],
];

/** Keystrokes coalesce into one grid render after this long. */
const SEARCH_DEBOUNCE_MS = 140;

export interface ToolbarPart {
  buildToolbar(container: HTMLElement): void;
  /** Push the thumbnail size and fit mode onto the shell. */
  applyThumbSize(): void;
}

export const toolbarPart: ViewPart<ToolbarPart> = {
  buildToolbar(container: HTMLElement): void {
    const bar = container.createDiv({ cls: "ib-toolbar" });

    const search = bar.createEl("input", {
      cls: "ib-search",
      type: "search",
      placeholder: "搜索图片（当前目录及子目录）…",
    });
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      // One render per burst of keystrokes, not one per key: on a large
      // subtree each render walks and re-sorts the whole hit list.
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => {
        this.searchTimer = 0;
        this.renderGrid({ resetScroll: true });
      }, SEARCH_DEBOUNCE_MS);
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && search.value) {
        e.stopPropagation();
        search.value = "";
        this.query = "";
        window.clearTimeout(this.searchTimer);
        this.searchTimer = 0;
        this.renderGrid({ resetScroll: true });
      }
    });
    this.searchEl = search;

    const filterField = bar.createDiv({ cls: "ib-field" });
    filterField.createSpan({ cls: "ib-field-label", text: "引用" });
    // `dropdown` is Obsidian's own class for a <select> (its stylesheet has
    // `.dropdown option`, and it uses `.conjunction.dropdown` on a select in
    // Bases). It is not decoration: the host resets `appearance: none` on every
    // select AND reserves a 13px arrow slot in `background-position`, but only
    // `.dropdown` actually supplies the arrow image. Without the class a plugin
    // select renders with a 24.7px empty gutter and no caret at all — measured
    // with a computed-style probe, not guessed.
    const filterSel = filterField.createEl("select", { cls: "ib-filter dropdown" });
    for (const [value, label] of REF_FILTER_OPTIONS) {
      filterSel.createEl("option", { text: label, value });
    }
    filterSel.value = this.plugin.settings.refFilter;
    filterSel.addEventListener("change", () => {
      this.plugin.settings.refFilter = filterSel.value as RefFilter;
      void this.plugin.saveSettings();
      this.renderGrid({ resetScroll: true });
    });

    const field = bar.createDiv({ cls: "ib-field" });
    field.createSpan({ cls: "ib-field-label", text: "排序" });
    // Same reason as the reference filter above: `dropdown` is what draws the
    // caret.
    const sortSel = field.createEl("select", { cls: "ib-sort dropdown" });
    for (const [value, label] of SORT_OPTIONS) {
      sortSel.createEl("option", { text: label, value });
    }
    sortSel.value = this.plugin.settings.sortKey;
    sortSel.addEventListener("change", () => {
      this.plugin.settings.sortKey = sortSel.value as SortKey;
      void this.plugin.saveSettings();
      this.renderGrid({ resetScroll: true });
    });

    const dirBtn = bar.createEl("button", { cls: "ib-icon-btn" });
    // Both the glyph and the tooltip follow the current direction, so the button
    // reads as a state plus its consequence — "升序，点击改为降序" — rather than a
    // bare verb. Vault Jukebox's sort control is worded the same way, and the
    // two plugins' toolbars should not describe the same toggle differently.
    const syncDir = () => {
      const asc = this.plugin.settings.sortAsc;
      setIcon(dirBtn, asc ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow");
      dirBtn.setAttr("title", asc ? "升序，点击改为降序" : "降序，点击改为升序");
    };
    syncDir();
    dirBtn.addEventListener("click", () => {
      this.plugin.settings.sortAsc = !this.plugin.settings.sortAsc;
      void this.plugin.saveSettings();
      syncDir();
      this.renderGrid({ resetScroll: true });
    });

    const resetBtn = bar.createEl("button", {
      cls: "ib-icon-btn",
      title: "清除当前目录的自定义顺序",
    });
    setIcon(resetBtn, "rotate-ccw");
    resetBtn.addEventListener("click", () => {
      const orders = this.plugin.settings.customOrders;
      if (!(this.currentPath in orders)) {
        new Notice("当前目录没有自定义顺序");
        return;
      }
      delete orders[this.currentPath];
      void this.plugin.saveSettings();
      new Notice("已清除当前目录的自定义顺序");
      this.renderGrid({ resetScroll: true });
    });

    const zoom = bar.createEl("input", {
      cls: "ib-zoom",
      type: "range",
      title: "缩略图尺寸",
    });
    zoom.min = "96";
    zoom.max = "280";
    zoom.step = "4";
    zoom.value = String(this.plugin.settings.thumbnailSize);
    zoom.addEventListener("input", () => {
      this.plugin.settings.thumbnailSize = Number(zoom.value);
      this.applyThumbSize();
      this.repaintForSize();
    });
    // Only the settled value is persisted; dragging must not write data.json.
    zoom.addEventListener("change", () => {
      void this.plugin.saveSettings();
    });

    const iconButton = (title: string, icon: string, fn: () => void) => {
      const btn = bar.createEl("button", { cls: "ib-icon-btn", title });
      setIcon(btn, icon);
      btn.addEventListener("click", fn);
    };

    iconButton("在当前目录中新建子目录", "folder-plus", () => this.promptCreateFolder());
    iconButton("粘贴剪贴板里的图片到当前目录（也可直接按 Ctrl/Cmd+V）", "clipboard-paste", () =>
      void this.importFromSystemClipboard()
    );
    iconButton("把当前目录（含子目录）的图片打包成 ZIP 导出", "download", () =>
      this.exportCurrentFolder()
    );
    iconButton("刷新当前目录", "refresh-cw", () => {
      this.store.invalidateBacklinks();
      this.refresh();
    });
  },

  applyThumbSize(): void {
    this.contentEl.style.setProperty("--ib-thumb", `${this.plugin.settings.thumbnailSize}px`);
    // One class on the shell beats a class on every card: the fit mode changes
    // two CSS rules, and neither of them needs to know about a given image.
    this.contentEl.toggleClass("is-crop-thumbs", this.plugin.settings.thumbnailFit === "crop");
  },
};

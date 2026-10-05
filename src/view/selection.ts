/* Selection: hit tests, range and select-all, the action bar, and the lightbox. */

import { Notice, setIcon } from "obsidian";
import type { ImageEntry } from "../types";
import { ImageDetailModal } from "../detail/lightbox";
import { FolderPickerModal } from "../batchModal";
import type { ViewPart } from "./viewTypes";

export interface SelectionPart {
  toggleSelect(path: string): void;
  selectRangeTo(path: string): void;
  selectAll(): void;
  syncSelectionClasses(): void;
  selectedEntries(): ImageEntry[];
  renderSelectionBar(): void;
  copySelectionEmbed(): void;
  copySelectionPaths(): void;
  promptMoveSelection(): void;
  openDetail(path: string): void;
}

export const selectionPart: ViewPart<SelectionPart> = {
  toggleSelect(path: string): void {
    if (this.selection.has(path)) this.selection.delete(path);
    else {
      this.selection.add(path);
      this.anchor = path;
    }
    this.syncSelectionClasses();
    this.renderSelectionBar();
  },

  selectRangeTo(path: string): void {
    const to = this.indexOf(path);
    if (to < 0) return;
    const from = this.anchor ? this.indexOf(this.anchor) : -1;
    if (from < 0) {
      this.selection.add(path);
    } else {
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      for (let i = lo; i <= hi; i++) {
        const it = this.items[i];
        if (it.kind === "image") this.selection.add(it.entry.path);
      }
    }
    this.syncSelectionClasses();
    this.renderSelectionBar();
  },

  selectAll(): void {
    for (const it of this.items) {
      if (it.kind === "image") this.selection.add(it.entry.path);
    }
    this.syncSelectionClasses();
    this.renderSelectionBar();
  },

  syncSelectionClasses(): void {
    for (const [index, el] of this.itemEls) {
      const it = this.items[index];
      if (!it || it.kind !== "image") continue;
      el.toggleClass("is-selected", this.selection.has(it.entry.path));
    }
  },

  selectedEntries(): ImageEntry[] {
    return this.visible.filter((e) => this.selection.has(e.path));
  },

  renderSelectionBar(): void {
    const bar = this.selBarEl;
    if (!bar) return;
    // The bar is rebuilt on every vault event, and it is the same bar almost
    // every time. One string compare beats emptying and refilling it while the
    // user is mid-scroll. 全选 is the only button that depends on anything
    // else, and only on whether there is something left to select.
    const canSelectAll =
      this.selection.size > 0 &&
      this.visible.length > 0 &&
      this.selection.size < this.visible.length;
    const signature = `${this.selection.size}\u0000${canSelectAll}`;
    if (signature === this.selSignature) return;
    this.selSignature = signature;

    bar.empty();
    const n = this.selection.size;
    bar.toggleClass("is-hidden", n === 0);
    if (n === 0) return;

    const label = bar.createSpan({ cls: "ib-sel-count", text: `已选中 ${n} 项` });

    const make = (text: string, icon: string, cls: string, fn: () => void) => {
      const btn = bar.createEl("button", { cls: `ib-btn ib-sel-btn ${cls}` });
      setIcon(btn.createSpan({ cls: "ib-sel-icon" }), icon);
      btn.createSpan({ text });
      btn.addEventListener("click", fn);
    };

    make("移动到…", "folder-input", "", () => this.promptMoveSelection());
    make("删除", "trash", "is-danger", () => void this.deleteSelection());
    make("复制嵌入引用", "link", "", () => this.copySelectionEmbed());
    make("复制文件路径", "copy", "", () => this.copySelectionPaths());
    if (canSelectAll) make("全选", "check-check", "", () => this.selectAll());
    make("取消选择", "x", "", () => {
      this.selection.clear();
      this.anchor = null;
      this.syncSelectionClasses();
      this.renderSelectionBar();
    });

    label.setAttr(
      "title",
      "悬停卡片勾选，或 Ctrl/Cmd 点击多选、Shift 点击选择区间；Esc 取消"
    );
  },

  copySelectionEmbed(): void {
    const text = this.selectedEntries()
      .map((e) => `![[${e.path}]]`)
      .join("\n");
    void navigator.clipboard.writeText(text);
    new Notice(`已复制 ${this.selection.size} 条嵌入引用`);
  },

  copySelectionPaths(): void {
    const text = this.selectedEntries()
      .map((e) => e.path)
      .join("\n");
    void navigator.clipboard.writeText(text);
    new Notice(`已复制 ${this.selection.size} 条文件路径`);
  },

  promptMoveSelection(): void {
    const folders = this.store.listFolders();
    if (folders.length === 0) return;
    new FolderPickerModal(
      this.app,
      folders,
      (folder) => {
        void this.moveImages([...this.selection], folder.isRoot() ? "" : folder.path, true);
      },
      `把 ${this.selection.size} 项移动到…`
    ).open();
  },

  /**
   * The lightbox pages through the grid's own order, so the list it walks must
   * be the visible one, not the folder's full contents.
   */
  openDetail(path: string): void {
    const index = this.visible.findIndex((e) => e.path === path);
    if (index < 0) return;
    new ImageDetailModal(this.app, {
      entries: this.visible,
      index,
      getBacklinks: (p) => this.store.getBacklinks(p),
    }).open();
  },
};

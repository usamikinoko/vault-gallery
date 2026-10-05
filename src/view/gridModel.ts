/* Turning the current folder, query and filters into the ordered cell list. */

import { setIcon } from "obsidian";
import type { FolderNode, GridItem, ImageEntry, RefFilter } from "../types";
import type { ViewPart } from "./viewTypes";

export interface GridModelPart {
  renderGrid(opts?: { resetScroll?: boolean }): void;
  toggleOrphanFilter(): void;
  renderEmptyState(opts: {
    icon?: string;
    title: string;
    hint?: string;
    /** Offer "new subfolder" and "paste". */
    actions?: boolean;
    /** Offer to drop the reference filter. */
    clearFilter?: boolean;
  }): void;
  /** Everything the memo in `collect` is allowed to depend on. */
  collectKeyFor(): string;
  collect(): { items: GridItem[]; images: ImageEntry[]; node: FolderNode | null };
  collectUncached(): { items: GridItem[]; images: ImageEntry[]; node: FolderNode | null };
  /** Path -> grid index, so hit tests and drag feedback are not O(n) scans. */
  rebuildPathIndex(items: GridItem[]): void;
}

export const gridModelPart: ViewPart<GridModelPart> = {
  /**
   * Everything the grid will show, with a memo in front of it.
   *
   * Building the list sorts a folder's images and walks the subtree when
   * searching. Selection changes, drag feedback and the selection bar all
   * repaint without changing any of those inputs, so the sorted result is
   * reused until something that actually feeds it moves.
   */
  renderGrid(opts: { resetScroll?: boolean } = {}): void {
    this.applyThumbSize();
    const result = this.collect();
    this.items = result.items;
    this.visible = result.images;
    this.renderedWindow = null;
    // Grid indices are positions in `items`; when the list is rebuilt the old
    // indices mean different things, so cached card elements must not survive
    // (the paint diff would otherwise reuse a card for the wrong image).
    this.itemEls.clear();

    if (opts.resetScroll) this.wrapEl.scrollTop = 0;

    const node = result.node;
    const searching = this.query.length > 0;
    const needsRefs =
      this.plugin.settings.refFilter !== "all" || this.plugin.settings.showRefBadges;

    let total = 0;
    if (needsRefs) {
      // One pass over the library, not two: the status line needs both the
      // total and the orphan count.
      const counts = this.store.countReferenced();
      total = counts.total;
      this.orphanCount = counts.orphans;
    } else {
      this.orphanCount = 0;
    }

    const items = this.items;
    const images = this.visible;

    if (!node) {
      this.countEl.setText("");
      this.gridEl.empty();
      this.metrics = null;
      this.renderEmptyState({
        icon: "alert-triangle",
        title: "找不到这个目录",
        hint: `当前根目录「${this.store.normalizeRoot() || "（空）"}」不存在，请到设置里改成一个真实目录。`,
      });
      this.renderSelectionBar();
      return;
    }

    if (items.length === 0) {
      this.gridEl.empty();
      this.metrics = null;
      const filter = this.plugin.settings.refFilter;
      if (searching) {
        this.renderEmptyState({
          icon: "search-x",
          title: `没有匹配「${this.query}」的图片`,
          hint: "换个关键词试试。",
        });
      } else if (filter !== "all") {
        this.renderEmptyState({
          icon: "filter",
          title: "这个筛选条件下没有图片",
          hint:
            filter === "unreferenced"
              ? "当前目录里每张图都被笔记引用了。"
              : "当前目录里还没有被引用的图片。",
          clearFilter: true,
        });
      } else {
        this.renderEmptyState({
          icon: "images",
          title: "这个目录还是空的",
          hint: "把图片粘贴进来（Ctrl/Cmd+V），或新建子目录开始分类。",
          actions: true,
        });
      }
    } else {
      this.paint(true);
    }

    // --- status line ---
    const parts: string[] = [];
    if (searching) parts.push(`${images.length} 张匹配`);
    else {
      parts.push(`${images.length} 张图片`);
      const folders = items.length - images.length;
      if (folders > 0) parts.push(`${folders} 个子目录`);
      parts.push(`子树共 ${node.totalImages} 张`);
    }
    if (this.plugin.settings.showRefBadges) {
      parts.push(`未引用 ${this.orphanCount} / ${total}`);
    }
    this.countEl.empty();
    this.countEl.createSpan({ text: parts.join(" · ") });
    if (this.orphanCount > 0) {
      const chip = this.countEl.createSpan({
        cls: "ib-orphan-chip",
        text: this.plugin.settings.refFilter === "unreferenced" ? "清除筛选" : "只看未引用",
      });
      chip.addEventListener("click", () => this.toggleOrphanFilter());
    }

    this.renderSelectionBar();
  },

  toggleOrphanFilter(): void {
    const next: RefFilter =
      this.plugin.settings.refFilter === "unreferenced" ? "all" : "unreferenced";
    this.plugin.settings.refFilter = next;
    void this.plugin.saveSettings();
    const sel = this.contentEl.querySelector<HTMLSelectElement>(".ib-filter");
    if (sel) sel.value = next;
    this.renderGrid({ resetScroll: true });
  },

  /**
   * The empty grid doubles as the place a new folder gets made. A bare "no
   * images here" line leaves the user hunting the toolbar; offering the two
   * things they actually came to do costs one row of buttons.
   */
  renderEmptyState(opts: {
    icon?: string;
    title: string;
    hint?: string;
    actions?: boolean;
    clearFilter?: boolean;
  }): void {
    // The empty state is a single full-width block, so drop the virtual grid's
    // pinned columns and row height or it would sit inside a phantom cell.
    this.gridEl.removeClass("is-virtual");
    this.gridEl.style.gridTemplateColumns = "";
    this.gridEl.style.gridAutoRows = "";

    const box = this.gridEl.createDiv({ cls: "ib-empty" });

    if (opts.icon) setIcon(box.createDiv({ cls: "ib-empty-icon" }), opts.icon);
    box.createDiv({ cls: "ib-empty-title", text: opts.title });
    if (opts.hint) box.createDiv({ cls: "ib-empty-hint", text: opts.hint });

    const row = box.createDiv({ cls: "ib-empty-actions" });
    const button = (text: string, icon: string, cls: string, fn: () => void) => {
      const btn = row.createEl("button", { cls: `ib-btn ${cls}` });
      setIcon(btn.createSpan({ cls: "ib-sel-icon" }), icon);
      btn.createSpan({ text });
      btn.addEventListener("click", fn);
    };

    if (opts.actions) {
      button("新建子目录", "folder-plus", "mod-cta", () => this.promptCreateFolder());
      button("粘贴剪贴板图片", "clipboard-paste", "", () => void this.importFromSystemClipboard());
    }
    if (opts.clearFilter) {
      button("显示全部图片", "filter-x", "", () => this.toggleOrphanFilter());
    }
  },

  // ------------------------------------------------------------ collection

  collectKeyFor(): string {
    const s = this.plugin.settings;
    return [
      this.store.generation,
      this.store.linkGeneration,
      this.currentPath,
      this.query,
      s.sortKey,
      s.sortAsc,
      s.refFilter,
      s.showRefBadges ? 1 : 0,
      s.showSubfolders ? 1 : 0,
      s.folderFirst ? 1 : 0,
      // Custom order for *this* folder, so a reorder invalidates the memo.
      (s.customOrders[this.currentPath] ?? []).join("\u0001"),
    ].join("\u0000");
  },

  collect(): { items: GridItem[]; images: ImageEntry[]; node: FolderNode | null } {
    const key = this.collectKeyFor();
    if (key === this.collectKey) {
      return { items: this.items, images: this.visible, node: this.collectedNode };
    }

    const result = this.collectUncached();
    this.collectKey = result.node ? key : null;
    this.collectedNode = result.node;
    return result;
  },

  collectUncached(): { items: GridItem[]; images: ImageEntry[]; node: FolderNode | null } {
    const tree = this.store.buildTree();
    if (!tree) return { items: [], images: [], node: null };
    const node = this.store.findNode(tree, this.currentPath);
    if (!node) return { items: [], images: [], node: null };

    const settings = this.plugin.settings;
    const searching = this.query.length > 0;
    const refs = this.store.getReferencedPaths();

    let pool: ImageEntry[];
    if (searching) {
      const hits: ImageEntry[] = [];
      const collect = (n: FolderNode) => {
        for (const img of n.images) {
          if (
            img.name.toLowerCase().includes(this.query) ||
            img.path.toLowerCase().includes(this.query)
          ) {
            hits.push(img);
          }
        }
        n.children.forEach(collect);
      };
      collect(node);
      pool = hits;
    } else {
      pool = node.images;
    }

    // Reference counts are needed for both the filter and the card pills.
    this.refCounts = new Map();
    if (settings.showRefBadges || settings.refFilter !== "all") {
      for (const img of pool) {
        this.refCounts.set(img.path, this.store.getBacklinks(img.path).length);
      }
    }

    if (settings.refFilter === "unreferenced") {
      pool = pool.filter((img) => !refs.has(img.path));
    } else if (settings.refFilter === "referenced") {
      pool = pool.filter((img) => refs.has(img.path));
    }

    const images = this.store.sortImages(pool, node.path);
    const folders = !searching && settings.showSubfolders ? [...node.children] : [];
    if (!settings.folderFirst) folders.sort((a, b) => b.totalImages - a.totalImages);

    const items: GridItem[] = [
      ...folders.map((f) => ({ kind: "folder", node: f }) as GridItem),
      ...images.map((e) => ({ kind: "image", entry: e }) as GridItem),
    ];

    this.rebuildPathIndex(items);
    return { items, images, node };
  },

  rebuildPathIndex(items: GridItem[]): void {
    const index = new Map<string, number>();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      index.set(item.kind === "image" ? item.entry.path : item.node.path, i);
    }
    this.pathIndex = index;
  },
};

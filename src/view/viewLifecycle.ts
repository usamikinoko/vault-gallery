/* Mount / unmount, the refresh entry points, and the leaf's identity. */

import { TFile } from "obsidian";
import { VIEW_TYPE_VAULT_GALLERY } from "./viewTypes";
import type { ViewPart } from "./viewTypes";
import { ancestorsOf } from "./folderTree";

/**
 * Deliberately *not* part of `LifecyclePart`: `ItemView` declares both of these
 * `protected`, and an interface cannot widen that. They are still installed and
 * still type-checked — just not merged into the class type.
 */
interface MountPart {
  onOpen(): Promise<void>;
  onClose(): Promise<void>;
}

export interface LifecyclePart {
  getViewType(): string;
  getDisplayText(): string;
  getIcon(): string;
  currentFolderPath(): string;
  exportCurrentFolder(): void;
  /**
   * Re-read the vault, then repaint. The three repaint entry points are split
   * by what they assume about the data, and this is the expensive one.
   */
  refresh(): void;
  onVaultChanged(): void;
  /**
   * Backlinks moved but the vault's structure did not: repaint the
   * link-derived bits without dropping the tree cache.
   */
  onLinksChanged(): void;
  /** Drop selected paths whose file is gone. */
  pruneSelection(): void;
}

export const lifecyclePart: ViewPart<LifecyclePart & MountPart> = {
  getViewType(): string {
    return VIEW_TYPE_VAULT_GALLERY;
  },

  getDisplayText(): string {
    return "图像资源管理器";
  },

  getIcon(): string {
    return "images";
  },

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("ib-root");
    container.tabIndex = 0;

    this.buildNav(container);

    // --- pane: manage (the browser) ---
    const manage = container.createDiv({ cls: "ib-pane" });
    manage.setAttr("data-pane", "manage");
    this.buildToolbar(manage);

    const body = manage.createDiv({ cls: "ib-body" });
    const sidebar = body.createDiv({ cls: "ib-sidebar" });
    this.treeEl = sidebar.createDiv({ cls: "ib-tree" });

    const main = body.createDiv({ cls: "ib-main" });
    const head = main.createDiv({ cls: "ib-main-head" });
    this.crumbEl = head.createDiv({ cls: "ib-crumb" });
    this.countEl = head.createDiv({ cls: "ib-count" });

    this.selBarEl = main.createDiv({ cls: "ib-selbar is-hidden" });

    const wrap = main.createDiv({ cls: "ib-grid-wrap" });
    this.wrapEl = wrap;
    this.gridEl = wrap.createDiv({ cls: "ib-grid" });

    wrap.addEventListener("scroll", this.onScrollBound, { passive: true });
    window.addEventListener("resize", this.onResizeBound);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onResizeBound);
      this.resizeObserver.observe(wrap);
    }
    container.addEventListener("keydown", (e) => this.onKeyDown(e));
    container.addEventListener("paste", (e) => {
      void this.onPaste(e);
    });
    // Clicking bare grid (not a card) is a "none of these" gesture: it clears
    // the selection the same way clicking empty desktop space clears a
    // marquee. Card clicks stop at their own handlers, so only true empty
    // space reaches this.
    this.gridEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".ib-card")) return;
      if (this.selection.size === 0) return;
      this.selection.clear();
      this.anchor = null;
      this.syncSelectionClasses();
      this.renderSelectionBar();
    });
    this.makeCurrentFolderDropTarget(wrap);

    // --- pane: heatmap ---
    const heat = container.createDiv({ cls: "ib-pane" });
    heat.setAttr("data-pane", "heatmap");
    this.heatPaneEl = heat.createDiv({ cls: "ib-heat-host" });

    // --- pane: settings ---
    const preferences = container.createDiv({ cls: "ib-pane" });
    preferences.setAttr("data-pane", "settings");
    this.settingsPaneEl = preferences;

    this.paneEls = { manage, heatmap: heat, settings: preferences };

    // Thumbnails land asynchronously; each one upgrades the mounted card that
    // asked for it. One subscription per view, not one per card.
    this.unsubThumbs = this.plugin.thumbs.onReady((path, url) =>
      this.applyThumbSrc(path, url)
    );

    const tree = this.store.buildTree();
    const configured = this.store.normalizeRoot();
    const remembered = this.plugin.settings.lastPath;
    let start = tree ? tree.path : configured;
    if (remembered && tree && this.store.findNode(tree, remembered)) start = remembered;

    this.currentPath = start;
    this.expanded.add(start);
    // Expand the ancestors of the remembered folder so it is visible in the tree.
    for (const ancestor of ancestorsOf(start)) this.expanded.add(ancestor);
    if (tree) for (const c of tree.children) this.expanded.add(c.path);

    this.refresh();
    this.showPane(this.activePane);
  },

  async onClose(): Promise<void> {
    this.wrapEl?.removeEventListener("scroll", this.onScrollBound);
    window.removeEventListener("resize", this.onResizeBound);
    window.cancelAnimationFrame(this.paintFrame);
    this.paintFrame = 0;
    window.clearTimeout(this.searchTimer);
    this.searchTimer = 0;
    this.unsubThumbs?.();
    this.unsubThumbs = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.contentEl.empty();
  },

  currentFolderPath(): string {
    return this.currentPath;
  },

  exportCurrentFolder(): void {
    this.plugin.openZipExport(this.currentPath);
  },

  /**
   * Dropping the cache has to happen here rather than only in the plugin's
   * vault listener: every mutation the view performs itself (move, rename,
   * delete, paste, new folder) ends in `refresh()`, and if the cache survived
   * it the grid would show the library as it was a moment before the edit.
   * Relying on the listener alone also silently breaks anywhere vault events
   * do not arrive — which is how the smoke test found it.
   */
  refresh(): void {
    this.store.invalidateTree();
    this.renderTree();
    this.renderCrumb();
    this.renderGrid({ resetScroll: false });
    this.renderSelectionBar();
  },

  onVaultChanged(): void {
    this.store.invalidateBacklinks();
    this.pruneSelection();
    this.refresh();
  },

  /**
   * The cheap twin of `onVaultChanged`: the tree cache survives, the grid memo
   * is keyed on the store's link generation so the reference pills and filters
   * rebuild, and nothing re-walks the vault. Skipped entirely when nothing on
   * screen depends on backlinks.
   */
  onLinksChanged(): void {
    const s = this.plugin.settings;
    if (!s.showRefBadges && s.refFilter === "all") return;
    this.renderGrid({ resetScroll: false });
    this.renderSelectionBar();
  },

  /** A rename made in the native explorer used to leave a stale path selected. */
  pruneSelection(): void {
    for (const path of [...this.selection]) {
      if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) {
        this.selection.delete(path);
      }
    }
  },
};

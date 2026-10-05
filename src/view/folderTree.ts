/* The sidebar folder tree, and entering a folder from it. */

import { setIcon } from "obsidian";
import type { FolderNode } from "../types";
import { parentPath } from "../utils";
import type { ViewPart } from "./viewTypes";

export interface FolderTreePart {
  renderTree(): void;
  /** Navigate to a folder: reset search / selection and repaint everything. */
  enter(path: string): void;
}

export const folderTreePart: ViewPart<FolderTreePart> = {
  renderTree(): void {
    const tree = this.store.buildTree();
    if (!tree) {
      if (this.treeSignature === "(missing)") return;
      this.treeSignature = "(missing)";
      this.treeEl.empty();
      this.treeEl
        .createDiv({ cls: "ib-empty" })
        .setText(`找不到这个目录：${this.store.normalizeRoot() || "（空）"}`);
      return;
    }

    // Rebuilding the rows is an `empty()` plus a DOM node per folder, and the
    // tree is redrawn on every vault event — including the ones that changed
    // nothing a row shows. The signature covers every input the rows are drawn
    // from: the store's generation moves on any vault change, so an unchanged
    // tree costs a string compare instead of a few hundred node allocations in
    // the middle of whatever the user is doing.
    const signature = `${this.currentPath}\u0000${[...this.expanded]
      .sort()
      .join("\u0001")}\u0000${this.store.generation}`;
    if (signature === this.treeSignature) return;
    this.treeSignature = signature;

    const rows: FolderNode[] = [];
    const flatten = (node: FolderNode) => {
      rows.push(node);
      if (this.expanded.has(node.path)) node.children.forEach(flatten);
    };
    flatten(tree);

    this.treeEl.empty();

    for (const node of rows) {
      const row = this.treeEl.createDiv({ cls: "ib-tree-row" });
      row.style.paddingLeft = `${8 + node.depth * 14}px`;
      if (node.path === this.currentPath) row.addClass("is-active");

      const arrow = row.createSpan({ cls: "ib-tree-arrow" });
      if (node.children.length > 0) {
        setIcon(arrow, this.expanded.has(node.path) ? "chevron-down" : "chevron-right");
        arrow.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.expanded.has(node.path)) this.expanded.delete(node.path);
          else this.expanded.add(node.path);
          this.renderTree();
        });
      }

      const icon = row.createSpan({ cls: "ib-tree-icon" });
      setIcon(icon, node.depth === 0 ? "hard-drive" : "folder");
      row.createSpan({ cls: "ib-tree-name", text: node.name });

      if (node.totalImages > 0) {
        row.createSpan({ cls: "ib-tree-badge", text: String(node.totalImages) });
      }

      row.addEventListener("click", () => this.enter(node.path));

      // Tree rows are drag sources as well as drop targets: dragging one onto
      // another is the fastest way to re-parent a directory, and the gesture
      // people already expect from the native explorer. The vault root is the
      // one row that cannot move.
      row.draggable = node.path !== "";
      row.addEventListener("dragstart", (e) => {
        if (node.path === "") {
          e.preventDefault();
          return;
        }
        this.beginFolderDrag(node.path);
        row.addClass("is-dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", node.path);
        }
      });
      row.addEventListener("dragend", () => {
        row.removeClass("is-dragging");
        this.endDrag();
      });

      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showFolderMenu(e, node);
      });

      this.makeFolderDropTarget(row, node.path);
    }
  },

  enter(path: string): void {
    if (path !== this.currentPath) this.selection.clear();
    this.currentPath = path;
    this.query = "";
    if (this.searchEl) this.searchEl.value = "";
    this.anchor = null;
    this.focusIndex = -1;
    this.expanded.add(path);
    this.plugin.settings.lastPath = path;
    void this.plugin.saveSettings();
    this.renderTree();
    this.renderCrumb();
    this.renderGrid({ resetScroll: true });
    this.renderSelectionBar();
  },
};

/** The chain of ancestors to expand so a remembered folder is visible. */
export function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  // parentPath() strictly shortens, so this cannot cycle.
  for (let cursor = parentPath(path); cursor !== ""; cursor = parentPath(cursor)) {
    out.push(cursor);
  }
  return out;
}

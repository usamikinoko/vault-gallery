/* Image-side mutations: move, rename, delete, reorder. */

import { Notice, TFile } from "obsidian";
import type { ImageEntry } from "../types";
import { ConfirmDeleteModal } from "../batchModal";
import { PromptModal } from "../detail/promptModal";
import { basename, extOf, parentPath, stripExt } from "../utils";
import type { ViewPart } from "./viewTypes";

export interface FileOpsPart {
  /** Move a batch of images into one folder, keeping selection on the results. */
  moveImages(sourcePaths: string[], destFolderPath: string, announce?: boolean): Promise<void>;
  /** Back-compat single-file entry point. */
  moveImage(sourcePath: string, destFolderPath: string): Promise<void>;
  promptRename(entry: ImageEntry): void;
  deleteSelection(): Promise<void>;
  /**
   * Trash an explicit set of entries. The context menu uses this so a
   * right-click delete on an unselected card deletes *that card* rather than
   * whatever happens to be selected.
   */
  deleteImages(entries: ImageEntry[]): Promise<void>;
  /** Drop-triggered reorder; writes the resulting name order for the folder. */
  reorderImages(
    sourcePaths: string[] | string,
    targetPath: string,
    insertAfter: boolean
  ): Promise<void>;
  /** Append " 2", " 3", … until the path is free. */
  uniquePath(desired: string, ignorePath: string): string;
  /** Keep custom orders from accumulating names of files that left the folder. */
  pruneFromOrder(folderPath: string, name: string): void;
}

export const fileOpsPart: ViewPart<FileOpsPart> = {
  async moveImages(
    sourcePaths: string[],
    destFolderPath: string,
    announce = false
  ): Promise<void> {
    const moved: Array<{ from: string; to: string }> = [];
    const nextSelection = new Set<string>();

    for (const sourcePath of sourcePaths) {
      const file = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(file instanceof TFile)) continue;

      const currentDir = parentPath(sourcePath);
      if (currentDir === destFolderPath) {
        nextSelection.add(sourcePath);
        continue;
      }

      const desired = destFolderPath ? `${destFolderPath}/${file.name}` : file.name;
      const target = this.uniquePath(desired, sourcePath);
      if (target === file.path) {
        nextSelection.add(sourcePath);
        continue;
      }

      try {
        await this.app.fileManager.renameFile(file, target);
        moved.push({ from: sourcePath, to: target });
        nextSelection.add(target);
        this.pruneFromOrder(currentDir, basename(sourcePath));
      } catch (err) {
        console.error(err);
        new Notice(`移动失败：${basename(sourcePath)} —— ${String(err)}`);
        nextSelection.add(sourcePath);
      }
    }

    if (moved.length > 0) {
      this.plugin.settings.lastPath = this.currentPath;
      void this.plugin.saveSettings();
      this.selection = nextSelection;
      if (announce) {
        new Notice(
          moved.length === 1
            ? `已移动 1 个文件到 ${destFolderPath || "/"}`
            : `已移动 ${moved.length} 个文件到 ${destFolderPath || "/"}`
        );
      }
    }
    this.refresh();
  },

  async moveImage(sourcePath: string, destFolderPath: string): Promise<void> {
    await this.moveImages([sourcePath], destFolderPath, true);
  },

  promptRename(entry: ImageEntry): void {
    new PromptModal(this.app, "重命名图片", entry.name, async (value) => {
      if (value === entry.name) return;
      // Keep the original extension if the user dropped it.
      const dot = value.lastIndexOf(".");
      const nextName = dot > 0 ? value : `${value}.${extOf(entry.name)}`;
      const dir = parentPath(entry.path);
      const target = dir ? `${dir}/${nextName}` : nextName;
      if (this.app.vault.getAbstractFileByPath(target)) {
        new Notice("已存在同名文件");
        return;
      }
      try {
        await this.app.fileManager.renameFile(entry.file, target);
        if (this.selection.delete(entry.path)) this.selection.add(target);
        new Notice(`已重命名为 ${nextName}`);
        this.refresh();
      } catch (err) {
        console.error(err);
        new Notice(`重命名失败：${entry.name} —— ${String(err)}`);
      }
    }).open();
  },

  async deleteSelection(): Promise<void> {
    await this.deleteImages(this.selectedEntries());
  },

  async deleteImages(entries: ImageEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const items = entries.map((e) => ({
      name: e.name,
      path: e.path,
      refCount: this.store.getBacklinks(e.path).length,
    }));

    const run = async () => {
      const removed = new Set(entries.map((e) => e.path));
      let ok = 0;
      for (const entry of entries) {
        try {
          await this.app.fileManager.trashFile(entry.file);
          ok++;
          this.pruneFromOrder(parentPath(entry.path), entry.name);
        } catch (err) {
          console.error(err);
          new Notice(`删除失败：${entry.name} —— ${String(err)}`);
        }
      }
      for (const path of removed) this.selection.delete(path);
      this.anchor = null;
      new Notice(ok === 1 ? "已移入回收站" : `已将 ${ok} 个文件移入回收站`);
      this.refresh();
    };

    if (this.plugin.settings.confirmDelete) {
      new ConfirmDeleteModal(this.app, items, () => void run()).open();
    } else {
      await run();
    }
  },

  /**
   * Dropping onto another card's left/right half moves the whole dragged block
   * there and writes the resulting name order.
   */
  async reorderImages(
    sourcePaths: string[] | string,
    targetPath: string,
    insertAfter: boolean
  ): Promise<void> {
    const sources = Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths];
    if (sources.length === 0 || sources.includes(targetPath)) return;

    const targetDir = parentPath(targetPath);
    const foreign = sources.filter((p) => parentPath(p) !== targetDir);

    if (foreign.length > 0) {
      await this.moveImages(foreign, targetDir, false);
      // Paths may have been renamed by collision suffixes; re-resolve by name.
      const resolved: string[] = [];
      for (const p of sources) {
        const direct = this.app.vault.getAbstractFileByPath(p);
        if (direct instanceof TFile) {
          resolved.push(p);
          continue;
        }
        const guess = targetDir ? `${targetDir}/${basename(p)}` : basename(p);
        if (this.app.vault.getAbstractFileByPath(guess) instanceof TFile) resolved.push(guess);
      }
      sources.length = 0;
      sources.push(...resolved);
    }

    const tree = this.store.buildTree();
    if (!tree) return;
    const node = this.store.findNode(tree, targetDir);
    if (!node) return;

    const names = this.store.sortImages(node.images, node.path).map((i) => i.name);
    const moving = sources.map((p) => basename(p));

    const kept = names.filter((n) => !moving.includes(n));
    let to = kept.indexOf(basename(targetPath));
    if (to < 0) to = kept.length - 1;
    if (insertAfter) to += 1;

    // Preserve the visual order of the dragged block.
    const orderedMoving = names.filter((n) => moving.includes(n));
    kept.splice(to, 0, ...orderedMoving);

    this.plugin.settings.customOrders[targetDir] = kept;
    const switched = this.plugin.settings.sortKey !== "custom";
    this.plugin.settings.sortKey = "custom";
    await this.plugin.saveSettings();

    const sortSel = this.contentEl.querySelector<HTMLSelectElement>(".ib-sort");
    if (sortSel) sortSel.value = "custom";

    if (switched) new Notice("已切换到自定义顺序并保存本次调整");

    this.renderTree();
    this.renderCrumb();
    this.renderGrid();
  },

  /**
   * The dot is only added when there is an extension to add — folders have
   * none, and "立绘 2." is not a name anyone wants.
   */
  uniquePath(desired: string, ignorePath: string): string {
    const taken = (p: string) => {
      if (p === ignorePath) return false;
      return this.app.vault.getAbstractFileByPath(p) !== null;
    };
    if (!taken(desired)) return desired;

    const dir = parentPath(desired);
    const name = basename(desired);
    const base = stripExt(name);
    const ext = extOf(name);

    for (let i = 2; i < 1000; i++) {
      const candidate = ext ? `${base} ${i}.${ext}` : `${base} ${i}`;
      const p = dir ? `${dir}/${candidate}` : candidate;
      if (!taken(p)) return p;
    }
    return desired;
  },

  pruneFromOrder(folderPath: string, name: string): void {
    const orders = this.plugin.settings.customOrders;
    const list = orders[folderPath];
    if (!list) return;
    const next = list.filter((n) => n !== name);
    if (next.length === 0) delete orders[folderPath];
    else orders[folderPath] = next;
  },
};

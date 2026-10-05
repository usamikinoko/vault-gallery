/* Directory mutations: move, rename, create (with parents), delete. */

import { Notice, TFolder } from "obsidian";
import type { FolderNode } from "../types";
import { ConfirmDeleteModal } from "../batchModal";
import { PromptModal } from "../detail/promptModal";
import { sanitizeFileName } from "../importer";
import { joinPath, parentPath, uniqueName } from "../utils";
import type { ViewPart } from "./viewTypes";

export interface FolderOpsPart {
  moveFolder(src: string, dest: string, announce?: boolean): Promise<void>;
  /** Rewrite every path we cache when a folder (and its subtree) moves. */
  remapFolderPaths(src: string, target: string): void;
  promptCreateFolder(parent?: string): void;
  createFolder(parent: string, rawName: string): Promise<void>;
  promptRenameFolder(node: FolderNode): void;
  promptDeleteFolder(node: FolderNode): void;
  deleteFolder(path: string): Promise<void>;
}

export const folderOpsPart: ViewPart<FolderOpsPart> = {
  /**
   * `renameFile` does the move and rewrites links inside the moved subtree.
   * What it cannot know is our own bookkeeping, which is keyed by folder path:
   * the custom sort orders, the folder being browsed, the expanded set. Miss
   * one and the user lands on "目录不存在" in the very directory they moved.
   */
  async moveFolder(src: string, dest: string, announce = false): Promise<void> {
    if (!this.folderMoveAllowed(src, dest)) {
      new Notice("不能把目录移动到它自己或它的子目录里");
      return;
    }
    const folder = this.folderAt(src);
    if (!folder) {
      new Notice("目录不存在，可能已被移动或删除");
      this.refresh();
      return;
    }

    const target = this.uniquePath(joinPath(dest, folder.name), src);
    try {
      await this.app.fileManager.renameFile(folder, target);
    } catch (err) {
      console.error(err);
      new Notice(`移动目录失败：${folder.name} —— ${String(err)}`);
      return;
    }

    this.remapFolderPaths(src, target);
    this.selection.clear();
    this.anchor = null;
    this.plugin.settings.lastPath = this.currentPath;
    void this.plugin.saveSettings();
    if (announce) new Notice(`已把「${folder.name}」移动到 ${dest || "/"}`);
    this.refresh();
  },

  remapFolderPaths(src: string, target: string): void {
    if (!src || src === target) return;
    const remap = (p: string) =>
      p === src || p.startsWith(`${src}/`) ? target + p.slice(src.length) : p;

    this.currentPath = remap(this.currentPath);
    this.plugin.settings.lastPath = remap(this.plugin.settings.lastPath);

    const expanded = new Set<string>();
    for (const p of this.expanded) expanded.add(remap(p));
    this.expanded = expanded;

    const orders = this.plugin.settings.customOrders;
    const moved: Record<string, string[]> = {};
    for (const key of Object.keys(orders)) {
      if (key === src || key.startsWith(`${src}/`)) {
        moved[remap(key)] = orders[key];
        delete orders[key];
      }
    }
    Object.assign(orders, moved);
  },

  promptCreateFolder(parentArg?: string): void {
    // Defaulted in the body, not in the parameter list: `this` in a parameter
    // initializer does not pick up the part's `ThisType`.
    const parent = parentArg ?? this.currentPath;
    const folder = this.folderAt(parent);
    if (!folder) {
      new Notice("目标目录不存在");
      return;
    }
    const placeholder = uniqueName(
      "新建目录",
      "",
      (name) => this.app.vault.getAbstractFileByPath(joinPath(parent, name)) !== null
    );
    new PromptModal(
      this.app,
      `在「${parent || "/（Vault 根目录）"}」中新建目录`,
      placeholder,
      (value) => void this.createFolder(parent, value)
    ).open();
  },

  /**
   * Create a folder, and any missing parents along the way, so typing
   * "角色/立绘/夜晚" in the prompt does the obvious thing.
   */
  async createFolder(parent: string, rawName: string): Promise<void> {
    const segments = rawName
      .replace(/\\/g, "/")
      .split("/")
      .map((s) => sanitizeFileName(s))
      .filter(Boolean);
    if (segments.length === 0) {
      new Notice("目录名不能为空");
      return;
    }

    let cursor = parent;
    for (const segment of segments) {
      const next = joinPath(cursor, segment);
      const existing = this.app.vault.getAbstractFileByPath(next);
      if (existing instanceof TFolder) {
        cursor = next;
        continue;
      }
      if (existing) {
        new Notice(`「${next}」已被一个同名文件占用`);
        return;
      }
      try {
        await this.app.vault.createFolder(next);
      } catch (err) {
        console.error(err);
        new Notice(`新建目录失败：${next} —— ${String(err)}`);
        return;
      }
      cursor = next;
    }

    new Notice(`已新建目录「${segments[segments.length - 1]}」`);
    this.enter(cursor);
  },

  promptRenameFolder(node: FolderNode): void {
    if (!node.path) return;
    new PromptModal(this.app, "重命名目录", node.name, async (value) => {
      const name = sanitizeFileName(value);
      if (!name || name === node.name) return;
      const target = joinPath(parentPath(node.path), name);
      if (this.app.vault.getAbstractFileByPath(target)) {
        new Notice("已存在同名目录");
        return;
      }
      const folder = this.folderAt(node.path);
      if (!folder) return;
      try {
        await this.app.fileManager.renameFile(folder, target);
        this.remapFolderPaths(node.path, target);
        new Notice(`已重命名为 ${name}`);
        this.refresh();
      } catch (err) {
        console.error(err);
        new Notice(`重命名失败：${node.name} —— ${String(err)}`);
      }
    }).open();
  },

  promptDeleteFolder(node: FolderNode): void {
    if (!node.path) return;
    const folder = this.folderAt(node.path);
    if (!folder) return;

    const items = folder.children.map((child) => ({
      name: child.name,
      path: child.path,
      refCount: 0,
    }));

    new ConfirmDeleteModal(this.app, items, () => void this.deleteFolder(node.path), {
      title: `删除目录「${node.name}」？`,
      note:
        node.totalImages > 0
          ? `目录里的全部内容（含 ${node.totalImages} 张图片及其子目录）都会被移入回收站。`
          : "目录里的全部内容及其子目录都会被移入回收站。",
      confirmText: "移入回收站",
    }).open();
  },

  async deleteFolder(path: string): Promise<void> {
    const folder = this.folderAt(path);
    if (!folder) return;
    const name = folder.name;
    try {
      await this.app.fileManager.trashFile(folder);
    } catch (err) {
      console.error(err);
      new Notice(`删除目录失败：${name} —— ${String(err)}`);
      return;
    }

    const inSubtree = (p: string) => p === path || p.startsWith(`${path}/`);
    const orders = this.plugin.settings.customOrders;
    for (const key of Object.keys(orders)) if (inSubtree(key)) delete orders[key];
    for (const p of [...this.expanded]) if (inSubtree(p)) this.expanded.delete(p);
    if (inSubtree(this.currentPath)) this.currentPath = parentPath(path);
    this.expanded.add(this.currentPath);
    this.selection.clear();
    this.anchor = null;
    this.plugin.settings.lastPath = this.currentPath;
    void this.plugin.saveSettings();

    new Notice(`已把目录「${name}」移入回收站`);
    this.refresh();
  },
};

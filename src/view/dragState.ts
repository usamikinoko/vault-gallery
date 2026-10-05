/*
 * Drag state and drop targets.
 *
 * Every folder-shaped surface in the view — tree rows, breadcrumb segments,
 * folder cards — goes through `makeFolderDropTarget`, so the cycle rules are
 * enforced in exactly one place.
 */

import { TFolder } from "obsidian";
import { parentPath } from "../utils";
import type { DragPayload, ViewPart } from "./viewTypes";

export interface DragStatePart {
  beginImageDrag(paths: string[]): void;
  beginFolderDrag(path: string): void;
  endDrag(): void;
  draggedImages(): string[];
  /** May the current drag land inside this folder? */
  canDropInto(target: string): boolean;
  folderMoveAllowed(src: string, dest: string): boolean;
  folderAt(path: string): TFolder | null;
  clearDropMarkers(): void;
  /** Finish a drop into a folder, whatever the payload happens to be. */
  landDrag(folderPath: string): void;
  makeFolderDropTarget(el: HTMLElement, folderPath: string): void;
  makeCurrentFolderDropTarget(wrap: HTMLElement): void;
}

export const dragStatePart: ViewPart<DragStatePart> = {
  beginImageDrag(paths: string[]): void {
    if (paths.length === 0) return;
    this.drag = { kind: "images", paths };
  },

  beginFolderDrag(path: string): void {
    if (!path) return;
    this.drag = { kind: "folder", path };
  },

  endDrag(): void {
    this.drag = null;
    this.clearDropMarkers();
  },

  draggedImages(): string[] {
    return this.drag?.kind === "images" ? this.drag.paths : [];
  },

  canDropInto(target: string): boolean {
    const d: DragPayload | null = this.drag;
    if (!d) return false;
    if (d.kind === "images") return d.paths.length > 0;
    return this.folderMoveAllowed(d.path, target);
  },

  /**
   * Is moving `src` into `dest` a meaningful operation?
   *
   * A directory cannot be dropped into itself or into any of its own
   * descendants (which would orphan the subtree), and a drop on its current
   * parent is a no-op that should not light up as if something were about to
   * happen. Both the drag path and the "move to…" dialog ask this, so the guard
   * lives here once.
   */
  folderMoveAllowed(src: string, dest: string): boolean {
    if (!src || src === dest) return false;
    if (dest.startsWith(`${src}/`)) return false; // into its own subtree
    if (parentPath(src) === dest) return false; // already there
    return this.folderAt(src) !== null;
  },

  /** Vault folder at a path; "" is the vault root, which has no lookup key. */
  folderAt(path: string): TFolder | null {
    if (!path) return this.app.vault.getRoot();
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFolder ? f : null;
  },

  clearDropMarkers(): void {
    this.contentEl
      .querySelectorAll(".ib-drop-target, .ib-drop-blocked, .ib-insert-before, .ib-insert-after")
      .forEach((el) =>
        el.removeClass("ib-drop-target", "ib-drop-blocked", "ib-insert-before", "ib-insert-after")
      );
  },

  makeFolderDropTarget(el: HTMLElement, folderPath: string): void {
    el.addEventListener("dragover", (e) => {
      if (!this.drag) return;
      e.stopPropagation();
      const ok = this.canDropInto(folderPath);
      el.removeClass("ib-drop-target", "ib-drop-blocked");
      if (!ok) {
        el.addClass("ib-drop-blocked");
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      el.addClass("ib-drop-target");
    });

    el.addEventListener("dragleave", () => {
      el.removeClass("ib-drop-target", "ib-drop-blocked");
    });

    el.addEventListener("drop", (e) => {
      if (!this.drag) return;
      e.stopPropagation();
      el.removeClass("ib-drop-target", "ib-drop-blocked");
      if (!this.canDropInto(folderPath)) return;
      e.preventDefault();
      this.landDrag(folderPath);
    });
  },

  /**
   * Dropping on empty grid space targets the folder being browsed, which is
   * what makes "drag a row out of the tree into the folder I am looking at"
   * work without a second trip through the tree.
   */
  makeCurrentFolderDropTarget(wrap: HTMLElement): void {
    wrap.addEventListener("dragover", (e) => {
      if (!this.drag) return;
      const ok = this.canDropInto(this.currentPath);
      wrap.removeClass("ib-drop-target", "ib-drop-blocked");
      if (!ok) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      wrap.addClass("ib-drop-target");
    });
    wrap.addEventListener("dragleave", (e) => {
      if (e.target === wrap) wrap.removeClass("ib-drop-target");
    });
    wrap.addEventListener("drop", (e) => {
      if (!this.drag) return;
      const ok = this.canDropInto(this.currentPath);
      wrap.removeClass("ib-drop-target");
      if (!ok) return;
      e.preventDefault();
      this.landDrag(this.currentPath);
    });
  },

  /** Finish a drop into a folder, whatever the payload happens to be. */
  landDrag(folderPath: string): void {
    const payload = this.drag;
    this.endDrag();
    if (!payload) return;
    if (payload.kind === "folder") void this.moveFolder(payload.path, folderPath, true);
    else void this.moveImages(payload.paths, folderPath, true);
  },
};

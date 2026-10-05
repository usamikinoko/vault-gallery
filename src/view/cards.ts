/* The two card kinds: a folder's pile of prints, and one image tile. */

import { setIcon } from "obsidian";
import type { FolderNode, ImageEntry } from "../types";
import { PLACEHOLDER_LAYERS, renderFolderStack } from "../folderStack";
import { shouldThumb } from "../thumbs";
import { formatBytes, parentPath } from "../utils";
import type { ViewPart } from "./viewTypes";

export interface CardPart {
  /** Grid index of a card, whether it is an image or a folder. */
  indexOf(path: string): number;
  markDragging(path: string, on: boolean): void;
  renderFolderCard(node: FolderNode): HTMLElement;
  renderImageCard(entry: ImageEntry, showPath: boolean): HTMLElement;
  /**
   * A thumbnail for `path` just settled: fill in the mounted card's img (with
   * the original file when generation failed). No repaint — one DOM touch.
   */
  applyThumbSrc(path: string, url: string | null): void;
  /** Dropping an image onto another reorders it; folders bubble to the folder. */
  makeReorderTarget(card: HTMLElement, entry: ImageEntry): void;
}

export const cardPart: ViewPart<CardPart> = {
  indexOf(path: string): number {
    return this.pathIndex.get(path) ?? -1;
  },

  markDragging(path: string, on: boolean): void {
    const el = this.itemEls.get(this.indexOf(path));
    if (el) el.toggleClass("is-dragging", on);
  },

  /**
   * Folder cards deliberately carry no chrome: no border, no fill. The pile of
   * prints is the whole card — wrapping it in a tinted rounded box put a card
   * inside a card, two nested frames around something that is already a stack
   * of framed things.
   */
  renderFolderCard(node: FolderNode): HTMLElement {
    const card = this.gridEl.createDiv({ cls: "ib-card ib-card-folder" });
    card.setAttr("data-path", node.path);
    card.setAttr(
      "title",
      `${node.relPath || node.name}\n${node.totalImages} 张图片（含子目录）\n拖动它可以把它移动进另一个目录`
    );
    card.draggable = node.path !== "";

    const thumb = card.createDiv({ cls: "ib-thumb ib-thumb-folder" });

    let drawn = 0;
    if (this.plugin.settings.folderPreview) {
      // Folder covers go through the thumbnail cache too: three full-resolution
      // decodes per folder card was the same tax the grid tiles used to pay.
      // A cover whose thumbnail is not ready yet shows the original — it will
      // upgrade to the thumbnail on the next repaint once generation lands.
      const thumbs = this.plugin.thumbs;
      drawn = renderFolderStack({
        host: thumb,
        // Covers come from the folder itself, or from its descendants when it
        // holds none — a directory of directories should still show content.
        images: node.coverImages,
        resolveSrc: (entry) =>
          thumbs.srcFor(entry.file) ?? this.app.vault.getResourcePath(entry.file),
        placeholderLayers: PLACEHOLDER_LAYERS,
      });
      for (const cover of node.coverImages) {
        if (shouldThumb(cover)) thumbs.request(cover.file);
      }
    }
    if (drawn === 0) {
      setIcon(thumb, node.children.length > 0 ? "folder-tree" : "folder");
    }

    const direct = node.images.length;
    const subs = node.children.length;
    let meta: string;
    if (node.totalImages === 0) meta = subs > 0 ? `${subs} 个子目录（空）` : "空目录";
    else if (direct === node.totalImages) meta = `${node.totalImages} 张`;
    else meta = `${direct} 张 · 共 ${node.totalImages}`;

    card.createDiv({ cls: "ib-folder-name", text: node.name });
    card.createDiv({ cls: "ib-folder-meta", text: meta });

    card.addEventListener("click", () => this.enter(node.path));
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showFolderMenu(e, node);
    });

    // --- drag source: move this folder somewhere else ---
    card.addEventListener("dragstart", (e) => {
      if (node.path === "") {
        e.preventDefault();
        return;
      }
      this.beginFolderDrag(node.path);
      card.addClass("is-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", node.path);
      }
    });
    card.addEventListener("dragend", () => {
      card.removeClass("is-dragging");
      this.endDrag();
    });

    this.makeFolderDropTarget(card, node.path);
    return card;
  },

  renderImageCard(entry: ImageEntry, showPath: boolean): HTMLElement {
    const card = this.gridEl.createDiv({ cls: "ib-card ib-card-image" });
    card.draggable = true;
    if (this.selection.has(entry.path)) card.addClass("is-selected");

    const thumb = card.createDiv({ cls: "ib-thumb" });

    // Large images are never decoded at full size for a tile: the thumbnail
    // cache downscales them once (off-thread) and the tile shows the small
    // bitmap. Until it lands the tile is marked pending — a quiet skeleton
    // instead of the hairline frame, which read as a hard edge around nothing.
    // Small files and cache-unsupported formats use their original bytes.
    const original = this.app.vault.getResourcePath(entry.file);
    let src: string | null = original;
    if (shouldThumb(entry)) {
      const hit = this.plugin.thumbs.srcFor(entry.file);
      if (hit) src = hit;
      else if (!this.plugin.thumbs.isFailed(entry.file)) {
        src = null;
        thumb.addClass("is-pending");
        this.plugin.thumbs.request(entry.file);
      }
    }

    // Ambient fill: the same bytes, blown up and blurred, behind the image, so
    // a portrait plate dropped in a square cell gets a letterbox made of the
    // picture itself. With thumbnails this is the *thumbnail* blown up — the
    // blur hides the upscaling, and the compositor surface stays tile-sized
    // instead of full-image-sized. Skipped in crop mode: the picture covers
    // the cell, but `filter: blur()` still asks for an offscreen surface per
    // card, and a hundred of those is real stutter on an integrated GPU.
    if (this.plugin.settings.thumbnailFit !== "crop") {
      const fill = thumb.createEl("img", { cls: "ib-thumb-fill" });
      fill.alt = "";
      fill.setAttr("aria-hidden", "true");
      fill.loading = "lazy";
      fill.decoding = "async";
      if (src !== null) fill.src = src;
    }

    const img = thumb.createEl("img", { cls: "ib-thumb-img" });
    img.loading = "lazy";
    img.decoding = "async";
    // The caption below the tile already carries the name; alt text would only
    // double it — and an img with no src yet renders its alt as visible text.
    img.alt = "";
    if (src !== null) img.src = src;

    // --- selection affordance ---
    const check = card.createDiv({ cls: "ib-check" });
    check.setAttr("title", "选中（Space）");
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      const path = entry.path;
      if (this.selection.has(path)) this.selection.delete(path);
      else {
        this.selection.add(path);
        this.anchor = path;
      }
      card.toggleClass("is-selected", this.selection.has(path));
      this.renderSelectionBar();
    });

    // --- reference pill ---
    if (this.plugin.settings.showRefBadges) {
      const count = this.refCounts.get(entry.path) ?? this.store.getBacklinks(entry.path).length;
      if (count === 0) {
        thumb
          .createDiv({ cls: "ib-ref-pill is-orphan", text: "未引用" })
          .setAttr("title", "没有任何笔记引用这张图片");
      } else {
        thumb
          .createDiv({ cls: "ib-ref-pill", text: String(count) })
          .setAttr("title", `被 ${count} 处引用`);
      }
    }

    card.createDiv({ cls: "ib-caption", text: entry.name });
    card.setAttr("title", `${entry.path}\n${formatBytes(entry.size)}`);
    // One meta line, never two: while searching the location is what you need,
    // the rest of the time the size is. Stacking them gave every card three
    // rows of small grey text and pushed the pictures apart.
    card.createDiv({
      cls: "ib-meta",
      text: showPath
        ? `${parentPath(entry.path) || "/"} · ${formatBytes(entry.size)}`
        : formatBytes(entry.size),
    });

    card.addEventListener("click", (e) => {
      this.contentEl.focus();
      this.focusIndex = this.indexOf(entry.path);
      if (e.ctrlKey || e.metaKey) {
        this.toggleSelect(entry.path);
        return;
      }
      if (e.shiftKey) {
        this.selectRangeTo(entry.path);
        return;
      }
      // A plain click opens the picture and touches nothing else. It used to
      // also select the card, which meant every casual browse sprayed
      // checkboxes over the grid — selection is now an explicit gesture only:
      // the checkbox, Ctrl-click, Shift-click, Space or Ctrl+A.
      this.openDetail(entry.path);
    });

    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showCardMenu(e, entry);
    });

    // --- drag source ---
    card.addEventListener("dragstart", (e) => {
      const paths =
        this.selection.has(entry.path) && this.selection.size > 1
          ? [...this.selection]
          : [entry.path];
      this.beginImageDrag(paths);
      card.addClass("is-dragging");
      for (const p of paths) this.markDragging(p, true);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", paths.join("\n"));
      }
    });
    card.addEventListener("dragend", () => {
      for (const p of this.draggedImages()) this.markDragging(p, false);
      this.endDrag();
      this.syncSelectionClasses();
    });

    this.makeReorderTarget(card, entry);
    return card;
  },

  applyThumbSrc(path: string, url: string | null): void {
    const index = this.pathIndex.get(path);
    if (index === undefined) return;
    const el = this.itemEls.get(index);
    if (!el || !el.isConnected) return;
    const item = this.items[index];
    if (!item || item.kind !== "image") return;

    // `null` means generation failed: the card falls back to the original.
    const src = url ?? this.app.vault.getResourcePath(item.entry.file);
    const img = el.querySelector<HTMLImageElement>(".ib-thumb-img");
    if (img && !img.getAttribute("src")) img.src = src;
    const fill = el.querySelector<HTMLImageElement>(".ib-thumb-fill");
    if (fill && !fill.getAttribute("src")) fill.src = src;
    // The skeleton hand-off is a one-way latch: once real pixels exist the
    // placeholder must go, whichever route they arrived by.
    el.querySelector(".ib-thumb")?.removeClass("is-pending");
  },

  /**
   * The left half of the target inserts before it, the right half inserts
   * after — the grid equivalent of the three-band hit test on a list row.
   */
  makeReorderTarget(card: HTMLElement, entry: ImageEntry): void {
    const hit = (e: DragEvent): boolean | null => {
      const sources = this.draggedImages();
      if (sources.length === 0 || sources.includes(entry.path)) return null;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = card.getBoundingClientRect();
      return e.clientX > rect.left + rect.width / 2;
    };

    card.addEventListener("dragover", (e) => {
      const after = hit(e);
      if (after === null) {
        e.stopPropagation();
        return;
      }
      card.removeClass("ib-insert-before", "ib-insert-after");
      card.addClass(after ? "ib-insert-after" : "ib-insert-before");
    });

    card.addEventListener("dragleave", () => {
      card.removeClass("ib-insert-before", "ib-insert-after");
    });

    card.addEventListener("drop", (e) => {
      const after = hit(e);
      if (after === null) {
        e.stopPropagation();
        return;
      }
      const sources = [...this.draggedImages()];
      this.endDrag();
      void this.reorderImages(sources, entry.path, after);
    });
  },
};

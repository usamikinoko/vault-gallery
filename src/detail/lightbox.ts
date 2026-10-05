/*
 * Image lightbox with real paging.
 *
 * Paging through the folder without closing and reopening the modal is the
 * single biggest quality-of-life win when reviewing a batch of assets, so the
 * whole body re-renders on ← / → (and on the on-screen arrows). The zoom and
 * pan maths live in ./zoomView; everything here is layout, metadata and keys.
 */

import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";
import type { ImageEntry } from "../types";
import { ZOOM_STEP } from "../zoom";
import { formatBytes, formatDateTime, revealInOS } from "../utils";
import { ZoomView } from "./zoomView";

export interface DetailOptions {
  /** All images in the order the grid shows them; the modal pages through it. */
  entries: ImageEntry[];
  index: number;
  getBacklinks: (path: string) => string[];
}

export class ImageDetailModal extends Modal {
  private index: number;
  private readonly zoomView = new ZoomView();

  constructor(app: App, private opts: DetailOptions) {
    super(app);
    this.index = opts.index;
  }

  private get entry(): ImageEntry | null {
    return this.opts.entries[this.index] ?? null;
  }

  onOpen(): void {
    this.contentEl.addClass("ib-detail");
    this.modalEl.addClass("ib-detail-modal");
    this.render();

    const paging: Array<[string, number]> = [
      ["ArrowLeft", -1],
      ["ArrowRight", 1],
    ];
    for (const [key, delta] of paging) {
      this.scope.register([], key, (e) => {
        e.preventDefault();
        this.step(delta);
        return false;
      });
    }

    const zoomKeys: Array<[string, () => void]> = [
      ["+", () => this.zoomView.zoomStep(ZOOM_STEP)],
      ["=", () => this.zoomView.zoomStep(ZOOM_STEP)],
      ["-", () => this.zoomView.zoomStep(1 / ZOOM_STEP)],
      ["0", () => this.zoomView.goFit(true)],
      ["1", () => this.zoomView.goNative(true)],
    ];
    for (const [key, fn] of zoomKeys) {
      this.scope.register([], key, (e) => {
        e.preventDefault();
        fn();
        return false;
      });
    }
  }

  private step(delta: number): void {
    const total = this.opts.entries.length;
    if (total <= 1) return;
    this.index = (this.index + delta + total) % total;
    this.render();
  }

  // --------------------------------------------------------------------- view

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.zoomView.detach();

    const entry = this.entry;
    if (!entry) {
      contentEl.createEl("h3", { text: "图片已不存在" });
      return;
    }

    const wrap = contentEl.createDiv({ cls: "ib-detail-wrap" });

    // The arrows and the counter belong to the picture, not to the whole
    // preview: that block also carries the zoom bar and the hint now, so
    // centring on it would drop them below the middle of the image. Keeping
    // them as siblings of the stage matters too — a pointerdown on an arrow
    // must not reach the pan handler.
    const preview = wrap.createDiv({ cls: "ib-detail-preview" });
    const viewport = preview.createDiv({ cls: "ib-detail-viewport" });
    const total = this.opts.entries.length;

    if (total > 1) {
      const counter = viewport.createDiv({
        cls: "ib-lightbox-counter",
        text: `${this.index + 1} / ${total}`,
      });
      counter.setAttr("title", "当前序号 / 总数（← → 翻页）");

      const prev = viewport.createEl("button", { cls: "ib-lightbox-nav is-prev", text: "‹" });
      prev.setAttr("title", "上一张（←）");
      prev.addEventListener("click", (e) => {
        e.stopPropagation();
        this.step(-1);
      });

      const next = viewport.createEl("button", { cls: "ib-lightbox-nav is-next", text: "›" });
      next.setAttr("title", "下一张（→）");
      next.addEventListener("click", (e) => {
        e.stopPropagation();
        this.step(1);
      });
    }

    const stage = viewport.createDiv({ cls: "ib-detail-stage" });
    stage.setAttr("title", "滚轮缩放 · 拖动平移 · 双击在适应与 1:1 之间切换");

    const img = stage.createEl("img", { cls: "ib-detail-img" });
    img.alt = entry.name;
    // Without this the browser's native image drag steals the pan gesture.
    img.draggable = false;

    // --- zoom bar ----------------------------------------------------------
    const bar = preview.createDiv({ cls: "ib-zoom-bar" });
    const zoomBtn = (label: string, title: string, cls: string) => {
      const btn = bar.createEl("button", { cls: `ib-zoom-btn ${cls}`, text: label });
      btn.setAttr("title", title);
      return btn;
    };

    zoomBtn("−", "缩小（−）", "is-icon is-out").addEventListener("click", () =>
      this.zoomView.zoomStep(1 / ZOOM_STEP)
    );
    const pctEl = bar.createDiv({ cls: "ib-zoom-pct", text: "100%" });
    pctEl.setAttr("title", "当前显示比例（100% = 原始像素）");
    zoomBtn("+", "放大（＋）", "is-icon is-in").addEventListener("click", () =>
      this.zoomView.zoomStep(ZOOM_STEP)
    );
    bar.createDiv({ cls: "ib-zoom-sep" });

    const fitBtn = zoomBtn("适应窗口", "整张图片放进窗口（0）", "is-toggle is-fit");
    fitBtn.addEventListener("click", () => this.zoomView.goFit(true));
    const nativeBtn = zoomBtn("1:1", "按原始像素显示（1）", "is-toggle is-native");
    nativeBtn.addEventListener("click", () => this.zoomView.goNative(true));

    // Zooming is invisible as a capability unless something says it exists.
    preview.createDiv({ cls: "ib-zoom-hint", text: "滚轮缩放 · 拖动平移 · 双击切换" });

    this.zoomView.attach({
      stage,
      img,
      src: this.app.vault.getResourcePath(entry.file),
      pctEl,
      fitBtn,
      nativeBtn,
    });

    this.renderSide(wrap, entry, img);
  }

  private renderSide(wrap: HTMLElement, entry: ImageEntry, img: HTMLImageElement): void {
    const backlinks = this.opts.getBacklinks(entry.path);
    const side = wrap.createDiv({ cls: "ib-detail-side" });
    side.createEl("h3", { cls: "ib-detail-title", text: entry.name });

    const rows: Array<[string, string]> = [
      ["路径", entry.path],
      ["大小", formatBytes(entry.size)],
      ["分辨率", "读取中…"],
      ["创建", formatDateTime(entry.ctime)],
      ["修改", formatDateTime(entry.mtime)],
      ["引用", backlinks.length > 0 ? `${backlinks.length} 处` : "未被引用"],
    ];

    const table = side.createDiv({ cls: "ib-detail-rows" });
    let resolutionEl: HTMLElement | null = null;
    for (const [key, value] of rows) {
      const row = table.createDiv({ cls: "ib-detail-row" });
      row.createDiv({ cls: "ib-detail-key", text: key });
      const val = row.createDiv({ cls: "ib-detail-val", text: value });
      if (key === "引用" && backlinks.length === 0) val.addClass("is-orphan");
      if (key === "分辨率") resolutionEl = val;
    }

    // Pixel dimensions are not part of the vault metadata, so they are read off
    // the lightbox's own <img>: a second probe element would decode the same
    // file a second time on every page turn.
    const setResolution = (text: string) => resolutionEl?.setText(text);
    const natural = () => `${img.naturalWidth} × ${img.naturalHeight} px`;
    img.addEventListener("load", () => setResolution(natural()));
    img.addEventListener("error", () => setResolution("无法读取（文件可能损坏）"));
    if (img.complete && img.naturalWidth > 0) setResolution(natural());

    if (backlinks.length > 0) {
      side.createEl("h4", { cls: "ib-detail-sub", text: "被以下笔记引用" });
      const list = side.createDiv({ cls: "ib-ref-list" });
      for (const source of backlinks) {
        const item = list.createDiv({ cls: "ib-ref-item", text: source });
        item.setAttr("title", source);
        item.addEventListener("click", () => {
          this.close();
          void this.app.workspace.openLinkText(source, "", false);
        });
      }
    } else {
      side.createEl("h4", { cls: "ib-detail-sub", text: "尚未被任何笔记引用" });
      side.createDiv({
        cls: "ib-detail-hint",
        text: "可以安全地把它归档或删除，不会破坏任何笔记。",
      });
    }

    const actions = side.createDiv({ cls: "ib-detail-actions" });

    const copyPath = actions.createEl("button", { cls: "ib-btn", text: "复制文件路径" });
    copyPath.addEventListener("click", () => {
      void navigator.clipboard.writeText(entry.path);
      new Notice("已复制文件路径");
    });

    const copyEmbed = actions.createEl("button", { cls: "ib-btn", text: "复制嵌入引用" });
    copyEmbed.addEventListener("click", () => {
      void navigator.clipboard.writeText(`![[${entry.path}]]`);
      new Notice("已复制嵌入引用");
    });

    const reveal = actions.createEl("button", { cls: "ib-btn", text: "在系统资源管理器中显示" });
    reveal.addEventListener("click", () => revealInOS(this.app, entry.path));
  }

  onClose(): void {
    this.zoomView.detach();
    this.contentEl.empty();
  }
}

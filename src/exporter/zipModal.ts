/* The ZIP export dialog: options, progress, result. */

import type { App } from "obsidian";
import { Modal, Notice, Setting } from "obsidian";
import type VaultGalleryPlugin from "../main";
import { joinFsPath, nodeRequire } from "../nodeRequire";
import {
  ZipAborted,
  randomNumericPassword,
  writeZip,
  type ZipEntry,
  type ZipProgress,
} from "../zip";
import {
  askSavePath,
  formatBytes,
  fullPathOf,
  hasSaveDialog,
  revealFullPath,
} from "../utils";
import { sanitizeFileStem } from "./stats";

export class ExportZipModal extends Modal {
  private busy = false;
  private aborted = false;
  private bodyEl!: HTMLElement;
  private pwInput: HTMLInputElement | null = null;

  constructor(
    app: App,
    private plugin: VaultGalleryPlugin,
    private folderPath: string,
    private label: string,
    private entries: ZipEntry[]
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ib-export-modal");
    this.titleEl.setText(`导出「${this.label}」为 ZIP`);
    this.bodyEl = this.contentEl.createDiv({ cls: "ib-export-body" });
    this.renderForm();
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.busy) this.aborted = true;
  }

  private totalBytes(): number {
    return this.entries.reduce((sum, e) => sum + e.size, 0);
  }

  /** Step 1: the options, and the estimate. */
  private renderForm(): void {
    const body = this.bodyEl;
    body.empty();

    const summary = body.createDiv({ cls: "ib-export-summary" });
    summary.createDiv({
      cls: "ib-export-count",
      text: `${this.entries.length} 个文件 · ${formatBytes(this.totalBytes())}`,
    });
    summary.createDiv({
      cls: "ib-export-path",
      text: this.folderPath || "（vault 根目录）",
    });

    if (this.entries.length === 0) {
      const empty = body.createDiv({ cls: "ib-export-note" });
      empty.setText("这个目录下没有图片，没有可导出的内容。");
      new Setting(body).addButton((b) =>
        b.setButtonText("关闭").setClass("ib-btn").onClick(() => this.close())
      );
      return;
    }

    const pw = { enabled: false, value: "" };

    const pwSetting = new Setting(body)
      .setName("解压密码")
      .setDesc(
        "ZipCrypto 加密：Windows、macOS、7-Zip 都能双击打开。6 位数字密码只是门栓，不是保险箱。"
      )
      .addText((text) => {
        text.setPlaceholder("6 位数字");
        text.inputEl.maxLength = 99;
        text.inputEl.disabled = true;
        text.inputEl.addEventListener("input", () => {
          pw.value = text.inputEl.value;
        });
        this.pwInput = text.inputEl;
      });

    const fill = (value: string) => {
      pw.value = value;
      if (this.pwInput) this.pwInput.value = value;
    };

    pwSetting.addButton((button) => {
      button.setButtonText("随机生成");
      button.setTooltip("生成一个 6 位数字密码");
      button.onClick(() => {
        fill(randomNumericPassword(6));
        new Notice(`已生成密码：${pw.value}`);
      });
    });

    pwSetting.addToggle((toggle) =>
      toggle.setValue(false).onChange((on) => {
        pw.enabled = on;
        if (this.pwInput) this.pwInput.disabled = !on;
        if (on && !pw.value) fill(randomNumericPassword(6));
      })
    );

    const actions = body.createDiv({ cls: "ib-export-actions" });
    const cancel = actions.createEl("button", { cls: "ib-btn", text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const go = actions.createEl("button", { cls: "ib-btn mod-cta", text: "选择位置并导出…" });
    go.addEventListener("click", () => void this.run(pw.enabled ? pw.value : ""));
  }

  /** Step 2: pick a path, write the archive, report progress. */
  private async run(password: string): Promise<void> {
    if (this.busy) return;

    if (password && !/^\d+$/.test(password)) {
      new Notice("密码只能包含数字。");
      return;
    }

    const target = await this.chooseTarget(`${sanitizeFileStem(this.label)}.zip`);
    if (!target) return;

    this.busy = true;
    this.aborted = false;
    const progress = this.renderProgress(password ? "已加密" : "未加密");

    try {
      const result = await writeZip({
        outPath: target,
        entries: this.entries,
        password: password || null,
        onProgress: (p) => progress.update(p),
        shouldAbort: () => this.aborted,
      });
      this.renderDone(target, result.files, result.bytes);
    } catch (err) {
      this.busy = false;
      if (err instanceof ZipAborted) {
        this.renderFailed("已取消导出，写了一半的文件已删除。");
        return;
      }
      console.error("[vault-gallery] zip export failed", err);
      this.renderFailed(`导出失败：${this.label} —— ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Where to put the archive.
   *
   * The native dialog is the intended path. If it is unavailable the export
   * still has to happen — a plugin that refuses to work because a private
   * Electron API moved is worse than one that puts the file somewhere
   * predictable and says so.
   */
  private async chooseTarget(defaultName: string): Promise<string | null> {
    if (hasSaveDialog()) {
      const answer = await askSavePath({
        defaultName,
        title: "导出图片",
        filters: [{ name: "ZIP 文件", extensions: ["zip"] }],
      });
      if (answer.status === "ok") return answer.path;
      if (answer.status === "cancelled") return null;
    }

    // `pluginDir()` is vault-relative; the filesystem needs it absolute.
    const dir = fullPathOf(this.app, this.pluginDir());
    if (!dir) {
      new Notice("系统保存对话框不可用，也无法确定插件目录，导出已取消。");
      return null;
    }
    const exportsDir = joinFsPath(dir, "exports");
    try {
      const fs = nodeRequire<{
        promises: { mkdir(p: string, o: { recursive: boolean }): Promise<void> };
      }>("fs");
      await fs.promises.mkdir(exportsDir, { recursive: true });
    } catch (err) {
      console.error("[vault-gallery] cannot create export dir", err);
      new Notice(`无法创建导出目录：${exportsDir}`);
      return null;
    }
    const fallback = joinFsPath(exportsDir, defaultName);
    new Notice(`系统保存对话框不可用，将导出到：${fallback}`, 8000);
    return fallback;
  }

  private pluginDir(): string {
    return this.plugin.manifest.dir ?? `.obsidian/plugins/${this.plugin.manifest.id}`;
  }

  private renderProgress(note: string): { update(p: ZipProgress): void } {
    const body = this.bodyEl;
    body.empty();

    const box = body.createDiv({ cls: "ib-export-progress" });
    box.createDiv({ cls: "ib-export-progress-label", text: `正在打包（${note}）…` });
    const track = box.createDiv({ cls: "ib-export-bar" });
    const fill = track.createDiv({ cls: "ib-export-bar-fill" });
    const text = box.createDiv({ cls: "ib-export-progress-text", text: "0%" });

    const actions = body.createDiv({ cls: "ib-export-actions" });
    const stop = actions.createEl("button", { cls: "ib-btn", text: "取消" });
    stop.addEventListener("click", () => {
      this.aborted = true;
      stop.disabled = true;
      stop.setText("正在取消…");
    });

    return {
      update: (p: ZipProgress) => {
        const fraction = p.totalBytes > 0 ? p.bytes / p.totalBytes : p.files / p.totalFiles;
        fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
        text.setText(
          `${p.files} / ${p.totalFiles} 个文件 · ${formatBytes(p.bytes)} / ${formatBytes(
            p.totalBytes
          )}`
        );
      },
    };
  }

  private renderDone(path: string, files: number, bytes: number): void {
    this.busy = false;
    const body = this.bodyEl;
    body.empty();

    const box = body.createDiv({ cls: "ib-export-done" });
    box.createDiv({ cls: "ib-export-done-title", text: "导出完成" });
    box.createDiv({
      cls: "ib-export-done-detail",
      text: `${files} 个文件 · ${formatBytes(bytes)}`,
    });
    box.createDiv({ cls: "ib-export-done-path", text: path });

    const actions = body.createDiv({ cls: "ib-export-actions" });
    const reveal = actions.createEl("button", { cls: "ib-btn", text: "在系统资源管理器中显示" });
    reveal.addEventListener("click", () => {
      if (!revealFullPath(path)) new Notice(path, 10000);
    });
    const close = actions.createEl("button", { cls: "ib-btn mod-cta", text: "完成" });
    close.addEventListener("click", () => this.close());
  }

  private renderFailed(message: string): void {
    const body = this.bodyEl;
    body.empty();
    body.createDiv({ cls: "ib-export-failed", text: message });
    const actions = body.createDiv({ cls: "ib-export-actions" });
    const close = actions.createEl("button", { cls: "ib-btn", text: "关闭" });
    close.addEventListener("click", () => this.close());
  }
}

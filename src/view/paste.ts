/* The Ctrl+V handler: deciding whether the clipboard is ours, and reading it. */

import { Notice } from "obsidian";
import { classifyClipboard, type ImportRequest } from "../importer";
import type { ViewPart } from "./viewTypes";

export interface PastePart {
  onPaste(evt: ClipboardEvent): Promise<void>;
  /** Read the accepted files' bytes and write them, plus any link payload. */
  consumePaste(
    files: File[],
    accepted: number[],
    url: string | null,
    localPath: string | null
  ): Promise<void>;
}

export const pastePart: ViewPart<PastePart> = {
  /**
   * When we claim the event: if the clipboard carries image data it is ours —
   * pasting a bitmap into a search box means nothing. If it carries only text we
   * stay out of the way, except when focus is *not* in a text field and the text
   * is an image URL or an absolute path to an image, which is the "paste a link,
   * get a file" workflow.
   */
  onPaste(evt: ClipboardEvent): Promise<void> {
    const dt = evt.clipboardData;
    if (!dt) return Promise.resolve();

    const files: File[] = [];
    if (dt.files && dt.files.length > 0) {
      for (const f of Array.from(dt.files)) files.push(f);
    } else if (dt.items && dt.items.length > 0) {
      // Some sources (screenshots on Windows) only populate the item list.
      for (const item of Array.from(dt.items)) {
        if (item.kind !== "file") continue;
        const f = item.getAsFile?.();
        if (f) files.push(f);
      }
    }

    const target = evt.target as HTMLElement | null;
    const inTextField = !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
    const text = inTextField ? "" : dt.getData("text/plain") ?? "";

    const plan = classifyClipboard(
      files.map((f) => ({ name: f.name, type: f.type })),
      text,
      this.plugin.settings.imageExtensions
    );

    const hasImageData = plan.accept.length > 0;
    const hasLink = plan.url !== null || plan.localPath !== null;
    // A clipboard holding files is ours even when we refuse every one of them:
    // doing nothing at all reads as "the paste was dropped", which is exactly
    // the confusion the check exists to prevent. Plain text is left alone.
    const claims = hasImageData || hasLink || plan.reject.length > 0;
    if (!claims) return Promise.resolve();
    evt.preventDefault();

    if (plan.reject.length > 0) {
      const names = plan.reject
        .slice(0, 3)
        .map((r) => r.name || r.type || "未命名")
        .join("、");
      const more = plan.reject.length > 3 ? ` 等 ${plan.reject.length} 项` : "";
      new Notice(
        hasImageData
          ? `已跳过非图片内容：${names}${more}`
          : `剪贴板里的内容不是图片，已忽略：${names}${more}`
      );
    }

    if (!hasImageData && !hasLink) return Promise.resolve();
    return this.consumePaste(files, plan.accept, plan.url, plan.localPath);
  },

  async consumePaste(
    files: File[],
    accepted: number[],
    url: string | null,
    localPath: string | null
  ): Promise<void> {
    const reqs: ImportRequest[] = [];
    for (const index of accepted) {
      const file = files[index];
      try {
        reqs.push({
          name: file.name,
          mime: file.type,
          data: await file.arrayBuffer(),
          source: file.name || "剪贴板图片",
        });
      } catch (err) {
        console.error(err);
        new Notice(`读取剪贴板文件失败：${file.name} —— ${String(err)}`);
      }
    }
    if (url !== null || localPath !== null) {
      await this.consumeLinks(this.currentPath, url, localPath, reqs);
    }
    await this.writeImports(this.currentPath, reqs);
  },
};

/*
 * Reading the OS clipboard, and writing what comes back into the vault.
 *
 * Distinct from `paste.ts` because there is no paste event here: with no
 * `clipboardData` the bytes have to be fetched from the system, and there are
 * three sources to try in order of how much they know.
 */

import { Notice } from "obsidian";
import {
  classifyClipboard,
  fetchImageBytes,
  fileNameFromUrl,
  nameHasAllowedExt,
  pasteStampBase,
  readLocalImageBytes,
  readNativeClipboardFiles,
  readNativeClipboardImage,
  readNativeClipboardText,
  resolvePastedExt,
  type ImportRequest,
} from "../importer";
import { basename, extOf, joinPath, uniqueName } from "../utils";
import type { ViewPart } from "./viewTypes";

export interface ClipboardImportPart {
  /** The toolbar button and the command palette entry. */
  importFromSystemClipboard(target?: string): Promise<void>;
  /** navigator.clipboard.read(), which Electron may refuse — hence the null. */
  readWebClipboard(): Promise<ImportRequest[] | null>;
  /** Download a pasted URL and/or read a pasted absolute path. */
  consumeLinks(
    target: string,
    url: string | null,
    localPath: string | null,
    reqs: ImportRequest[]
  ): Promise<void>;
  /** Write the bytes, resolving every name before anything lands on disk. */
  writeImports(target: string, reqs: ImportRequest[]): Promise<void>;
}

export const clipboardImportPart: ViewPart<ClipboardImportPart> = {
  async importFromSystemClipboard(targetArg?: string): Promise<void> {
    const target = targetArg ?? this.currentPath;
    if (!this.folderAt(target)) {
      new Notice("目标目录不存在");
      return;
    }

    // The web API first: it preserves the real MIME type when it answers at all.
    const fromWeb = await this.readWebClipboard();
    if (fromWeb && fromWeb.length > 0) {
      await this.writeImports(target, fromWeb);
      return;
    }

    // Files copied in the OS file manager next: that flavour still knows the
    // original name and format, which the bitmap flavour below does not.
    const copied = readNativeClipboardFiles();
    if (copied.length > 0) {
      const allowed = copied.filter((f) =>
        nameHasAllowedExt(f.name, this.plugin.settings.imageExtensions)
      );
      if (allowed.length === 0) {
        new Notice(
          `剪贴板里的内容不是图片，已忽略：${copied
            .slice(0, 3)
            .map((f) => f.name)
            .join("、")}`
        );
        return;
      }
      const reqs: ImportRequest[] = [];
      const unreadable: string[] = [];
      for (const file of allowed) {
        const got = readLocalImageBytes(file.fullPath);
        if ("error" in got) {
          unreadable.push(file.name);
          continue;
        }
        reqs.push({
          name: file.name,
          mime: `image/${got.ext}`,
          data: got.data,
          source: file.fullPath,
        });
      }
      if (unreadable.length > 0) {
        new Notice(`无法读取剪贴板里的文件：${unreadable.slice(0, 3).join("、")}`);
      }
      if (reqs.length > 0) {
        await this.writeImports(target, reqs);
        return;
      }
    }

    // Then Electron's bitmap reader — the only thing that works for a
    // screenshot taken while the view was not focused.
    const native = readNativeClipboardImage();
    if (!("error" in native)) {
      await this.writeImports(target, [
        { name: "", mime: "image/png", data: native.data, source: "系统剪贴板位图" },
      ]);
      return;
    }

    const text = readNativeClipboardText();
    const plan = classifyClipboard([], text, this.plugin.settings.imageExtensions);
    if (plan.url !== null || plan.localPath !== null) {
      await this.consumeLinks(target, plan.url, plan.localPath, []);
      return;
    }
    if (text.trim()) {
      new Notice("剪贴板里没有图片。复制图片文件、截图，或复制图片链接后再试。");
      return;
    }
    new Notice(native.error || "剪贴板里没有图片");
  },

  async readWebClipboard(): Promise<ImportRequest[] | null> {
    const clip = navigator.clipboard;
    if (!clip || typeof clip.read !== "function") return null;
    try {
      const items = await clip.read();
      const out: ImportRequest[] = [];
      for (const item of items) {
        for (const type of item.types) {
          if (!type.startsWith("image/")) continue;
          const blob = await item.getType(type);
          out.push({
            name: "",
            mime: type,
            data: await blob.arrayBuffer(),
            source: "系统剪贴板",
          });
        }
      }
      return out;
    } catch {
      return null; // permission denied, or no implementation behind the API
    }
  },

  async consumeLinks(
    target: string,
    url: string | null,
    localPath: string | null,
    reqs: ImportRequest[]
  ): Promise<void> {
    if (url) {
      new Notice("正在下载剪贴板里的图片链接…");
      const got = await fetchImageBytes(url);
      if ("error" in got) {
        new Notice(`链接导入失败：${url} —— ${got.error}`);
        return;
      }
      reqs.push({ name: fileNameFromUrl(url), mime: got.mime, data: got.data, source: url });
    }

    if (localPath) {
      const got = readLocalImageBytes(localPath);
      if ("error" in got) {
        new Notice(`读取本地文件失败：${localPath} —— ${got.error}`);
        return;
      }
      reqs.push({
        name: basename(localPath.replace(/\\/g, "/")),
        mime: `image/${got.ext}`,
        data: got.data,
        source: localPath,
      });
    }

    if (reqs.length > 0) await this.writeImports(target, reqs);
  },

  async writeImports(target: string, reqs: ImportRequest[]): Promise<void> {
    if (reqs.length === 0) return;
    if (!this.folderAt(target)) {
      new Notice("目标目录不存在");
      return;
    }

    // Names are reserved for the whole batch before anything is written, so two
    // pasted screenshots cannot both claim "粘贴图片 …png".
    const reserved = new Set<string>();
    const taken = (name: string) => {
      if (reserved.has(name)) return true;
      return this.app.vault.getAbstractFileByPath(joinPath(target, name)) !== null;
    };

    const saved: string[] = [];
    const failed: string[] = [];
    const unknownExt = new Set<string>();
    const allowed = this.plugin.settings.imageExtensions;
    const now = new Date();
    // Every pasted image is named after where and when it arrived:
    // `目录名-yymmddhhmmss`. A paste into the vault root has no directory of
    // its own, so the vault name stands in for it.
    const base = pasteStampBase(
      basename(target) || this.app.vault.getName(),
      now,
      "vault"
    );

    for (const req of reqs) {
      const ext = resolvePastedExt(req.name, req.mime, allowed);
      const name = uniqueName(base, ext, taken, "-");
      reserved.add(name);
      const path = joinPath(target, name);
      try {
        // Bytes go in untouched: no canvas, no re-encode, no downscale.
        await this.app.vault.createBinary(path, req.data);
        saved.push(path);
        const savedExt = extOf(name);
        if (savedExt && !allowed.includes(savedExt)) unknownExt.add(savedExt);
      } catch (err) {
        console.error(err);
        failed.push(name);
      }
    }

    if (failed.length > 0) {
      const names = failed.slice(0, 3).join("、");
      const more = failed.length > 3 ? ` 等 ${failed.length} 个文件` : "";
      new Notice(`写入失败：${names}${more} —— 无法写入 vault`);
    }
    if (saved.length === 0) return;

    // Freshly pasted files are NOT selected: an import that flips a dozen
    // checkboxes on by itself reads as state the user never made, and the next
    // stray click or drag then acts on files they never chose. Selection stays
    // exactly what it was; the vault event refreshes the grid and the new
    // files appear unselected, like anything else that was already there.
    this.plugin.settings.lastPath = this.currentPath;
    void this.plugin.saveSettings();

    new Notice(
      saved.length === 1
        ? `已导入 ${basename(saved[0])} 到 ${target || "/"}`
        : `已导入 ${saved.length} 张图片到 ${target || "/"}`
    );
    if (unknownExt.size > 0) {
      new Notice(
        `注意：${[...unknownExt].join("、")} 不在插件的图片扩展名列表里，暂时不会显示在网格中。`
      );
    }
    this.refresh();
  },
};

/*
 * Where the bytes come from: the network, the OS clipboard, or the disk.
 *
 * Everything here is impure and desktop-only, so each entry point is guarded
 * and returns a discriminated result instead of throwing.
 *
 * Hard rule: bytes are written verbatim. Nothing here decodes and re-encodes an
 * image, so a pasted 4K screenshot lands as a 4K PNG.
 */

import { nodeRequire } from "../nodeRequire";
import { extOf } from "../utils";
import { isAllowedImageMime } from "./names";

export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

export function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

export interface FetchedImage {
  data: ArrayBuffer;
  mime: string;
}

/**
 * Download a pasted URL, but only after the server says it is an image.
 * A 20 s abort keeps a dead host from pinning the view open.
 */
export async function fetchImageBytes(
  url: string,
  timeoutMs = 20_000
): Promise<FetchedImage | { error: string }> {
  if (typeof fetch !== "function") return { error: "当前环境不支持网络请求" };
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "image/*,*/*;q=0.4" },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const mime = (res.headers?.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!isAllowedImageMime(mime)) {
      return { error: `链接返回的不是图片（${mime || "未知类型"}）` };
    }
    const declared = Number(res.headers?.get("content-length") ?? "0");
    if (declared > MAX_IMPORT_BYTES) return { error: "文件超过 64 MB" };
    const data = await res.arrayBuffer();
    if (data.byteLength > MAX_IMPORT_BYTES) return { error: "文件超过 64 MB" };
    if (data.byteLength === 0) return { error: "下载到的内容是空的" };
    return { data, mime };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    return { error: aborted ? "下载超时" : String(err) };
  } finally {
    window.clearTimeout(timer);
  }
}

// ------------------------------------------------------------- OS clipboard

interface ElectronClipboard {
  availableFormats?: (type?: string) => string[];
  readImage?: () => { isEmpty?: () => boolean; toPNG?: () => Uint8Array };
  readText?: (type?: string) => string;
  readBuffer?: (format: string) => { toString: (encoding?: string) => string } | null;
}

/** Electron's clipboard, reached through the desktop-only Node bridge. */
function electronClipboard(): ElectronClipboard | null {
  try {
    return nodeRequire<{ clipboard?: ElectronClipboard } | null>("electron")?.clipboard ?? null;
  } catch {
    return null;
  }
}

export interface NativeClipboardImage {
  data: ArrayBuffer;
  ext: string;
  /** Formats the clipboard advertised; useful for diagnostics in the Notice. */
  formats: string[];
}

/**
 * Bitmap-only read of the OS clipboard.
 *
 * This is the one path that cannot preserve an original file: the OS hands over
 * a decoded bitmap, so PNG is the honest container. It is also the only path
 * that works for screenshots taken while the view did not have focus, which is
 * exactly why the toolbar button exists.
 */
export function readNativeClipboardImage(): NativeClipboardImage | { error: string } {
  const clip = electronClipboard();
  if (!clip?.readImage) return { error: "无法读取系统剪贴板" };
  let formats: string[] = [];
  try {
    formats = clip.availableFormats?.() ?? [];
  } catch {
    formats = [];
  }
  try {
    const image = clip.readImage();
    if (!image || image.isEmpty?.() === true) {
      return {
        error: formats.length
          ? `剪贴板里没有图片（含 ${formats.join(", ")}）`
          : "剪贴板里没有图片",
      };
    }
    const png = image.toPNG?.();
    if (!png || png.length === 0) return { error: "剪贴板图片为空" };
    return { data: toArrayBuffer(png), ext: "png", formats };
  } catch (err) {
    return { error: String(err) };
  }
}

export interface NativeClipboardFile {
  fullPath: string;
  name: string;
}

/**
 * Files copied in Explorer / Finder, recovered from the Windows CF_HDROP
 * flavour. Without this the button would have to fall back to the clipboard's
 * *bitmap* preview, which loses the original file name and format.
 */
export function readNativeClipboardFiles(): NativeClipboardFile[] {
  const clip = electronClipboard();
  if (!clip?.readBuffer) return [];
  try {
    const buf = clip.readBuffer("FileNameW");
    if (!buf) return [];
    return buf
      .toString("ucs2")
      .split("\u0000")
      .map((s) => s.trim())
      .filter((s) => /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s))
      .map((fullPath) => ({
        fullPath,
        name: fullPath.split(/[\\/]/).pop() ?? "",
      }));
  } catch {
    return [];
  }
}

export function readNativeClipboardText(): string {
  try {
    return electronClipboard()?.readText?.("text/plain") ?? "";
  } catch {
    return "";
  }
}

// -------------------------------------------------------------------- disk

/** Bytes of a local image path, read through Node. Desktop only, always guarded. */
export function readLocalImageBytes(
  fullPath: string
): { data: ArrayBuffer; ext: string } | { error: string } {
  try {
    const fs = nodeRequire<{ readFileSync?: (p: string) => Uint8Array } | null>("fs");
    if (!fs?.readFileSync) return { error: "当前环境无法读取本地文件" };
    const buf = fs.readFileSync(fullPath);
    if (!buf || buf.length === 0) return { error: "文件是空的" };
    if (buf.length > MAX_IMPORT_BYTES) return { error: "文件超过 64 MB" };
    return { data: toArrayBuffer(buf), ext: extOf(fullPath) || "png" };
  } catch (err) {
    return { error: String(err) };
  }
}

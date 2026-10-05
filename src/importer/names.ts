/*
 * Deciding what to call an incoming file, and whether it is an image at all.
 *
 * Pure: no DOM, no clipboard, no vault. The interesting bugs in a paste handler
 * are never in the plumbing — they are in "is this actually an image", "what
 * should it be called", and "is that URL worth downloading".
 */

import { extOf, rawExtOf } from "../utils";

const IMAGE_MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jxl": "jxl",
};

/** Canonical extension for a clipboard MIME type, or null if we reject it. */
export function extensionForMime(mime: string): string | null {
  if (!mime) return null;
  const key = mime.toLowerCase().split(";")[0].trim();
  if (!key) return null;
  const known = IMAGE_MIME_TO_EXT[key];
  if (known) return known;
  // Unknown but still an image subtype (image/x-foo): accept only if the
  // subtype is a plausible bare token, and keep the subtype as the extension.
  if (!key.startsWith("image/")) return null;
  const sub = key.slice("image/".length);
  if (!/^[a-z0-9]{1,10}$/.test(sub)) return null;
  return sub === "jpeg" ? "jpg" : sub;
}

export function isAllowedImageMime(mime: string): boolean {
  return extensionForMime(mime) !== null;
}

/** True when the file name ends in one of the extensions the plugin manages. */
export function nameHasAllowedExt(name: string, allowed: string[]): boolean {
  return allowed.includes(extOf(name));
}

/** Characters that cannot appear in a vault path, plus control codes. */
const ILLEGAL_CHARS = /[\\/:*?"<>|#^[\]]|[\u0000-\u001f]/g;

/**
 * Make an arbitrary clipboard-provided string safe as a single path segment.
 * Anything that would change the directory it lands in is stripped rather than
 * escaped — a pasted name must never decide its own folder.
 */
export function sanitizeFileName(raw: string): string {
  const leaf = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = leaf
    .replace(ILLEGAL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/, "");
  return cleaned.slice(0, 120);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * `yymmddhhmmss` — twelve digits, no separators.
 *
 * Lexicographic order is chronological order at this width for another ~74
 * years, so a directory of pasted images also sorts by when it was pasted.
 */
export function compactStamp(now: Date): string {
  const yy = String(now.getFullYear()).slice(-2);
  return (
    `${yy}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  );
}

/**
 * The paste auto-name: `目录名-yymmddhhmmss`.
 *
 * Every pasted image gets this name — whatever the clipboard called it, the
 * only facts worth keeping are *where* it landed and *when*. The directory
 * segment is scrubbed hard: illegal characters are dropped outright and all
 * whitespace is removed (never replaced), because the name must be a single
 * clean token. A root paste has no directory to name it after, so the vault
 * name stands in; `fallback` covers a nameless vault.
 */
export function pasteStampBase(dirName: string, now: Date, fallback = "vault"): string {
  const leaf = String(dirName ?? "").split(/[\\/]/).pop() ?? "";
  const clean = leaf
    .replace(ILLEGAL_CHARS, "")
    .replace(/\s+/g, "")
    .replace(/^\.+/, "");
  return `${clean.length > 0 ? clean : fallback}-${compactStamp(now)}`;
}

/** Last path segment of a URL, decoded, query string and hash removed. */
export function fileNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(seg);
  } catch {
    return "";
  }
}

/**
 * Pick the extension to save a pasted file under.
 *
 * A file that already carries an allowed extension keeps it verbatim — case
 * included. Re-casing "草图.PNG" on the way in is the kind of unrequested edit
 * that makes people stop trusting an importer.
 */
export function resolvePastedExt(
  fileName: string,
  mimeType: string,
  allowedExtensions: string[]
): string {
  const own = rawExtOf(fileName);
  const allowed =
    allowedExtensions.includes(own) || allowedExtensions.includes(own.toLowerCase());
  if (own && allowed) return own;
  return extensionForMime(mimeType) ?? own ?? "png";
}

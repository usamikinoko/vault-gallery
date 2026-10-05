/*
 * The whole "should we even try" decision for a paste. Kept pure so the smoke
 * test can throw every awkward clipboard at it without a browser.
 */

import { isAllowedImageMime, nameHasAllowedExt } from "./names";

/** Trimmed length cap for pasted text, before any pattern is applied. */
const MAX_TEXT_LENGTH = 4096;

export function isHttpUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

/** Absolute OS path, in any of the shapes a clipboard realistically holds. */
export function looksLikeLocalPath(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > MAX_TEXT_LENGTH) return false;
  if (/\r|\n/.test(t)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(t)) return true; // C:\dir\file.png
  if (/^\\\\[^\\]/.test(t)) return true; // \\server\share\file.png
  if (/^\/(?:Users|home|mnt|media|Volumes|tmp|var)\//.test(t)) return true;
  return false;
}

export interface ClipboardFileLike {
  name: string;
  type: string;
}

export interface ClipboardClassifyResult {
  /** Indices into the input array that should be imported. */
  accept: number[];
  /** Files whose type we refuse; surfaced to the user, never silently dropped. */
  reject: ClipboardFileLike[];
  /** An http(s) URL worth downloading, if that is what the clipboard held. */
  url: string | null;
  /** An absolute local image path worth reading, if that is what it held. */
  localPath: string | null;
}

export function classifyClipboard(
  files: ClipboardFileLike[],
  text: string,
  allowedExtensions: string[]
): ClipboardClassifyResult {
  const accept: number[] = [];
  const reject: ClipboardFileLike[] = [];

  files.forEach((f, i) => {
    if (isAllowedImageMime(f.type)) {
      accept.push(i);
      return;
    }
    // Chromium reports an empty type for some CF_HDROP copies; fall back to
    // the extension, which is the only signal left.
    if (!f.type && nameHasAllowedExt(f.name, allowedExtensions)) {
      accept.push(i);
      return;
    }
    reject.push(f);
  });

  let url: string | null = null;
  let localPath: string | null = null;
  const trimmed = text.trim();
  if (files.length === 0 && trimmed) {
    if (isHttpUrl(trimmed)) url = trimmed;
    else if (looksLikeLocalPath(trimmed) && nameHasAllowedExt(trimmed, allowedExtensions)) {
      localPath = trimmed;
    }
  }

  return { accept, reject, url, localPath };
}

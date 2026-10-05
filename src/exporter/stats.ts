/* What an export contains: scope selection and the library summary. Pure. */

import type { ImageEntry } from "../types";
import { basename } from "../utils";
import { countExtensions, totalBytes } from "../store/stats";
import type { ZipEntry } from "../zip";

export interface LibraryStats {
  root: string;
  images: number;
  folders: number;
  bytes: number;
  /** Extension (lowercase, no dot) -> count, sorted by count descending. */
  byExtension: Array<{ ext: string; count: number }>;
}

/** Pure so the JSON payload can be asserted without a vault. */
export function libraryStats(
  images: ImageEntry[],
  folders: number,
  root: string
): LibraryStats {
  return {
    root,
    images: images.length,
    folders,
    bytes: totalBytes(images),
    byExtension: countExtensions(images),
  };
}

/** Images at or below a folder, from a flat list. */
export function imagesUnder(images: ImageEntry[], folderPath: string): ImageEntry[] {
  if (!folderPath) return images;
  const prefix = `${folderPath}/`;
  return images.filter((img) => img.path.startsWith(prefix));
}

/**
 * Every image at or below `folderPath`, as archive entries.
 *
 * Scoping happens here, not in the caller: entry names are derived by chopping
 * `folderPath` off each vault path, so an out-of-scope image would not be
 * "extra" — it would be silently renamed to a fragment of its own path.
 *
 * The top folder is kept inside the archive, so extracting does not scatter its
 * contents into whatever directory the user happens to be in.
 */
export function collectExportEntries(opts: {
  images: ImageEntry[];
  /** Vault-relative folder being exported; empty string means the vault root. */
  folderPath: string;
  /** Name to give that folder inside the archive. */
  rootFolderName: string;
  /** Vault-relative path -> absolute path on disk, or null if unresolvable. */
  toFullPath: (vaultPath: string) => string | null;
}): ZipEntry[] {
  const prefix = opts.folderPath ? `${opts.folderPath}/` : "";
  const top = sanitizeFileStem(opts.rootFolderName) || "export";
  const out: ZipEntry[] = [];

  for (const img of imagesUnder(opts.images, opts.folderPath)) {
    const absolute = opts.toFullPath(img.path);
    // Dropping an unresolvable entry is the only correct move: writing it
    // anyway would either abort the archive halfway or emit a zero-byte member
    // that looks like a corrupt image after extraction.
    if (!absolute) continue;
    out.push({
      // Vault paths already use `/`, which is also what ZIP stores.
      name: `${top}/${prefix ? img.path.slice(prefix.length) : img.path}`,
      filePath: absolute,
      size: img.size,
    });
  }

  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A safe file stem: strip the characters Windows refuses, and trailing dots. */
export function sanitizeFileStem(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\s.]+$/, "")
    .trim();
  return cleaned || "export";
}

/** Name shown for an export that targets the vault root. */
export function exportLabelFor(vaultName: string, folderPath: string): string {
  return folderPath ? basename(folderPath) : vaultName;
}

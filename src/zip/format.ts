/*
 * On-disk facts about the ZIP container, and the two guards that keep a
 * malformed archive from being written at all.
 *
 * Format notes that cost real debugging time if you get them wrong:
 *  - Names are UTF-8 and general-purpose bit 11 must be set, or Chinese folder
 *    names turn into mojibake in Explorer.
 *  - ZIP64 extra fields carry values in a fixed order — uncompressed,
 *    compressed, offset — and only the overflowing ones, which is why the
 *    field's own length varies.
 */

export const SIG_LOCAL = 0x04034b50;
export const SIG_CENTRAL = 0x02014b50;
export const SIG_EOCD = 0x06054b50;
export const SIG_ZIP64_EOCD = 0x06064b50;
export const SIG_ZIP64_LOCATOR = 0x07064b50;

/** Anything at or above this cannot be expressed in the 32-bit fields. */
export const U32_MAX = 0xffffffff;

/** Bit 11 marks the name as UTF-8; bit 0 marks the payload as encrypted. */
export const FLAG_UTF8 = 0x0800;
export const FLAG_ENCRYPTED = 0x0001;

/** ZipCrypto stores a 1-byte length; anything longer cannot be represented. */
export const MAX_PASSWORD_BYTES = 99;

/**
 * Formats that are already compressed. Running deflate over a JPEG costs a full
 * pass over every byte for a fraction of a percent, and on a 4 GB folder that
 * pass is the difference between "instant" and "why is this frozen".
 */
const COMPRESSIBLE = new Set(["svg", "bmp", "tif", "tiff", "ico"]);

export function shouldDeflate(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return COMPRESSIBLE.has(name.slice(dot + 1).toLowerCase());
}

/**
 * A member name must stay inside the archive. Unreachable with vault-derived
 * names, but an archive writer should fail closed rather than emit `../` paths
 * that an extractor would follow out of the target directory.
 */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return false;
  return !name.split("/").some((segment) => segment === "..");
}

/** Thrown when `shouldAbort` calls the export off. */
export class ZipAborted extends Error {
  constructor() {
    super("导出已取消");
    this.name = "ZipAborted";
  }
}

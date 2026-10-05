/*
 * A minimal, dependency-free ZIP writer.
 *
 * Why hand-rolled instead of a library or a call to the system 7z.exe:
 *  - A library is 100 KB+ in main.js for one button, and the only compressor we
 *    already have is Node's `zlib`, which is exactly what a ZIP entry needs
 *    (raw deflate).
 *  - Shelling out to 7-Zip would make the feature fail on any machine without
 *    it installed.
 */

import { nodeRequire } from "../nodeRequire";
import { ByteWriter } from "./bytes";
import { buildEntry, centralHeader, type CentralRecord, type ZipEntry } from "./entry";
import {
  MAX_PASSWORD_BYTES,
  SIG_EOCD,
  SIG_ZIP64_EOCD,
  SIG_ZIP64_LOCATOR,
  U32_MAX,
  ZipAborted,
  isSafeEntryName,
} from "./format";
import { type NodeCrypto, type NodeFs, type WriteStreamLike, writeChunk } from "./io";

export type { ZipEntry };

export interface ZipProgress {
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
  /** Name of the entry just finished. */
  current: string;
}

export interface ZipOptions {
  outPath: string;
  entries: ZipEntry[];
  /** Empty or null writes an unencrypted archive. */
  password?: string | null;
  onProgress?: (p: ZipProgress) => void;
  /**
   * Polled between entries. Returning true aborts and deletes the partial file,
   * which is the difference between "cancel" and "now I have a truncated
   * archive on disk that looks valid until you open it".
   */
  shouldAbort?: () => boolean;
}

export interface ZipResult {
  files: number;
  bytes: number;
}

/** The ZIP64 end-of-central-directory pair, for archives past the 32-bit limits. */
async function writeZip64Footer(
  stream: WriteStreamLike,
  entryCount: number,
  centralStart: number,
  centralSize: number
): Promise<void> {
  const eocd64 = new ByteWriter();
  eocd64
    .u32(SIG_ZIP64_EOCD)
    .u64(44) // size of the remainder of this record
    .u16(45)
    .u16(45)
    .u32(0)
    .u32(0)
    .u64(entryCount)
    .u64(entryCount)
    .u64(centralSize)
    .u64(centralStart);
  await writeChunk(stream, eocd64.concat());

  const locator = new ByteWriter();
  locator.u32(SIG_ZIP64_LOCATOR).u32(0).u64(centralStart + centralSize).u32(1);
  await writeChunk(stream, locator.concat());
}

/**
 * Write `entries` into a ZIP at `outPath`.
 *
 * Entries are processed one at a time: read, compress, encrypt, write. Peak
 * memory is one file, not the whole archive, and every step awaits, so the
 * interface keeps painting while a multi-gigabyte export runs.
 */
export async function writeZip(opts: ZipOptions): Promise<ZipResult> {
  const fs = nodeRequire<NodeFs>("fs");
  const crypto = nodeRequire<NodeCrypto>("crypto");
  const password = opts.password ?? "";
  if (password.length > MAX_PASSWORD_BYTES) {
    throw new Error("ZIP 传统加密的密码最长 99 字节。");
  }

  const stream = fs.createWriteStream(opts.outPath);
  const directory: CentralRecord[] = [];
  const totalBytes = opts.entries.reduce((sum, e) => sum + e.size, 0);
  let offset = 0;
  let doneBytes = 0;
  let doneFiles = 0;

  try {
    for (const entry of opts.entries) {
      if (!isSafeEntryName(entry.name)) {
        throw new Error(`不安全的压缩包内路径：${entry.name}`);
      }
      if (opts.shouldAbort?.()) throw new ZipAborted();

      const built = await buildEntry(fs, crypto, entry, password);
      const { local, body } = built;
      built.record.offset = offset;

      await writeChunk(stream, local);
      await writeChunk(stream, body);
      directory.push(built.record);

      offset += local.length + body.length;
      doneFiles++;
      doneBytes += entry.size;
      opts.onProgress?.({
        files: doneFiles,
        totalFiles: opts.entries.length,
        bytes: doneBytes,
        totalBytes,
        current: entry.name,
      });
    }

    // --- central directory ---
    const centralStart = offset;
    let centralSize = 0;
    for (const rec of directory) {
      const bytes = centralHeader(rec);
      await writeChunk(stream, bytes);
      centralSize += bytes.length;
    }

    const entryCount = directory.length;
    if (entryCount >= 0xffff || centralSize >= U32_MAX || centralStart >= U32_MAX) {
      await writeZip64Footer(stream, entryCount, centralStart, centralSize);
    }

    const eocd = new ByteWriter();
    eocd
      .u32(SIG_EOCD)
      .u16(0)
      .u16(0)
      .u16(Math.min(entryCount, 0xffff))
      .u16(Math.min(entryCount, 0xffff))
      .u32(Math.min(centralSize, U32_MAX))
      .u32(Math.min(centralStart, U32_MAX))
      .u16(0);
    await writeChunk(stream, eocd.concat());

    await new Promise<void>((resolve, reject) => {
      stream.once("error", (e) => reject(e as Error));
      stream.end(() => resolve());
    });

    return { files: entryCount, bytes: offset + centralSize };
  } catch (err) {
    try {
      (stream as unknown as { destroy?: () => void }).destroy?.();
    } catch {
      /* the stream may already be gone; the original error matters more */
    }
    // A half-written archive is worse than no archive: it has a valid header
    // and no central directory, so it looks like a corrupt file rather than an
    // interrupted export.
    try {
      const fsAny = fs as unknown as { promises: { rm(p: string): Promise<void> } };
      await fsAny.promises.rm(opts.outPath);
    } catch {
      /* nothing to remove, or already gone */
    }
    throw err;
  }
}

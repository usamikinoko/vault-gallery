/*
 * One archive member: read, compress, encrypt, and lay out both of the headers
 * that describe it.
 *
 * Everything here is per-entry and stateless — the running offset is the only
 * thing the container has to hand back in, which is why it lives on the record
 * rather than in a parameter.
 */

import { ByteWriter, dosDateTime, utf8Bytes } from "./bytes";
import { crc32 } from "./crc32";
import { ZipCrypto } from "./crypto";
import {
  FLAG_ENCRYPTED,
  FLAG_UTF8,
  SIG_CENTRAL,
  SIG_LOCAL,
  U32_MAX,
  shouldDeflate,
} from "./format";
import { NodeCrypto, NodeFs, type BufferLike, deflateRaw } from "./io";

export interface ZipEntry {
  /** Path inside the archive: forward slashes, no leading slash. */
  name: string;
  /** Absolute path on disk. */
  filePath: string;
  /** Uncompressed size in bytes, used for progress only. */
  size: number;
}

export interface CentralRecord {
  name: Uint8Array;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
  time: number;
  date: number;
  method: number;
  flags: number;
  /** Whether this entry's own sizes/offset needed a ZIP64 extra field. */
  zip64: boolean;
  extra: Uint8Array;
}

export async function buildEntry(
  fs: NodeFs,
  crypto: NodeCrypto,
  entry: ZipEntry,
  password: string
): Promise<{ local: BufferLike; body: BufferLike; record: CentralRecord }> {
  const plain = await fs.promises.readFile(entry.filePath);
  const name = utf8Bytes(entry.name);

  let method = 0;
  let payload: BufferLike = plain;
  if (shouldDeflate(entry.name)) {
    const deflated = await deflateRaw(plain);
    // Keeping the deflated bytes when they came out larger is what every
    // archiver does; the method field is what tells readers which is which.
    if (deflated.length < plain.length) {
      method = 8;
      payload = deflated;
    }
  }

  const crc = crc32(plain);
  const flags = FLAG_UTF8 | (password ? FLAG_ENCRYPTED : 0);

  let body: BufferLike = payload;
  if (password) {
    const cipher = new ZipCrypto(password);
    const head = cipher.header(crc, crypto.randomBytes(12));
    const data = cipher.encrypt(payload);
    body = new Uint8Array(head.length + data.length);
    body.set(head, 0);
    body.set(data, head.length);
  }

  // The stat is best-effort: a timestamp is not worth failing an export over.
  const stat = await fs.promises.stat(entry.filePath).catch(() => null);
  const stamp = dosDateTime(stat?.mtime ?? new Date());
  const uncompressedSize = plain.length;
  const compressedSize = body.length;
  const needsZip64 = uncompressedSize >= U32_MAX || compressedSize >= U32_MAX;

  const extra = new ByteWriter();
  if (needsZip64) extra.u16(0x0001).u16(16).u64(uncompressedSize).u64(compressedSize);
  const extraBytes = extra.concat();

  const local = new ByteWriter();
  local
    .u32(SIG_LOCAL)
    .u16(needsZip64 ? 45 : 20)
    .u16(flags)
    .u16(method)
    .u16(stamp.time)
    .u16(stamp.date)
    .u32(crc)
    .u32(needsZip64 ? U32_MAX : compressedSize)
    .u32(needsZip64 ? U32_MAX : uncompressedSize)
    .u16(name.length)
    .u16(extraBytes.length)
    .bytes(name)
    .bytes(extraBytes);

  return {
    local: local.concat(),
    body,
    record: {
      name,
      crc,
      compressedSize,
      uncompressedSize,
      offset: 0, // filled in by the caller, which knows the running offset
      time: stamp.time,
      date: stamp.date,
      method,
      flags,
      zip64: needsZip64,
      extra: extraBytes,
    },
  };
}

/** The central directory's copy of the same facts, plus the file's offset. */
export function centralHeader(rec: CentralRecord): Uint8Array {
  const writer = new ByteWriter();
  writer
    .u32(SIG_CENTRAL)
    .u16(0x031e) // made by: UNIX, version 3.0 — neutral, and honest
    .u16(rec.zip64 ? 45 : 20)
    .u16(rec.flags)
    .u16(rec.method)
    .u16(rec.time)
    .u16(rec.date)
    .u32(rec.crc)
    .u32(rec.zip64 ? U32_MAX : rec.compressedSize)
    .u32(rec.zip64 ? U32_MAX : rec.uncompressedSize)
    .u16(rec.name.length)
    .u16(rec.extra.length)
    .u16(0) // comment length
    .u16(0) // disk number
    .u16(0) // internal attributes
    .u32(0x81a40000 | 0o644) // external attributes: regular file, 0644
    .u32(rec.offset >= U32_MAX ? U32_MAX : rec.offset)
    .bytes(rec.name)
    .bytes(rec.extra);
  return writer.concat();
}

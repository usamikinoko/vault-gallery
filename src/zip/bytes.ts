/* Byte-level helpers for the ZIP container: encoding, stamps, and a writer. */

type BufferLike = Uint8Array;

export function utf8Bytes(s: string): Uint8Array {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(s);
  // Fallback for the headless DOM, where TextEncoder may be absent.
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63)
      );
    }
  }
  return new Uint8Array(out);
}

/** MS-DOS date and time, as ZIP has stored timestamps since 1989. */
export function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Little-endian field writer, so header layouts stay readable. */
export class ByteWriter {
  private parts: BufferLike[] = [];
  private length = 0;

  u16(v: number): this {
    this.parts.push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
    this.length += 2;
    return this;
  }

  u32(v: number): this {
    this.parts.push(
      new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff])
    );
    this.length += 4;
    return this;
  }

  u64(v: number): this {
    // Split rather than BigInt: sizes here are always below 2^53.
    const lo = v % 0x100000000;
    const hi = Math.floor(v / 0x100000000);
    return this.u32(lo).u32(hi);
  }

  bytes(b: BufferLike): this {
    this.parts.push(b);
    this.length += b.length;
    return this;
  }

  get size(): number {
    return this.length;
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/*
 * The Node side of the ZIP writer: the pieces the archive format does not care
 * about but that have to be right anyway — the fs stream, raw deflate, and a
 * password that is not guessable from the clock.
 */

import { nodeRequire } from "../nodeRequire";

export type BufferLike = Uint8Array;

export interface NodeFs {
  promises: {
    readFile(p: string): Promise<BufferLike>;
    stat(p: string): Promise<{ size: number; mtime: Date }>;
  };
  createWriteStream(p: string): WriteStreamLike;
}

export interface WriteStreamLike {
  write(chunk: BufferLike): boolean;
  end(cb?: () => void): void;
  once(event: string, cb: (...args: unknown[]) => void): void;
  removeListener?(event: string, cb: (...args: unknown[]) => void): void;
}

interface NodeZlib {
  deflateRaw(buf: BufferLike, cb: (err: Error | null, out: BufferLike) => void): void;
}

export interface NodeCrypto {
  randomBytes(n: number): BufferLike;
}

export function deflateRaw(data: BufferLike): Promise<BufferLike> {
  const zlib = nodeRequire<NodeZlib>("zlib");
  return new Promise((resolve, reject) => {
    zlib.deflateRaw(data, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/**
 * Await backpressure, but not forever: without the error branch a full disk
 * would park the export on a `drain` that never comes.
 */
export function writeChunk(stream: WriteStreamLike, chunk: BufferLike): Promise<void> {
  if (stream.write(chunk)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener?.("drain", onDrain);
      stream.removeListener?.("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

/**
 * A six-digit numeric password.
 *
 * `Math.random()` would be enough to pick one of a million values, but the
 * password is the only thing standing between the archive and a stranger, and
 * Node's CSPRNG is one call away. Bytes are drawn by rejection sampling rather
 * than `% 10`, which would bias the low digits.
 */
export function randomNumericPassword(digits = 6): string {
  try {
    const crypto = nodeRequire<NodeCrypto>("crypto");
    let out = "";
    while (out.length < digits) {
      for (const byte of crypto.randomBytes(digits * 2)) {
        if (byte >= 250) continue; // largest multiple of 10 below 256
        out += String(byte % 10);
        if (out.length === digits) break;
      }
    }
    return out;
  } catch {
    let out = "";
    for (let i = 0; i < digits; i++) out += String(Math.floor(Math.random() * 10));
    return out;
  }
}

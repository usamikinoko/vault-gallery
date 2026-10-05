/*
 * Session-scoped thumbnail cache: the one fix that actually moves the needle.
 *
 * The grid used to point every card's <img> at `vault.getResourcePath()` — the
 * *full-resolution* file. A folder of 4K screenshots meant every visible tile
 * decoded tens of megapixels, uploaded a huge texture, and the ambient-blur
 * backdrop asked for a second full-size compositor surface on top. Scrolling
 * a large folder therefore decoded gigabytes of pixels, and the eviction churn
 * that followed is what slowed the whole app down, not just this view.
 *
 * Here each large image is decoded once — off the main thread, via
 * `createImageBitmap` — downscaled in a canvas to roughly the tile size, and
 * kept as a WebP blob URL. A tile then costs a few dozen KB and a trivial
 * decode, and the blur backdrop operates on the same small bitmap.
 *
 * Everything lives in memory for the session: no disk cache to invalidate, no
 * stale thumbnails after an edit (the cache key includes mtime and size, so a
 * modified file simply misses). Files too small to be worth it, and formats
 * the pipeline must not touch (animated GIFs would freeze, SVGs are already
 * tiny), keep using their original bytes.
 */

import type { App, TFile } from "obsidian";
import { extOf } from "./utils";

/** Extensions never run through the thumbnail pipeline. */
const SKIP_EXTENSIONS = new Set(["gif", "svg", "ico"]);

/** Below this file size a full decode is cheaper than the bookkeeping. */
export const THUMB_MIN_BYTES = 256 * 1024;

/** How many blob URLs to keep before the oldest start getting revoked. */
const CACHE_CAP = 600;

/** Pause between two generations, so the queue never competes with a frame. */
const YIELD_MS = 40;

/** True when this entry is worth a thumbnail at all. */
export function shouldThumb(file: { name: string; size: number }): boolean {
  return file.size >= THUMB_MIN_BYTES && !SKIP_EXTENSIONS.has(extOf(file.name));
}

/** Cache key: any change to path, content or target size is a new thumbnail. */
function keyOf(file: TFile, edge: number): string {
  return `${file.path}\u0000${file.stat.mtime}\u0000${file.stat.size}\u0000${edge}`;
}

export interface ThumbCacheOptions {
  app: App;
  /** Longest edge of a generated thumbnail, in CSS pixels. */
  edge: () => number;
}

export class ThumbCache {
  private app: App;
  private edge: () => number;

  /** key -> blob URL, in insertion order (oldest first) for LRU eviction. */
  private urls = new Map<string, string>();
  /** Keys that failed to generate; do not retry them this session. */
  private failed = new Set<string>();
  /** Keys queued or currently generating. */
  private pending = new Set<string>();
  private queue: Array<{ file: TFile; key: string }> = [];
  private draining = false;
  private disposed = false;
  private listeners = new Set<(path: string, url: string | null) => void>();

  constructor(o: ThumbCacheOptions) {
    this.app = o.app;
    this.edge = o.edge;
  }

  /** Blob URL for this file's thumbnail, or null when it is not cached. */
  srcFor(file: TFile): string | null {
    return this.urls.get(keyOf(file, this.currentEdge())) ?? null;
  }

  /** True when generation already failed — the caller should use the original. */
  isFailed(file: TFile): boolean {
    return this.failed.has(keyOf(file, this.currentEdge()));
  }

  /** Queue generation. Cheap and idempotent; returns immediately. */
  request(file: TFile): void {
    if (this.disposed) return;
    const key = keyOf(file, this.currentEdge());
    if (this.urls.has(key) || this.failed.has(key) || this.pending.has(key)) return;
    this.pending.add(key);
    this.queue.push({ file, key });
    void this.drain();
  }

  /** Drop queued (not yet started) work whose path is not in `keep`. */
  retain(keep: Set<string>): void {
    if (this.queue.length === 0) return;
    this.queue = this.queue.filter((job) => {
      if (keep.has(job.file.path)) return true;
      this.pending.delete(job.key);
      return false;
    });
  }

  /** Be told when a thumbnail settles — `url` is null when it failed. */
  onReady(cb: (path: string, url: string | null) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Revoke everything. Called from plugin unload. */
  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.pending.clear();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.listeners.clear();
  }

  private currentEdge(): number {
    // Retina-ish: twice the tile, clamped so the slider cannot ask for posters.
    return Math.min(640, Math.max(256, Math.round(this.edge() * 2)));
  }

  private emit(path: string, url: string | null): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(path, url);
      } catch (err) {
        console.error(err);
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const job = this.queue.shift()!;
        this.pending.delete(job.key);
        if (this.urls.has(job.key) || this.failed.has(job.key)) continue;
        let url: string | null = null;
        try {
          url = await this.generate(job.file);
        } catch {
          url = null;
        }
        if (this.disposed) {
          if (url) URL.revokeObjectURL(url);
          continue;
        }
        if (url) {
          this.urls.set(job.key, url);
          this.evictOverCap();
        } else {
          this.failed.add(job.key);
        }
        this.emit(job.file.path, url);
        // Give the app a frame between decodes — the queue is background work.
        await new Promise((r) => setTimeout(r, YIELD_MS));
      }
    } finally {
      this.draining = false;
    }
  }

  private evictOverCap(): void {
    while (this.urls.size > CACHE_CAP) {
      const oldest = this.urls.keys().next();
      if (oldest.done) break;
      const url = this.urls.get(oldest.value)!;
      this.urls.delete(oldest.value);
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Decode off-thread, downscale, encode as WebP, return a blob URL.
   * Null means "not possible / not worthwhile" — the caller falls back to the
   * original file. Safe in headless environments: every API is feature-tested.
   */
  private async generate(file: TFile): Promise<string | null> {
    if (typeof createImageBitmap !== "function") return null;
    if (typeof URL?.createObjectURL !== "function") return null;
    const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
    if (!canvas || typeof canvas.toBlob !== "function") return null;

    let bytes: ArrayBuffer;
    try {
      bytes = await this.app.vault.readBinary(file);
    } catch {
      return null;
    }

    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(new Blob([bytes]));
    } catch {
      return null; // undecodable here (HEIC and friends): use the original
    }

    try {
      const edge = this.currentEdge();
      const longest = Math.max(bmp.width, bmp.height);
      if (longest <= edge) return null; // already thumbnail-sized
      const scale = edge / longest;
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bmp, 0, 0, w, h);
      const out = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, "image/webp", 0.85)
      );
      if (!out) return null;
      return URL.createObjectURL(out);
    } finally {
      bmp.close();
    }
  }
}

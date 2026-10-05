/*
 * Reverse-link index over Obsidian's metadata cache.
 *
 * Both the "unreferenced" filter and the per-card reference pill read from
 * here; without an index each of those asks the cache once per image, which on
 * a virtualised grid means thousands of lookups per repaint.
 */

import type { ImageEntry } from "../types";

type ResolvedLinks = Record<string, Record<string, number>>;

export interface ReferenceCounts {
  total: number;
  referenced: number;
  orphans: number;
}

export class BacklinkIndex {
  private links: Map<string, string[]> | null = null;
  private paths: Set<string> | null = null;

  constructor(private resolve: () => ResolvedLinks) {}

  invalidate(): void {
    this.links = null;
    this.paths = null;
  }

  private build(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    const resolved = this.resolve();
    for (const source of Object.keys(resolved)) {
      for (const target of Object.keys(resolved[source])) {
        const bucket = index.get(target);
        if (bucket) bucket.push(source);
        else index.set(target, [source]);
      }
    }
    return index;
  }

  /** Notes that embed or link this file. */
  forFile(path: string): string[] {
    if (!this.links) this.links = this.build();
    return this.links.get(path) ?? [];
  }

  /** Every path the vault links to; O(1) membership test per card. */
  referencedPaths(): Set<string> {
    if (!this.paths) this.paths = new Set(this.build().keys());
    return this.paths;
  }

  /** How many images are referenced and how many are not, in one pass. */
  countIn(entries: ImageEntry[]): ReferenceCounts {
    const refs = this.referencedPaths();
    let referenced = 0;
    for (const img of entries) if (refs.has(img.path)) referenced++;
    return { total: entries.length, referenced, orphans: entries.length - referenced };
  }
}

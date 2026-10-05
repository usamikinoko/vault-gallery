/* Library statistics derived from a flat image list. Pure, no vault access. */

import type { ImageEntry } from "../types";
import { extOf } from "../utils";

/** Extension histogram, ordered by count then name. */
export function countExtensions(
  images: ImageEntry[]
): Array<{ ext: string; count: number }> {
  const counts = new Map<string, number>();
  for (const img of images) {
    const ext = extOf(img.name) || "（无扩展名）";
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count || (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0));
}

/** Total bytes over a flat image list. */
export function totalBytes(images: ImageEntry[]): number {
  let bytes = 0;
  for (const img of images) bytes += img.size;
  return bytes;
}

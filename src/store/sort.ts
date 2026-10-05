/* Sorting one folder's images by the configured criterion. Pure. */

import type { VaultGallerySettings, ImageEntry } from "../types";
import type { Comparer } from "./comparer";

/**
 * Apply the configured sort to one folder's direct images.
 *
 * Always returns a new array: the input lists are handed out by the scan cache
 * and must never be reordered in place.
 */
export function sortImages(
  entries: ImageEntry[],
  folderPath: string,
  settings: VaultGallerySettings,
  compare: Comparer
): ImageEntry[] {
  const list = [...entries];

  if (settings.sortKey === "custom") {
    const rank = new Map<string, number>();
    for (const [i, name] of (settings.customOrders[folderPath] ?? []).entries()) {
      rank.set(name, i);
    }
    list.sort((a, b) => {
      const ra = rank.get(a.name) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.name) ?? Number.MAX_SAFE_INTEGER;
      return ra !== rb ? ra - rb : compare(a.name, b.name);
    });
    return settings.sortAsc ? list : list.reverse();
  }

  const dir = settings.sortAsc ? 1 : -1;
  const key = settings.sortKey;
  list.sort((a, b) => {
    let r = 0;
    if (key === "name") r = compare(a.name, b.name);
    else if (key === "mtime") r = a.mtime - b.mtime;
    else if (key === "ctime") r = a.ctime - b.ctime;
    else if (key === "size") r = a.size - b.size;
    // Name is the tie-break, so equal timestamps still have a stable order.
    if (r === 0) r = compare(a.name, b.name);
    return r * dir;
  });
  return list;
}

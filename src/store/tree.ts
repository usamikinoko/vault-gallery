/*
 * One walk of the vault, projected into the tree the grid renders.
 *
 * Kept separate from the cache in `ImageStore` so the expensive part — the
 * traversal and the per-folder buckets — can be reasoned about on its own.
 */

import { TFile, TFolder } from "obsidian";
import type { FolderNode, ImageEntry } from "../types";
import { isImageName } from "../utils";
import { MAX_STACK_LAYERS } from "../folderStack";
import type { Comparer } from "./comparer";

export interface TreeIndex {
  tree: FolderNode | null;
  /** Every image at or below the root, in traversal order. */
  flat: ImageEntry[];
  /** Folders at or below the root, the root included. */
  folderCount: number;
}

export interface TreeOptions {
  root: TFolder | null;
  /** Lowercase extensions without the dot. */
  extensions: string[];
  /** Normalized configured root, for the display-only `relPath`. */
  rootPrefix: string;
  /** Shown as the root node's name; the vault root has no useful `name`. */
  vaultName: string;
  compare: Comparer;
  sortEntries: (entries: ImageEntry[], folderPath: string) => ImageEntry[];
}

export function buildTreeIndex(o: TreeOptions): TreeIndex {
  const index: TreeIndex = { tree: null, flat: [], folderCount: 0 };
  if (!o.root) return index;

  const flat = index.flat;
  let folderCount = 0;

  const build = (folder: TFolder, depth: number): FolderNode => {
    // The vault root reports "/" as its path; "" matches parentPath() output
    // and the empty rootPath setting.
    const folderPath = folder.isRoot() ? "" : folder.path;
    folderCount++;

    const images: ImageEntry[] = [];
    const node: FolderNode = {
      path: folderPath,
      name: folder.isRoot() ? o.vaultName : folder.name,
      relPath: o.rootPrefix
        ? folderPath.slice(o.rootPrefix.length).replace(/^\/+/, "")
        : folderPath,
      depth,
      children: [],
      images,
      totalImages: 0,
      coverImages: [],
    };

    for (const child of folder.children) {
      if (child instanceof TFolder) {
        node.children.push(build(child, depth + 1));
      } else if (child instanceof TFile && isImageName(child.name, o.extensions)) {
        const entry: ImageEntry = {
          file: child,
          name: child.name,
          path: child.path,
          size: child.stat.size,
          mtime: child.stat.mtime,
          ctime: child.stat.ctime,
        };
        images.push(entry);
        flat.push(entry);
      }
    }

    node.children.sort((a, b) => o.compare(a.name, b.name));
    node.totalImages =
      images.length + node.children.reduce((sum, c) => sum + c.totalImages, 0);
    return node;
  };

  index.tree = build(o.root, 0);
  index.folderCount = folderCount;

  // Covers need the whole tree built first: a folder with no images of its own
  // borrows its first child's covers, and children are only ready once their
  // own subtrees are done.
  const attachCovers = (node: FolderNode): void => {
    for (const child of node.children) attachCovers(child);
    node.coverImages = (
      node.images.length > 0
        ? o.sortEntries(node.images, node.path)
        : node.children.flatMap((c) => c.coverImages)
    ).slice(0, MAX_STACK_LAYERS);
  };
  attachCovers(index.tree);

  return index;
}

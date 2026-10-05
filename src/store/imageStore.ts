/*
 * Read-only projection of the part of the vault this plugin manages.
 *
 * The vault stays the single source of truth — no file contents are ever
 * cached. What is cached is the *shape* of the tree: the walk, the per-folder
 * buckets and the sort order. Rendering one screen used to walk the whole
 * vault three times and allocate an `ImageEntry` per file each time; on a
 * library of a few thousand images that is tens of thousands of allocations
 * per repaint, and a repaint happens on every scroll tick.
 *
 * The cache key includes the configured root and extension list, so changing
 * either invalidates it without the settings code knowing this cache exists.
 */

import type { App } from "obsidian";
import { TFolder } from "obsidian";
import type { FolderNode, VaultGallerySettings, ImageEntry } from "../types";
import { BacklinkIndex } from "./backlinks";
import { createComparer, type Comparer } from "./comparer";
import { countExtensions } from "./stats";
import { sortImages } from "./sort";
import { buildTreeIndex } from "./tree";

export class ImageStore {
  private backlinks: BacklinkIndex;
  private compare: Comparer;

  private treeCache: FolderNode | null = null;
  private flatCache: ImageEntry[] = [];
  private folderCountCache = 0;
  private cacheKey: string | null = null;
  /** Separate from `treeCache !== null`: a missing root is a valid built state. */
  private built = false;
  private revision = 0;
  /**
   * Bumped whenever the reverse-link index is dropped. The grid's collect memo
   * keys on it, so a backlink refresh rebuilds the link-derived parts of the
   * item list without touching the (much more expensive) tree walk.
   */
  private linkRevision = 0;

  constructor(
    private app: App,
    private getSettings: () => VaultGallerySettings
  ) {
    this.compare = createComparer();
    this.backlinks = new BacklinkIndex(() => this.app.metadataCache.resolvedLinks);
  }

  /**
   * Bumped whenever the projected tree changes. Callers that memoise work
   * derived from the tree (the grid's item list, the folder tree's rows) use it
   * as part of their cache key, so a stale list is unrepresentable.
   */
  get generation(): number {
    this.ensureCache();
    return this.revision;
  }

  /** Drop the reverse-link index; call when the metadata cache resolves. */
  invalidateBacklinks(): void {
    this.backlinks.invalidate();
    this.linkRevision++;
  }

  /** Version of the backlink data; changes when `invalidateBacklinks` runs. */
  get linkGeneration(): number {
    return this.linkRevision;
  }

  /** Drop the tree projection; call when the vault's structure changes. */
  invalidateTree(): void {
    this.built = false;
    this.treeCache = null;
    this.flatCache = [];
    this.folderCountCache = 0;
    this.cacheKey = null;
  }

  /** Configured root, normalized to a vault-relative path with no slashes. */
  normalizeRoot(): string {
    return this.getSettings().rootPath.trim().replace(/^\/+|\/+$/g, "");
  }

  getRootFolder(): TFolder | null {
    const p = this.normalizeRoot();
    if (!p) return this.app.vault.getRoot();
    const f = this.app.vault.getAbstractFileByPath(p);
    return f instanceof TFolder ? f : null;
  }

  private currentKey(): string {
    return `${this.normalizeRoot()}\u0000${this.getSettings().imageExtensions.join(",")}`;
  }

  private ensureCache(): void {
    const key = this.currentKey();
    if (this.built && this.cacheKey === key) return;
    this.cacheKey = key;
    this.built = true;
    this.revision++;

    const index = buildTreeIndex({
      root: this.getRootFolder(),
      extensions: this.getSettings().imageExtensions,
      rootPrefix: this.normalizeRoot(),
      vaultName: this.app.vault.getName(),
      compare: this.compare,
      sortEntries: (entries, folderPath) => this.sortImages(entries, folderPath),
    });
    this.treeCache = index.tree;
    this.flatCache = index.flat;
    this.folderCountCache = index.folderCount;
  }

  /** Every image under the configured root, at any depth. Cached. */
  scanImages(): ImageEntry[] {
    this.ensureCache();
    return this.flatCache;
  }

  /** How many images are managed right now. Cheap enough for a timer. */
  imageCount(): number {
    return this.scanImages().length;
  }

  /** Number of folders at or below the root, including the root itself. */
  folderCount(): number {
    this.ensureCache();
    return this.folderCountCache;
  }

  /** Recursive folder tree with per-folder and subtree image counts. Cached. */
  buildTree(): FolderNode | null {
    this.ensureCache();
    return this.treeCache;
  }

  findNode(root: FolderNode, path: string): FolderNode | null {
    if (root.path === path) return root;
    for (const child of root.children) {
      const hit = this.findNode(child, path);
      if (hit) return hit;
    }
    return null;
  }

  /** Apply the configured sort to one folder's direct images. */
  sortImages(entries: ImageEntry[], folderPath: string): ImageEntry[] {
    return sortImages(entries, folderPath, this.getSettings(), this.compare);
  }

  /** Notes that embed or link this file. */
  getBacklinks(path: string): string[] {
    return this.backlinks.forFile(path);
  }

  /** Paths of every file the vault links to. */
  getReferencedPaths(): Set<string> {
    return this.backlinks.referencedPaths();
  }

  /** How many images are referenced, and how many are not, in one pass. */
  countReferenced(): { total: number; referenced: number; orphans: number } {
    return this.backlinks.countIn(this.scanImages());
  }

  /** Every folder at or below the configured root, sorted by path. */
  listFolders(): TFolder[] {
    const root = this.getRootFolder();
    if (!root) return [];
    const out: TFolder[] = [];
    const walk = (folder: TFolder) => {
      out.push(folder);
      for (const child of folder.children) {
        if (child instanceof TFolder) walk(child);
      }
    };
    walk(root);
    out.sort((a, b) => this.compare(a.path || "/", b.path || "/"));
    return out;
  }

  /** Extension histogram, for the export summary. */
  countByExtension(): Array<{ ext: string; count: number }> {
    return countExtensions(this.scanImages());
  }
}

import type { TFile } from "obsidian";

export type SortKey = "name" | "mtime" | "ctime" | "size" | "custom";

/** Which slice of the image set to display, by reference status. */
export type RefFilter = "all" | "unreferenced" | "referenced";

/**
 * How a non-square image fills its square thumbnail cell.
 *
 * `pad` shows the whole image over a blurred blow-up of itself — nothing is
 * ever hidden. `crop` fills the cell edge to edge, like a photo contact sheet,
 * which makes the grid read as an even mosaic at the cost of the margins.
 */
export type ThumbnailFit = "pad" | "crop";

/**
 * How much motion the interface is allowed to use.
 *
 * Every transition in styles.css is expressed with one of three duration
 * tokens; this setting is the single value those tokens hang off, so the whole
 * plugin can be made calmer from one place.
 *
 * `full` is the designed default, `reduced` keeps every cue at roughly
 * two-thirds the time, and `none` snaps instantly — for anyone who reads
 * animation as noise rather than polish.
 */
export type MotionLevel = "full" | "reduced" | "none";

export interface VaultGallerySettings {
  /** Vault-relative path of the folder this plugin manages. Empty string = whole vault. */
  rootPath: string;
  /** Lowercase extensions without the leading dot. */
  imageExtensions: string[];
  /** Thumbnail edge length in px; drives the grid column width. */
  thumbnailSize: number;
  /** How non-square images fill their square cell. */
  thumbnailFit: ThumbnailFit;
  /** How much animation the interface is allowed to use. */
  motion: MotionLevel;
  /** Render child folders as cards inside the grid. */
  showSubfolders: boolean;
  /** Sort folders before images (folders always rank above files otherwise too). */
  folderFirst: boolean;
  confirmDelete: boolean;
  sortKey: SortKey;
  sortAsc: boolean;
  /** Folder cards preview the first few images inside them as a stack. */
  folderPreview: boolean;
  /** Show a reference count pill on image cards, and highlight orphans. */
  showRefBadges: boolean;
  refFilter: RefFilter;
  /** Above this many cards in one view the grid switches to windowed rendering. */
  virtualThreshold: number;
  /** Folder shown the last time the view was open, so it reopens where you left off. */
  lastPath: string;
  /** folderPath -> ordered array of file names. Only folders you reordered appear here. */
  customOrders: Record<string, string[]>;
}

export const DEFAULT_SETTINGS: VaultGallerySettings = {
  rootPath: "",
  imageExtensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"],
  thumbnailSize: 148,
  thumbnailFit: "pad",
  motion: "full",
  showSubfolders: true,
  folderFirst: true,
  confirmDelete: true,
  sortKey: "name",
  sortAsc: true,
  folderPreview: true,
  showRefBadges: true,
  refFilter: "all",
  virtualThreshold: 300,
  lastPath: "",
  customOrders: {},
};

export interface ImageEntry {
  file: TFile;
  name: string;
  path: string;
  size: number;
  mtime: number;
  ctime: number;
}

export interface FolderNode {
  /** Vault-relative folder path. Empty string means the vault root. */
  path: string;
  name: string;
  /** Folder path relative to the configured root, for display. */
  relPath: string;
  depth: number;
  children: FolderNode[];
  /** Images sitting directly in this folder. */
  images: ImageEntry[];
  /** Images in this folder plus every descendant. */
  totalImages: number;
  /**
   * Up to three images to draw as the folder's cover pile. Falls back to the
   * descendants' covers, so a directory of directories still previews its
   * contents instead of showing a placeholder.
   */
  coverImages: ImageEntry[];
}

/** One rendered cell in the grid; the virtual scroller treats these uniformly. */
export type GridItem =
  | { kind: "folder"; node: FolderNode }
  | { kind: "image"; entry: ImageEntry };


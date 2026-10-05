/*
 * The image browser view.
 *
 * This file holds the *state* and nothing else: the behaviour lives in the
 * `*Part` objects assembled onto the prototype at the bottom. The split is by
 * responsibility, not by state, because every part reads the same grid, tree,
 * selection and drag fields — passing them around would be a fiction.
 *
 * The fields are public on purpose: the parts are plain objects installed onto
 * `VaultGalleryView.prototype`, and TypeScript will not let a `private` field
 * be reached through `ThisType<VaultGalleryView>` from outside the class body.
 */

import { ItemView } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type VaultGalleryPlugin from "../main";
import type { ImageStore } from "../store";
import type { FolderNode, GridItem, ImageEntry } from "../types";
import type { GridMetrics, GridWindow } from "../virtualGrid";
import { VIEW_TYPE_VAULT_GALLERY, type DragPayload } from "./viewTypes";
import { navPart, type NavPart } from "./nav";
import { toolbarPart, type ToolbarPart } from "./toolbar";
import { folderTreePart, type FolderTreePart } from "./folderTree";
import { breadcrumbPart, type BreadcrumbPart } from "./breadcrumb";
import { gridModelPart, type GridModelPart } from "./gridModel";
import { gridPaintPart, type GridPaintPart } from "./gridPaint";
import { cardPart, type CardPart } from "./cards";
import { selectionPart, type SelectionPart } from "./selection";
import { dragStatePart, type DragStatePart } from "./dragState";
import { menuPart, type MenuPart } from "./menus";
import { keyboardPart, type KeyboardPart } from "./keyboard";
import { pastePart, type PastePart } from "./paste";
import { clipboardImportPart, type ClipboardImportPart } from "./clipboardImport";
import { fileOpsPart, type FileOpsPart } from "./fileOps";
import { folderOpsPart, type FolderOpsPart } from "./folderOps";
import { lifecyclePart, type LifecyclePart } from "./viewLifecycle";

export { VIEW_TYPE_VAULT_GALLERY };

/** Cached measurement of the scroll container, refreshed on resize. */
export interface Viewport {
  width: number;
  height: number;
  /** False when the container had no box yet; the next paint re-measures. */
  valid: boolean;
}

export class VaultGalleryView extends ItemView {
  store: ImageStore;
  plugin: VaultGalleryPlugin;

  /** Vault-relative path of the folder currently shown in the grid. */
  currentPath = "";
  /** Lowercased search query; empty means "whole current folder". */
  query = "";
  expanded = new Set<string>();
  /** Vault paths of selected images. */
  selection = new Set<string>();
  /** Anchor for shift-click range selection. */
  anchor: string | null = null;
  /** Current drag, or null. */
  drag: DragPayload | null = null;
  /** Images in display order — the lightbox walks this. */
  visible: ImageEntry[] = [];
  /** Everything the grid renders, folders and images alike. */
  items: GridItem[] = [];
  /** Path -> grid index. Rebuilt whenever `items` changes. */
  pathIndex = new Map<string, number>();
  refCounts = new Map<string, number>();
  orphanCount = 0;

  // --- windowed rendering ---
  metrics: GridMetrics | null = null;
  renderedWindow: GridWindow | null = null;
  itemEls = new Map<number, HTMLElement>();
  viewport: Viewport = { width: 0, height: 0, valid: false };

  focusIndex = -1;

  treeEl!: HTMLElement;
  crumbEl!: HTMLElement;
  countEl!: HTMLElement;
  selBarEl!: HTMLElement;
  gridEl!: HTMLElement;
  wrapEl!: HTMLElement;
  searchEl: HTMLInputElement | null = null;

  /** The three top-level panes, keyed by their nav id. */
  paneEls: Record<string, HTMLElement> = {};
  navBtns = new Map<string, HTMLElement>();
  heatPaneEl: HTMLElement | null = null;
  settingsPaneEl: HTMLElement | null = null;
  activePane = "manage";
  /** Set when the heatmap is stale while another pane is on screen. */
  heatDirty = true;

  onScrollBound = () => this.schedulePaint();
  onResizeBound = () => this.repaintForSize();
  resizeObserver: ResizeObserver | null = null;
  paintFrame = 0;

  /** Search keystrokes coalesce into one grid render after this delay. */
  searchTimer = 0;
  /** Unsubscribes this view from the plugin's thumbnail-ready notifications. */
  unsubThumbs: (() => void) | null = null;

  /** Key of the item list currently in `this.items`, for the collect memo. */
  collectKey: string | null = null;
  /** Node the memo was built for; null means the last collect failed. */
  collectedNode: FolderNode | null = null;
  /** Everything the folder tree's rows are drawn from, for its own memo. */
  treeSignature: string | null = null;
  /** Selection the bar was last built for, so a no-op refresh cannot churn it. */
  selSignature: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: VaultGalleryPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = plugin.store;
  }
}

/*
 * Declaration merging, so the parts' methods are visible on the class type.
 *
 * Without this, `Object.assign` is opaque to the compiler: `ThisType<...>` in
 * `ViewPart` would resolve to a view without any of the methods the parts call
 * on each other, and every cross-part call would be an error. The interface is
 * the type the compiler sees; `Object.assign` below is what makes it true at
 * runtime.
 */
export interface VaultGalleryView
  extends LifecyclePart,
    NavPart,
    ToolbarPart,
    FolderTreePart,
    BreadcrumbPart,
    GridModelPart,
    GridPaintPart,
    CardPart,
    SelectionPart,
    DragStatePart,
    MenuPart,
    KeyboardPart,
    PastePart,
    ClipboardImportPart,
    FileOpsPart,
    FolderOpsPart {}

/*
 * Install the parts. Order is irrelevant — no part overwrites another — but
 * keeping it aligned with the file layout above makes the view easy to read
 * from the outside: identity, chrome, grid, interaction, mutations.
 */
Object.assign(
  VaultGalleryView.prototype,
  lifecyclePart,
  navPart,
  toolbarPart,
  folderTreePart,
  breadcrumbPart,
  gridModelPart,
  gridPaintPart,
  cardPart,
  selectionPart,
  dragStatePart,
  menuPart,
  keyboardPart,
  pastePart,
  clipboardImportPart,
  fileOpsPart,
  folderOpsPart
);

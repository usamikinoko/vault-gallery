import { Notice, Plugin } from "obsidian";
import type { VaultGallerySettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { ImageStore } from "./store";
import { ThumbCache } from "./thumbs";
import { VaultGalleryView, VIEW_TYPE_VAULT_GALLERY } from "./view/explorerView";
import { VaultGallerySettingTab } from "./settings";
import { HistoryStore } from "./historyStore";
import {
  ExportZipModal,
  collectExportEntries,
  exportInfoJson,
  exportLabelFor,
  libraryStats,
} from "./exporter";
import { fullPathOf } from "./utils";
import { clearVaultHooks, registerCommands, registerVaultHooks } from "./pluginCommands";

/** How often to refresh today's snapshot while the plugin is running. */
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

/** `process` exists in Electron's renderer but is not part of the DOM types. */
function platformName(): string {
  const p = (globalThis as { process?: { platform?: string } }).process;
  return p?.platform ?? "unknown";
}

export default class VaultGalleryPlugin extends Plugin {
  settings!: VaultGallerySettings;
  store!: ImageStore;
  history!: HistoryStore;
  /** Session thumbnail cache, shared by every open browser view. */
  thumbs!: ThumbCache;

  // Public because ./pluginCommands drives the debounced vault handling from
  // outside the class, the same way the view's parts drive the view.
  vaultTimer = 0;
  metaTimer = 0;
  private snapshotTimer = 0;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.applyMotion();
    this.store = new ImageStore(this.app, () => this.settings);
    this.thumbs = new ThumbCache({ app: this.app, edge: () => this.settings.thumbnailSize });
    this.history = new HistoryStore({
      app: this.app,
      dir: this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`,
    });
    await this.history.load();
    this.snapshotNow();

    this.registerView(VIEW_TYPE_VAULT_GALLERY, (leaf) => new VaultGalleryView(leaf, this));

    registerCommands(this);
    registerVaultHooks(this);

    this.addSettingTab(new VaultGallerySettingTab(this.app, this));

    // A snapshot is what makes the heatmap possible at all, so it also has to
    // be taken while nothing is happening.
    this.snapshotTimer = window.setInterval(() => this.snapshotNow(), SNAPSHOT_INTERVAL_MS);
  }

  onunload(): void {
    document.body.removeAttribute("data-ib-motion");
    clearVaultHooks(this);
    window.clearInterval(this.snapshotTimer);
    this.thumbs?.dispose();
    void this.history?.flush();
    this.history?.dispose();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_VAULT_GALLERY);
  }

  /** Record today's image total. Cheap: the store caches the walk. */
  snapshotNow(): void {
    if (!this.history.record(this.store.imageCount())) return;
    // Only the heatmap reads this, and redrawing it is cheap.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_GALLERY)) {
      if (leaf.view instanceof VaultGalleryView) leaf.view.onHistoryChanged();
    }
  }

  /**
   * Publish the motion preference as one attribute on <body>.
   *
   * The modals are appended to <body> rather than inside the view, so a
   * document-level attribute is the only place that reaches the grid, the
   * lightbox and the prompts without threading the setting through every
   * constructor in between. The matching CSS custom properties live at the top
   * of styles.css; nothing else in the plugin knows the value.
   */
  applyMotion(): void {
    document.body.setAttribute("data-ib-motion", this.settings.motion);
  }

  async activateView(pane?: string): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_VAULT_GALLERY);
    let leaf = existing[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_VAULT_GALLERY, active: true });
    }
    await workspace.revealLeaf(leaf);
    if (pane && leaf.view instanceof VaultGalleryView) leaf.view.showPane(pane);
  }

  /**
   * Keep every open view honest after the vault changed underneath it. This
   * goes through the view's own change hook rather than a bare re-render, so
   * the reverse-link cache is dropped and selections that point at files which
   * no longer exist are pruned — a rename made in the native explorer used to
   * leave a stale path selected here forever.
   */
  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_GALLERY)) {
      if (leaf.view instanceof VaultGalleryView) leaf.view.onVaultChanged();
    }
  }

  /**
   * The metadata cache finished a pass — backlinks moved, nothing else.
   *
   * This used to run the full `refreshViews` path, which invalidates and
   * rebuilds the whole vault walk. `resolved` fires after every note edit and
   * repeatedly at startup, so an open image browser turned each pause in
   * someone's writing into a re-walk of the entire library. Here the tree
   * cache stays warm and only the link-derived bits (pills, filters) repaint.
   */
  refreshLinks(): void {
    this.store.invalidateBacklinks();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_GALLERY)) {
      if (leaf.view instanceof VaultGalleryView) leaf.view.onLinksChanged();
    }
  }

  /**
   * The image browser the user is actually looking at: the active leaf when it
   * is one of ours, otherwise any open one. Commands that act on "the current
   * directory" need this rather than a fan-out to every open view.
   */
  activeView(): VaultGalleryView | null {
    const active = this.app.workspace.activeLeaf;
    if (active?.view instanceof VaultGalleryView) return active.view;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_GALLERY)) {
      if (leaf.view instanceof VaultGalleryView) return leaf.view;
    }
    return null;
  }

  /** Open the ZIP export dialog for a folder (defaults to the current one). */
  openZipExport(folderPath?: string): void {
    const view = this.activeView();
    const target = folderPath ?? view?.currentFolderPath() ?? this.store.normalizeRoot();
    const label = exportLabelFor(this.app.vault.getName(), target);
    const entries = collectExportEntries({
      images: this.store.scanImages(),
      folderPath: target,
      rootFolderName: label,
      toFullPath: (vaultPath) => fullPathOf(this.app, vaultPath),
    });
    if (entries.length === 0) {
      new Notice(`「${label}」下没有可导出的图片。`);
      return;
    }
    new ExportZipModal(this.app, this, target, label, entries).open();
  }

  /** Write the settings + heatmap JSON. */
  async exportInfoJson(): Promise<string | null> {
    const images = this.store.scanImages();
    const base =
      (this.app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.() ??
      this.app.vault.getName();
    const target = await exportInfoJson({
      pluginVersion: this.manifest.version,
      vaultName: this.app.vault.getName(),
      platform: platformName(),
      settings: this.settings,
      library: libraryStats(images, this.store.folderCount(), this.store.normalizeRoot()),
      history: this.history.snapshot,
      now: new Date(),
      fallbackDir: base,
    });
    if (target) new Notice(`已导出插件信息：${target}`, 6000);
    return target;
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<VaultGallerySettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyMotion();
  }
}

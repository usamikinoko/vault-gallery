/* Command-palette entries, and the ribbon button. */

import { TFile } from "obsidian";
import type VaultGalleryPlugin from "./main";
import { extOf } from "./utils";

/**
 * How long to wait for the dust to settle after a vault event.
 *
 * A bulk import of 500 images fires 500 "create" events. Without this, each one
 * rebuilt the tree and repainted the grid — 500 full passes over the library,
 * which is exactly the stutter the plugin is supposed to avoid.
 */
export const VAULT_DEBOUNCE_MS = 180;

/**
 * How long to wait before reacting to the metadata cache finishing a pass.
 *
 * `resolved` is the noisiest event in the app. It fires after every note edit,
 * after every file that lands in the vault, and repeatedly during startup — and
 * each one used to drop the reverse-link index and rebuild the whole tree
 * synchronously. That rebuild is invisible when it lands between keystrokes and
 * very visible when it lands inside one, which is exactly what "the plugin
 * stutters while I work" turns out to be. Nothing here is worth reacting to
 * faster than this.
 */
export const META_DEBOUNCE_MS = 600;

export function registerCommands(plugin: VaultGalleryPlugin): void {
  plugin.addRibbonIcon("images", "打开图像资源管理器", () => {
    void plugin.activateView();
  });

  plugin.addCommand({
    id: "open-vault-gallery",
    name: "打开图像资源管理器",
    callback: () => {
      void plugin.activateView();
    },
  });

  plugin.addCommand({
    id: "open-heatmap",
    name: "打开图像资源管理器（热力图）",
    callback: () => {
      void plugin.activateView("heatmap");
    },
  });

  plugin.addCommand({
    id: "open-settings-view",
    name: "打开图像资源管理器（插件设置）",
    callback: () => {
      void plugin.activateView("settings");
    },
  });

  plugin.addCommand({
    id: "open-unreferenced",
    name: "打开图像资源管理器（只看未引用）",
    callback: () => {
      plugin.settings.refFilter = "unreferenced";
      void plugin.saveSettings();
      void plugin.activateView().then(() => plugin.refreshViews());
    },
  });

  plugin.addCommand({
    id: "new-folder",
    name: "新建子目录",
    checkCallback: (checking) => {
      const view = plugin.activeView();
      if (!view) return false;
      if (!checking) view.promptCreateFolder();
      return true;
    },
  });

  plugin.addCommand({
    id: "paste-images",
    name: "粘贴剪贴板中的图片到当前目录",
    checkCallback: (checking) => {
      const view = plugin.activeView();
      if (!view) return false;
      if (!checking) void view.importFromSystemClipboard();
      return true;
    },
  });

  plugin.addCommand({
    id: "export-images-zip",
    name: "导出当前目录的图片为 ZIP",
    checkCallback: (checking) => {
      const view = plugin.activeView();
      if (!view) return false;
      if (!checking) view.exportCurrentFolder();
      return true;
    },
  });

  plugin.addCommand({
    id: "export-plugin-info",
    name: "导出插件信息（配置 + 热力图，JSON）",
    callback: () => {
      void plugin.exportInfoJson();
    },
  });
}

/**
 * Keep the grid in sync when the vault changes underneath it.
 *
 * Only the *repaint* is deferred. Dropping the tree cache is O(1) — it just
 * clears fields, and the expensive walk happens lazily on the next read — so it
 * happens immediately. Deferring it too would mean anything that reads the
 * store between the event and the timer (a newly created folder opened right
 * away, a command acting on the current folder) would read a tree that no
 * longer matches the vault. Correctness first, then throughput.
 */
export function registerVaultHooks(plugin: VaultGalleryPlugin): void {
  const onVaultChange = () => queueVaultChange(plugin);

  plugin.registerEvent(plugin.app.vault.on("create", onVaultChange));
  plugin.registerEvent(plugin.app.vault.on("delete", onVaultChange));
  plugin.registerEvent(plugin.app.vault.on("rename", onVaultChange));
  plugin.registerEvent(
    plugin.app.vault.on("modify", (f) => {
      // Only image edits can change anything we display, and only their size.
      if (f instanceof TFile && plugin.settings.imageExtensions.includes(extOf(f.name))) {
        onVaultChange();
      }
    })
  );
  plugin.registerEvent(
    plugin.app.metadataCache.on("resolved", () => {
      // Deferred rather than handled inline: see META_DEBOUNCE_MS. And it goes
      // through `refreshLinks`, not `refreshViews`: this event says backlinks
      // moved, not that the vault's structure did, so the tree cache stays warm
      // and only the link-derived UI repaints. Rebuilding the whole walk here
      // is what made an open image browser tax every pause in note editing.
      window.clearTimeout(plugin.metaTimer);
      plugin.metaTimer = window.setTimeout(() => {
        plugin.metaTimer = 0;
        plugin.refreshLinks();
      }, META_DEBOUNCE_MS);
    })
  );
}

export function queueVaultChange(plugin: VaultGalleryPlugin): void {
  plugin.store.invalidateTree();
  window.clearTimeout(plugin.vaultTimer);
  plugin.vaultTimer = window.setTimeout(() => {
    plugin.vaultTimer = 0;
    // Repaint first, snapshot second, and the order is not cosmetic.
    //
    // `refreshViews` ends in `refresh()`, which drops the cache and rebuilds it
    // once. `snapshotNow` then reads the image count out of that fresh cache for
    // free. Done the other way round — which is how this started — the snapshot
    // walked the whole vault, and then `refresh()` threw that walk away and did
    // it again: two full traversals of the library for every burst of events.
    plugin.refreshViews();
    plugin.snapshotNow();
  }, VAULT_DEBOUNCE_MS);
}

export function clearVaultHooks(plugin: VaultGalleryPlugin): void {
  window.clearTimeout(plugin.vaultTimer);
  window.clearTimeout(plugin.metaTimer);
}

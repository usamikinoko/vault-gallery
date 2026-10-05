import type { App } from "obsidian";
import { PluginSettingTab } from "obsidian";
import type VaultGalleryPlugin from "./main";
import { renderSettingsPanel } from "./settingsPanel";

/**
 * The plugin's entry in Obsidian's own settings dialog.
 *
 * It is a two-line delegation on purpose: the same panel is also rendered
 * inside the plugin's view (the 设置 tab of the navigation bar), and having two
 * renderers over one list is how the two places start disagreeing. Anything you
 * want to change about a setting belongs in `settingSpec.ts`.
 */
export class VaultGallerySettingTab extends PluginSettingTab {
  plugin: VaultGalleryPlugin;

  constructor(app: App, plugin: VaultGalleryPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "图像资源管理器" });
    renderSettingsPanel(containerEl, this.plugin);
  }
}

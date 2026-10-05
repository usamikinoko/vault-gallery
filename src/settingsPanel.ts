/*
 * One renderer for the settings, used twice.
 *
 * Obsidian's plugin tab and the plugin's own settings view show the same list
 * because they call the same function — the alternative (two renderers over one
 * data table) tends to drift the first time somebody adds a setting in a hurry.
 * The rows are Obsidian's own `Setting` component, so both places inherit the
 * theme's control styling for free.
 */

import { Notice, Setting } from "obsidian";
import type VaultGalleryPlugin from "./main";
import {
  SETTINGS_GROUPS,
  decodeSetting,
  defaultedSettings,
  encodeSetting,
  type ActionSpec,
  type SettingSpec,
} from "./settingSpec";

export interface PanelOptions {
  /** Extra class on the container, for spacing tweaks per host. */
  cls?: string;
}

/** Typing in a path field should not rescan the vault on every keystroke. */
const TEXT_DEBOUNCE_MS = 400;

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number) {
  let timer = 0;
  return (...args: Parameters<T>) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  };
}

export function renderSettingsPanel(
  container: HTMLElement,
  plugin: VaultGalleryPlugin,
  options: PanelOptions = {}
): void {
  container.empty();
  container.addClass("ib-settings");
  if (options.cls) container.addClass(options.cls);

  const commit = async (spec: SettingSpec, raw: string) => {
    const next = encodeSetting(spec, raw, plugin.settings);
    if ((plugin.settings[spec.key] as unknown) === next) return;
    (plugin.settings[spec.key] as unknown) = next;
    await plugin.saveSettings();
    plugin.refreshViews();
  };

  for (const group of SETTINGS_GROUPS) {
    const section = container.createDiv({ cls: "ib-settings-group" });
    section.createEl("h3", { cls: "ib-settings-title", text: group.title });
    if (group.hint) {
      section.createDiv({ cls: "ib-settings-hint", text: group.hint });
    }

    for (const spec of group.settings) {
      if (spec.visible && !spec.visible(plugin.settings)) continue;
      renderRow(section, plugin, spec, commit);
    }

    for (const action of group.actions ?? []) {
      renderAction(section, container, plugin, action);
    }
  }

  const stamp = container.createDiv({ cls: "ib-settings-stamp" });
  // Just the build stamp. This is the one screen the user opens when something
  // behaves oddly, and "which build are you on" is the first question any bug
  // report has to answer — the explanation of where the file lives is not.
  stamp.setText(`Vault Gallery v${plugin.manifest.version}`);
}

function renderRow(
  host: HTMLElement,
  plugin: VaultGalleryPlugin,
  spec: SettingSpec,
  commit: (spec: SettingSpec, raw: string) => void
): void {
  const setting = new Setting(host).setName(spec.name).setDesc(spec.desc);
  const value = plugin.settings[spec.key];
  const current = decodeSetting(spec, value);

  if (spec.control.kind === "toggle") {
    setting.addToggle((toggle) =>
      toggle.setValue(value === true).onChange((v) => commit(spec, String(v)))
    );
    return;
  }

  if (spec.control.kind === "slider") {
    const { min = 0, max = 100, step = 1 } = spec.control;
    setting.addSlider((slider) =>
      slider
        .setLimits(min, max, step)
        .setValue(Number(value))
        .setDynamicTooltip()
        // `input` fires while dragging so the value is visible immediately;
        // the write to disk waits for `change`, which fires once on release.
        .onChange((v) => commit(spec, String(v)))
    );
    return;
  }

  if (spec.control.kind === "dropdown") {
    setting.addDropdown((drop) => {
      for (const option of spec.control.options ?? []) {
        drop.addOption(option.value, option.label);
      }
      drop.setValue(current).onChange((v) => commit(spec, v));
    });
    return;
  }

  // Text: debounce so a rescan does not start on every keystroke.
  setting.addText((text) => {
    if (spec.control.placeholder) text.setPlaceholder(spec.control.placeholder);
    text.setValue(current);
    const fire = debounce(() => commit(spec, text.inputEl.value), TEXT_DEBOUNCE_MS);
    text.inputEl.addEventListener("input", () => fire());
    text.inputEl.addEventListener("blur", () => commit(spec, text.inputEl.value));
  });
}

function renderAction(
  host: HTMLElement,
  root: HTMLElement,
  plugin: VaultGalleryPlugin,
  action: ActionSpec
): void {
  const describe = (): string => {
    if (action.key !== "clearOrders") return action.desc;
    const count = Object.keys(plugin.settings.customOrders).length;
    return count > 0 ? `${count} 个目录有自定义顺序。` : "还没有自定义顺序。";
  };

  const setting = new Setting(host).setName(action.name).setDesc(describe());
  setting.addButton((button) => {
    button.setButtonText(action.button);
    if (action.warning) button.setWarning();
    button.onClick(async () => {
      if (action.key === "reset") {
        plugin.settings = defaultedSettings(plugin.settings);
        await plugin.saveSettings();
        plugin.refreshViews();
        renderSettingsPanel(root, plugin);
        new Notice("已恢复默认设置");
        return;
      }
      if (action.key === "clearOrders") {
        plugin.settings.customOrders = {};
        if (plugin.settings.sortKey === "custom") plugin.settings.sortKey = "name";
        await plugin.saveSettings();
        plugin.refreshViews();
        renderSettingsPanel(root, plugin);
        new Notice("已清空所有自定义排序");
      }
    });
  });
}

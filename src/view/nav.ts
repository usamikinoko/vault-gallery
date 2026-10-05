/*
 * The pane switcher.
 *
 * All three panes stay mounted and are shown/hidden with a class, so switching
 * back to the browser keeps its scroll position, selection and focus instead of
 * rebuilding them from the settings each time. A consequence worth knowing:
 * because `.ib-settings` *is* a pane, no component class may set `display` on
 * it — that would override `.ib-pane { display: none }` at equal specificity.
 */

import { setIcon } from "obsidian";
import { renderHeatmap } from "../heatmap";
import { renderSettingsPanel } from "../settingsPanel";
import type { ViewPart } from "./viewTypes";

interface PaneSpec {
  id: string;
  label: string;
  icon?: string;
  /** Draw the heatmap glyph by hand rather than borrowing from the icon set. */
  grid?: boolean;
}

/** A 3x3 block of squares is literally the heatmap, and cannot go missing. */
const HEAT_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<g fill="currentColor">' +
  '<rect x="1" y="1" width="4" height="4" rx="1"/>' +
  '<rect x="6" y="1" width="4" height="4" rx="1" opacity="0.55"/>' +
  '<rect x="11" y="1" width="4" height="4" rx="1"/>' +
  '<rect x="1" y="6" width="4" height="4" rx="1" opacity="0.55"/>' +
  '<rect x="6" y="6" width="4" height="4" rx="1"/>' +
  '<rect x="11" y="6" width="4" height="4" rx="1" opacity="0.55"/>' +
  '<rect x="1" y="11" width="4" height="4" rx="1"/>' +
  '<rect x="6" y="11" width="4" height="4" rx="1" opacity="0.55"/>' +
  '<rect x="11" y="11" width="4" height="4" rx="1"/>' +
  "</g></svg>";

export interface NavPart {
  buildNav(container: HTMLElement): void;
  /** Switch panes. Safe to call before `onOpen` finished, and idempotent. */
  showPane(id: string): void;
  /** Called by the plugin when a new daily snapshot landed. */
  onHistoryChanged(): void;
  renderHeatPane(): void;
  renderSettingsPane(): void;
}

export const navPart: ViewPart<NavPart> = {
  buildNav(container: HTMLElement): void {
    const nav = container.createDiv({ cls: "ib-nav" });
    nav.setAttr("role", "tablist");

    const panes: PaneSpec[] = [
      { id: "manage", label: "管理", icon: "images" },
      { id: "heatmap", label: "热力图", grid: true },
      { id: "settings", label: "设置", icon: "settings" },
    ];

    for (const pane of panes) {
      const btn = nav.createEl("button", { cls: "ib-nav-btn" });
      btn.setAttr("data-pane", pane.id);
      btn.setAttr("type", "button");
      btn.setAttr("role", "tab");

      const iconEl = btn.createSpan({ cls: "ib-nav-icon" });
      if (pane.icon) setIcon(iconEl, pane.icon);
      else if (pane.grid) iconEl.innerHTML = HEAT_ICON;

      btn.createSpan({ cls: "ib-nav-label", text: pane.label });
      btn.addEventListener("click", () => this.showPane(pane.id));
      this.navBtns.set(pane.id, btn);
    }
  },

  showPane(id: string): void {
    if (!this.paneEls[id]) return;
    this.activePane = id;

    for (const [key, el] of Object.entries(this.paneEls)) {
      el.toggleClass("is-active", key === id);
    }
    for (const [key, btn] of this.navBtns) {
      btn.toggleClass("is-active", key === id);
      btn.setAttr("aria-selected", key === id ? "true" : "false");
    }

    if (id !== "heatmap") {
      // Leaving the chart while the pointer is over a square: `display: none`
      // does not fire `mouseleave`, so the bubble would still be sitting there
      // the next time the tab is opened.
      this.heatPaneEl?.querySelector(".ib-heat-tip")?.classList.add("is-hidden");
    }

    if (id === "heatmap" && (this.heatDirty || this.heatPaneEl?.childElementCount === 0)) {
      this.renderHeatPane();
    }
    if (id === "settings") this.renderSettingsPane();
  },

  onHistoryChanged(): void {
    if (this.activePane === "heatmap") this.renderHeatPane();
    else this.heatDirty = true;
  },

  renderHeatPane(): void {
    if (!this.heatPaneEl) return;
    renderHeatmap(this.heatPaneEl, { history: this.plugin.history.snapshot });
    this.heatDirty = false;
  },

  renderSettingsPane(): void {
    if (!this.settingsPaneEl) return;
    renderSettingsPanel(this.settingsPaneEl, this.plugin);
  },
};

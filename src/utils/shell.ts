/*
 * Desktop-only file operations, reached through Electron.
 *
 * Neither the shell nor `getFullPath` is part of Obsidian's public API, so
 * every step is guarded and every failure has a visible fallback: a plugin
 * that cannot reveal a file in Explorer still has to keep working.
 */

import type { App } from "obsidian";
import { Notice } from "obsidian";
import { nodeRequire } from "../nodeRequire";

interface ElectronShell {
  showItemInFolder?: (fullPath: string) => void;
  openPath?: (fullPath: string) => Promise<string>;
}

function electronShell(): ElectronShell | null {
  try {
    return nodeRequire<{ shell?: ElectronShell } | null>("electron")?.shell ?? null;
  } catch {
    return null;
  }
}

/** Absolute OS path for a vault-relative path, or null if unavailable. */
export function fullPathOf(app: App, vaultPath: string): string | null {
  try {
    const adapter = app.vault.adapter as unknown as {
      getFullPath?: (p: string) => string;
    };
    return typeof adapter.getFullPath === "function"
      ? adapter.getFullPath(vaultPath)
      : null;
  } catch {
    return null;
  }
}

/** Reveal an absolute path in the OS file manager. False when it could not. */
export function revealFullPath(fullPath: string): boolean {
  const shell = electronShell();
  if (shell?.showItemInFolder) {
    shell.showItemInFolder(fullPath);
    return true;
  }
  return false;
}

/** Reveal a vault file in the OS file manager. */
export function revealInOS(app: App, vaultPath: string): void {
  const full = fullPathOf(app, vaultPath);
  if (full && revealFullPath(full)) return;
  new Notice("无法在系统资源管理器中定位该文件");
}

/** Hand a vault file to the OS default application. */
export function openWithOS(app: App, vaultPath: string): void {
  const full = fullPathOf(app, vaultPath);
  const shell = electronShell();
  if (full && shell?.openPath) {
    void shell.openPath(full);
    return;
  }
  new Notice("无法用系统默认应用打开该文件");
}

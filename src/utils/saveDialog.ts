/*
 * The native "where should this file go?" dialog.
 *
 * Electron's `remote` facade was removed from Electron itself (14+) and
 * re-homed in `@electron/remote`, which Obsidian initialises; which of the two
 * answers varies by build, so both spellings are tried. Callers must handle
 * "neither" without throwing — every export has a documented fallback path.
 */

import { joinFsPath, nodeRequire } from "../nodeRequire";

interface ElectronRemote {
  dialog?: { showSaveDialog?: (...args: unknown[]) => unknown };
  app?: { getPath?: (name: string) => string };
  getCurrentWindow?: () => unknown;
}

function electronRemote(): ElectronRemote | null {
  for (const name of ["@electron/remote", "electron"]) {
    try {
      const mod = nodeRequire<ElectronRemote & { remote?: ElectronRemote } | null>(name);
      if (!mod) continue;
      const candidate = name === "electron" ? mod.remote : mod;
      if (candidate?.dialog?.showSaveDialog) return candidate;
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

/** Whether a native file dialog can be opened at all on this installation. */
export function hasSaveDialog(): boolean {
  return electronRemote()?.dialog?.showSaveDialog !== undefined;
}

export type SavePathResult =
  | { status: "ok"; path: string }
  | { status: "cancelled" }
  /** No native dialog available; the caller must fall back. */
  | { status: "unavailable" };

export interface SaveDialogRequest {
  /** File name shown in the dialog, extension included. */
  defaultName: string;
  title?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/**
 * Ask the OS where to put a file.
 *
 * Defaults into the platform's downloads folder rather than the vault: an
 * export is by definition outside the vault's managed range, and dropping a
 * multi-hundred-megabyte archive into a synced folder is a surprise nobody
 * wants.
 */
export async function askSavePath(req: SaveDialogRequest): Promise<SavePathResult> {
  const remote = electronRemote();
  const dialog = remote?.dialog;
  if (!dialog?.showSaveDialog) return { status: "unavailable" };

  let defaultPath = req.defaultName;
  try {
    const downloads = remote?.app?.getPath?.("downloads");
    if (downloads) defaultPath = joinFsPath(downloads, req.defaultName);
  } catch {
    /* a bare file name is still a valid defaultPath */
  }

  const payload = {
    title: req.title ?? "选择保存位置",
    defaultPath,
    filters: req.filters,
    properties: ["createDirectory", "showOverwriteConfirmation"],
  };

  let win: unknown = null;
  try {
    win = remote?.getCurrentWindow?.() ?? null;
  } catch {
    win = null;
  }

  let raw: unknown;
  try {
    raw = win ? dialog.showSaveDialog(win, payload) : dialog.showSaveDialog(payload);
  } catch {
    // Passing a window Electron dislikes throws; retry without one.
    raw = dialog.showSaveDialog(payload);
  }

  const result = (await Promise.resolve(raw)) as
    | { canceled?: boolean; filePath?: string }
    | null
    | undefined;
  if (!result || result.canceled || !result.filePath) return { status: "cancelled" };
  return { status: "ok", path: result.filePath };
}

/*
 * Persistence for the snapshot history.
 *
 * Kept in its own file next to the plugin rather than inside `data.json`:
 * a snapshot is written on a timer and on every vault change, and rewriting the
 * settings file that often would churn a file Obsidian watches. Splitting them
 * also means a corrupt history cannot cost the user their settings.
 *
 * Writes are debounced, because a bulk import fires one vault event per file.
 */

import type { App } from "obsidian";
import {
  dateKey,
  pruneHistory,
  recordSnapshot,
  type SnapshotHistory,
} from "./history";

export const HISTORY_FILE = "history.json";

/** How long to wait after the last change before touching the disk. */
const SAVE_DEBOUNCE_MS = 2000;

export interface HistoryHost {
  app: App;
  /** Vault-relative plugin directory, e.g. `.obsidian/plugins/<id>`. */
  dir: string;
}

export function historyPathFor(dir: string): string {
  const cleaned = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${cleaned}/${HISTORY_FILE}`;
}

/**
 * Accept only the shape we wrote: `YYYY-MM-DD` keys mapped to non-negative
 * finite counts. Anything else is dropped rather than trusted — this file is
 * hand-editable and outlives plugin versions.
 *
 * The type check before the numeric one is not pedantry: `Number(null)` is 0
 * and `Number(true)` is 1 and `Number("")` is 0, so coercing first would turn
 * "no record for that day" into "the folder held nothing that day" — which is
 * precisely the distinction the heatmap exists to preserve.
 */
export function sanitizeHistory(value: unknown): SnapshotHistory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: SnapshotHistory = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (typeof raw !== "number" && typeof raw !== "string") continue;
    if (typeof raw === "string" && raw.trim() === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) continue;
    out[key] = Math.floor(n);
  }
  return out;
}

export class HistoryStore {
  private data: SnapshotHistory = {};
  private timer = 0;
  private pending = false;
  private disposed = false;
  private readonly path: string;

  constructor(private host: HistoryHost) {
    this.path = historyPathFor(host.dir);
  }

  get snapshot(): SnapshotHistory {
    return this.data;
  }

  get filePath(): string {
    return this.path;
  }

  async load(): Promise<void> {
    try {
      const raw = await this.host.app.vault.adapter.read(this.path);
      this.data = sanitizeHistory(JSON.parse(raw) as unknown);
    } catch {
      // Missing on first run, which is not an error worth reporting.
      this.data = {};
    }
  }

  /**
   * File today's total. Returns whether anything actually changed, so the
   * caller can skip repainting the heatmap when nothing did.
   */
  record(count: number, now: Date = new Date()): boolean {
    const key = dateKey(now);
    const changed = recordSnapshot(this.data, key, count);
    pruneHistory(this.data, key);
    if (changed) this.scheduleSave();
    return changed;
  }

  private scheduleSave(): void {
    if (this.disposed) return;
    this.pending = true;
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Write immediately. Safe to call when nothing is pending. */
  async flush(): Promise<void> {
    if (!this.pending) return;
    this.pending = false;
    try {
      await this.host.app.vault.adapter.write(
        this.path,
        JSON.stringify(this.data, null, 2)
      );
    } catch (err) {
      // Losing a snapshot is survivable; losing the whole plugin is not.
      console.error("[vault-gallery] could not save history", err);
      this.pending = true;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = 0;
  }
}

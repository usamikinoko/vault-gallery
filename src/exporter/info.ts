/*
 * The "export plugin info" flow: settings + library + heatmap as one JSON file.
 *
 * The payload is assembled from plain values rather than from the plugin, so
 * its shape can be asserted without an Obsidian runtime.
 */

import { Notice } from "obsidian";
import type { VaultGallerySettings } from "../types";
import type { SnapshotHistory } from "../history";
import { HEATMAP_DAYS, buildCalendar, summarize } from "../history";
import { describeSettings } from "../settingSpec";
import { joinFsPath, nodeRequire } from "../nodeRequire";
import { askSavePath, hasSaveDialog } from "../utils";
import type { LibraryStats } from "./stats";

export interface InfoPayload {
  meta: Record<string, string | number>;
  settings: {
    /** Human-readable, in settings-page order. */
    readable: Record<string, string>;
    /** Exactly what is stored in data.json. */
    raw: VaultGallerySettings;
  };
  library: LibraryStats;
  heatmap: {
    window: { days: number; from: string; to: string };
    summary: {
      recordedDays: number;
      added: number;
      removed: number;
      net: number;
      current: number | null;
      firstDate: string | null;
      lastDate: string | null;
      peak: number;
    };
    /** Every day in the window; `count` is null where nothing was recorded. */
    days: Array<{ date: string; count: number | null; delta: number | null; level: number }>;
  };
}

export interface InfoExportRequest {
  pluginVersion: string;
  vaultName: string;
  platform: string;
  settings: VaultGallerySettings;
  library: LibraryStats;
  history: SnapshotHistory;
  now: Date;
  /** Used when no native dialog is available. */
  fallbackDir: string;
}

export function buildInfoPayload(opts: {
  pluginVersion: string;
  vaultName: string;
  platform: string;
  settings: VaultGallerySettings;
  library: LibraryStats;
  history: SnapshotHistory;
  now: Date;
}): InfoPayload {
  const now = opts.now;
  const cal = buildCalendar(opts.history, { today: now });
  const stats = summarize(cal);
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours()
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const days = cal.days.filter((d) => d.inRange);

  return {
    meta: {
      plugin: "Vault Gallery",
      pluginId: "vault-gallery",
      pluginVersion: opts.pluginVersion,
      schemaVersion: 1,
      exportedAt: now.toISOString(),
      exportedAtLocal: local,
      vault: opts.vaultName,
      platform: opts.platform,
    },
    settings: {
      readable: describeSettings(opts.settings),
      raw: JSON.parse(JSON.stringify(opts.settings)) as VaultGallerySettings,
    },
    library: opts.library,
    heatmap: {
      window: {
        days: HEATMAP_DAYS,
        from: days.length ? days[0].date : "",
        to: days.length ? days[days.length - 1].date : "",
      },
      summary: {
        recordedDays: stats.recordedDays,
        added: stats.added,
        removed: stats.removed,
        net: stats.net,
        current: stats.current,
        firstDate: stats.firstDate,
        lastDate: stats.lastDate,
        peak: cal.peak,
      },
      days: days.map((d) => ({
        date: d.date,
        count: d.count,
        delta: d.delta,
        level: d.level,
      })),
    },
  };
}

/** Default file name for the info export. */
export function infoFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `vault-gallery-info-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
}

/** Ask, build, write, report. Returns the path written, or null. */
export async function exportInfoJson(req: InfoExportRequest): Promise<string | null> {
  const payload = buildInfoPayload(req);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const name = infoFileName(req.now);

  let target: string | null = null;
  if (hasSaveDialog()) {
    const answer = await askSavePath({
      defaultName: name,
      title: "导出插件信息",
      filters: [{ name: "JSON 文件", extensions: ["json"] }],
    });
    if (answer.status === "cancelled") return null;
    if (answer.status === "ok") target = answer.path;
  }
  if (!target) {
    target = joinFsPath(req.fallbackDir, name);
    // Say where it went, prominently: the user did not choose this location.
    new Notice(`系统保存对话框不可用，已写入 vault：${target}`, 8000);
  }

  try {
    const fs = nodeRequire<{
      promises: { writeFile(p: string, data: string, enc: string): Promise<void> };
    }>("fs");
    await fs.promises.writeFile(target, text, "utf8");
  } catch (err) {
    console.error("[vault-gallery] info export failed", err);
    new Notice(`导出失败：${name} —— ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  return target;
}

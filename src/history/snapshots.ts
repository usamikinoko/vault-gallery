/*
 * The snapshot ledger: one image total per day, and the change between days.
 *
 * Obsidian can tell you when a file was created or modified, but nothing about
 * a file that no longer exists, so net daily change cannot be reconstructed
 * after the fact — it can only be observed. Everything here is a pure function
 * over the snapshot map so it can be exercised without a vault.
 */

import { parseKey, shiftKey } from "./dates";

/** `YYYY-MM-DD` (local time) -> total image count observed on that day. */
export type SnapshotHistory = Record<string, number>;

/** How many days of history to keep. 400 leaves margin over the 365 shown. */
export const HISTORY_KEEP_DAYS = 400;

/**
 * File today's total. The last observation of a day wins: the value means
 * "what the folder held at the end of that day", so opening Obsidian twice
 * today does not create two records.
 */
export function recordSnapshot(
  history: SnapshotHistory,
  key: string,
  count: number
): boolean {
  if (!parseKey(key)) return false;
  if (history[key] === count) return false;
  history[key] = count;
  return true;
}

/** Drop records older than the retention window, so the file cannot grow forever. */
export function pruneHistory(history: SnapshotHistory, todayKey: string): number {
  const cutoff = shiftKey(todayKey, -HISTORY_KEEP_DAYS);
  let removed = 0;
  for (const key of Object.keys(history)) {
    if (key < cutoff) {
      delete history[key];
      removed++;
    }
  }
  return removed;
}

/** Recorded days in ascending order. */
export function recordedKeys(history: SnapshotHistory): string[] {
  return Object.keys(history)
    .filter((k) => parseKey(k) !== null && Number.isFinite(history[k]))
    .sort();
}

/**
 * Change for every recorded day: `count(day) - count(previous recorded day)`.
 *
 * Gaps are attributed forward — if the vault was unopened for a week, the whole
 * week's movement lands on the first day back, which keeps the sum of the
 * deltas equal to the real change. The earliest record has no predecessor, so
 * its change is `null` (unknown) rather than 0 (which would claim nothing
 * happened).
 */
export function computeDeltas(history: SnapshotHistory): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const keys = recordedKeys(history);
  for (let i = 0; i < keys.length; i++) {
    out.set(keys[i], i === 0 ? null : history[keys[i]] - history[keys[i - 1]]);
  }
  return out;
}

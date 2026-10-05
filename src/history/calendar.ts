/*
 * Laying the snapshot ledger out as a GitHub-style year grid, plus the summary
 * line under it. Pure: takes a history map, returns a structure.
 */

import { dateKey, parseKey, startOfDay, startOfWeek } from "./dates";
import { computeDeltas, type SnapshotHistory } from "./snapshots";

/** Days drawn in the heatmap, GitHub-style "past year". */
export const HEATMAP_DAYS = 365;

export interface HeatDay {
  date: string;
  /** Total images observed that day, or null when there is no record. */
  count: number | null;
  /** Change against the previous recorded day; null when unknown. */
  delta: number | null;
  /** 0 = no change, 1..4 = magnitude bin. */
  level: number;
  /** False for padding days before the window or after today. */
  inRange: boolean;
  isToday: boolean;
}

export interface HeatWeek {
  /** `YYYY-MM-DD` of this column's Sunday. */
  start: string;
  /** Exactly 7 entries, Sunday first. */
  days: HeatDay[];
  /** Month to print above this column, or null when it needs no label. */
  monthLabel: string | null;
}

export interface HeatCalendar {
  weeks: HeatWeek[];
  days: HeatDay[];
  /** Largest absolute change seen in the window. */
  peak: number;
  /** Days in the window that carry a record. */
  recorded: number;
}

const MONTHS = [
  "1月", "2月", "3月", "4月", "5月", "6月",
  "7月", "8月", "9月", "10月", "11月", "12月",
];

/**
 * Bin magnitudes into four steps, with thresholds at the 25th, 50th and 75th
 * percentile of the *distinct* non-zero values.
 *
 * Distinct rather than every observation: with a year of "+0/+1/+1/+20" days,
 * raw percentiles collapse onto 1 and every real change renders identically.
 * And when the whole year holds fewer than four distinct magnitudes, the
 * quartiles collapse *entirely* — a young history or a quiet one would paint
 * every change the palest shade. There the thresholds scale off the peak
 * instead: the biggest change seen is the darkest cell, the rest spread below
 * it, so sparse data still produces visible contrast.
 */
export function levelThresholds(absDeltas: number[]): number[] {
  const distinct = [...new Set(absDeltas.filter((v) => v > 0))].sort((a, b) => a - b);
  if (distinct.length === 0) return [];
  if (distinct.length < 4) {
    const max = distinct[distinct.length - 1];
    return [0.25, 0.5, 0.75].map((f) => max * f);
  }
  const at = (p: number) =>
    distinct[Math.min(distinct.length - 1, Math.floor(p * distinct.length))];
  return [at(0.25), at(0.5), at(0.75)];
}

/**
 * `>=` on purpose: the top threshold is allowed to equal the peak (with four
 * distinct values the 75th percentile *is* the maximum), and the biggest change
 * must always reach the deepest bin.
 */
export function levelOf(magnitude: number, thresholds: number[]): number {
  if (!(magnitude > 0)) return 0;
  let level = 1;
  for (const t of thresholds) if (magnitude >= t) level++;
  return Math.min(4, level);
}

export interface CalendarOptions {
  /** Last day in the window. Defaults to today. */
  today?: Date;
  /** Length of the window in days. */
  days?: number;
}

/**
 * Lay the history out as GitHub does: columns of seven days, Sunday first, the
 * last column ending on today. The leading column may start before the window,
 * which is why cells carry `inRange`.
 */
export function buildCalendar(
  history: SnapshotHistory,
  options: CalendarOptions = {}
): HeatCalendar {
  const today = startOfDay(options.today ?? new Date());
  const span = Math.max(7, options.days ?? HEATMAP_DAYS);
  const todayKey = dateKey(today);
  const windowStart = startOfDay(today);
  windowStart.setDate(windowStart.getDate() - (span - 1));

  const gridStart = startOfWeek(windowStart);
  const gridEnd = startOfWeek(today);
  gridEnd.setDate(gridEnd.getDate() + 6);

  const deltas = computeDeltas(history);

  // Two passes: build the raw days, collect magnitudes, then bin.
  const raw: HeatDay[] = [];
  const cursor = new Date(gridStart);
  while (cursor.getTime() <= gridEnd.getTime()) {
    const key = dateKey(cursor);
    const inRange =
      cursor.getTime() >= windowStart.getTime() && cursor.getTime() <= today.getTime();
    const has = Object.prototype.hasOwnProperty.call(history, key);
    raw.push({
      date: key,
      count: has ? history[key] : null,
      delta: has ? (deltas.get(key) ?? null) : null,
      level: 0,
      inRange,
      isToday: key === todayKey,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  const magnitudes = raw
    .filter((d) => d.inRange && d.delta !== null)
    .map((d) => Math.abs(d.delta as number));
  const thresholds = levelThresholds(magnitudes);
  for (const d of raw) {
    d.level = d.delta === null ? 0 : levelOf(Math.abs(d.delta), thresholds);
  }

  const weeks: HeatWeek[] = [];
  for (let i = 0; i < raw.length; i += 7) {
    const days = raw.slice(i, i + 7);
    if (days.length < 7) break;
    weeks.push({ start: days[0].date, days, monthLabel: null });
  }

  // Label the first column whose week *contains* the 1st of a month, and never
  // within two columns of the previous label — short months otherwise produce
  // two labels on top of each other.
  let lastLabelAt = -99;
  for (let i = 0; i < weeks.length; i++) {
    const firstOfMonth = weeks[i].days.find((d) => parseKey(d.date)!.getDate() === 1);
    if (!firstOfMonth || i - lastLabelAt < 3) continue;
    weeks[i].monthLabel = MONTHS[parseKey(firstOfMonth.date)!.getMonth()];
    lastLabelAt = i;
  }
  // The label needs somewhere to sit; if the opening column carries one, drop
  // it rather than let it hang off the left edge of the scroller.
  if (weeks.length > 0 && weeks[0].monthLabel) {
    const nextLabel = weeks.findIndex((w, i) => i > 0 && w.monthLabel !== null);
    weeks[0].monthLabel = nextLabel >= 3 ? weeks[0].monthLabel : null;
  }

  return {
    weeks,
    days: raw,
    peak: magnitudes.length ? Math.max(...magnitudes) : 0,
    recorded: raw.filter((d) => d.inRange && d.count !== null).length,
  };
}

export interface HistorySummary {
  /** Days carrying a record inside the window. */
  recordedDays: number;
  added: number;
  removed: number;
  net: number;
  /** Newest recorded total, or null. */
  current: number | null;
  firstDate: string | null;
  lastDate: string | null;
}

/** Totals over the calendar window, for the line under the heatmap. */
export function summarize(cal: HeatCalendar): HistorySummary {
  let added = 0;
  let removed = 0;
  let recordedDays = 0;
  let current: number | null = null;
  let firstDate: string | null = null;
  let lastDate: string | null = null;

  for (const d of cal.days) {
    if (!d.inRange || d.count === null) continue;
    recordedDays++;
    if (firstDate === null) firstDate = d.date;
    lastDate = d.date;
    current = d.count;
    if (d.delta !== null && d.delta > 0) added += d.delta;
    if (d.delta !== null && d.delta < 0) removed += -d.delta;
  }

  return { recordedDays, added, removed, net: added - removed, current, firstDate, lastDate };
}

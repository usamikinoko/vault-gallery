/*
 * Local-calendar date keys.
 *
 * Deliberately not `toISOString()`: that is UTC, and a snapshot taken at 01:00
 * local would be filed under the previous day.
 */

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/** Local-time `YYYY-MM-DD`. */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Midnight local time for a `YYYY-MM-DD` key. Invalid keys yield null. */
export function parseKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Sunday-based week start, matching the GitHub grid's row order. */
export function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  s.setDate(s.getDate() - s.getDay());
  return s;
}

export function shiftKey(key: string, days: number): string {
  const d = parseKey(key);
  if (!d) return key;
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function dayDelta(a: string, b: string): number {
  const da = parseKey(a);
  const db = parseKey(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

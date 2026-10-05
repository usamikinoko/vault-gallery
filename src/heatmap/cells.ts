/* One day cell: how it looks, and the three lines the hover bubble shows. */

import type { HeatDay } from "../history";

export const WEEKDAY_LABELS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** Visual class of a day. Kept as data attributes so the colour ramp lives in CSS. */
export function appearanceOf(day: HeatDay): { dir: string; level: number } {
  if (day.count === null) return { dir: "none", level: 0 };
  if (day.delta === null) return { dir: "base", level: 0 };
  if (day.delta > 0) return { dir: "up", level: day.level };
  if (day.delta < 0) return { dir: "down", level: day.level };
  return { dir: "flat", level: 0 };
}

/** The three lines the hover bubble shows, also used as the aria-label. */
export function describeDay(
  day: HeatDay,
  opts: { today?: string } = {}
): { date: string; change: string; total: string } {
  const date = day.isToday && opts.today ? `${day.date}（${opts.today}）` : day.date;
  if (day.count === null) return { date, change: "无记录", total: "" };
  if (day.delta === null) return { date, change: "基线", total: `共 ${day.count} 张` };
  if (day.delta === 0) return { date, change: "无变化", total: `共 ${day.count} 张` };
  const word = day.delta > 0 ? "新增" : "减少";
  return {
    date,
    change: `${word} ${Math.abs(day.delta)} 张`,
    total: `共 ${day.count} 张`,
  };
}

/**
 * Build one cell. Its bubble text is baked onto the node: the alternative is a
 * lookup table or a closure per cell (371 of them), and the text is three
 * short strings.
 */
export function makeCell(day: HeatDay, rowIndex: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "ib-heat-cell";
  if (!day.inRange) el.classList.add("is-out");
  if (day.isToday) el.classList.add("is-today");

  const { dir, level } = appearanceOf(day);
  el.setAttr("data-date", day.date);
  el.setAttr("data-row", String(rowIndex));
  el.setAttr("data-dir", dir);
  el.setAttr("data-level", String(level));

  const text = describeDay(day, { today: "今天" });
  el.setAttr("data-tip-date", text.date);
  el.setAttr("data-tip-change", text.change);
  el.setAttr("data-tip-total", text.total);
  el.setAttr("aria-label", [text.date, text.change, text.total].filter(Boolean).join(" · "));
  return el;
}

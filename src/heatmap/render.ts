/*
 * GitHub-style contribution graph for image counts: 53 columns of seven days,
 * Sunday first. Two departures from GitHub, both because the data differs:
 *  - Colour encodes *signed* change — green grew, red shrank.
 *  - "Never observed" is drawn differently from "nothing changed": the vault is
 *    not always open, and conflating the two would be a lie the chart tells on
 *    its own.
 */

import type { HeatCalendar, SnapshotHistory } from "../history";
import { buildCalendar, summarize } from "../history";
import { WEEKDAY_LABELS, makeCell } from "./cells";
import { attachTooltip } from "./tooltip";

export interface HeatmapOptions {
  history: SnapshotHistory;
  today?: Date;
}

export function renderHeatmap(
  container: HTMLElement,
  opts: HeatmapOptions
): HeatCalendar {
  const cal = buildCalendar(opts.history, { today: opts.today });

  container.empty();
  container.addClass("ib-heat");
  container.setAttr("data-ib-heat-version", "1");

  buildHead(container, cal, summarize(cal));
  buildGrid(container, cal);
  buildFoot(container);
  attachTooltip(container);

  return cal;
}

function buildHead(
  container: HTMLElement,
  cal: HeatCalendar,
  stats: ReturnType<typeof summarize>
): void {
  const head = container.createDiv({ cls: "ib-heat-head" });

  const summary = head.createDiv({ cls: "ib-heat-summary" });
  summary.createDiv({
    cls: "ib-heat-big",
    text: stats.current === null ? "—" : String(stats.current),
  });
  summary.createDiv({
    cls: "ib-heat-big-label",
    text: stats.current === null ? "尚无快照" : "当前图片总数",
  });

  const facts = head.createDiv({ cls: "ib-heat-facts" });
  const fact = (label: string, value: string, cls = "") => {
    const row = facts.createDiv({ cls: "ib-heat-fact" });
    row.createSpan({ cls: "ib-heat-fact-label", text: label });
    row.createSpan({ cls: `ib-heat-fact-value ${cls}`.trim(), text: value });
  };
  fact("近 365 天", `+${stats.added} / −${stats.removed}`);
  fact(
    "净变化",
    `${stats.net < 0 ? "−" : "+"}${Math.abs(stats.net)}`,
    stats.net < 0 ? "is-down" : "is-up"
  );
  fact("有记录", `${stats.recordedDays} 天`);
  fact("单日峰值", cal.peak > 0 ? `±${cal.peak}` : "—");

  if (stats.recordedDays === 0) {
    container
      .createDiv({ cls: "ib-heat-note" })
      .setText("还没有快照，从今天起开始累积。");
  }
}

function buildGrid(container: HTMLElement, cal: HeatCalendar): void {
  const scroller = container.createDiv({ cls: "ib-heat-scroll" });
  const body = scroller.createDiv({ cls: "ib-heat-body" });

  const months = body.createDiv({ cls: "ib-heat-months" });
  const weekdays = body.createDiv({ cls: "ib-heat-weekdays" });
  const cells = body.createDiv({ cls: "ib-heat-cells" });

  // Sunday-first rows; GitHub labels Mon / Wed / Fri and leaves the rest blank.
  // `grid-row` is 1-based, so row index n is placed at n + 1.
  for (const rowIndex of [1, 3, 5]) {
    const el = weekdays.createDiv({
      cls: "ib-heat-weekday",
      text: WEEKDAY_LABELS[rowIndex],
    });
    el.style.gridRow = String(rowIndex + 1);
  }

  for (const week of cal.weeks) {
    const label = months.createDiv({ cls: "ib-heat-month" });
    if (week.monthLabel) label.setText(week.monthLabel);
    else label.addClass("is-blank");

    week.days.forEach((day, rowIndex) => {
      cells.appendChild(makeCell(day, rowIndex));
    });
  }
}

function buildFoot(container: HTMLElement): void {
  const foot = container.createDiv({ cls: "ib-heat-foot" });
  // Short enough to read at a glance and nothing more. The colour ramp is
  // labelled 减少 / 增加 at its two ends, so the only thing left worth a word
  // is the two marks that are not colours.
  foot.createSpan({
    cls: "ib-heat-foot-note",
    text: "斜纹=未记录 · 空心=首条基线",
  });

  const legend = foot.createDiv({ cls: "ib-heat-legend" });
  const swatch = (dir: string, level: number, title: string) => {
    const el = legend.createDiv({ cls: "ib-heat-cell is-legend" });
    el.setAttr("data-dir", dir);
    el.setAttr("data-level", String(level));
    el.setAttr("title", title);
  };

  // The increasing ramp reads left-to-right as 增加; the decreasing ramp is the
  // same four steps reversed, so it sits to the left of it. The two end labels
  // double as the separator between the runs, which is why no rule is drawn
  // between them: a separator next to a word that already divides the two
  // directions would be one mark too many.
  legend.createSpan({ cls: "ib-heat-legend-label", text: "减少" });
  for (let level = 4; level >= 1; level--) {
    swatch("down", level, `减少（第 ${level} 档）`);
  }
  legend.createSpan({ cls: "ib-heat-legend-label", text: "增加" });
  for (let level = 1; level <= 4; level++) {
    swatch("up", level, `增加（第 ${level} 档）`);
  }
}

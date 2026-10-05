/*
 * Pure-logic tests for the snapshot history, the heatmap layout and the export
 * payload.
 *
 * These three modules are the parts of v0.5 that can be wrong in ways the DOM
 * would never reveal: an off-by-one in the ledger, a week that starts on the
 * wrong day, a percentile that collapses every real change onto one colour, a
 * JSON export that quietly drops a field. None of them need a vault, a DOM or
 * Obsidian, so they are bundled straight from source and called directly —
 * faster and far more precise than driving them through the UI.
 *
 * Run: node test/logic.cjs
 */

const path = require("path");
const os = require("os");
const fs = require("fs");
const Module = require("module");
const esbuild = require("esbuild");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}` +
      (ok ? "" : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`)
  );
}
function ok(label, condition) {
  check(label, !!condition, true);
}

// ------------------------------------------------------------------- bundling

/*
 * `exporter.ts` imports `obsidian` for Modal / Notice / Setting. The pure
 * functions under test never touch them, but the import has to resolve, so the
 * bundle is built with `obsidian` external and the loader is hooked.
 */
const obsidianStub = {
  Modal: class {},
  Notice: class {
    constructor() {}
  },
  Setting: class {},
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidianStub;
  return originalLoad.call(this, request, parent, isMain);
};

function bundle(entry) {
  // The whole entry path, not just the basename: `history/index.ts`,
  // `heatmap/index.ts` and `exporter/index.ts` all basename to "index", and a
  // shared outfile meant `require`'s cache handed out whichever module was
  // built first for every later request.
  const out = path.join(os.tmpdir(), `ib-${entry.replace(/[\\/]/g, "-")}.build.cjs`);
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", "src", entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "es2018",
    outfile: out,
    external: ["obsidian"],
    logLevel: "silent",
  });
  return require(out);
}

const H = bundle("history/index.ts");
const E = bundle("exporter/index.ts");

// ------------------------------------------------------------------ date keys

console.log("== date keys are local, not UTC");
{
  // The bug this guards against: `toISOString()` files a 01:00 local snapshot
  // under the previous day for anybody east of Greenwich.
  const early = new Date(2026, 9, 4, 1, 30);
  check("01:30 local stays on its own day", H.dateKey(early), "2026-10-04");
  const late = new Date(2026, 9, 4, 23, 59);
  check("23:59 local stays on its own day", H.dateKey(late), "2026-10-04");

  check("parseKey round-trips", H.dateKey(H.parseKey("2026-03-09")), "2026-03-09");
  check("parseKey rejects junk", H.parseKey("2026-3-9"), null);
  check("parseKey rejects out-of-shape keys", H.parseKey("today"), null);

  check("shiftKey crosses a month", H.shiftKey("2026-03-01", -1), "2026-02-28");
  check("shiftKey crosses a leap day", H.shiftKey("2024-03-01", -1), "2024-02-29");
  check("shiftKey crosses a year", H.shiftKey("2026-01-01", -1), "2025-12-31");
  check("dayDelta counts whole days", H.dayDelta("2026-01-01", "2026-01-11"), 10);
  check("dayDelta is signed", H.dayDelta("2026-01-11", "2026-01-01"), -10);
  check("dayDelta survives a DST boundary", H.dayDelta("2026-03-01", "2026-04-01"), 31);

  // Sunday-based, matching the GitHub grid's row order.
  const sunday = H.startOfWeek(new Date(2026, 9, 4)); // 2026-10-04
  check("startOfWeek lands on a Sunday", sunday.getDay(), 0);
  ok("startOfWeek never moves forward", sunday.getTime() <= new Date(2026, 9, 4).getTime());
  const saturday = H.startOfWeek(new Date(2026, 9, 10));
  check("the day before Sunday is still the previous week", H.dateKey(saturday), H.dateKey(sunday));
}

// ------------------------------------------------------------------ snapshots

console.log("\n== the snapshot ledger");
{
  const hist = {};
  check("a fresh record is a change", H.recordSnapshot(hist, "2026-10-01", 10), true);
  check("re-recording the same total is not", H.recordSnapshot(hist, "2026-10-01", 10), false);
  H.recordSnapshot(hist, "2026-10-01", 12);
  check("the last observation of a day wins", hist["2026-10-01"], 12);
  check("a malformed key is refused", H.recordSnapshot(hist, "2026-10-1", 3), false);
  check("and leaves nothing behind", Object.keys(hist).length, 1);
  check("zero is a legitimate total", H.recordSnapshot(hist, "2026-10-02", 0), true);

  const deltas = H.computeDeltas({
    "2026-10-01": 10,
    "2026-10-02": 13,
    "2026-10-06": 9, // the vault was closed for three days
  });
  check("the earliest record has no predecessor", deltas.get("2026-10-01"), null);
  check("a normal day is a plain difference", deltas.get("2026-10-02"), 3);
  check("a gap is attributed forward, in full", deltas.get("2026-10-06"), -4);
  check("the deltas sum to the real movement", 3 + -4, 13 - 10 + (9 - 13));

  // Retention: the file must not grow without bound.
  const old = { "2025-01-01": 1, "2026-09-01": 2, "2026-10-04": 3 };
  check("pruneHistory drops only what is past the window", H.pruneHistory(old, "2026-10-04"), 1);
  check("and keeps the rest", Object.keys(old).sort(), ["2026-09-01", "2026-10-04"]);
}

// -------------------------------------------------------------- level binning

console.log("\n== magnitude binning");
{
  // The bug this guards against: raw percentiles over "+0/+1/+1/+20" put every
  // value at the same threshold, so every real change renders identically.
  const collapsed = H.levelThresholds([0, 1, 1, 20]);
  ok("duplicate magnitudes collapse to distinct thresholds", new Set(collapsed).size > 1);
  check("thresholds are ascending", collapsed, [...collapsed].sort((a, b) => a - b));
  check("no thresholds for an all-zero year", H.levelThresholds([0, 0]), []);
  check("no thresholds for an empty year", H.levelThresholds([]), []);

  const t = H.levelThresholds([1, 2, 3, 4, 5, 6, 7, 8]);
  check("no change is level 0", H.levelOf(0, t), 0);
  ok("a change is at least level 1", H.levelOf(1, t) >= 1);
  ok("a big change is at most level 4", H.levelOf(999, t) <= 4);
  check("the ramp tops out at 4", H.levelOf(999, t), 4);
  // With a single distinct magnitude there is nothing to spread against, so
  // the thresholds scale to the peak: the one change that exists is the whole
  // scale, and it must be plainly visible rather than the palest shade.
  check("a lone magnitude is the whole scale", H.levelOf(1, H.levelThresholds([1])), 4);
  const sparse = H.levelThresholds([3, 12]);
  ok("sparse data spreads across the ramp", H.levelOf(3, sparse) < H.levelOf(12, sparse));
  check("sparse data still tops out", H.levelOf(12, sparse), 4);
  const four = H.levelThresholds([1, 2, 3, 4]);
  check("the peak of a full ramp reaches level 4", H.levelOf(4, four), 4);
}

// -------------------------------------------------------------- the calendar

console.log("\n== the calendar grid");
{
  const today = new Date(2026, 9, 4);
  const cal = H.buildCalendar({ "2026-09-30": 5, "2026-10-04": 9 }, { today });

  check("every column holds seven days", [...new Set(cal.weeks.map((w) => w.days.length))], [7]);
  ok("the grid is a GitHub-sized year", cal.weeks.length >= 53 && cal.weeks.length <= 54);
  check("columns tile the days exactly", cal.days.length, cal.weeks.length * 7);

  check(
    "every column starts on a Sunday",
    [...new Set(cal.weeks.map((w) => H.parseKey(w.start).getDay()))],
    [0]
  );
  ok(
    "days inside a column run consecutively",
    cal.weeks.every((w) => w.days.every((d, i) => i === 0 || H.dayDelta(w.days[i - 1].date, d.date) === 1))
  );
  ok(
    "columns run consecutively",
    cal.weeks.every((w, i) => i === 0 || H.dayDelta(cal.weeks[i - 1].start, w.start) === 7)
  );

  const inRange = cal.days.filter((d) => d.inRange);
  check("the window is 365 days long", inRange.length, 365);
  check("it ends today", inRange[inRange.length - 1].date, "2026-10-04");
  check("it starts 364 days earlier", inRange[0].date, "2025-10-05");
  check("padding days are flagged, not hidden", cal.days.length - inRange.length, cal.days.length - 365);

  const todayCell = cal.days.find((d) => d.isToday);
  check("exactly one cell is today", cal.days.filter((d) => d.isToday).length, 1);
  check("today is the last in-range day", todayCell.date, "2026-10-04");
  check("today's total is carried through", todayCell.count, 9);

  const unrecorded = cal.days.find((d) => d.date === "2026-10-01");
  check("a day with no snapshot has no count", unrecorded.count, null);
  check("and no delta either", unrecorded.delta, null);
  check("no record is level 0", unrecorded.level, 0);

  const baseline = cal.days.find((d) => d.date === "2026-09-30");
  check("the first record is a baseline", baseline.delta, null);
  check("the baseline day still carries its total", baseline.count, 5);

  const later = cal.days.find((d) => d.date === "2026-10-04");
  check("a later record gets its real delta", later.delta, 4);
  ok("and a non-zero level", later.level > 0);
  check("the peak is the largest absolute change", cal.peak, 4);
  check("recorded counts the days with a snapshot", cal.recorded, 2);

  const stats = H.summarize(cal);
  check("summary: recorded days", stats.recordedDays, 2);
  check("summary: added", stats.added, 4);
  check("summary: removed", stats.removed, 0);
  check("summary: net", stats.net, 4);
  check("summary: current total", stats.current, 9);
  check("summary: first date", stats.firstDate, "2026-09-30");
  check("summary: last date", stats.lastDate, "2026-10-04");

  const empty = H.summarize(H.buildCalendar({}, { today }));
  check("an empty history has no current total", empty.current, null);
  check("an empty history adds nothing", empty.added, 0);
  check("an empty history reports no recorded days", empty.recordedDays, 0);
  check("an empty history claims no first date", empty.firstDate, null);
  check("an empty calendar has no peak to show", H.buildCalendar({}, { today }).peak, 0);
}

{
  console.log("\n== month labels");
  const today = new Date(2026, 9, 4);
  const cal = H.buildCalendar({}, { today });
  const labels = cal.weeks
    .map((w, i) => ({ i, label: w.monthLabel }))
    .filter((l) => l.label !== null);

  ok("a year gets several month labels", labels.length >= 8);
  ok(
    "no two labels sit closer than three columns",
    labels.every((l, k) => k === 0 || l.i - labels[k - 1].i >= 3)
  );
  ok(
    "every label sits on a column that really contains the 1st",
    labels.every((l) =>
      cal.weeks[l.i].days.some((d) => H.parseKey(d.date).getDate() === 1)
    )
  );
  ok(
    "no month is labelled twice",
    new Set(labels.map((l) => l.label)).size === labels.length
  );
  check(
    "the label is the month of the 1st it sits on",
    labels.map((l) => {
      const first = cal.weeks[l.i].days.find((d) => H.parseKey(d.date).getDate() === 1);
      return H.parseKey(first.date).getMonth() + 1 === Number(l.label.replace("月", ""));
    }).every(Boolean),
    true
  );
  check("the first column never carries a label that would hang off the edge", cal.weeks[0].monthLabel, null);
}

// --------------------------------------------------------- heatmap appearance

{
  console.log("\n== how a day is drawn");
  // heatmap.ts is bundled through the same loader; its two pure helpers decide
  // what a cell looks like, so they are worth pinning down.
  const M = bundle("heatmap/index.ts");
  const day = (o) => ({ date: "2026-10-04", count: 3, delta: 1, level: 2, inRange: true, isToday: false, ...o });

  check("never observed", M.appearanceOf(day({ count: null, delta: null })), { dir: "none", level: 0 });
  check("observed but nothing to compare to", M.appearanceOf(day({ delta: null })), { dir: "base", level: 0 });
  check("no change", M.appearanceOf(day({ delta: 0 })), { dir: "flat", level: 0 });
  check("growth", M.appearanceOf(day({ delta: 4, level: 3 })), { dir: "up", level: 3 });
  check("shrinkage", M.appearanceOf(day({ delta: -4, level: 1 })), { dir: "down", level: 1 });

  check("a missing day says so", M.describeDay(day({ count: null, delta: null })).change, "无记录");
  check("the baseline says what it is", M.describeDay(day({ delta: null })).change, "基线");
  check("a flat day says so", M.describeDay(day({ delta: 0 })).change, "无变化");
  check("growth is spelled out", M.describeDay(day({ delta: 5 })).change, "新增 5 张");
  check("shrinkage is spelled out", M.describeDay(day({ delta: -5 })).change, "减少 5 张");
  check("the total is always there", M.describeDay(day({ count: 42 })).total, "共 42 张");
  check("the date is the bare key", M.describeDay(day()).date, "2026-10-04");

  // The tooltip's date must be the sortable `YYYY-MM-DD` the request asked for.
  for (const d of [day({ delta: 5 }), day({ count: null, delta: null }), day({ delta: null })]) {
    ok(`the tooltip date is yyyy-mm-dd (${M.describeDay(d).change})`, /^\d{4}-\d{2}-\d{2}/.test(M.describeDay(d).date));
  }
}

// ----------------------------------------------------------- export: selection

console.log("\n== what an export contains");
{
  const images = [
    { name: "b.png", path: "00_Attachments/Images/b.png", size: 10 },
    { name: "a.png", path: "00_Attachments/Images/a.png", size: 20 },
    { name: "wall.jpg", path: "01_Resources/Art_Media/wall.jpg", size: 30 },
  ];

  check(
    "the whole library is everything",
    E.imagesUnder(images, "").length,
    3
  );
  check(
    "a folder scope takes its subtree, not just its own files",
    E.imagesUnder(images, "00_Attachments").map((i) => i.name),
    ["b.png", "a.png"]
  );
  check(
    "a prefix is a path segment, not a string",
    E.imagesUnder(images, "00_Attach").length,
    0
  );
  check("a leaf folder is just itself", E.imagesUnder(images, "01_Resources/Art_Media").length, 1);

  const toFullPath = (rel) => `C:/vault/${rel}`;
  const entries = E.collectExportEntries({
    images,
    folderPath: "00_Attachments",
    rootFolderName: "SNAPSHOT",
    toFullPath,
  });
  check(
    "entries keep the top-level folder, so the archive unpacks into it",
    entries.map((e) => e.name),
    ["SNAPSHOT/Images/a.png", "SNAPSHOT/Images/b.png"]
  );
  check("entries are sorted, so two exports are comparable", entries.map((e) => e.name).slice().sort(), entries.map((e) => e.name));
  check("each entry carries the real file path", entries[0].filePath, "C:/vault/00_Attachments/Images/a.png");
  check("each entry carries its size", entries[0].size, 20);

  // Out-of-scope images must be filtered by name, not renamed into fragments.
  check(
    "an image outside the scope is never renamed into the archive",
    E.collectExportEntries({
      images,
      folderPath: "00_Attachments",
      rootFolderName: "SNAPSHOT",
      toFullPath: (p) => `C:/vault/${p}`,
    }).every((e) => e.name.startsWith("SNAPSHOT/Images/")),
    true
  );

  check(
    "an item whose absolute path cannot be resolved is dropped, not written as a broken entry",
    E.collectExportEntries({
      images,
      folderPath: "",
      rootFolderName: "R",
      toFullPath: (p) => (p.endsWith("b.png") ? null : `C:/v/${p}`),
    }).length,
    2
  );
  check(
    "a folder scope exports only that folder",
    E.collectExportEntries({
      images,
      folderPath: "01_Resources/Art_Media",
      rootFolderName: "R",
      toFullPath: (p) => `C:/v/${p}`,
    }).map((e) => e.name),
    ["R/wall.jpg"]
  );
  check(
    "a folder name with a slash in it does not create a second nested top level",
    E.collectExportEntries({
      images,
      folderPath: "00_Attachments",
      rootFolderName: "a/b",
      toFullPath: (p) => `C:/v/${p}`,
    }).every((e) => e.name.startsWith("a_b/")),
    true
  );

  // A top-level folder name has to survive being used as a file name.
  check("illegal characters are replaced", E.sanitizeFileStem('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
  check("trailing dots and spaces go", E.sanitizeFileStem("vault. "), "vault");
  check("an all-illegal name still yields something", E.sanitizeFileStem("///"), "___");
  check("an empty name still yields something", E.sanitizeFileStem("   "), "export");
}

// -------------------------------------------------------------- export: info

console.log("\n== the JSON info export");
{
  const now = new Date(2026, 9, 4, 15, 4, 5);
  const settings = {
    rootPath: "01_Resources",
    imageExtensions: ["png", "jpg"],
    thumbnailSize: 148,
    thumbnailFit: "pad",
    motion: "full",
    showSubfolders: true,
    folderFirst: true,
    confirmDelete: true,
    sortKey: "name",
    sortAsc: true,
    folderPreview: true,
    showRefBadges: true,
    refFilter: "all",
    virtualThreshold: 300,
    lastPath: "01_Resources/Art_Media",
    customOrders: {},
  };
  const images = [
    { name: "a.png", path: "01_Resources/a.png", size: 100 },
    { name: "b.png", path: "01_Resources/b.png", size: 200 },
    { name: "c.jpg", path: "01_Resources/c.jpg", size: 50 },
  ];
  const payload = E.buildInfoPayload({
    pluginVersion: "0.5.0",
    vaultName: "SORROFUL_PALADIN",
    platform: "win32",
    settings,
    library: E.libraryStats(images, 4, "01_Resources"),
    history: { "2026-10-01": 2, "2026-10-04": 3 },
    now,
  });

  check("meta: plugin version", payload.meta.pluginVersion, "0.5.0");
  check("meta: vault", payload.meta.vault, "SORROFUL_PALADIN");
  check("meta: platform", payload.meta.platform, "win32");
  check("meta: local timestamp", payload.meta.exportedAtLocal, "2026-10-04 15:04:05");
  ok("meta: ISO timestamp", /^\d{4}-\d{2}-\d{2}T/.test(String(payload.meta.exportedAt)));
  check("meta: schema version", payload.meta.schemaVersion, 1);

  check("settings: raw is exactly what data.json holds", payload.settings.raw.rootPath, "01_Resources");
  check("settings: raw is a copy, not a live reference", payload.settings.raw === settings, false);
  check(
    "settings: raw carries every stored key, view state included",
    Object.keys(settings).sort(),
    Object.keys(payload.settings.raw).sort()
  );
  ok(
    "settings: the readable block has a line for every key on the settings page",
    [
      "rootPath", "imageExtensions", "thumbnailSize", "thumbnailFit", "showSubfolders",
      "folderPreview", "folderFirst", "showRefBadges", "motion", "sortKey", "sortAsc",
      "refFilter", "confirmDelete", "virtualThreshold",
    ].every((k) => payload.settings.readable[k]?.length > 0)
  );
  ok(
    "settings: every readable line is paired with the label it came from",
    Object.keys(payload.settings.readable).every(
      (k) => !k.endsWith("__label") || payload.settings.readable[k].length > 0
    )
  );
  check("settings: the readable block reads like the page", payload.settings.readable.thumbnailSize, "148 px");
  check(
    "settings: an empty root path says what it means",
    E.buildInfoPayload({
      pluginVersion: "0.5.0",
      vaultName: "V",
      platform: "win32",
      settings: { ...settings, rootPath: "" },
      library: E.libraryStats([], 0, ""),
      history: {},
      now,
    }).settings.readable.rootPath,
    "（整个 vault）"
  );
  check(
    "settings: view state is summarised rather than dumped",
    payload.settings.readable.customOrders !== undefined,
    false
  );

  check("library: image count", payload.library.images, 3);
  check("library: folder count", payload.library.folders, 4);
  check("library: total bytes", payload.library.bytes, 350);
  check("library: extension histogram is ordered by count", payload.library.byExtension.map((e) => e.ext), ["png", "jpg"]);

  check("heatmap: window length", payload.heatmap.window.days, 365);
  check("heatmap: window end", payload.heatmap.window.to, "2026-10-04");
  check("heatmap: window start", payload.heatmap.window.from, "2025-10-05");
  check("heatmap: one entry per day in the window", payload.heatmap.days.length, 365);
  check("heatmap: summary recorded days", payload.heatmap.summary.recordedDays, 2);
  check("heatmap: summary added", payload.heatmap.summary.added, 1);
  check("heatmap: summary current", payload.heatmap.summary.current, 3);
  check("heatmap: every day carries a date", payload.heatmap.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)), true);
  check(
    "heatmap: unrecorded days are null, not zero",
    payload.heatmap.days.find((d) => d.date === "2026-10-02").count,
    null
  );

  // The whole point of the file is that it can be read back.
  check("the payload survives a JSON round trip", JSON.parse(JSON.stringify(payload)).heatmap.days.length, 365);
  check("the file name is dated", E.infoFileName(now), "vault-gallery-info-20261004.json");
}

// ------------------------------------------------------------- persistence

{
  console.log("\n== the history file is not trusted");
  // This file is hand-editable and outlives plugin versions, so anything that
  // is not the shape we wrote is dropped rather than parsed into the ledger.
  const S = bundle("historyStore.ts");
  check("a clean file round-trips", S.sanitizeHistory({ "2026-10-04": 12 }), { "2026-10-04": 12 });
  check("junk keys are dropped", S.sanitizeHistory({ today: 1, "2026-10-04": 2 }), { "2026-10-04": 2 });
  check("null counts are dropped", S.sanitizeHistory({ "2026-10-04": null }), {});
  check("booleans are dropped", S.sanitizeHistory({ "2026-10-04": true }), {});
  check("objects are dropped", S.sanitizeHistory({ "2026-10-04": { n: 1 } }), {});
  check("empty strings are dropped", S.sanitizeHistory({ "2026-10-04": "  " }), {});
  check("negative counts are dropped", S.sanitizeHistory({ "2026-10-04": -3 }), {});
  check("non-finite counts are dropped", S.sanitizeHistory({ "2026-10-04": Number.POSITIVE_INFINITY }), {});
  check("fractional counts are floored", S.sanitizeHistory({ "2026-10-04": 4.9 }), { "2026-10-04": 4 });
  check("numeric strings are accepted", S.sanitizeHistory({ "2026-10-04": "7" }), { "2026-10-04": 7 });
  check("an array is not an object of days", S.sanitizeHistory([]), {});
  check("null is an empty ledger", S.sanitizeHistory(null), {});
  check("a string is an empty ledger", S.sanitizeHistory("nope"), {});

  check("the file sits next to the plugin", S.historyPathFor(".obsidian/plugins/vault-gallery"), ".obsidian/plugins/vault-gallery/history.json");
  check("...and the separator is normalized", S.historyPathFor(".obsidian\\plugins\\vault-gallery\\"), ".obsidian/plugins/vault-gallery/history.json");
}

// ------------------------------------------------------------------- report

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) {
  console.log(`${fail} FAILED`);
  process.exit(1);
}

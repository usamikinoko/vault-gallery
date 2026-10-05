/*
 * tokens: the design-system lint.
 *
 * The styles are 11 source shards glued into styles.css by build-styles.mjs, so
 * a token can rot in two ways this test exists to catch:
 *
 *   1. a token declared but never referenced — the `fast/base/slow` ladder this
 *      suite was written for had two thirds of it unspent, which is how a
 *      "design system" turns into a pile of names nobody dares delete;
 *   2. a `var(--ib-x)` referenced but never declared — the component silently
 *      loses its styling and nothing errors.
 *
 * It also pins the three things that are easy to regress silently and
 * expensive to notice: no decorative shadows (flat design), one corner radius
 * for components (the pill-shaped badges and the browser-tab strip were the
 * last two survivors of a per-component radius), and the `body ` prefix on
 * every button family without which the host's own `button` rule — (0,1,1),
 * with a fill and a five-layer shadow — wins over a plain class.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0;
function eq(actual, expected, label) {
  assert.deepStrictEqual(
    actual,
    expected,
    `${label}\n  got      ${JSON.stringify(actual)}\n  expected ${JSON.stringify(expected)}`,
  );
  passed++;
}
function ok(condition, label) {
  assert.ok(condition, label);
  passed++;
}

const root = path.join(__dirname, "..");
const stylesDir = path.join(root, "styles");
const shards = fs
  .readdirSync(stylesDir)
  .filter((f) => f.endsWith(".css"))
  .sort();

/** Comments are prose, not declarations. Scanning them produced a false
 *  positive once already: a comment explaining "box-shadow: none kills the
 *  host's shadow" was read as a decorative shadow. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

let css = "";
const declared = new Map();
const perShard = new Map();
for (const file of shards) {
  const code = stripComments(fs.readFileSync(path.join(stylesDir, file), "utf8"));
  css += code;
  perShard.set(file, code);
  for (const m of code.matchAll(/^\s*(--ib-[a-z0-9-]+)\s*:/gim)) {
    if (!declared.has(m[1])) declared.set(m[1], file);
  }
}

/* --- 1. every declared token is spent, every spent token is declared ----- */

// The one legitimate exception: tokens whose value is per-frame data, written
// from TypeScript with setProperty. Discovered from the source rather than
// hardcoded, so adding a second one does not require editing this test.
const fromTs = new Set();
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith(".ts")) {
      const t = fs.readFileSync(p, "utf8");
      for (const m of t.matchAll(/setProperty\(\s*"(--ib-[a-z0-9-]+)"/g)) fromTs.add(m[1]);
    }
  }
}
walk(path.join(root, "src"));

const referenced = new Set([...css.matchAll(/var\(\s*(--ib-[a-z0-9-]+)/gi)].map((m) => m[1]));

const dead = [...declared.keys()].filter((k) => !referenced.has(k) && !fromTs.has(k));
const undefinedRefs = [...referenced].filter((k) => !declared.has(k));
const declaredNotSpent = [...fromTs].filter((k) => !declared.has(k));

eq(dead, [], "no declared token goes unspent");
eq(undefinedRefs, [], "no referenced token is undeclared");
eq(declaredNotSpent, [], "every TS-written token is also declared in CSS");
ok(declared.size > 0, "the token scan actually found tokens");

/* --- 2. flat design: no shadows in the component shards ------------------ */

// Three shards are out of scope by decision, not by accident: the thumbnail
// tile (cards.css), the pile of prints a folder card is made of
// (folder-stack.css) and the folder card's own drop rings (pane-and-grid.css).
// Their shadows are the *subject* of those visuals, so the rule is scoped
// rather than absolute — everything the plugin's chrome is made of lives
// outside them.
const SHADOW_EXEMPT = new Set(["cards.css", "folder-stack.css", "pane-and-grid.css"]);

const decorative = [];
for (const [file, code] of perShard) {
  if (SHADOW_EXEMPT.has(file)) continue;
  for (const m of code.matchAll(/box-shadow\s*:\s*([^;}]+)/gi)) {
    const value = m[1].trim().replace(/\s+/g, " ");
    if (!/^(none|0(px)?( 0(px)?)*)$/i.test(value)) decorative.push(`${file}: ${value}`);
  }
}
eq(decorative, [], "box-shadow is only ever used to reset the host's own shadow");

/* --- 3. one radius, and no pills ---------------------------------------- */

// `999px` was how four separate components asked to be a pill: the tree's
// count badge, the reference badge, the orphan chip and the lightbox counter.
// A pill is a shape the rest of the plugin does not speak.
const pills = shards.filter((f) => /border-radius\s*:\s*[^;]*999px/i.test(perShard.get(f)));
eq(pills, [], "no component reaches for a pill radius");

// Literal radii are the two documented exceptions: the 2px of a *bar* (the
// drag-insert line, the active-tab underline, a heatmap mark) and the tick's
// elbow in the selection checkbox. Everything else spends --ib-radius.
const RADIUS_OK = new Set(["2px", "0 0 1px 0"]);
const strayRadii = [];
for (const [file, code] of perShard) {
  for (const m of code.matchAll(/border-radius\s*:\s*([^;}]+)/gi)) {
    const value = m[1].trim().replace(/\s+/g, " ");
    if (value.startsWith("var(")) continue;
    if (!RADIUS_OK.has(value)) strayRadii.push(`${file}: ${value}`);
  }
}
eq(strayRadii, [], "every component radius comes from --ib-radius");

/* --- 4. the button families outrank the host ---------------------------- */

// Obsidian styles `button:not(.clickable-icon)` at (0,1,1). A family whose base
// rule is a bare class therefore loses the cascade to the host and renders with
// the host's fill and shadow — which is exactly how unchecked checkboxes once
// looked checked and how every toolbar button ended up with a drop shadow.
// Descendant and pseudo-element rules (`… svg`, `…::after`) are exempt: they
// style the glyph or the underline, never the button box itself.
const BUTTON_FAMILIES = [
  "ib-btn",
  "ib-icon-btn",
  "ib-nav-btn",
  "ib-lightbox-nav",
  "ib-zoom-btn",
];
const unprefixed = [];
for (const [file, code] of perShard) {
  for (const m of code.matchAll(/(^|\})\s*([^{}]+)\{/g)) {
    const selector = m[2].trim();
    if (!selector || selector.startsWith("@") || selector.startsWith("body")) continue;
    for (const family of BUTTON_FAMILIES) {
      if (!new RegExp(`^\\.${family}(?![a-z0-9-])`).test(selector)) continue;
      if (selector.includes(" ") || selector.includes("::")) continue;
      unprefixed.push(`${file}: ${selector}`);
    }
  }
}
eq(unprefixed, [], "every button-family base rule carries the `body ` prefix");

/* --- 5. the built stylesheet matches the shards -------------------------- */

const built = stripComments(fs.readFileSync(path.join(root, "styles.css"), "utf8"));
// build-styles.mjs joins the shards; compare the token set rather than the
// bytes, so the test does not break on the banner/separator formatting.
const builtTokens = new Set([...built.matchAll(/var\(\s*(--ib-[a-z0-9-]+)/gi)].map((m) => m[1]));
eq(
  [...builtTokens].filter((t) => !referenced.has(t)),
  [],
  "styles.css references no token the shards do not",
);
eq(
  [...referenced].filter((t) => !builtTokens.has(t)),
  [],
  "styles.css is not stale — rebuild it (npm run build) if this fails",
);

/* --- 6. the reduced-motion ladder stays honest --------------------------- */

// Anchored to the start of a line so it matches the *declaration* block and not
// the first `body[data-ib-motion="reduced"] .something` consumer that happens to
// come earlier in the concatenation — the shards are read in alphabetical
// order, which is not the cascade order.
for (const mode of ["full", "reduced", "none"]) {
  const re = new RegExp(`^body\\[data-ib-motion="${mode}"\\]\\s*\\{([^}]*)\\}`, "m");
  const m = css.match(re);
  ok(m, `motion mode "${mode}" is declared`);
  if (m) ok(/--ib-dur-fast\s*:/.test(m[1]), `motion mode "${mode}" sets --ib-dur-fast`);
}

console.log(`tokens: ${passed} assertions passed`);

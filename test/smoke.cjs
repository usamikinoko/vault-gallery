/*
 * Headless smoke test.
 *
 * Obsidian plugins cannot be unit-tested out of the box, so this harness
 * fakes the pieces we actually touch:
 *   - a jsdom document, patched with Obsidian's HTMLElement extensions
 *     (createDiv / addClass / empty / setText / ...)
 *   - a CommonJS "obsidian" module with the classes the plugin extends
 *   - a fake vault tree with a few folders and image files
 *
 * Then it loads the real built main.js, runs onload(), instantiates the view,
 * runs onOpen(), and asserts on the rendered DOM.
 *
 * Run: node test/smoke.cjs
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");
const esbuild = require("esbuild");
const { JSDOM } = require("jsdom");

// --------------------------------------------------------------------- DOM

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const { window } = dom;
global.window = window;
global.document = window.document;
global.HTMLElement = window.HTMLElement;
global.Element = window.Element;
global.Node = window.Node;
global.Image = window.Image;
global.navigator = window.navigator;
global.getComputedStyle = window.getComputedStyle.bind(window);
window.require = () => null; // block any electron access

const proto = window.Element.prototype;

function applyInfo(el, o) {
  if (!o) return;
  if (typeof o === "string") {
    el.className = o;
    return;
  }
  if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
  if (o.text !== undefined) el.textContent = String(o.text);
  if (o.title) el.setAttribute("title", o.title);
  if (o.type) el.setAttribute("type", o.type);
  if (o.placeholder) el.setAttribute("placeholder", o.placeholder);
  if (o.href) el.setAttribute("href", o.href);
  if (o.value !== undefined) el.value = o.value;
  if (o.attr) {
    for (const k of Object.keys(o.attr)) el.setAttribute(k, o.attr[k]);
  }
}

proto.empty = function () {
  while (this.firstChild) this.removeChild(this.firstChild);
  return this;
};
proto.addClass = function (...cls) {
  for (const c of cls) {
    if (!c) continue;
    for (const part of String(c).split(/\s+/)) if (part) this.classList.add(part);
  }
  return this;
};
proto.removeClass = function (...cls) {
  for (const c of cls) {
    if (!c) continue;
    for (const part of String(c).split(/\s+/)) if (part) this.classList.remove(part);
  }
  return this;
};
proto.toggleClass = function (c, on) {
  this.classList.toggle(c, on);
  return this;
};
/* Obsidian ships hasClass alongside addClass/removeClass; the guard paths in
   the lightbox read it before touching the DOM. */
proto.hasClass = function (c) {
  return this.classList.contains(c);
};
proto.setAttr = function (k, v) {
  if (v === null || v === undefined || v === false) this.removeAttribute(k);
  else this.setAttribute(k, String(v));
  return this;
};
proto.setText = function (t) {
  this.textContent = String(t);
  return this;
};
proto.createEl = function (tag, o, cb) {
  const el = document.createElement(tag);
  applyInfo(el, o);
  this.appendChild(el);
  if (typeof cb === "function") cb(el);
  return el;
};
proto.createDiv = function (o, cb) {
  return this.createEl("div", o, cb);
};
proto.createSpan = function (o, cb) {
  return this.createEl("span", o, cb);
};

// ---------------------------------------------------------------- fake vault

class TFile {
  constructor(p) {
    this.path = p;
    this.name = p.split("/").pop();
    this.extension = this.name.split(".").pop();
    this.stat = {
      size: 120 * 1024,
      mtime: Date.now() - 86_400_000,
      ctime: Date.now() - 172_800_000,
    };
  }
}
class TFolder {
  constructor(p, name) {
    this.path = p;
    this.name = name;
    this.children = [];
  }
  isRoot() {
    return this.path === "/";
  }
}

const root = new TFolder("/", "SORROFUL_PALADIN");
const attachments = new TFolder("00_Attachments", "00_Attachments");
const images = new TFolder("00_Attachments/Images", "Images");
const resources = new TFolder("01_Resources", "01_Resources");
const artMedia = new TFolder("01_Resources/Art_Media", "Art_Media");

root.children = [attachments, resources];
attachments.children = [images];
resources.children = [artMedia];

for (let i = 1; i <= 5; i++) images.children.push(new TFile(`00_Attachments/Images/img-${i}.png`));
for (let i = 1; i <= 2; i++) artMedia.children.push(new TFile(`01_Resources/Art_Media/wall-${i}.jpg`));
// A non-image file that must be ignored by the scanner.
images.children.push(new TFile("00_Attachments/Images/notes.md"));

const byPath = new Map();
const indexNode = (node) => {
  const key = node instanceof TFolder && node.isRoot() ? "" : node.path;
  byPath.set(key, node);
  if (node.children) node.children.forEach(indexNode);
};
indexNode(root);

// ------------------------------------------- fake filesystem mutation layer

const parentOf = (p) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

/** Repoint one node and everything under it after a move or rename. */
function moveSubtree(node, newParentPath, newName) {
  const oldPath = node.path;
  const oldParent = byPath.get(parentOf(oldPath));
  if (oldParent) oldParent.children = oldParent.children.filter((c) => c !== node);

  node.path = newParentPath ? `${newParentPath}/${newName}` : newName;
  node.name = newName;
  byPath.delete(oldPath);
  byPath.set(node.path, node);

  const parent = byPath.get(newParentPath);
  if (parent) parent.children.push(node);

  const walk = (n) => {
    for (const c of n.children ?? []) {
      byPath.delete(c.path);
      c.path = `${n.path}/${c.name}`;
      byPath.set(c.path, c);
      walk(c);
    }
  };
  walk(node);
}

function removeSubtree(node) {
  const parent = byPath.get(parentOf(node.path));
  if (parent) parent.children = parent.children.filter((c) => c !== node);
  const drop = (n) => {
    byPath.delete(n.path);
    for (const c of n.children ?? []) drop(c);
  };
  drop(node);
}

let currentApp = null;

/*
 * Vault events are wired for real, not stubbed out.
 *
 * The plugin drops its tree cache from the vault listener, so a harness whose
 * `on()` returns a dead object would be testing a fiction: mutations would
 * appear to leave a stale cache behind, and — worse — a genuine regression in
 * the listener would pass unnoticed. Emitting the same four events Obsidian
 * emits keeps the harness honest about the one integration that the cache
 * depends on.
 */
const vaultHandlers = new Map();
const onVaultEvent = (name, cb) => {
  const list = vaultHandlers.get(name) ?? [];
  list.push(cb);
  vaultHandlers.set(name, list);
  return { id: `evt-${name}-${list.length}` };
};
const emitVault = (name, payload) => {
  for (const cb of vaultHandlers.get(name) ?? []) cb(payload);
};

const app = {
  vault: {
    getRoot: () => root,
    getName: () => "SORROFUL_PALADIN",
    getAbstractFileByPath: (p) => byPath.get(p) ?? null,
    getResourcePath: (f) => `app://local/${encodeURIComponent(f.path)}`,
    createFolder: async (path) => {
      if (byPath.has(path)) throw new Error(`folder exists: ${path}`);
      const parent = byPath.get(parentOf(path));
      if (!parent) throw new Error(`no parent for: ${path}`);
      const folder = new TFolder(path, path.split("/").pop());
      parent.children.push(folder);
      byPath.set(path, folder);
      emitVault("create", folder);
      return folder;
    },
    createBinary: async (path, data) => {
      if (byPath.has(path)) throw new Error(`file exists: ${path}`);
      const parent = byPath.get(parentOf(path));
      if (!parent) throw new Error(`no parent for: ${path}`);
      const file = new TFile(path);
      file.stat.size = data.byteLength;
      parent.children.push(file);
      byPath.set(path, file);
      emitVault("create", file);
      return file;
    },
    on: onVaultEvent,
    adapter: {
      getFullPath: (p) => `/fake-vault/${p}`,
      // In-memory stand-in for the real adapter. The history file is the only
      // thing the plugin persists outside of `data.json`, and it writes on a
      // timer, so without this the harness cannot tell "persisted" from
      // "silently failed and logged".
      files: new Map(),
      async read(p) {
        if (!this.files.has(p)) throw new Error(`ENOENT ${p}`);
        return this.files.get(p);
      },
      async write(p, data) {
        this.files.set(p, data);
      },
      async exists(p) {
        return this.files.has(p);
      },
    },
  },
  fileManager: {
    renameFile: async (file, newPath) => {
      const from = file.path;
      moveSubtree(file, parentOf(newPath), newPath.split("/").pop());
      emitVault("rename", file, from);
    },
    trashFile: async (file) => {
      removeSubtree(file);
      emitVault("delete", file);
    },
  },
  metadataCache: {
    // notes/one.md embeds img-1.png, notes/two.md embeds img-1.png and wall-1.jpg
    resolvedLinks: {
      "notes/one.md": { "00_Attachments/Images/img-1.png": 1 },
      "notes/two.md": {
        "00_Attachments/Images/img-1.png": 1,
        "01_Resources/Art_Media/wall-1.jpg": 1,
      },
    },
    on: () => ({ id: "evt" }),
  },
  workspace: {
    getLeavesOfType: () => [],
    getLeaf: () => ({ setViewState: async () => {} }),
    revealLeaf: async () => {},
    openLinkText: () => {},
    detachLeavesOfType: () => {},
    on: () => ({ id: "evt" }),
  },
};
currentApp = app;

/*
 * Seeding helpers.
 *
 * Tests must grow the vault through the vault API rather than by pushing onto
 * `children`, because the plugin's tree cache is dropped from the vault
 * listener. A test that mutates the fixtures behind the API's back would be
 * asserting against a state the plugin was never told about — the assertion
 * would pass for the wrong reason, or fail for one that cannot happen.
 */
const seedFolder = (path) => app.vault.createFolder(path);
const seedFile = (path, size = 120 * 1024) =>
  app.vault.createBinary(path, Buffer.alloc(size));
const dropNode = (node) => {
  removeSubtree(node);
  emitVault("delete", node);
};

// ------------------------------------------------------------ obsidian stub

const viewCreators = new Map();

class Events {
  on() {
    return { id: "evt" };
  }
}

class Plugin {
  constructor(a, manifest) {
    this.app = a;
    this.manifest = manifest;
    this._data = null;
  }
  addRibbonIcon() {
    return { id: "ribbon" };
  }
  addCommand() {
    return {};
  }
  addSettingTab(tab) {
    this._settingTab = tab;
    return tab;
  }
  registerView(type, creator) {
    viewCreators.set(type, creator);
  }
  registerEvent() {}
  async loadData() {
    return this._data;
  }
  async saveData(d) {
    this._data = d;
  }
}

class ItemView extends Events {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.app = currentApp;
    this.containerEl = document.createElement("div");
    this.contentEl = document.createElement("div");
    this.containerEl.appendChild(this.contentEl);
  }
}

class PluginSettingTab {
  constructor(a, plugin) {
    this.app = a;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
  }
}

class FuzzySuggestModal {
  constructor(a) {
    this.app = a;
  }
  setPlaceholder() {}
}
const modals = [];
class Modal {
  constructor(a) {
    this.app = a;
    this.contentEl = document.createElement("div");
    this.modalEl = document.createElement("div");
    this.titleEl = document.createElement("div");
    this.titleEl.className = "modal-title";
    this.modalEl.append(this.titleEl, this.contentEl);
    // Real Obsidian Modals get a Scope; the lightbox registers its paging and
    // zoom keys on it, so the stub has to keep them for the test to press.
    this.scope = {
      handlers: {},
      register(_mods, key, fn) {
        this.handlers[key] = fn;
      },
    };
    modals.push(this);
  }
  // Deliberately not auto-calling onOpen(): other modals in the plugin build
  // UI that the stub does not model. Tests call onOpen() on the instance they
  // want to drive.
  open() {}
  close() {}
}
class Menu {
  addItem() {
    return this;
  }
  addSeparator() {
    return this;
  }
  showAtMouseEvent() {}
}
const notices = [];
class Notice {
  constructor(msg) {
    this.message = msg;
    notices.push(String(msg));
  }
}
/*
 * Settings components, modelled with real DOM.
 *
 * The point of the settings list is that one description table drives two
 * renderers, so the test has to be able to *read* a row: find it by name, type
 * into its input, fire the event the real component would fire, and watch the
 * setting change. A stub that ignores its callback would let the whole panel
 * render nothing and still pass.
 */
class TextComponent {
  constructor(parent) {
    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    parent.appendChild(this.inputEl);
  }
  setPlaceholder(v) {
    this.inputEl.placeholder = v;
    return this;
  }
  setValue(v) {
    this.inputEl.value = String(v);
    return this;
  }
  onChange(cb) {
    this.inputEl.addEventListener("input", () => cb(this.inputEl.value));
    return this;
  }
}
class SliderComponent {
  constructor(parent) {
    this.sliderEl = document.createElement("input");
    this.sliderEl.type = "range";
    parent.appendChild(this.sliderEl);
  }
  setLimits(min, max, step) {
    this.sliderEl.min = String(min);
    this.sliderEl.max = String(max);
    this.sliderEl.step = String(step);
    return this;
  }
  setValue(v) {
    this.sliderEl.value = String(v);
    return this;
  }
  setDynamicTooltip() {
    return this;
  }
  onChange(cb) {
    // Obsidian fires `change` on release; `input` would fire mid-drag.
    this.sliderEl.addEventListener("change", () => cb(Number(this.sliderEl.value)));
    return this;
  }
}
class ToggleComponent {
  constructor(parent) {
    this.toggleEl = document.createElement("input");
    this.toggleEl.type = "checkbox";
    parent.appendChild(this.toggleEl);
  }
  setValue(v) {
    this.toggleEl.checked = !!v;
    return this;
  }
  onChange(cb) {
    this.toggleEl.addEventListener("change", () => cb(this.toggleEl.checked));
    return this;
  }
}
class DropdownComponent {
  constructor(parent) {
    this.selectEl = document.createElement("select");
    parent.appendChild(this.selectEl);
  }
  addOption(value, label) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    this.selectEl.appendChild(option);
    return this;
  }
  setValue(v) {
    this.selectEl.value = String(v);
    return this;
  }
  onChange(cb) {
    this.selectEl.addEventListener("change", () => cb(this.selectEl.value));
    return this;
  }
}
class ButtonComponent {
  constructor(parent) {
    this.buttonEl = document.createElement("button");
    parent.appendChild(this.buttonEl);
  }
  setButtonText(t) {
    this.buttonEl.textContent = t;
    return this;
  }
  setWarning() {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }
  setTooltip(t) {
    this.buttonEl.title = t;
    return this;
  }
  onClick(cb) {
    this.buttonEl.addEventListener("click", () => cb());
    return this;
  }
}

/** Rows are queryable by name so a test can act on "the root path row". */
class Setting {
  constructor(containerEl) {
    this.settingEl = document.createElement("div");
    this.settingEl.className = "setting-item";
    this.nameEl = document.createElement("div");
    this.nameEl.className = "setting-item-name";
    this.descEl = document.createElement("div");
    this.descEl.className = "setting-item-description";
    this.controlEl = document.createElement("div");
    this.controlEl.className = "setting-item-control";
    this.settingEl.append(this.nameEl, this.descEl, this.controlEl);
    containerEl.appendChild(this.settingEl);
  }
  setName(n) {
    this.nameEl.textContent = n;
    return this;
  }
  setDesc(d) {
    this.descEl.textContent = d ?? "";
    return this;
  }
  addText(cb) {
    cb(new TextComponent(this.controlEl));
    return this;
  }
  addSlider(cb) {
    cb(new SliderComponent(this.controlEl));
    return this;
  }
  addToggle(cb) {
    cb(new ToggleComponent(this.controlEl));
    return this;
  }
  addDropdown(cb) {
    cb(new DropdownComponent(this.controlEl));
    return this;
  }
  addButton(cb) {
    cb(new ButtonComponent(this.controlEl));
    return this;
  }
}

const obsidianStub = {
  App: class {},
  Component: Events,
  Events,
  ItemView,
  Modal,
  Moment: class {},
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile: class {},
  TFile,
  TFolder,
  WorkspaceLeaf: class {},
  FuzzySuggestModal,
  Menu,
  setIcon: (el, name) => el.setAttribute("data-icon", name),
  normalizePath: (p) => p,
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidianStub;
  return originalLoad.call(this, request, parent, isMain);
};

// -------------------------------------------------------------------- run

const results = [];
function check(label, actual, expected) {
  const ok = actual === expected;
  results.push({ ok, label, actual, expected });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (got ${actual}, want ${expected})`);
}
/** For invariants that have no single expected value to print. */
function ok(label, condition) {
  check(label, !!condition, true);
}

(async () => {
  const mod = require(path.join(__dirname, "..", "main.js"));
  const PluginClass = mod.default ?? mod;
  console.log("== loaded plugin class:", typeof PluginClass, "\n");

  // The real manifest, not a stub: the plugin stamps its version into the
  // settings footer, and a hard-coded fake would let that stamp go stale.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

  const plugin = new PluginClass(app, manifest);
  await plugin.onload();
  console.log("== onload() ok, manifest v" + manifest.version);
  check(
    "motion: loaded with the designed default",
    document.body.getAttribute("data-ib-motion"),
    "full"
  );

  // --- store level ---
  const store = plugin.store;
  const tree = store.buildTree();
  check("tree root children", tree.children.length, 2);
  check("scanner finds images only (skips .md)", store.scanImages().length, 7);
  check("subtree count on root", tree.totalImages, 7);

  const imagesNode = store.findNode(tree, "00_Attachments/Images");
  check("Images folder direct images", imagesNode.images.length, 5);

  check(
    "backlinks for img-1.png",
    store.getBacklinks("00_Attachments/Images/img-1.png").length,
    2
  );
  check(
    "backlinks for unreferenced img-2.png",
    store.getBacklinks("00_Attachments/Images/img-2.png").length,
    0
  );

  // --- view level ---
  const creator = viewCreators.get("vault-gallery-view");
  check("view registered", typeof creator, "function");

  const leaf = {};
  const view = creator(leaf);
  await view.onOpen();

  check("tree rows rendered", view.contentEl.querySelectorAll(".ib-tree-row").length, 5);
  check("root grid folder cards", view.contentEl.querySelectorAll(".ib-card-folder").length, 2);
  check("root grid image cards", view.contentEl.querySelectorAll(".ib-card-image").length, 0);

  // drill into the Images folder
  view.enter("00_Attachments/Images");
  check("Images grid image cards", view.contentEl.querySelectorAll(".ib-card-image").length, 5);
  check("Images grid folder cards", view.contentEl.querySelectorAll(".ib-card-folder").length, 0);

  const firstImg = view.contentEl.querySelector(".ib-card-image img");
  check("thumbnail src set", firstImg?.getAttribute("src")?.startsWith("app://local/"), true);

  // --- file mutations ---
  await view.moveImage("00_Attachments/Images/img-5.png", "01_Resources");
  check(
    "move: file lands at new path",
    app.vault.getAbstractFileByPath("01_Resources/img-5.png") !== null,
    true
  );
  check(
    "move: old path is gone",
    app.vault.getAbstractFileByPath("00_Attachments/Images/img-5.png"),
    null
  );

  // Name collision in the destination folder must not clobber the existing file.
  await seedFile("01_Resources/wall-1.jpg");
  await view.moveImage("01_Resources/Art_Media/wall-1.jpg", "01_Resources");
  check(
    "move: collision resolved with numeric suffix",
    app.vault.getAbstractFileByPath("01_Resources/wall-1 2.jpg") !== null,
    true
  );

  // --- drag reorder ---
  plugin.settings.sortKey = "name";
  plugin.settings.sortAsc = true;
  view.enter("00_Attachments/Images");

  const before = Array.from(view.contentEl.querySelectorAll(".ib-card-image")).map(
    (el) => el.querySelector(".ib-caption").textContent
  );
  check("reorder: starts alphabetical", before.join(","), "img-1.png,img-2.png,img-3.png,img-4.png");

  // Drop img-1 onto the right half of img-4 => img-1 lands right after img-4.
  await view.reorderImages(
    "00_Attachments/Images/img-1.png",
    "00_Attachments/Images/img-4.png",
    true
  );

  check("reorder: key switched to custom", plugin.settings.sortKey, "custom");
  check(
    "reorder: order persisted to data.json",
    JSON.stringify(plugin.settings.customOrders["00_Attachments/Images"]),
    JSON.stringify(["img-2.png", "img-3.png", "img-4.png", "img-1.png"])
  );

  const after = Array.from(view.contentEl.querySelectorAll(".ib-card-image")).map(
    (el) => el.querySelector(".ib-caption").textContent
  );
  check(
    "reorder: img-1 renders right after img-4",
    after.indexOf("img-1.png") - after.indexOf("img-4.png"),
    1
  );

  // ============================ v0.2: stacks, filter, batch, virtual scroll ==

  // --- folder cover stacks ---
  await app.vault.createFolder("07_Empty");

  view.enter("");
  const folderCards = Array.from(view.contentEl.querySelectorAll(".ib-card-folder"));
  const folderAt = (p) =>
    folderCards.find((el) => el.getAttribute("data-path") === p);

  const containerFolder = folderAt("00_Attachments");
  check("folder card exists in the grid", !!containerFolder, true);
  check(
    "a folder with no images of its own borrows its subtree's covers",
    containerFolder.querySelectorAll(".ib-stack-layer img").length,
    3
  );
  check(
    "folder cards draw no fallback glyph while previews are on",
    containerFolder.querySelectorAll("[data-icon]").length,
    0
  );
  check(
    "folder cards use the folder caption, not the image caption",
    containerFolder.querySelectorAll(".ib-caption").length,
    0
  );
  check(
    "folder cards use the folder caption, not the image caption",
    containerFolder.querySelectorAll(".ib-folder-name").length,
    1
  );
  check(
    "the pile lives in its own square stage",
    containerFolder.querySelectorAll(".ib-thumb-stack > .ib-stack-stage").length,
    1
  );
  check(
    "the prints sit inside that stage",
    containerFolder.querySelectorAll(".ib-stack-stage > .ib-stack-layer").length,
    3
  );

  // Previews can be switched off entirely, and then the old glyph comes back.
  plugin.settings.folderPreview = false;
  view.renderGrid({ resetScroll: true });
  const glyphFolder = Array.from(
    view.contentEl.querySelectorAll(".ib-card-folder")
  ).find((el) => el.getAttribute("data-path") === "00_Attachments");
  check(
    "with previews off a folder falls back to a glyph",
    glyphFolder.querySelectorAll(".ib-thumb-folder[data-icon]").length,
    1
  );
  check(
    "with previews off nothing draws a pile",
    glyphFolder.querySelectorAll(".ib-thumb-stack").length,
    0
  );
  plugin.settings.folderPreview = true;
  view.renderGrid({ resetScroll: true });

  const emptyFolder = folderAt("07_Empty");
  const emptyStack = emptyFolder.querySelector(".ib-thumb-stack");
  check("an empty folder still draws a pile", emptyStack !== null, true);
  check(
    "the empty pile is flagged blank",
    emptyStack.classList.contains("is-blank"),
    true
  );
  check(
    "the empty pile draws placeholder sheets",
    emptyStack.querySelectorAll(".ib-stack-layer.is-blank-sheet").length,
    3
  );
  check(
    "placeholder sheets hold no images",
    emptyStack.querySelectorAll("img").length,
    0
  );
  check(
    "the placeholder cover shows an image glyph",
    emptyStack.querySelectorAll(".ib-stack-blank-icon[data-icon='image']").length,
    1
  );
  check(
    "the placeholder cover is the last sheet",
    emptyStack.querySelectorAll(".ib-stack-layer")[2].hasAttribute("data-front"),
    true
  );
  check(
    "an empty folder carries no count badge",
    emptyStack.querySelectorAll(".ib-stack-badge").length,
    0
  );
  check("the empty folder says so", emptyFolder.querySelector(".ib-folder-meta").textContent, "空目录");

  view.enter("00_Attachments");
  const stack = view.contentEl.querySelector(".ib-card-folder .ib-thumb-stack");
  check("folder with direct images gets a stack cover", stack !== null, true);
  check("stack reports 3 prints", stack?.getAttribute("data-layers"), "3");
  check("stack renders 3 layers", stack.querySelectorAll(".ib-stack-layer").length, 3);
  check("stack layers each hold an image", stack.querySelectorAll("img").length, 3);
  // The count badge is gone on purpose: the total lives in the tree row and in
  // the card's own meta line, not stamped over the artwork.
  check(
    "stack carries no count badge",
    stack.querySelectorAll(".ib-stack-badge").length,
    0
  );
  check(
    "exactly one layer is marked as the cover",
    stack.querySelectorAll(".ib-stack-layer[data-front]").length,
    1
  );
  check(
    "stack cover images are vault resources",
    stack.querySelector(".ib-stack-layer img")?.getAttribute("src")?.startsWith("app://local/"),
    true
  );

  view.enter("01_Resources");
  const single = view.contentEl.querySelector(".ib-card-folder .ib-thumb-stack");
  check("folder with one image shows one print", single?.getAttribute("data-layers"), "1");

  // --- reference filter ---
  view.enter("00_Attachments/Images");
  check(
    "unreferenced images carry an orphan pill",
    view.contentEl.querySelectorAll(".ib-ref-pill.is-orphan").length,
    3
  );

  plugin.settings.refFilter = "unreferenced";
  view.renderGrid({ resetScroll: true });
  check(
    "unreferenced filter hides linked images",
    view.contentEl.querySelectorAll(".ib-card-image").length,
    3
  );

  plugin.settings.refFilter = "referenced";
  view.renderGrid({ resetScroll: true });
  check(
    "referenced filter keeps only linked images",
    view.contentEl.querySelectorAll(".ib-card-image").length,
    1
  );

  plugin.settings.refFilter = "all";
  view.renderGrid({ resetScroll: true });
  check(
    "clearing the filter restores every card",
    view.contentEl.querySelectorAll(".ib-card-image").length,
    4
  );

  // --- virtual scrolling (needs a folder big enough to trip the threshold) ---
  const bulk = await seedFolder("09_Bulk");
  for (let i = 0; i < 60; i++) {
    await seedFile(`09_Bulk/b-${String(i).padStart(2, "0")}.png`);
  }

  view.enter("09_Bulk");
  plugin.settings.virtualThreshold = 1;
  view.renderGrid({ resetScroll: true });
  check("virtual: item list built", view.items.length, 60);
  check("virtual: single column at this width", view.metrics.columns, 1);
  check(
    "virtual: only a windowful of cards is mounted",
    view.contentEl.querySelectorAll(".ib-card").length,
    2
  );
  check(
    "virtual: a bottom spacer reserves the rest",
    view.contentEl.querySelectorAll(".ib-vpad-bottom").length,
    1
  );
  check(
    "virtual: no top spacer while at the top",
    view.contentEl.querySelectorAll(".ib-vpad-top").length,
    0
  );

  view.wrapEl.scrollTop = 900;
  view.paint(false);
  check(
    "virtual: a top spacer appears after scrolling",
    view.contentEl.querySelectorAll(".ib-vpad-top").length,
    1
  );
  check(
    "virtual: window advances with the scroll position",
    view.contentEl.querySelectorAll(".ib-card").length,
    4
  );
  check(
    "virtual: every mounted card maps to an item index",
    view.itemEls.size,
    view.contentEl.querySelectorAll(".ib-card").length
  );
  check(
    "virtual: mounted cards carry absolute indices",
    view.contentEl.querySelector(".ib-card").getAttribute("data-index"),
    "2"
  );

  // Tear the bulk folder down again so later checks see the original vault.
  dropNode(bulk);

  plugin.settings.virtualThreshold = 300;
  view.enter("00_Attachments/Images");
  check(
    "virtual: small folders render every card again",
    view.contentEl.querySelectorAll(".ib-card-image").length,
    4
  );

  // --- multi-select ---
  view.toggleSelect("00_Attachments/Images/img-2.png");
  view.toggleSelect("00_Attachments/Images/img-3.png");
  check("selection tracks two files", view.selection.size, 2);
  check(
    "selection bar becomes visible",
    view.selBarEl.classList.contains("is-hidden"),
    false
  );
  check(
    "selected cards are marked",
    view.contentEl.querySelectorAll(".ib-card-image.is-selected").length,
    2
  );

  // --- batch move ---
  await view.moveImages(
    ["00_Attachments/Images/img-2.png", "00_Attachments/Images/img-3.png"],
    "01_Resources",
    false
  );
  check(
    "batch move: first file relocated",
    app.vault.getAbstractFileByPath("01_Resources/img-2.png") !== null,
    true
  );
  check(
    "batch move: second file relocated",
    app.vault.getAbstractFileByPath("01_Resources/img-3.png") !== null,
    true
  );
  check(
    "batch move: selection follows the files",
    view.selection.has("01_Resources/img-2.png"),
    true
  );

  // --- batch delete ---
  plugin.settings.confirmDelete = false;
  view.selection.clear();
  view.toggleSelect("00_Attachments/Images/img-1.png");
  view.toggleSelect("00_Attachments/Images/img-4.png");
  check("batch delete: two files queued", view.selection.size, 2);
  await view.deleteSelection();
  check(
    "batch delete: first file is gone",
    app.vault.getAbstractFileByPath("00_Attachments/Images/img-1.png"),
    null
  );
  check(
    "batch delete: second file is gone",
    app.vault.getAbstractFileByPath("00_Attachments/Images/img-4.png"),
    null
  );
  check("batch delete: selection cleared", view.selection.size, 0);

  // --- keyboard navigation ---
  view.enter("01_Resources");
  const key = (k) => {
    const evt = new window.KeyboardEvent("keydown", { key: k, bubbles: true });
    view.contentEl.dispatchEvent(evt);
  };
  view.focusIndex = -1;
  key("ArrowRight");
  check("keyboard: first arrow focuses the first card", view.focusIndex, 0);
  key("ArrowRight");
  check("keyboard: second arrow advances", view.focusIndex, 1);
  check(
    "keyboard: focused card is marked",
    view.contentEl.querySelectorAll(".ib-card.is-focused").length,
    1
  );
  key(" ");
  check("keyboard: space selects the focused card", view.selection.size, 1);
  key("Escape");
  check("keyboard: escape clears the selection", view.selection.size, 0);

  // --- reorder in a second folder, then settings persistence ---
  const resourcesBefore = Array.from(
    view.contentEl.querySelectorAll(".ib-card-image")
  ).map((el) => el.querySelector(".ib-caption").textContent);
  check(
    "resources folder lists its images alphabetically",
    resourcesBefore.join(","),
    "img-2.png,img-3.png,img-5.png,wall-1 2.jpg,wall-1.jpg"
  );

  await view.reorderImages("01_Resources/img-5.png", "01_Resources/img-2.png", false);
  check(
    "reorder: second folder order persisted",
    JSON.stringify(plugin._data.customOrders["01_Resources"]),
    JSON.stringify(["img-5.png", "img-2.png", "img-3.png", "wall-1 2.jpg", "wall-1.jpg"])
  );
  check(
    "reorder: the grid reflects the new order",
    view.contentEl.querySelector(".ib-card-image .ib-caption").textContent,
    "img-5.png"
  );
  check("last visited folder is remembered", plugin._data.lastPath, "01_Resources");

  // ============================ v0.3: folder drag, paste, empty state ======

  const settle = () => new Promise((r) => setTimeout(r, 0));

  // --- empty-state call to action ---
  view.enter("07_Empty");
  check(
    "an empty folder explains itself",
    view.contentEl.querySelector(".ib-empty-title")?.textContent,
    "这个目录还是空的"
  );
  check(
    "an empty folder offers new-folder and paste",
    view.contentEl.querySelectorAll(".ib-btn").length,
    2
  );
  check(
    "the toolbar offers a new-folder button",
    Array.from(view.contentEl.querySelectorAll(".ib-toolbar [data-icon]"))
      .map((e) => e.getAttribute("data-icon"))
      .includes("folder-plus"),
    true
  );
  check(
    "the toolbar offers a paste button",
    Array.from(view.contentEl.querySelectorAll(".ib-toolbar [data-icon]"))
      .map((e) => e.getAttribute("data-icon"))
      .includes("clipboard-paste"),
    true
  );
  /*
   * Both selects carry Obsidian's own `dropdown` class. It is not cosmetic:
   * the host resets `appearance: none` on every <select> and still reserves a
   * 13px slot in `background-position`, but only `.dropdown` supplies the
   * arrow image. Drop the class and the control renders with a 24.7px empty
   * gutter and no caret at all — which is what it did until a computed-style
   * probe caught it. No CSS lint can see this, so it is pinned here.
   *
   * `check` compares with `===`, so this has to collapse to a primitive; an
   * array-to-array compare would report "got true,true, want true,true".
   */
  const fieldSelects = Array.from(view.contentEl.querySelectorAll(".ib-toolbar select"));
  check("the toolbar has the two field selects", fieldSelects.length, 2);
  check(
    "the toolbar selects carry Obsidian's caret class",
    fieldSelects.every((e) => e.classList.contains("dropdown")),
    true
  );
  /*
   * The sort-direction button states where the order stands and what a click
   * does to it — "升序，点击改为降序" — rather than the bare verb it used to
   * carry ("切换升序 / 降序"). Vault Jukebox's control for the same job is
   * worded identically, and the two toolbars must not drift apart again, so
   * the pair is pinned here. Read the expected side off the live setting so
   * this does not silently assume a default.
   */
  const findDirBtn = () =>
    view.contentEl.querySelector(
      ".ib-toolbar [data-icon='arrow-up-narrow-wide'], .ib-toolbar [data-icon='arrow-down-wide-narrow']"
    );
  const sortAsc = plugin.settings.sortAsc;
  check(
    "the sort direction button names the current direction",
    findDirBtn().getAttribute("title"),
    sortAsc ? "升序，点击改为降序" : "降序，点击改为升序"
  );
  findDirBtn().dispatchEvent(new window.Event("click", { bubbles: true }));
  check(
    "and rewrites itself once the direction flips",
    findDirBtn().getAttribute("title"),
    sortAsc ? "降序，点击改为升序" : "升序，点击改为降序"
  );
  // Put it back: the rest of the suite reads the grid in the order it set above.
  findDirBtn().dispatchEvent(new window.Event("click", { bubbles: true }));
  check(
    "the flip is symmetric",
    findDirBtn().getAttribute("title"),
    sortAsc ? "升序，点击改为降序" : "降序，点击改为升序"
  );

  view.enter("00_Attachments");
  view.query = "zzz-nothing-matches";
  view.renderGrid({ resetScroll: true });
  check(
    "a fruitless search offers no folder actions",
    view.contentEl.querySelectorAll(".ib-btn").length,
    0
  );
  view.query = "";

  // --- every folder-shaped surface is a drag source ---
  view.enter("");
  const treeRows = Array.from(view.contentEl.querySelectorAll(".ib-tree-row"));
  check(
    "tree rows are drag sources, the vault root is not",
    treeRows.filter((r) => r.draggable).length,
    treeRows.length - 1
  );
  const rootRow = treeRows.find(
    (r) => r.querySelector(".ib-tree-name")?.textContent === "SORROFUL_PALADIN"
  );
  check(
    "the vault root row cannot be dragged",
    rootRow ? rootRow.draggable : null,
    false
  );
  check(
    "folder cards are drag sources",
    Array.from(view.contentEl.querySelectorAll(".ib-card-folder")).every(
      (el) => el.draggable
    ),
    true
  );

  // --- folder move rules (no cycles, no no-ops) ---
  view.beginFolderDrag("01_Resources");
  check("drag rules: onto itself is refused", view.canDropInto("01_Resources"), false);
  check(
    "drag rules: into its own descendant is refused",
    view.canDropInto("01_Resources/Art_Media"),
    false
  );
  check(
    "drag rules: into its current parent is a no-op",
    view.canDropInto(""),
    false
  );
  check(
    "drag rules: into an unrelated folder is allowed",
    view.canDropInto("00_Attachments"),
    true
  );
  view.endDrag();
  check(
    "drag rules: nothing can be dropped once the drag ends",
    view.canDropInto("00_Attachments"),
    false
  );

  // --- a folder moved into another folder (the tree-to-tree gesture) ---
  view.enter("01_Resources/Art_Media");
  plugin.settings.customOrders["01_Resources/Art_Media"] = ["wall-2.jpg"];
  await view.moveFolder("01_Resources/Art_Media", "00_Attachments", false);

  check(
    "folder move: the directory lands under the new parent",
    app.vault.getAbstractFileByPath("00_Attachments/Art_Media") !== null,
    true
  );
  check(
    "folder move: the old path is gone",
    app.vault.getAbstractFileByPath("01_Resources/Art_Media"),
    null
  );
  check(
    "folder move: files inside travelled with it",
    app.vault.getAbstractFileByPath("00_Attachments/Art_Media/wall-2.jpg") !== null,
    true
  );
  check(
    "folder move: custom orders are remapped",
    JSON.stringify(plugin.settings.customOrders["00_Attachments/Art_Media"]),
    JSON.stringify(["wall-2.jpg"])
  );
  check(
    "folder move: the stale order key is gone",
    plugin.settings.customOrders["01_Resources/Art_Media"],
    undefined
  );
  check(
    "folder move: the browsed folder follows the move",
    view.currentPath,
    "00_Attachments/Art_Media"
  );
  check(
    "folder move: the tree expansion follows the move",
    view.expanded.has("00_Attachments/Art_Media"),
    true
  );
  check(
    "folder move: lastPath follows the move",
    plugin._data.lastPath,
    "00_Attachments/Art_Media"
  );

  // --- dropping a folder on the folder being browsed ---
  view.enter("00_Attachments");
  view.beginFolderDrag("07_Empty");
  view.wrapEl.dispatchEvent(new window.Event("drop", { bubbles: true }));
  await settle();
  await settle();
  check(
    "dropping on empty grid space re-parents the folder",
    app.vault.getAbstractFileByPath("00_Attachments/07_Empty") !== null,
    true
  );
  check(
    "the drop clears the drag state",
    view.drag,
    null
  );

  // --- nested folder creation in one prompt ---
  await view.createFolder("00_Attachments", "角色/立绘/夜晚");
  check(
    "new folder: the deepest segment is created",
    app.vault.getAbstractFileByPath("00_Attachments/角色/立绘/夜晚") !== null,
    true
  );
  check(
    "new folder: intermediate parents are created too",
    app.vault.getAbstractFileByPath("00_Attachments/角色") !== null,
    true
  );
  check(
    "new folder: the view navigates into it",
    view.currentPath,
    "00_Attachments/角色/立绘/夜晚"
  );

  await view.createFolder("00_Attachments/角色", "a:b*c?");
  check(
    "new folder: illegal characters are stripped",
    app.vault.getAbstractFileByPath("00_Attachments/角色/a b c") !== null,
    true
  );

  // --- folder deletion takes the subtree with it ---
  plugin.settings.customOrders["00_Attachments/角色/立绘/夜晚"] = ["x.png"];
  await view.deleteFolder("00_Attachments/角色");
  check(
    "delete folder: the subtree is gone",
    app.vault.getAbstractFileByPath("00_Attachments/角色"),
    null
  );
  check(
    "delete folder: bookkeeping under it is dropped",
    plugin.settings.customOrders["00_Attachments/角色/立绘/夜晚"],
    undefined
  );
  check(
    "delete folder: the view falls back to the parent",
    view.currentPath,
    "00_Attachments"
  );

  // ---------------------------------------------------------- clipboard

  const pastedFile = (name, type, size = 16) => ({
    name,
    type,
    arrayBuffer: async () => new ArrayBuffer(size),
  });

  const pasteEvent = (payload, text, target) => {
    const state = { prevented: false };
    return {
      clipboardData: {
        files: payload.files ?? [],
        items: payload.items ?? [],
        getData: () => text,
      },
      target: target ?? view.contentEl,
      preventDefault: () => {
        state.prevented = true;
      },
      __prevented: state,
    };
  };

  view.enter("00_Attachments");
  view.selection.clear();

  // A Windows screenshot: no name at all, just image/png on the clipboard.
  let evt = pasteEvent({ files: [pastedFile("", "image/png")] }, "");
  await view.onPaste(evt);
  check("paste: a nameless screenshot is claimed", evt.__prevented.prevented, true);
  // The paste landed in 00_Attachments, so the auto-name is 目录名-yymmddhhmmss.
  const shot = view.items.find(
    (i) => i.kind === "image" && /^00_Attachments-\d{12}\.png$/.test(i.entry.name)
  );
  check("paste: it is named 目录名-时间戳", shot !== undefined, true);
  check("paste: the mime type decides the extension", shot?.entry.name.endsWith(".png"), true);

  // A screenshot that only arrives through the item list (the other branch).
  evt = pasteEvent(
    {
      files: [],
      items: [{ kind: "file", getAsFile: () => pastedFile("", "image/jpeg") }],
    },
    ""
  );
  await view.onPaste(evt);
  check(
    "paste: the item-list branch is honoured",
    view.items.some((i) => i.kind === "image" && i.entry.name.endsWith(".jpg")),
    true
  );

  // A copied file keeps its bytes verbatim but is auto-renamed like every
  // other paste — the clipboard's own name is not preserved.
  evt = pasteEvent({ files: [pastedFile("我的图 (草稿).PNG", "image/png", 2048)] }, "");
  await view.onPaste(evt);
  const pasted = view.items.find((i) => i.kind === "image" && i.entry.size === 2048);
  check(
    "paste: a copied file is auto-renamed 目录名-时间戳",
    /^00_Attachments-\d{12}\.PNG$/.test(pasted?.entry.name ?? ""),
    true
  );
  check("paste: bytes are written verbatim", pasted?.entry.size, 2048);

  evt = pasteEvent({ files: [pastedFile("dup.png", "image/png")] }, "");
  await view.onPaste(evt);
  await view.onPaste(pasteEvent({ files: [pastedFile("dup.png", "image/png")] }, ""));
  // Both dups land under the auto-name (suffixed when the stamp is taken);
  // the clipboard's name never reaches the vault.
  check(
    "paste: the original name is not kept",
    app.vault.getAbstractFileByPath("00_Attachments/dup.png"),
    null
  );

  // Non-images are refused, loudly, and nothing is written.
  evt = pasteEvent({ files: [pastedFile("report.pdf", "application/pdf")] }, "");
  await view.onPaste(evt);
  check("paste: a non-image is refused", evt.__prevented.prevented, true);
  check(
    "paste: the refusal is explained rather than silent",
    notices.some((n) => n.includes("不是图片") && n.includes("report.pdf")),
    true
  );
  check(
    "paste: the refused file never reaches the vault",
    app.vault.getAbstractFileByPath("00_Attachments/report.pdf"),
    null
  );

  // Plain text outside a text field is not our business.
  evt = pasteEvent({ files: [] }, "just some ordinary words");
  await view.onPaste(evt);
  check("paste: plain text is not hijacked", evt.__prevented.prevented, false);

  // ...and inside a text field, neither is an image URL.
  const fakeInput = window.document.createElement("input");
  evt = pasteEvent({ files: [] }, "https://example.com/a.png", fakeInput);
  await view.onPaste(evt);
  check(
    "paste: a URL pasted into a text field is left alone",
    evt.__prevented.prevented,
    false
  );

  // An image URL is downloaded, but only after the server proves it is one.
  global.fetch = async (url) => ({
    ok: true,
    headers: {
      get: (k) => (String(k).toLowerCase() === "content-type" ? "image/png" : "0"),
    },
    arrayBuffer: async () => new ArrayBuffer(99),
  });
  evt = pasteEvent({ files: [] }, "https://example.com/pics/hero.png?v=2");
  await view.onPaste(evt);
  check("paste: an image URL is claimed", evt.__prevented.prevented, true);
  const downloaded = view.items.find((i) => i.kind === "image" && i.entry.size === 99);
  check(
    "paste: the download is auto-renamed 目录名-时间戳",
    /^00_Attachments-\d{12}(-\d+)?\.png$/.test(downloaded?.entry.name ?? ""),
    true
  );

  global.fetch = async () => ({
    ok: true,
    headers: {
      get: (k) => (String(k).toLowerCase() === "content-type" ? "text/html" : "0"),
    },
    arrayBuffer: async () => new ArrayBuffer(99),
  });
  evt = pasteEvent({ files: [] }, "https://example.com/not-an-image");
  await view.onPaste(evt);
  check(
    "paste: a non-image URL writes nothing",
    app.vault.getAbstractFileByPath("00_Attachments/not-an-image") ,
    null
  );

  // An absolute local path is claimed by the event, but the headless harness
  // has no fs behind window.require, so it must fail closed.
  evt = pasteEvent({ files: [] }, "C:\\pics\\shot.png");
  await view.onPaste(evt);
  check("paste: an absolute image path is claimed", evt.__prevented.prevented, true);
  check(
    "paste: ...and fails closed without a filesystem",
    app.vault.getAbstractFileByPath("00_Attachments/shot.png"),
    null
  );

  // An import flips no checkboxes on by itself: selection stays exactly what
  // the user made it, and the select-all affordance still works afterwards.
  check("paste: imported files are not auto-selected", view.selection.size, 0);
  view.selectAll();
  check("paste: explicit select-all still works", view.selection.size > 0, true);
  check(
    "paste: every selected path is a real file",
    [...view.selection].every(
      (p) => app.vault.getAbstractFileByPath(p) instanceof TFile
    ),
    true
  );

  // The toolbar button has no paste event to read, so it goes to the OS
  // clipboard; with neither Electron nor a web clipboard it must not throw.
  const beforeButton = view.items.length;
  await view.importFromSystemClipboard();
  check(
    "the button path is a no-op without a readable clipboard",
    view.items.length,
    beforeButton
  );

  view.selection.clear();

  // --- a folder name collision must not invent an extension ---
  await app.vault.createFolder("00_Attachments/A");
  await app.vault.createFolder("00_Attachments/A/重复");
  await app.vault.createFolder("00_Attachments/B");
  await app.vault.createFolder("00_Attachments/B/重复");
  await view.moveFolder("00_Attachments/B/重复", "00_Attachments/A", false);
  check(
    "folder move: a name collision is suffixed",
    app.vault.getAbstractFileByPath("00_Attachments/A/重复 2") !== null,
    true
  );
  check(
    "folder move: the suffixed name has no stray dot",
    app.vault.getAbstractFileByPath("00_Attachments/A/重复 2."),
    null
  );
  check(
    "folder move: the original stays where it was",
    app.vault.getAbstractFileByPath("00_Attachments/A/重复") !== null,
    true
  );

  // --- the plugin's refresh prunes bookkeeping that went stale ---
  app.workspace.getLeavesOfType = () => [{ view }];
  view.enter("00_Attachments");
  const vanishPath = shot?.entry.path ?? "";
  view.toggleSelect(vanishPath);
  check("a file can be selected before it vanishes", view.selection.size, 1);
  removeSubtree(app.vault.getAbstractFileByPath(vanishPath));
  plugin.refreshViews();
  check(
    "an external delete prunes the selection pointing at it",
    view.selection.has(vanishPath),
    false
  );

  // ================= v0.4: the image tile and the lightbox zoom ============
  //
  // Zoom maths is bundled separately rather than reached through the plugin:
  // it is pure functions over a plain state object, and the whole reason it
  // lives in its own module is so that it can be checked here, in a process
  // with no layout engine and no viewport, where `translate + scale` mistakes
  // are otherwise invisible until someone opens a large photo.

  const zoomBundle = path.join(os.tmpdir(), "ib-zoom.build.cjs");
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", "src", "zoom.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "es2018",
    outfile: zoomBundle,
    logLevel: "silent",
  });
  const Z = require(zoomBundle);
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

  // --- fit and initial scale ---
  check("zoom: fit is the tighter of the two axes", Z.fitScale(2000, 1000, 800, 600), 0.4);
  check("zoom: an oversized scan opens downscaled", Z.initialScale(4000, 3000, 800, 600), 0.2);
  check("zoom: a small icon opens at 1:1, never blown up", Z.initialScale(40, 40, 800, 600), 1);
  check("zoom: a degenerate size cannot divide by zero", Z.fitScale(0, 0, 800, 600), 1);

  const big = Z.makeBounds(2000, 1000, 800, 600);
  check("zoom: the floor is the fit scale", big.minScale, 0.4);
  check("zoom: there is headroom past 100% for pixel peeping", big.maxScale, 4);

  // --- pan clamping ---
  const smallBounds = Z.makeBounds(100, 100, 800, 600);
  const recentred = Z.clampPan({ scale: 1, tx: 999, ty: -999 }, smallBounds);
  check("zoom: a picture smaller than the stage is centred (x)", recentred.tx, 350);
  check("zoom: a picture smaller than the stage is centred (y)", recentred.ty, 250);
  const snapped = Z.clampPan({ scale: 1, tx: 9999, ty: -9999 }, big);
  check("zoom: panning off the left edge snaps back", snapped.tx, 0);
  check("zoom: panning off the bottom edge snaps back", snapped.ty, -400);

  const panned = Z.panBy({ scale: 1, tx: 0, ty: 0 }, -100, -50, big);
  check("zoom: a drag moves the picture", panned.tx, -100);
  check("zoom: a drag is clamped at the edge", Z.panBy({ scale: 1, tx: 0, ty: 0 }, -9999, 0, big).tx, -1200);

  // --- the cursor is the anchor (the whole point of a wheel zoom) ---
  const start = Z.centered(0.4, big);
  check("zoom: opens centred on the short axis", start.ty, 100);
  const zoomed = Z.zoomAt(start, 400, 300, 0.8, big);
  const anchorX = zoomed.tx + zoomed.scale * ((400 - start.tx) / start.scale);
  const anchorY = zoomed.ty + zoomed.scale * ((300 - start.ty) / start.scale);
  check("zoom: the pixel under the cursor stays put (x)", near(anchorX, 400), true);
  check("zoom: the pixel under the cursor stays put (y)", near(anchorY, 300), true);
  check("zoom: zooming in magnifies", zoomed.scale, 0.8);

  // --- limits ---
  check("zoom: cannot exceed the ceiling", Z.zoomAt(start, 0, 0, 999, big).scale, 4);
  check("zoom: cannot fall below fit", Z.zoomAt(start, 0, 0, 0.001, big).scale, 0.4);
  check(
    "zoom: a clamped no-op returns the same object",
    Z.zoomAt(start, 0, 0, 0.4, big) === start,
    true
  );
  check("zoom: nothing to pan while fitted", Z.canPan(start, big), false);
  check("zoom: panning unlocks once magnified", Z.canPan({ scale: 1, tx: 0, ty: 0 }, big), true);

  // --- readout and the double-click cycle ---
  check("zoom: the readout is the scale as a percentage", Z.percentOf(0.4), 40);
  check("zoom: 100% counts as native", Z.isNative({ scale: 1, tx: 0, ty: 0 }), true);
  check("zoom: the fit scale counts as fitted", Z.isFitted(start, big), true);
  check("zoom: cycle → from fit to 100%", Z.nextToggleScale(start, big), 1);
  check("zoom: cycle → from 100% to 200%", Z.nextToggleScale({ scale: 1, tx: 0, ty: 0 }, big), 2);
  check("zoom: cycle → from 200% back to fit", Z.nextToggleScale({ scale: 2, tx: 0, ty: 0 }, big), 0.4);

  // --- wheel normalisation ---
  check(
    "wheel: a line-mode mouse matches a pixel-mode trackpad",
    near(Z.wheelFactor(3, 1), Z.wheelFactor(48, 0)),
    true
  );
  check("wheel: scrolling up magnifies", Z.wheelFactor(-120, 0) > 1, true);
  check(
    "wheel: zooming in and back out lands on the same scale",
    near(Z.wheelFactor(-120, 0) * Z.wheelFactor(120, 0), 1),
    true
  );

  // --- the tile itself ---
  // 01_Resources still holds pictures at this point; the fixture folder
  // 00_Attachments/Images was emptied by the move and delete cases above.
  plugin.settings.thumbnailFit = "pad";
  plugin.settings.refFilter = "all";
  plugin.settings.showRefBadges = false;
  plugin.settings.folderFirst = true;
  view.query = "";
  view.enter("01_Resources");

  const tile = view.contentEl.querySelector(".ib-card-image");
  const backdrop = tile.querySelector(".ib-thumb-fill");
  const picture = tile.querySelector(".ib-thumb-img");

  check("tile: there is a backdrop element behind the picture", !!backdrop, true);
  check("tile: there is a picture element on top", !!picture, true);
  check(
    "tile: the backdrop reuses the picture's bytes (no second request)",
    backdrop.getAttribute("src"),
    picture.getAttribute("src")
  );
  check(
    "tile: the backdrop is decorative, not content",
    backdrop.getAttribute("aria-hidden"),
    "true"
  );
  check("tile: the backdrop carries no alt text", backdrop.getAttribute("alt"), "");
  // No alt on the tile img: the caption below the tile already says the name,
  // and an img with no src yet (thumbnail pending) would render alt as text.
  check("tile: the picture carries no alt text of its own", picture.getAttribute("alt"), "");
  const order = Array.from(tile.querySelector(".ib-thumb").children);
  check(
    "tile: the backdrop is mounted first, so DOM order does the layering",
    order.indexOf(backdrop) < order.indexOf(picture),
    true
  );

  // --- one meta line, and it swaps content instead of stacking ---
  check("tile: exactly one meta line", tile.querySelectorAll(".ib-meta").length, 1);
  check("tile: the old path line is gone", tile.querySelectorAll(".ib-subcaption").length, 0);
  check(
    "tile: browsing shows the size only, no location",
    tile.querySelector(".ib-meta").textContent.includes(" · "),
    false
  );

  view.query = "img";
  view.refresh();
  const searched = view.contentEl.querySelector(".ib-card-image");
  check("tile: searching still renders one meta line", searched.querySelectorAll(".ib-meta").length, 1);
  const searchedMeta = searched.querySelector(".ib-meta").textContent;
  check(
    "tile: searching folds the location into that line",
    searchedMeta.includes(" · "),
    true
  );
  check(
    "tile: ...and the size survives alongside it",
    /(B|KB|MB|GB)$/.test(searchedMeta),
    true
  );
  check(
    "tile: the caption block never changes height",
    searched.querySelectorAll(".ib-subcaption").length,
    0
  );
  view.query = "";
  view.refresh();

  // --- fill mode is one class on the shell ---
  plugin.settings.thumbnailFit = "crop";
  view.refresh();
  check(
    "tile: crop mode is a single class on the shell",
    view.contentEl.classList.contains("is-crop-thumbs"),
    true
  );
  plugin.settings.thumbnailFit = "pad";
  view.refresh();
  check(
    "tile: leaving crop mode takes it off again",
    view.contentEl.classList.contains("is-crop-thumbs"),
    false
  );

  // --- the lightbox, driven through the real class -------------------------
  //
  // openDetail() is the production path into ImageDetailModal, so this
  // exercises the actual gesture wiring rather than a mirror of it. jsdom has
  // no layout, so the two things the modal would normally read from it —
  // natural size and stage size — are pinned with defineProperty.
  view.enter("01_Resources");
  const detailIdx = view.visible.findIndex((e) => e.path === "01_Resources/img-5.png");
  check("lightbox: there is something to open", detailIdx >= 0, true);

  view.openDetail("01_Resources/img-5.png");
  const modal = modals[modals.length - 1];
  check("lightbox: it is the detail modal", !!modal, true);
  modal.onOpen();
  check(
    "lightbox: the modal is titled for the image",
    modal.contentEl.querySelector(".ib-detail-title").textContent,
    "img-5.png"
  );

  const stage = modal.contentEl.querySelector(".ib-detail-stage");
  const lboxImg = modal.contentEl.querySelector(".ib-detail-img");
  const pct = modal.contentEl.querySelector(".ib-zoom-pct");
  check("lightbox: there is a stage", !!stage, true);
  check("lightbox: the image starts unfitted", lboxImg.style.transform, "");
  check("lightbox: a zoom readout exists", pct.textContent, "100%");

  Object.defineProperty(lboxImg, "naturalWidth", { value: 2000, configurable: true });
  Object.defineProperty(lboxImg, "naturalHeight", { value: 1000, configurable: true });
  Object.defineProperty(stage, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(stage, "clientHeight", { value: 600, configurable: true });
  lboxImg.dispatchEvent(new window.Event("load"));

  check(
    "lightbox: opening sizes the image in image pixels",
    lboxImg.style.width + "/" + lboxImg.style.height,
    "2000px/1000px"
  );
  check(
    "lightbox: it opens fitted and centred",
    lboxImg.style.transform,
    "translate(0px, 100px) scale(0.4)"
  );
  check("lightbox: the readout follows", pct.textContent, "40%");
  check(
    "lightbox: the fit button is named as the active one",
    modal.contentEl.querySelector(".ib-zoom-btn.is-fit").classList.contains("is-active"),
    true
  );

  // --- arrival vs. zoom: the first fit is not an animation -------------------
  //
  // The picture used to be fitted through the same transition the zoom buttons
  // use, so opening a large photo painted it at natural size for a frame and
  // then visibly shrank it into the well — a layout bug to the eye, not an
  // entrance. It also repeated on every page turn, since each ← / → builds a
  // fresh <img>. The picture now fades in (is-ready) and only discrete jumps
  // get the transform transition (is-animating).
  check(
    "lightbox: opening does not animate the fit",
    lboxImg.classList.contains("is-animating"),
    false
  );
  check(
    "lightbox: the picture is revealed once it is fitted",
    lboxImg.classList.contains("is-ready"),
    true
  );

  // --- the wheel zooms about the cursor ---
  const wheel = (deltaY, x, y) => {
    const e = new window.Event("wheel", { bubbles: true, cancelable: true });
    e.deltaY = deltaY;
    e.deltaMode = 0;
    e.clientX = x;
    e.clientY = y;
    stage.dispatchEvent(e);
    return e;
  };
  check("lightbox: the wheel is claimed", wheel(-120, 400, 300).defaultPrevented, true);
  const afterWheel = /scale\(([\d.]+)\)/.exec(lboxImg.style.transform)[1];
  check("lightbox: the wheel magnifies", +afterWheel > 0.4, true);
  check("lightbox: the wheel is not a fixed step", +afterWheel > 0.45, true);
  check(
    "lightbox: the readout tracks the wheel",
    pct.textContent,
    Math.round(+afterWheel * 100) + "%"
  );

  // --- buttons step, and the two named scales are reachable ---
  const scaleBeforeStep = +/scale\(([\d.]+)\)/.exec(lboxImg.style.transform)[1];
  modal.contentEl.querySelector(".ib-zoom-btn.is-in").dispatchEvent(
    new window.Event("click", { bubbles: true })
  );
  const afterIn = +/scale\(([\d.]+)\)/.exec(lboxImg.style.transform)[1];
  check(
    "lightbox: + magnifies by one step",
    near(afterIn / scaleBeforeStep, Z.ZOOM_STEP, 1e-3),
    true
  );
  check(
    "lightbox: a discrete jump is animated",
    lboxImg.classList.contains("is-animating"),
    true
  );
  // ...but a gesture that lands mid-flight has to drop it, or the picture
  // trails the pointer by the length of the easing.
  wheel(-120, 400, 300);
  check(
    "lightbox: the wheel drops that animation immediately",
    lboxImg.classList.contains("is-animating"),
    false
  );

  modal.contentEl.querySelector(".ib-zoom-btn.is-native").dispatchEvent(
    new window.Event("click", { bubbles: true })
  );
  check("lightbox: the 1:1 button lands on 100%", pct.textContent, "100%");
  check(
    "lightbox: and hides a picture twice the stage wide",
    /translate\(-?\d/.test(lboxImg.style.transform),
    true
  );

  modal.contentEl.querySelector(".ib-zoom-btn.is-fit").dispatchEvent(
    new window.Event("click", { bubbles: true })
  );
  check("lightbox: the fit button returns to the fit scale", pct.textContent, "40%");

  const outBtn = modal.contentEl.querySelector(".ib-zoom-btn.is-out");
  outBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  check("lightbox: − cannot zoom out past fit", pct.textContent, "40%");

  // --- dragging pans, and a drag is not a click ---
  const pointer = (type, x, y) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    e.button = 0;
    e.clientX = x;
    e.clientY = y;
    stage.dispatchEvent(e);
    return e;
  };
  modal.contentEl.querySelector(".ib-zoom-btn.is-native").dispatchEvent(
    new window.Event("click", { bubbles: true })
  );
  const beforeDrag = lboxImg.style.transform;
  pointer("pointerdown", 400, 300);
  pointer("pointermove", 340, 260);
  pointer("pointerup", 340, 260);
  const afterDrag = lboxImg.style.transform;
  check("lightbox: a drag pans the picture", afterDrag !== beforeDrag, true);
  check("lightbox: the drag did not also toggle", pct.textContent, "100%");
  check(
    "lightbox: panning is clamped, so the picture cannot leave the stage",
    /translate\((-?\d+(\.\d+)?)px, (-?\d+(\.\d+)?)px\)/.test(afterDrag),
    true
  );

  // A press that never moves is a click, and should cycle the zoom.
  const beforeClick = pct.textContent;
  pointer("pointerdown", 400, 300);
  pointer("pointerup", 400, 300);
  check("lightbox: a click still cycles the zoom", pct.textContent !== beforeClick, true);

  // --- keys ---
  const press = (key) => {
    const e = { preventDefault() {} };
    const fn = modal.scope.handlers[key];
    if (fn) fn(e);
    return !!fn;
  };
  check("lightbox: + is bound", press("+"), true);
  modal.contentEl.querySelector(".ib-zoom-btn.is-fit").dispatchEvent(
    new window.Event("click", { bubbles: true })
  );
  press("+");
  check("lightbox: the + key magnifies", pct.textContent !== "40%", true);
  press("0");
  check("lightbox: 0 returns to fit", pct.textContent, "40%");
  press("1");
  check("lightbox: 1 jumps to 100%", pct.textContent, "100%");

  // --- paging keeps the zoom from leaking across images ---
  const pageTo = modal.scope.handlers["ArrowRight"];
  check("lightbox: arrow keys are bound for paging", !!pageTo, true);
  pageTo({ preventDefault() {} });
  check(
    "lightbox: paging shows a different image",
    modal.contentEl.querySelector(".ib-detail-title").textContent !== "img-5.png",
    true
  );
  check(
    "lightbox: paging resets the zoom instead of keeping the old transform",
    modal.contentEl.querySelector(".ib-detail-img").style.transform,
    ""
  );
  check(
    "lightbox: a page turn arrives the same way, without an animated fit",
    modal.contentEl.querySelector(".ib-detail-img").classList.contains("is-animating"),
    false
  );

  modal.onClose();
  check("lightbox: closing tears the body down", modal.contentEl.childElementCount, 0);

  // --- the motion preference is one attribute on <body> ---------------------
  //
  // Every duration in styles.css comes from a custom property that hangs off
  // this attribute; the modals live outside the view's DOM, so <body> is the
  // only scope that reaches them all.
  plugin.settings.motion = "reduced";
  await plugin.saveSettings();
  check(
    "motion: the setting reaches the document",
    document.body.getAttribute("data-ib-motion"),
    "reduced"
  );
  plugin.settings.motion = "full";
  await plugin.saveSettings();
  check(
    "motion: and follows it back",
    document.body.getAttribute("data-ib-motion"),
    "full"
  );

  // ====================== v0.5: nav, heatmap, settings, export, caching =====

  // A dedicated folder, so the identity checks below cannot pass by comparing
  // two empty panes.
  const navFolder = await seedFolder("08_Nav");
  await seedFile("08_Nav/x.png");
  await seedFile("08_Nav/y.png");
  view.enter("08_Nav");

  // --- the pane switcher -----------------------------------------------------
  const navBtn = (pane) => view.contentEl.querySelector(`.ib-nav-btn[data-pane="${pane}"]`);
  const navBtns = () =>
    Array.from(view.contentEl.querySelectorAll(".ib-nav-btn"));

  check("nav: three buttons", navBtns().length, 3);
  check(
    "nav: manage / heatmap / settings, in that order",
    navBtns().map((b) => b.getAttribute("data-pane")).join(","),
    "manage,heatmap,settings"
  );
  check(
    "nav: and labelled in the requested words",
    navBtns().map((b) => b.querySelector(".ib-nav-label").textContent).join(","),
    "管理,热力图,设置"
  );
  check(
    "nav: every button carries an icon",
    navBtns().every(
      (b) =>
        b.querySelector(".ib-nav-icon").childElementCount > 0 ||
        b.querySelector(".ib-nav-icon").hasAttribute("data-icon")
    ),
    true
  );
  check("nav: the strip is a tablist", view.contentEl.querySelector(".ib-nav").getAttribute("role"), "tablist");
  check("nav: buttons declare themselves as tabs", navBtns().every((b) => b.getAttribute("role") === "tab"), true);
  check("nav: the manager is what opens", view.activePane, "manage");
  check("nav: exactly one pane is shown", view.contentEl.querySelectorAll(".ib-pane.is-active").length, 1);
  check(
    "nav: and it is the manager",
    view.contentEl.querySelector(".ib-pane.is-active").getAttribute("data-pane"),
    "manage"
  );
  check("nav: aria-selected agrees", navBtn("manage").getAttribute("aria-selected"), "true");

  // The three panes stay mounted; switching only toggles a class. That is what
  // makes coming back free, so it is worth asserting rather than assuming.
  const manageGrid = view.contentEl.querySelector('.ib-pane[data-pane="manage"] .ib-grid');
  const manageCard = view.contentEl.querySelector('.ib-pane[data-pane="manage"] .ib-card');
  ok("nav: the manager pane has something to preserve", manageGrid !== null && manageCard !== null);
  view.toggleSelect("08_Nav/x.png");
  check("nav: a selection is in place before switching", view.selection.size, 1);

  view.showPane("heatmap");
  check("nav: switching pane", view.activePane, "heatmap");
  check("nav: aria-selected follows", navBtn("heatmap").getAttribute("aria-selected"), "true");
  check("nav: the tab we left is unselected", navBtn("manage").getAttribute("aria-selected"), "false");
  check(
    "nav: the heatmap is the visible pane",
    view.contentEl.querySelector(".ib-pane.is-active").getAttribute("data-pane"),
    "heatmap"
  );
  check("nav: switching does not unmount the grid", view.contentEl.querySelector('.ib-pane[data-pane="manage"] .ib-grid'), manageGrid);
  check("nav: nor rebuild the cards", view.contentEl.querySelector('.ib-pane[data-pane="manage"] .ib-card'), manageCard);

  view.showPane("manage");
  check("nav: coming back keeps the selection", view.selection.size, 1);
  check("nav: and keeps the very same nodes", view.contentEl.querySelector('.ib-pane[data-pane="manage"] .ib-card'), manageCard);
  view.selection.clear();

  // --- the heatmap pane ------------------------------------------------------
  view.showPane("heatmap");
  const heat = view.contentEl.querySelector(".ib-heat");
  check("heatmap: the pane renders one", heat !== null, true);

  const heatCells = () => Array.from(view.contentEl.querySelectorAll(".ib-heat-cells > .ib-heat-cell"));
  const dayCell = (date) => heatCells().find((c) => c.getAttribute("data-date") === date);
  ok("heatmap: a full year of cells", heatCells().length >= 365);
  check("heatmap: seven cells per column", heatCells().length % 7, 0);
  check(
    "heatmap: one month slot per column",
    view.contentEl.querySelectorAll(".ib-heat-month").length,
    heatCells().length / 7
  );
  ok("heatmap: the month axis is labelled", view.contentEl.querySelectorAll(".ib-heat-month:not(.is-blank)").length >= 8);
  check(
    "heatmap: the weekday axis shows MON / WED / FRI and nothing else",
    Array.from(view.contentEl.querySelectorAll(".ib-heat-weekday")).map((e) => e.textContent).join(","),
    "MON,WED,FRI"
  );
  check(
    "heatmap: ...on rows 2, 4 and 6, spaced like GitHub's",
    Array.from(view.contentEl.querySelectorAll(".ib-heat-weekday")).map((e) => e.style.gridRow).join(","),
    "2,4,6"
  );
  check(
    "heatmap: every cell carries a yyyy-mm-dd date",
    heatCells().every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.getAttribute("data-date"))),
    true
  );
  check("heatmap: exactly one cell is today", heatCells().filter((c) => c.classList.contains("is-today")).length, 1);

  // Padding days outside the window exist but are marked, so the grid can be a
  // clean rectangle without the chart pretending those days are data.
  ok("heatmap: leading padding is flagged rather than drawn as data", heatCells().some((c) => c.classList.contains("is-out")));

  const legend = Array.from(view.contentEl.querySelectorAll(".ib-heat-legend .ib-heat-cell"));
  check("heatmap: the legend has a swatch per level, per direction", legend.length, 8);
  check(
    "heatmap: the ramp is drawn 减少 4..1 then 增加 1..4",
    legend.map((e) => `${e.getAttribute("data-dir")}${e.getAttribute("data-level")}`).join(" "),
    "down4 down3 down2 down1 up1 up2 up3 up4"
  );
  check(
    "heatmap: 减少 and 增加 bracket the ramp, as asked",
    Array.from(view.contentEl.querySelectorAll(".ib-heat-legend-label")).map((e) => e.textContent).join(","),
    "减少,增加"
  );
  check("heatmap: the legend sits in the chart's bottom-right", view.contentEl.querySelector(".ib-heat-foot .ib-heat-legend") !== null, true);

  // The two things this chart must not lie about.
  ok(
    "heatmap: a day with no snapshot is not drawn as a day with no change",
    heatCells().some((c) => c.getAttribute("data-dir") === "none") &&
      heatCells().some((c) => c.getAttribute("data-dir") === "base")
  );

  // --- the hover bubble ------------------------------------------------------
  const tip = view.contentEl.querySelector(".ib-heat-tip");
  check("heatmap: the bubble starts hidden", tip.classList.contains("is-hidden"), true);

  const todayCell = heatCells().find((c) => c.classList.contains("is-today"));
  todayCell.dispatchEvent(new window.Event("mouseover", { bubbles: true }));
  check("heatmap: hovering a cell reveals it", tip.classList.contains("is-hidden"), false);
  check(
    "heatmap: it names the exact date",
    tip.querySelector(".ib-heat-tip-date").textContent.startsWith(todayCell.getAttribute("data-date")),
    true
  );
  ok("heatmap: it reports the change", tip.querySelector(".ib-heat-tip-change").textContent.length > 0);
  ok("heatmap: and the running total", tip.querySelector(".ib-heat-tip-total").textContent.length > 0);
  check(
    "heatmap: the bubble matches whatever the cell carries",
    tip.querySelector(".ib-heat-tip-change").textContent,
    todayCell.getAttribute("data-tip-change")
  );
  // The flip is a property of the *row*, not of today's weekday — pinning it
  // to the today cell made this suite green only on Sundays. Hover whatever
  // cell actually sits in row 0.
  const firstRowCell = heatCells().find((c) => c.getAttribute("data-row") === "0");
  firstRowCell.dispatchEvent(new window.Event("mouseover", { bubbles: true }));
  check(
    "heatmap: a first-row cell flips the bubble below it, so it cannot leave the pane",
    tip.classList.contains("is-below"),
    true
  );

  const middleCell = heatCells().find((c) => c.getAttribute("data-row") === "3");
  middleCell.dispatchEvent(new window.Event("mouseover", { bubbles: true }));
  check("heatmap: a mid-grid cell keeps the bubble above it", tip.classList.contains("is-below"), false);
  check(
    "heatmap: and the bubble followed the pointer",
    tip.querySelector(".ib-heat-tip-date").textContent.startsWith(middleCell.getAttribute("data-date")),
    true
  );

  view.contentEl.querySelector(".ib-heat").dispatchEvent(new window.Event("mouseleave"));
  check("heatmap: leaving the chart hides it again", tip.classList.contains("is-hidden"), true);

  // The pointer is still *inside* `.ib-heat` here, so `mouseleave` never fires.
  // Sliding from a square onto the legend (or the month row, or the padding)
  // used to leave the bubble anchored to a square nobody was pointing at.
  view.contentEl
    .querySelector(".ib-heat-legend .ib-heat-cell")
    .dispatchEvent(new window.Event("mouseover", { bubbles: true }));
  check(
    "heatmap: moving off a square onto the legend hides the bubble",
    tip.classList.contains("is-hidden"),
    true
  );

  const unrecorded = heatCells().find((c) => c.getAttribute("data-dir") === "none");
  unrecorded.dispatchEvent(new window.Event("mouseover", { bubbles: true }));
  check(
    "heatmap: an unobserved day says so rather than reporting zero",
    tip.querySelector(".ib-heat-tip-change").textContent,
    "无记录"
  );
  check(
    "heatmap: ...and has no total to show",
    tip.querySelector(".ib-heat-tip-total").textContent,
    ""
  );
  view.contentEl.querySelector(".ib-heat").dispatchEvent(new window.Event("mouseleave"));

  // --- the settings pane -----------------------------------------------------
  view.showPane("settings");
  const panel = view.contentEl.querySelector('.ib-pane[data-pane="settings"]');
  check("settings view: the pane renders the panel", panel.classList.contains("ib-settings"), true);
  check("settings view: grouped", panel.querySelectorAll(".ib-settings-group").length, 4);
  check(
    "settings view: with the same four headings",
    Array.from(panel.querySelectorAll(".ib-settings-title")).map((e) => e.textContent).join(","),
    "目录与扫描,显示,行为,维护"
  );

  const panelRows = Array.from(panel.querySelectorAll(".setting-item"));
  const rowNamed = (name) =>
    panelRows.find((r) => r.querySelector(".setting-item-name").textContent === name);
  const rowNames = () => panelRows.map((r) => r.querySelector(".setting-item-name").textContent);

  check("settings view: a row for every setting plus the two maintenance actions", panelRows.length, 14 + 2);
  check("settings view: no blank rows", rowNames().filter((n) => !n).length, 0);
  check("settings view: rows read like Obsidian's own settings page", rowNames().slice(0, 3).join(","), "图片根目录,图片扩展名,缩略图尺寸");
  check("settings view: every row explains itself", panelRows.filter((r) => r.querySelector(".setting-item-description").textContent.length > 0).length >= 16, true);
  check("settings view: each row has exactly one control", panelRows.filter((r) => r.querySelector(".setting-item-control").childElementCount === 0).length, 0);

  // The footer is the one place a user can read the build they are on.
  const stamp = panel.querySelector(".ib-settings-stamp");
  check("settings view: the footer names the build", stamp.textContent, "Vault Gallery v" + manifest.version);
  check("settings view: and nothing else", stamp.textContent.length < 40, true);

  // Obsidian's own plugin tab must render the same list — the whole point of
  // describing the settings once.
  const tabHost = document.createElement("div");
  plugin._settingTab.containerEl = tabHost;
  plugin._settingTab.display();
  check("settings: the plugin tab renders the same number of rows", tabHost.querySelectorAll(".setting-item").length, panelRows.length);
  check(
    "settings: with the same names, in the same order",
    Array.from(tabHost.querySelectorAll(".setting-item-name")).map((e) => e.textContent).join(","),
    rowNames().join(",")
  );
  check("settings: and the same descriptions", Array.from(tabHost.querySelectorAll(".setting-item-description")).map((e) => e.textContent).join("|"), panelRows.map((r) => r.querySelector(".setting-item-description").textContent).join("|"));

  // Text: the debounce holds the write, blur commits it.
  const rootInput = rowNamed("图片根目录").querySelector('input[type="text"]');
  check("settings view: the root path is a text field", !!rootInput, true);
  check("settings view: seeded with the current value", rootInput.value, plugin.settings.rootPath);
  check("settings view: and with the placeholder that explains empty", rootInput.placeholder, "（留空 = 整个 vault）");
  rootInput.value = "01_Resources";
  rootInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  check("settings view: typing alone does not rescan the vault", plugin.settings.rootPath, "");
  rootInput.dispatchEvent(new window.Event("blur", { bubbles: true }));
  check("settings view: leaving the field commits it", plugin.settings.rootPath, "01_Resources");
  rootInput.value = "";
  rootInput.dispatchEvent(new window.Event("blur", { bubbles: true }));
  check("settings view: and an empty field means the whole vault again", plugin.settings.rootPath, "");

  // Toggle.
  const previewToggle = rowNamed("目录卡预览内部图片").querySelector('input[type="checkbox"]');
  check("settings view: a boolean is a checkbox", !!previewToggle, true);
  check("settings view: whose state follows the setting", previewToggle.checked, true);
  previewToggle.checked = false;
  previewToggle.dispatchEvent(new window.Event("change", { bubbles: true }));
  check("settings view: unchecking writes false", plugin.settings.folderPreview, false);
  previewToggle.checked = true;
  previewToggle.dispatchEvent(new window.Event("change", { bubbles: true }));
  check("settings view: and checking writes it back", plugin.settings.folderPreview, true);

  // Slider: `change` fires on release, not during the drag.
  const sizeSlider = rowNamed("缩略图尺寸").querySelector('input[type="range"]');
  check("settings view: the thumbnail size is a slider", !!sizeSlider, true);
  check("settings view: bounded by the declared range", `${sizeSlider.min}-${sizeSlider.max}`, "96-280");
  sizeSlider.value = "200";
  sizeSlider.dispatchEvent(new window.Event("change", { bubbles: true }));
  check("settings view: releasing writes the value", plugin.settings.thumbnailSize, 200);

  // Dropdown.
  const fitSelect = rowNamed("缩略图填充方式").querySelector("select");
  check("settings view: a choice is a dropdown", !!fitSelect, true);
  check(
    "settings view: listing the declared options",
    Array.from(fitSelect.options).map((o) => o.value).join(","),
    "pad,crop"
  );
  fitSelect.value = "crop";
  fitSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
  check("settings view: choosing writes the value", plugin.settings.thumbnailFit, "crop");

  // The crop mode is also the one perf change that shows in the DOM: with the
  // picture covering the cell there is nothing to pad, so the blurred backdrop
  // is not built at all rather than built and hidden.
  view.enter("08_Nav");
  check("perf: crop mode builds no blurred backdrop", view.contentEl.querySelectorAll(".ib-thumb-fill").length, 0);
  check("perf: ...but still draws every picture", view.contentEl.querySelectorAll(".ib-thumb-img").length, 2);

  plugin.settings.thumbnailFit = "pad";
  view.enter("08_Nav");
  check("perf: pad mode builds it again, one per picture", view.contentEl.querySelectorAll(".ib-thumb-fill").length, 2);

  plugin.settings.thumbnailSize = 148;
  view.enter("08_Nav");

  // --- the caching contract --------------------------------------------------
  //
  // This is the performance work stated as a property rather than a stopwatch:
  // reading the store must not re-walk the vault, and only an explicit
  // invalidation may cost a walk. `generation` counts rebuilds.
  const walkCount = () => store.generation;
  const g0 = walkCount();
  view.paint(true);
  check("perf: a full repaint does not re-walk the vault", walkCount(), g0);
  view.renderGrid({ resetScroll: false });
  check("perf: re-rendering the grid does not re-walk the vault", walkCount(), g0);
  view.wrapEl.scrollTop = 300;
  view.paint(false);
  view.paint(false);
  check("perf: scrolling does not re-walk the vault", walkCount(), g0);
  check("perf: every accessor serves the same list", store.scanImages() === store.scanImages(), true);
  walkCount();
  store.scanImages();
  store.buildTree();
  store.countReferenced();
  store.folderCount();
  store.countByExtension();
  check("perf: reading through all of them still walks at most once", walkCount() - g0, 0);

  // A repaint is what shows a change; only a vault change may invalidate.
  view.refresh();
  check("perf: an explicit refresh is the one thing that re-walks", walkCount(), g0 + 1);

  // --- vault events are coalesced --------------------------------------------
  //
  // 60 files landing one at a time — a bulk import — must cost one walk, and
  // must be visible immediately: a deferred invalidation would leave anything
  // that reads the store before the debounce elapses looking at a stale vault.
  const burst = await seedFolder("09_Burst");
  // The settings writes above each end in their own asynchronous refresh. Let
  // those land before the counter is captured, or they get charged to the burst.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const gBefore = walkCount();
  for (let i = 0; i < 60; i++) await seedFile(`09_Burst/b-${String(i).padStart(2, "0")}.png`);
  check("perf: 60 vault events cost exactly one re-walk", walkCount() - gBefore, 1);
  check(
    "perf: and nothing reads a stale vault in the meantime",
    store.findNode(store.buildTree(), "09_Burst") !== null,
    true
  );
  check(
    "perf: all 60 files are picked up",
    store.scanImages().filter((i) => i.path.startsWith("09_Burst/")).length,
    60
  );
  view.enter("09_Burst");
  check("perf: and the grid can show them without waiting on a timer", view.items.length, 60);
  dropNode(burst);
  view.enter("00_Attachments/Images");

  // --- the snapshot ledger ---------------------------------------------------
  const pad2 = (n) => String(n).padStart(2, "0");
  const nowDate = new Date();
  const todayKeyNow = `${nowDate.getFullYear()}-${pad2(nowDate.getMonth() + 1)}-${pad2(nowDate.getDate())}`;

  check(
    "history: kept beside the plugin, not inside data.json",
    plugin.history.filePath.endsWith("history.json") && !plugin.history.filePath.includes("data.json"),
    true
  );
  check("history: today's total was recorded when the plugin loaded", typeof plugin.history.snapshot[todayKeyNow], "number");
  await plugin.history.flush();
  const historyFile = app.vault.adapter.files.get(plugin.history.filePath);
  check("history: and survives to disk", typeof historyFile, "string");
  check(
    "history: as JSON keyed by local date",
    typeof JSON.parse(historyFile)[todayKeyNow],
    "number"
  );
  check("history: it is written under the plugin directory", plugin.history.filePath.includes("/plugins/vault-gallery/"), true);
  check(
    "history: and holds nothing but dated totals",
    Object.keys(JSON.parse(historyFile)).every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)),
    true
  );

  // --- the export entry points ------------------------------------------------
  //
  // The harness has no filesystem behind window.require, which is exactly the
  // "no Electron" case: the flow must build its file list and then fail
  // honestly, never half-write or throw out of a click handler.
  const modalsBefore = modals.length;
  plugin.openZipExport("08_Nav");
  check("export: opening the ZIP dialog mounts a modal", modals.length, modalsBefore + 1);
  const zipModal = modals[modals.length - 1];
  zipModal.onOpen();
  check("export: the dialog is titled with the scope", zipModal.titleEl.textContent.includes("08_Nav"), true);
  check(
    "export: it states how many files and how large",
    zipModal.contentEl.querySelector(".ib-export-count").textContent,
    "2 个文件 · 240 KB"
  );
  check(
    "export: it names the folder being exported",
    zipModal.contentEl.querySelector(".ib-export-path").textContent,
    "08_Nav"
  );
  ok("export: the password field starts disabled", zipModal.contentEl.querySelector('input[type="text"]').disabled);

  // The toggle enables the field and fills it in, which is the whole point of
  // the feature: nobody wants to invent a six-digit number.
  const pwToggle = zipModal.contentEl.querySelector('input[type="checkbox"]');
  pwToggle.checked = true;
  pwToggle.dispatchEvent(new window.Event("change", { bubbles: true }));
  const pwField = zipModal.contentEl.querySelector('input[type="text"]');
  check("export: turning the password on enables the field", pwField.disabled, false);
  check("export: and generates a six-digit one for you", /^\d{6}$/.test(pwField.value), true);
  check(
    "export: the dialog says which encryption it uses and why",
    zipModal.contentEl.textContent.includes("ZipCrypto"),
    true
  );
  zipModal.onClose();

  // No filesystem: the info export must report the failure, not throw.
  notices.length = 0;
  const infoResult = await plugin.exportInfoJson();
  check("export: the JSON export fails closed with no filesystem", infoResult, null);
  ok("export: and says so", notices.some((n) => n.includes("导出失败")));

  console.log("\n== all checks complete");
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("FAILURES:", failed.map((f) => f.label).join(", "));
    process.exit(1);
  }
  // Timers the plugin registered (the vault debounce, the 5-minute snapshot
  // interval) would otherwise keep the process alive after the last assertion.
  await plugin.onunload();
  process.exit(0);
})().catch((err) => {
  console.error("\n!! smoke test threw:\n", err);
  process.exit(1);
});

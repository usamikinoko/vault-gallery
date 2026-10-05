/*
 * The settings, described once.
 *
 * There are two places a user can change these — the plugin's own settings view
 * and Obsidian's plugin tab — and a third that reads them (the JSON export).
 * Keeping the list here means there is exactly one place to add a setting, and
 * one place where its label, explanation and control type are decided; the
 * renderers below are dumb loops over this array.
 *
 * The kind-specific defaults (`encode` / `decode`) exist so neither renderer has
 * to know that "the image extensions text field holds a comma-separated string
 * but the setting is an array" and similar trivia.
 */

import type { VaultGallerySettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

export type ControlKind = "text" | "slider" | "toggle" | "dropdown";

export interface ControlSpec {
  kind: ControlKind;
  /** Text only. */
  placeholder?: string;
  /** Slider only. */
  min?: number;
  max?: number;
  step?: number;
  /** Dropdown only. */
  options?: Array<{ value: string; label: string }>;
}

export interface SettingSpec {
  key: keyof VaultGallerySettings;
  name: string;
  desc: string;
  control: ControlSpec;
  /** Raw control value to stored value. Falls back to the kind's default. */
  encode?: (raw: string, current: VaultGallerySettings) => unknown;
  /** Stored value to control value. Falls back to the kind's default. */
  decode?: (value: unknown) => string;
  /** Show the value next to the label in the JSON export summary. */
  format?: (value: unknown) => string;
  /** Hidden when this returns false. */
  visible?: (s: VaultGallerySettings) => boolean;
}

/** An action row: a button that does something rather than storing a value. */
export interface ActionSpec {
  key: string;
  name: string;
  desc: string;
  button: string;
  warning?: boolean;
}

export interface SettingsGroup {
  title: string;
  hint?: string;
  settings: SettingSpec[];
  actions?: ActionSpec[];
}

const REF_FILTER_OPTIONS = [
  { value: "all", label: "全部图片" },
  { value: "unreferenced", label: "仅未引用的图片" },
  { value: "referenced", label: "仅已被引用的图片" },
];

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    title: "目录与扫描",
    settings: [
      {
        key: "rootPath",
        name: "图片根目录",
        desc: "vault 内相对路径，例如 01_Resources/Art。留空即整个 vault。",
        control: { kind: "text", placeholder: "（留空 = 整个 vault）" },
        encode: (raw) => raw.trim().replace(/^\/+|\/+$/g, ""),
        format: (v) => (String(v) ? String(v) : "（整个 vault）"),
      },
      {
        key: "imageExtensions",
        name: "图片扩展名",
        desc: "逗号或空格分隔，小写，不含点。",
        control: { kind: "text" },
        encode: (raw, current) => {
          const exts = raw
            .split(/[,\s]+/)
            .map((s) => s.trim().replace(/^\./, "").toLowerCase())
            .filter(Boolean);
          // An empty list would hide every image in the vault; keep the old
          // value rather than let a half-typed field blank the grid.
          return exts.length > 0 ? exts : current.imageExtensions;
        },
        decode: (v) => (Array.isArray(v) ? v.join(", ") : ""),
        format: (v) => (Array.isArray(v) ? v.join(" ") : ""),
      },
    ],
  },
  {
    title: "显示",
    settings: [
      {
        key: "thumbnailSize",
        name: "缩略图尺寸",
        desc: "网格列宽基准（像素）。",
        control: { kind: "slider", min: 96, max: 280, step: 4 },
        format: (v) => `${v} px`,
      },
      {
        key: "thumbnailFit",
        name: "缩略图填充方式",
        desc: "留白不裁切，空档用图片自身垫底；裁切填满更整齐，代价是切掉长边。",
        control: {
          kind: "dropdown",
          options: [
            { value: "pad", label: "留白（垫模糊底，不裁切）" },
            { value: "crop", label: "裁切填满（整齐的九宫格）" },
          ],
        },
      },
      {
        key: "showSubfolders",
        name: "在网格中显示子文件夹",
        desc: "关闭后只显示当前目录的图片。",
        control: { kind: "toggle" },
      },
      {
        key: "folderPreview",
        name: "目录卡预览内部图片",
        desc: "用目录里的前 3 张堆成封面；自己没有图片的目录借用子目录的封面。",
        control: { kind: "toggle" },
      },
      {
        key: "folderFirst",
        name: "文件夹排在图片前面",
        desc: "关闭后子目录与图片混排。",
        control: { kind: "toggle" },
      },
      {
        key: "showRefBadges",
        name: "显示引用标记",
        desc: "在缩略图上标出被引用次数；0 次显示「未引用」角标。",
        control: { kind: "toggle" },
      },
      {
        key: "motion",
        name: "界面动效",
        desc: "控制悬停、缩放、翻页过渡的时长。",
        control: {
          kind: "dropdown",
          options: [
            { value: "full", label: "完整" },
            { value: "reduced", label: "精简" },
            { value: "none", label: "关闭" },
          ],
        },
      },
    ],
  },
  {
    title: "行为",
    settings: [
      {
        key: "sortKey",
        name: "默认排序字段",
        desc: "自定义顺序需要先在网格里拖动过图片。",
        control: {
          kind: "dropdown",
          options: [
            { value: "name", label: "文件名" },
            { value: "mtime", label: "修改时间" },
            { value: "ctime", label: "创建时间" },
            { value: "size", label: "文件大小" },
            { value: "custom", label: "自定义顺序" },
          ],
        },
      },
      { key: "sortAsc", name: "升序", desc: "关闭则降序。", control: { kind: "toggle" } },
      {
        key: "refFilter",
        name: "默认引用筛选",
        desc: "打开视图时默认显示哪一类图片。",
        control: { kind: "dropdown", options: REF_FILTER_OPTIONS },
      },
      {
        key: "confirmDelete",
        name: "删除前确认",
        desc: "批量删除、删除目录前先列出清单。",
        control: { kind: "toggle" },
      },
      {
        key: "virtualThreshold",
        name: "虚拟滚动阈值",
        desc: "卡片数超过该值时只渲染可见的几十张。",
        control: { kind: "slider", min: 100, max: 2000, step: 50 },
        format: (v) => `${v} 张`,
      },
    ],
  },
  {
    title: "维护",
    settings: [],
    actions: [
      {
        key: "reset",
        name: "恢复默认设置",
        desc: "不影响热力图历史与你的文件。",
        button: "恢复默认",
        warning: true,
      },
      {
        key: "clearOrders",
        name: "清空自定义排序",
        desc: "",
        button: "全部清空",
        warning: true,
      },
    ],
  },
];

/** Every setting, flattened, in display order. */
export function allSettings(): SettingSpec[] {
  return SETTINGS_GROUPS.flatMap((g) => g.settings);
}

/** Raw control value to stored value, using the kind's default where unsure. */
export function encodeSetting(
  spec: SettingSpec,
  raw: string,
  current: VaultGallerySettings
): unknown {
  if (spec.encode) return spec.encode(raw, current);
  switch (spec.control.kind) {
    case "toggle":
      return raw === "true" || raw === "1";
    case "slider":
      return Number(raw);
    default:
      return raw;
  }
}

/** Stored value to the string a control holds. */
export function decodeSetting(spec: SettingSpec, value: unknown): string {
  if (spec.decode) return spec.decode(value);
  switch (spec.control.kind) {
    case "toggle":
      return value ? "true" : "false";
    default:
      return value === undefined || value === null ? "" : String(value);
  }
}

/**
 * A human-readable snapshot of the current settings, for the JSON export.
 * Keys follow the settings order so the file reads like the settings page.
 */
export function describeSettings(
  settings: VaultGallerySettings
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of allSettings()) {
    const value = settings[spec.key];
    const text = spec.format
      ? spec.format(value)
      : Array.isArray(value)
        ? value.join(", ")
        : typeof value === "object" && value !== null
          ? `${Object.keys(value as object).length} 项`
          : String(value);
    out[String(spec.key)] = text;
    out[`${String(spec.key)}__label`] = spec.name;
  }
  return out;
}

/** What "恢复默认设置" restores. Keeps what is not a preference. */
export function defaultedSettings(
  current: VaultGallerySettings
): VaultGallerySettings {
  return {
    ...DEFAULT_SETTINGS,
    // Where you were last looking is state, not a preference; and a reset that
    // silently drops every custom sort order would be destructive.
    lastPath: current.lastPath,
    customOrders: current.customOrders,
  };
}

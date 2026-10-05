import { setIcon } from "obsidian";
import type { ImageEntry } from "./types";

/*
 * Folder card cover art: the folder's first few images as a fanned pile of
 * prints. The pile *is* the card — no border, no fill, or it reads as a card
 * inside a card. A folder with nothing to show draws the same fan in blank
 * sheets, so an empty directory is still recognisably a folder.
 *
 * Layers are declarative: layer 0 is backmost, the last is the cover, and all
 * offsets are percentages of the layer box so the composition scales with the
 * thumbnail size slider for free.
 */

interface FanStep {
  /** Horizontal offset, in % of the layer box. */
  x: number;
  /** Vertical offset, in % of the layer box. */
  y: number;
  /** Rotation, in degrees. */
  r: number;
  /** Uniform scale. */
  s: number;
  /** Opacity, for depth. */
  o: number;
}

/** Pre-tuned compositions for 1–3 prints. Index = number of prints. */
const FANS: Record<number, FanStep[]> = {
  1: [{ x: 0, y: 0, r: 0, s: 1, o: 1 }],
  2: [
    { x: -6, y: -3, r: -4.5, s: 0.94, o: 0.9 },
    { x: 0, y: 0, r: 0, s: 1, o: 1 },
  ],
  3: [
    { x: -8, y: -6, r: -6, s: 0.87, o: 0.8 },
    { x: 7, y: -3, r: 4.5, s: 0.94, o: 0.9 },
    { x: 0, y: 0, r: 0, s: 1, o: 1 },
  ],
};

export const MAX_STACK_LAYERS = 3;
/** Sheets drawn for a directory with nothing to preview. */
export const PLACEHOLDER_LAYERS = 3;

export interface FolderStackOptions {
  /** Thumbnail host element; its contents are replaced. */
  host: HTMLElement;
  /** Up to three images, already ordered — index 0 becomes the cover. */
  images: ImageEntry[];
  /** Vault resource URL for an entry. */
  resolveSrc: (entry: ImageEntry) => string;
  /** Blank sheets to draw when there is nothing to preview. 0 disables them. */
  placeholderLayers?: number;
}

/**
 * Renders the pile and returns the number of sheets drawn. 0 means the host
 * was left alone, which is the caller's cue to fall back to a folder glyph.
 */
export function renderFolderStack(o: FolderStackOptions): number {
  const prints = o.images.slice(0, MAX_STACK_LAYERS);
  const blank = prints.length === 0;
  const blankCount = Math.max(
    1,
    Math.min(MAX_STACK_LAYERS, o.placeholderLayers ?? PLACEHOLDER_LAYERS)
  );
  const layers = blank ? (o.placeholderLayers === 0 ? 0 : blankCount) : prints.length;
  if (layers === 0) return 0;

  o.host.empty();
  o.host.addClass("ib-thumb-stack");
  o.host.toggleClass("is-blank", blank);
  o.host.setAttr("data-layers", String(layers));

  // The pile lives in its own square stage. The cell it sits in is not always
  // square — windowed rendering stretches the thumbnail box to whatever the
  // row height allows, and themes differ in caption height — and a pile that
  // changes shape with its cell stops reading as a pile of prints.
  const stage = o.host.createDiv({ cls: "ib-stack-stage" });

  const fan = FANS[layers] ?? FANS[1];
  // Layer order in the DOM is back-to-front, which lets plain stacking order
  // do the compositing with no z-index bookkeeping.
  const ordered = blank ? prints : [...prints].reverse();

  for (let i = 0; i < layers; i++) {
    const step = fan[i] ?? FANS[1][0];
    const layer = stage.createDiv({ cls: "ib-stack-layer" });
    layer.setAttr("data-layer", String(i));
    // The cover is the last layer; CSS needs to name it to animate it on hover
    // (:last-of-type is unreliable here because the badges are siblings too).
    if (i === layers - 1) layer.setAttr("data-front", "true");
    layer.style.setProperty("--x", `${step.x}%`);
    layer.style.setProperty("--y", `${step.y}%`);
    layer.style.setProperty("--r", `${step.r}deg`);
    layer.style.setProperty("--s", String(step.s));
    layer.style.setProperty("--o", String(step.o));
    layer.style.setProperty("--i", String(i));

    if (blank) {
      layer.addClass("is-blank-sheet");
      if (i === layers - 1) {
        const glyph = layer.createDiv({ cls: "ib-stack-blank-icon" });
        setIcon(glyph, "image");
      }
      continue;
    }

    const entry = ordered[i];
    const img = layer.createEl("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.src = o.resolveSrc(entry);
  }

  return layers;
}

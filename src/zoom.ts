/*
 * Lightbox zoom arithmetic — pure functions over a plain state object, so the
 * maths can be exercised headlessly without a browser or a real image.
 *
 *   transform: translate(tx, ty) scale(scale)   with transform-origin: 0 0
 *
 * With that origin an image pixel (u, v) lands at (tx + scale*u, ty + scale*v),
 * so `scale` is literally "CSS pixels per image pixel": 1 means 100%.
 */

export interface ZoomBounds {
  /** Image natural size, in image pixels. */
  iw: number;
  ih: number;
  /** Viewport (stage) size, in CSS pixels. */
  vw: number;
  vh: number;
  /** Smallest allowed scale — the fit scale, so the image can never be lost. */
  minScale: number;
  maxScale: number;
}

export interface ZoomState {
  scale: number;
  tx: number;
  ty: number;
}

/** One click of the +/- buttons, and one keyboard nudge. */
export const ZOOM_STEP = 1.25;

/** Hard ceiling, independent of image size. */
const ABSOLUTE_MAX_SCALE = 16;

/** Pointer travel (px) before a press becomes a pan instead of a click. */
export const DRAG_SLOP = 4;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Largest scale that still shows the whole image inside the viewport. */
export function fitScale(iw: number, ih: number, vw: number, vh: number): number {
  if (!(iw > 0) || !(ih > 0) || !(vw > 0) || !(vh > 0)) return 1;
  return Math.min(vw / iw, vh / ih);
}

/**
 * Scale the modal opens at: fit, but never magnified past 100%.
 *
 * Blowing a 48px icon up to fill a 900px stage is technically "fitting the
 * window" and looks like a mistake. Fitting is capped at native size, so small
 * assets open crisp and large ones open whole.
 */
export function initialScale(iw: number, ih: number, vw: number, vh: number): number {
  return Math.min(fitScale(iw, ih, vw, vh), 1);
}

export function makeBounds(iw: number, ih: number, vw: number, vh: number): ZoomBounds {
  const minScale = initialScale(iw, ih, vw, vh);
  return {
    iw: iw > 0 ? iw : 1,
    ih: ih > 0 ? ih : 1,
    vw,
    vh,
    minScale,
    // Enough headroom to inspect single pixels of a big scan, without
    // letting a slider drag the image into a blurry mess.
    maxScale: clamp(Math.max(4, minScale * 8), minScale, ABSOLUTE_MAX_SCALE),
  };
}

export function clampScale(scale: number, b: ZoomBounds): number {
  return clamp(scale, b.minScale, b.maxScale);
}

/** True when the image overflows the stage on either axis. */
export function canPan(state: ZoomState, b: ZoomBounds): boolean {
  return b.iw * state.scale > b.vw + 0.5 || b.ih * state.scale > b.vh + 0.5;
}

/**
 * Keep the image from drifting out of reach: centre it on an axis where it is
 * smaller than the stage, otherwise pin its edges to the stage edges. Without
 * this, one flick leaves you staring at empty background with no way back.
 */
export function clampPan(state: ZoomState, b: ZoomBounds): ZoomState {
  const w = b.iw * state.scale;
  const h = b.ih * state.scale;
  const tx = w <= b.vw ? (b.vw - w) / 2 : clamp(state.tx, b.vw - w, 0);
  const ty = h <= b.vh ? (b.vh - h) / 2 : clamp(state.ty, b.vh - h, 0);
  return { scale: state.scale, tx, ty };
}

export function centered(scale: number, b: ZoomBounds): ZoomState {
  return clampPan({ scale, tx: 0, ty: 0 }, b);
}

/**
 * Zoom to `nextScale` while keeping the image point under the cursor fixed.
 *
 * This is the whole point of a wheel zoom: you aim at an eye, you scroll, and
 * the eye stays where you aimed. Solved by converting the cursor into image
 * space before the scale changes and back again after.
 */
export function zoomAt(
  state: ZoomState,
  px: number,
  py: number,
  nextScale: number,
  b: ZoomBounds
): ZoomState {
  const scale = clampScale(nextScale, b);
  if (scale === state.scale) return state;
  const u = (px - state.tx) / state.scale;
  const v = (py - state.ty) / state.scale;
  return clampPan({ scale, tx: px - scale * u, ty: py - scale * v }, b);
}

/** Zoom about the middle of the stage. */
export function zoomCentered(state: ZoomState, factor: number, b: ZoomBounds): ZoomState {
  return zoomAt(state, b.vw / 2, b.vh / 2, state.scale * factor, b);
}

export function panBy(state: ZoomState, dx: number, dy: number, b: ZoomBounds): ZoomState {
  return clampPan({ scale: state.scale, tx: state.tx + dx, ty: state.ty + dy }, b);
}

/** The number shown in the zoom bar. */
export function percentOf(scale: number): number {
  return Math.round(scale * 100);
}

/** Are we effectively at 100%? Used to highlight the "1:1" button. */
export function isNative(state: ZoomState): boolean {
  return Math.abs(state.scale - 1) < 0.005;
}

/** Are we effectively at the fit scale? Used to highlight the "适应" button. */
export function isFitted(state: ZoomState, b: ZoomBounds): boolean {
  return Math.abs(state.scale - b.minScale) < 0.005;
}

/**
 * The scale a double-click / double-tap click should toggle to, given the
 * state we are leaving. Cycles fit → 100% → 200% → fit, so a small image still
 * has somewhere to go after it hits native size.
 */
export function nextToggleScale(state: ZoomState, b: ZoomBounds): number {
  if (isFitted(state, b) && !isNative(state)) return 1;
  if (isNative(state)) return clampScale(2, b);
  return b.minScale;
}

/**
 * Normalise a wheel event's delta across devices. Trackpads report pixels,
 * legacy mice report lines; without this, one of them zooms imperceptibly and
 * the other rockets to 1600%.
 */
export function wheelFactor(deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  // Exponential so that zooming in and back out returns to the same scale.
  return Math.exp(-px * 0.0022);
}

/*
 * Pan-and-zoom state for one image inside one viewport.
 *
 * The modal owns the layout; this owns `translate(tx, ty) scale(s)` and the
 * gestures that drive it. Split out because the zoom maths is where lightboxes
 * rot — a stray `+tx` and the image flies off screen — so it is worth having in
 * one place with all of its arithmetic already covered by ./zoom. The gesture
 * state machines themselves live in ./zoomGestures.
 */

import {
  canPan,
  centered,
  clampPan,
  isFitted,
  isNative,
  makeBounds,
  percentOf,
  zoomCentered,
  type ZoomBounds,
  type ZoomState,
} from "../zoom";
import { wireZoomGestures, type ZoomGestureHost } from "./zoomGestures";

/** The DOM this controller drives. All of it is rebuilt on every page turn. */
export interface ZoomSurface {
  /** The clipping viewport; the gestures are bound here. */
  stage: HTMLElement;
  img: HTMLImageElement;
  /** Vault resource URL for the image. */
  src: string;
  pctEl: HTMLElement | null;
  fitBtn: HTMLElement | null;
  nativeBtn: HTMLElement | null;
}

export class ZoomView implements ZoomGestureHost {
  private stage: HTMLElement | null = null;
  private img: HTMLImageElement | null = null;
  private pctEl: HTMLElement | null = null;
  private fitBtn: HTMLElement | null = null;
  private nativeBtn: HTMLElement | null = null;

  private bounds: ZoomBounds | null = null;
  private zoom: ZoomState = { scale: 1, tx: 0, ty: 0 };

  private ro: ResizeObserver | null = null;
  private animTimer = 0;

  /**
   * Bind to a freshly built surface: clear the old state, wire the gestures,
   * and start loading the picture so the first fit can happen.
   *
   * Never animated, including from the load handler: the first fit is not a
   * zoom, it is the picture arriving. Animating it shows the photo at natural
   * size for a frame and then visibly shrinks it into the well, which reads as
   * a layout bug — and it happened again on every page turn.
   */
  attach(s: ZoomSurface): void {
    this.detach();
    this.stage = s.stage;
    this.img = s.img;
    this.pctEl = s.pctEl;
    this.fitBtn = s.fitBtn;
    this.nativeBtn = s.nativeBtn;

    s.img.addEventListener("load", () => this.fit(false));
    s.img.addEventListener("error", () => s.stage.addClass("is-broken"));
    wireZoomGestures(s.stage, this);
    this.observeStage();

    s.img.src = s.src;
    if (s.img.complete && s.img.naturalWidth > 0) this.fit(false);
    this.syncUi();
  }

  /** Drop references to the previous render's nodes and observers. */
  detach(): void {
    this.ro?.disconnect();
    this.ro = null;
    window.clearTimeout(this.animTimer);
    this.animTimer = 0;
    this.stage = null;
    this.img = null;
    this.pctEl = null;
    this.fitBtn = null;
    this.nativeBtn = null;
    this.bounds = null;
    this.zoom = { scale: 1, tx: 0, ty: 0 };
  }

  /**
   * Watch the stage for size changes. Keyed to the stage because that is what
   * the fit scale derives from, so this has to be re-established on every
   * render — the stage element is new each time. Doing it once up front quietly
   * stops observing after the first page turn.
   */
  private observeStage(): void {
    if (typeof ResizeObserver !== "function" || !this.stage) return;
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(this.stage);
  }

  // ------------------------------------------------------- gestures' view of us

  getBounds(): ZoomBounds | null {
    return this.bounds;
  }

  getZoom(): ZoomState {
    return this.zoom;
  }

  commit(zoom: ZoomState, animate: boolean): void {
    this.zoom = zoom;
    this.apply(animate);
  }

  cancelAnimating(): void {
    window.clearTimeout(this.animTimer);
    this.img?.removeClass("is-animating");
  }

  // ------------------------------------------------------------------- zoom

  /**
   * Size the image to its natural pixels and recompute the fit bounds.
   *
   * The <img> gets an explicit width/height in image pixels so that `scale: 1`
   * genuinely means 1:1 and the percentage readout is honest; doing this with
   * `object-fit` instead would make "100%" a number nothing could be trusted to
   * mean.
   */
  fit(animate: boolean): void {
    const { stage, img } = this;
    if (!stage || !img) return;

    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!(iw > 0) || !(ih > 0)) return;

    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    if (!(vw > 0) || !(vh > 0)) return;

    img.style.width = `${iw}px`;
    img.style.height = `${ih}px`;

    this.bounds = makeBounds(iw, ih, vw, vh);
    this.zoom = centered(this.bounds.minScale, this.bounds);
    this.apply(animate);
    this.reveal();
  }

  /**
   * Fade the picture in, once, after it has been fitted.
   *
   * The forced reflow is load-bearing. When the image is already decoded the
   * fit happens in the same task as the element's creation, so the browser
   * never paints the `opacity: 0` state and a class added now would simply
   * snap — no transition, and the flash of un-fitted picture comes back.
   * Reading offsetWidth commits the current style first.
   */
  private reveal(): void {
    const img = this.img;
    if (!img || img.hasClass("is-ready")) return;
    void img.offsetWidth;
    img.addClass("is-ready");
  }

  /** Re-derive bounds after the stage changed size, keeping the user's scale. */
  private onResize(): void {
    const { stage, img } = this;
    if (!stage || !img) return;

    const b = this.bounds;
    // The stage was zero-sized when the picture was first measured (the modal
    // was still being laid out), so the fit has not happened yet.
    if (!b) {
      this.fit(false);
      return;
    }

    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    if (!(vw > 0) || !(vh > 0)) return;
    if (vw === b.vw && vh === b.vh) return;

    const wasFitted = isFitted(this.zoom, b);
    const next = makeBounds(b.iw, b.ih, vw, vh);
    this.bounds = next;
    this.zoom = wasFitted ? centered(next.minScale, next) : clampPan(this.zoom, next);
    this.apply(false);
  }

  private apply(animate: boolean): void {
    const { img } = this;
    const b = this.bounds;
    if (!img || !b) return;

    if (animate) {
      img.addClass("is-animating");
      window.clearTimeout(this.animTimer);
      // Slightly longer than --ib-dur-slow (190ms), the transition this class
      // switches on: dropping it early would cut the easing short.
      this.animTimer = window.setTimeout(() => img.removeClass("is-animating"), 220);
    } else if (img.hasClass("is-animating")) {
      // A wheel notch or a drag that lands mid-transition: the class has to go
      // or the gesture trails a smooth 190ms behind the pointer.
      window.clearTimeout(this.animTimer);
      img.removeClass("is-animating");
    }

    img.style.transform = `translate(${this.zoom.tx}px, ${this.zoom.ty}px) scale(${this.zoom.scale})`;
    this.stage?.toggleClass("is-pannable", canPan(this.zoom, b));
    this.syncUi();
  }

  private syncUi(): void {
    const b = this.bounds;
    if (this.pctEl) this.pctEl.setText(`${percentOf(this.zoom.scale)}%`);
    if (b) {
      this.fitBtn?.toggleClass("is-active", isFitted(this.zoom, b));
      this.nativeBtn?.toggleClass("is-active", isNative(this.zoom));
    }
  }

  zoomStep(factor: number): void {
    const b = this.bounds;
    if (!b) return;
    this.zoom = zoomCentered(this.zoom, factor, b);
    this.apply(true);
  }

  goFit(animate: boolean): void {
    const b = this.bounds;
    if (!b) return;
    this.zoom = centered(b.minScale, b);
    this.apply(animate);
  }

  goNative(animate: boolean): void {
    const b = this.bounds;
    if (!b) return;
    this.zoom = centered(1, b);
    this.apply(animate);
  }
}

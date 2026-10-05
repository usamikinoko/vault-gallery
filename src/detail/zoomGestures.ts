/*
 * Gesture wiring for a zoom surface: wheel, drag-to-pan, click-to-cycle.
 *
 * Kept apart from `ZoomView` because the gestures are all state machines with
 * their own mutable bookkeeping, while the view is only ever asked to commit a
 * new transform. The pan state lives in this closure and is thrown away with
 * the stage it was bound to, which is exactly the lifetime it should have: the
 * lightbox rebuilds the stage on every page turn.
 */

import { DRAG_SLOP, canPan, nextToggleScale, panBy, wheelFactor, zoomAt } from "../zoom";
import type { ZoomBounds, ZoomState } from "../zoom";

/** The slice of `ZoomView` the gestures drive. */
export interface ZoomGestureHost {
  getBounds(): ZoomBounds | null;
  getZoom(): ZoomState;
  /** Commit a new transform. `animate` only matters for the click cycle. */
  commit(zoom: ZoomState, animate: boolean): void;
  goFit(animate: boolean): void;
  /** Cut any in-flight smooth transition short, so a gesture is not trailed. */
  cancelAnimating(): void;
}

/**
 * Cycle fit → 100% → 200% → fit, zooming about the point that was clicked so
 * the thing you aimed at is the thing you end up looking at.
 */
function toggleZoomAt(host: ZoomGestureHost, e: PointerEvent | MouseEvent, stage: HTMLElement): void {
  const b = host.getBounds();
  if (!b) return;

  const target = nextToggleScale(host.getZoom(), b);
  if (target === b.minScale) {
    host.goFit(true);
    return;
  }

  const rect = stage.getBoundingClientRect();
  host.commit(zoomAt(host.getZoom(), e.clientX - rect.left, e.clientY - rect.top, target, b), true);
}

export function wireZoomGestures(stage: HTMLElement, host: ZoomGestureHost): void {
  let panning = false;
  let panMoved = false;
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let lastY = 0;

  // --- wheel: zoom at the pointer -----------------------------------------
  stage.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      const b = host.getBounds();
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      // A pending smooth transition would fight the wheel; cut it short so the
      // gesture feels welded to the hand.
      host.cancelAnimating();
      const rect = stage.getBoundingClientRect();
      host.commit(
        zoomAt(
          host.getZoom(),
          e.clientX - rect.left,
          e.clientY - rect.top,
          host.getZoom().scale * wheelFactor(e.deltaY, e.deltaMode),
          b
        ),
        false
      );
    },
    { passive: false }
  );

  // --- drag: pan when zoomed ----------------------------------------------
  stage.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) return;
    panning = true;
    panMoved = false;
    downX = lastX = e.clientX;
    downY = lastY = e.clientY;
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom and odd pointer ids; panning still works without capture */
    }
  });

  stage.addEventListener("pointermove", (e: PointerEvent) => {
    if (!panning) return;
    const b = host.getBounds();
    if (!b) return;

    // A few pixels of hand tremor must not turn a click into a pan.
    if (!panMoved) {
      const travel = Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY);
      if (travel < DRAG_SLOP) return;
      panMoved = true;
      if (!canPan(host.getZoom(), b)) return;
      stage.addClass("is-grabbing");
    }

    host.commit(panBy(host.getZoom(), e.clientX - lastX, e.clientY - lastY, b), false);
    lastX = e.clientX;
    lastY = e.clientY;
  });

  const endPan = (e: PointerEvent) => {
    if (!panning) return;
    const wasClick = !panMoved;
    panning = false;
    panMoved = false;
    stage.removeClass("is-grabbing");
    if (wasClick && e.button === 0) toggleZoomAt(host, e, stage);
  };
  stage.addEventListener("pointerup", endPan);
  stage.addEventListener("pointercancel", () => {
    panning = false;
    panMoved = false;
    stage.removeClass("is-grabbing");
  });

  // Native double-click still fires after two clicks; let it drive the cycle
  // so a fast double click does not just undo itself.
  stage.addEventListener("dblclick", (e: MouseEvent) => {
    e.preventDefault();
  });
}

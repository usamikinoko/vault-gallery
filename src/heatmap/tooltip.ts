/*
 * The hover bubble for the heatmap. A native `title` is too slow to appear and
 * cannot be styled, and this chart is about comparing days.
 *
 * Hiding is the fiddly half: "no cell under the pointer" and "pointer left the
 * chart" are different events, and only the second fires `mouseleave` — sliding
 * from a cell onto the month labels, the weekday gutter, the legend or the
 * padding all happen *inside* the chart. So any pointer event that misses a real
 * cell hides the bubble; `mouseleave` is only the last line of defence.
 */
export function attachTooltip(root: HTMLElement): void {
  const bubble = root.createDiv({ cls: "ib-heat-tip is-hidden" });
  const dateEl = bubble.createDiv({ cls: "ib-heat-tip-date" });
  const changeEl = bubble.createDiv({ cls: "ib-heat-tip-change" });
  const totalEl = bubble.createDiv({ cls: "ib-heat-tip-total" });

  const hide = () => bubble.addClass("is-hidden");

  const show = (cell: HTMLElement) => {
    dateEl.setText(cell.getAttribute("data-tip-date") ?? "");
    changeEl.setText(cell.getAttribute("data-tip-change") ?? "");
    changeEl.setAttr("data-dir", cell.getAttribute("data-dir") ?? "none");
    totalEl.setText(cell.getAttribute("data-tip-total") ?? "");

    // Rows 0 and 1 would push the bubble out of the pane, so it flips below.
    const flip = Number(cell.getAttribute("data-row") ?? "0") < 2;
    bubble.toggleClass("is-below", flip);

    // Positioned relative to the pane, measured in page coordinates so the
    // grid's own scrolling does not skew the arithmetic. Unhidden *before*
    // measuring, or the bubble's width reads as zero.
    bubble.removeClass("is-hidden");
    const host = root.getBoundingClientRect();
    const box = cell.getBoundingClientRect();

    const width = bubble.getBoundingClientRect().width || 150;
    const limit = root.clientWidth || host.width;
    const centre = box.left - host.left + box.width / 2;
    bubble.style.left = `${Math.max(width / 2 + 4, Math.min(limit - width / 2 - 4, centre))}px`;
    bubble.style.top = `${(flip ? box.bottom : box.top) - host.top}px`;
  };

  let hovered: HTMLElement | null = null;

  root.addEventListener("mouseover", (evt) => {
    const target = evt.target as HTMLElement | null;
    const cell = target?.closest?.(".ib-heat-cell") as HTMLElement | null;
    const valid = cell && root.contains(cell) && !cell.classList.contains("is-legend");
    if (!valid) {
      hovered = null;
      hide();
      return;
    }
    // Same square still under the pointer: leave the bubble alone rather than
    // re-measuring and rewriting it on every pixel of movement.
    if (cell === hovered) return;
    hovered = cell;
    show(cell);
  });

  root.addEventListener("mouseleave", () => {
    hovered = null;
    hide();
  });
  // Scrolling moves the cells out from under a tooltip that cannot follow them.
  root.addEventListener(
    "scroll",
    () => {
      hovered = null;
      hide();
    },
    true
  );
  // Alt-tabbing away with the pointer over a square leaves the bubble behind
  // when the window comes back; there is no pointer event to tell us.
  window.addEventListener("blur", () => {
    hovered = null;
    hide();
  });
  hide();
}

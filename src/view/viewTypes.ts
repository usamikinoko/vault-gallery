import type { VaultGalleryView } from "./explorerView";

export const VIEW_TYPE_VAULT_GALLERY = "vault-gallery-view";

/**
 * What is currently being dragged inside the view.
 *
 * Images carry a whole selection; folders move one at a time, because "drag
 * three folders into one" has no unambiguous landing order and no undo worth
 * speaking of.
 */
export type DragPayload =
  | { kind: "images"; paths: string[] }
  | { kind: "folder"; path: string };

/**
 * A group of methods installed onto `VaultGalleryView.prototype`.
 *
 * The view is one stateful object by design — the grid, the tree, the drag
 * state and the selection all read the same fields — so splitting it by
 * responsibility means splitting *methods*, not state. Each part is a plain
 * object whose methods are typed with `this: VaultGalleryView`, and
 * `explorerView.ts` installs them in one place.
 */
export type ViewPart<T> = T & ThisType<VaultGalleryView>;

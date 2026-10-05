/*
 * Name comparison for every sort in the plugin.
 *
 * `a.localeCompare(b, "zh")` constructs a collator on every call, and sorting
 * a few thousand names reads it twice per comparison — so exactly one collator
 * is created, once.
 */

export type Comparer = (a: string, b: string) => number;

export function createComparer(): Comparer {
  const collator =
    typeof Intl !== "undefined" && typeof Intl.Collator === "function"
      ? new Intl.Collator("zh")
      : null;
  return collator
    ? (a, b) => collator.compare(a, b)
    : (a, b) => (a < b ? -1 : a > b ? 1 : 0);
}

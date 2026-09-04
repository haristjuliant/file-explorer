/**
 * Selection arithmetic, isolated as pure functions so the full gesture matrix
 * can be unit-tested without React, a store, or a rendered view.
 */

/**
 * Every path between `a` and `b` inclusive, in the order they appear.
 *
 * When the anchor is no longer present -- it was deleted, filtered out, or a
 * collapsed tree node swallowed it -- the range degrades to just `b` rather
 * than throwing or selecting everything.
 */
export function rangeBetween(paths: readonly string[], a: string, b: string): string[] {
  const i = paths.indexOf(a);
  const j = paths.indexOf(b);
  if (j < 0) return [];
  if (i < 0) return [b];
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  return paths.slice(lo, hi + 1);
}

/**
 * Where the cursor lands after moving `delta` from index `from`, clamped to the
 * list.
 *
 * `from < 0` means "no cursor yet": moving down enters at the first row and
 * moving up enters at the last, which is what makes the first arrow press after
 * a click on empty space feel right.
 */
export function stepIndex(len: number, from: number, delta: number): number {
  if (len === 0) return -1;
  const start = from < 0 ? (delta > 0 ? -1 : len) : from;
  return Math.min(len - 1, Math.max(0, start + delta));
}

/** Add or remove one path, returning a new Set (the store treats Sets as immutable). */
export function toggleIn(set: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(set);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/** Union of a set and a range, for additive Ctrl+Shift+click. */
export function unionRange(
  set: ReadonlySet<string>,
  paths: readonly string[],
  a: string,
  b: string,
): Set<string> {
  const next = new Set(set);
  for (const p of rangeBetween(paths, a, b)) next.add(p);
  return next;
}

/**
 * Drop paths that no longer exist in the visible order.
 *
 * Called after a directory re-read, a filter change, or a tree collapse. Without
 * this, the cursor can sit on a path that is not in `paths`, and every arrow
 * press then restarts from the top of the list.
 */
export function pruneToOrder(
  selection: ReadonlySet<string>,
  paths: readonly string[],
): Set<string> {
  const present = new Set(paths);
  const next = new Set<string>();
  for (const p of selection) if (present.has(p)) next.add(p);
  return next;
}

/** Index range covered by a marquee drag, given fixed row height. */
export function marqueeRange(
  yStart: number,
  yEnd: number,
  rowHeight: number,
  count: number,
): { from: number; to: number } | null {
  if (count === 0 || rowHeight <= 0) return null;
  const a = Math.floor(Math.min(yStart, yEnd) / rowHeight);
  const b = Math.floor(Math.max(yStart, yEnd) / rowHeight);
  const from = Math.max(0, Math.min(count - 1, a));
  const to = Math.max(0, Math.min(count - 1, b));
  // A drag entirely above or below the rows selects nothing.
  if (b < 0 || a > count - 1) return null;
  return { from, to };
}

/**
 * Next match for type-to-select.
 *
 * The search begins at `fromIndex` and wraps around the end. Callers pass
 * `cursor + 1` while a single letter is being repeated, so pressing "a" over and
 * over walks through every entry starting with "a" instead of sticking on the
 * first one; while a multi-character buffer is still growing they pass 0.
 */
export function findByPrefix(
  names: readonly string[],
  prefix: string,
  fromIndex: number,
): number {
  if (prefix === "" || names.length === 0) return -1;
  const needle = prefix.toLowerCase();
  const start = fromIndex < 0 ? 0 : fromIndex;
  for (let k = 0; k < names.length; k++) {
    const i = (start + k) % names.length;
    if (names[i].toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

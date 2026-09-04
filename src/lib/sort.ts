/**
 * Sort comparators.
 *
 * Sorting happens here, in the frontend, not in Rust. That is an architectural
 * choice: the whole `OrderSource` model requires the frontend to know the FULL
 * order of a directory. If Rust sorted and paged, `visibleOrder` would no longer
 * know the complete order and Ctrl+A, shift-ranges spanning an unloaded gap, and
 * Quick Look stepping past the loaded window would all break.
 *
 * The cost is bounded by the backend's 50,000-entry cap; the payoff is that
 * Ctrl+H, changing the sort column, and the filter field are all instant and
 * cost no IPC.
 */

import type { DirEntry } from "../ipc/types";
import { Attr, hasFlag } from "../ipc/types";

export type SortKey = "name" | "modified" | "size" | "kind";
export type SortDir = 1 | -1;

/**
 * `numeric: true` gives natural ordering (`file2` before `file10`) and
 * `sensitivity: "base"` makes it case- and accent-insensitive, both of which
 * match Finder. Constructed once: `Intl.Collator` is expensive to build and
 * cheap to reuse.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Exact tiebreak so equal-by-collation names still have a stable order. */
function tiebreak(a: DirEntry, b: DirEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function compareEntries(a: DirEntry, b: DirEntry, key: SortKey, dir: SortDir): number {
  // Folders always first, regardless of key or direction -- as in Finder and
  // Explorer. Direction must NOT flip this, or "sort by size descending" buries
  // every folder at the bottom.
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;

  let r = 0;
  switch (key) {
    case "name":
      r = collator.compare(a.name, b.name);
      break;
    case "modified":
      r = a.modifiedMs - b.modifiedMs;
      break;
    case "size":
      // Directories have no meaningful size, so they sort among themselves by
      // name even when the size column is active.
      r = a.isDir ? collator.compare(a.name, b.name) : a.size - b.size;
      break;
    case "kind":
      r = collator.compare(a.category, b.category) || collator.compare(a.ext, b.ext);
      break;
  }
  if (r === 0) r = tiebreak(a, b);
  return r * dir;
}

export interface VisibleOptions {
  showHidden: boolean;
  showSystem: boolean;
  filter: string;
  sortKey: SortKey;
  sortDir: SortDir;
}

/**
 * Filter then sort. Returns a NEW array; callers must memoize it -- returning
 * this straight out of a zustand selector would re-render on every store change.
 */
export function visibleSorted(entries: readonly DirEntry[], o: VisibleOptions): DirEntry[] {
  const needle = o.filter.trim().toLowerCase();
  const out: DirEntry[] = [];
  for (const e of entries) {
    if (!o.showHidden && hasFlag(e.flags, Attr.Hidden)) continue;
    if (!o.showSystem && hasFlag(e.flags, Attr.System)) continue;
    if (needle !== "" && !e.name.toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  out.sort((a, b) => compareEntries(a, b, o.sortKey, o.sortDir));
  return out;
}

/**
 * Which direction a column should start in when it is first clicked.
 * Name and Kind read best ascending; Date and Size read best descending
 * (newest and biggest first), which is what Finder does and what users expect.
 */
export function initialDirFor(key: SortKey): SortDir {
  return key === "name" || key === "kind" ? 1 : -1;
}

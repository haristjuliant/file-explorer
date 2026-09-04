/**
 * The `OrderSource` registry -- the crux of this whole design.
 *
 * Quick Look must step between files with the arrow keys identically in all
 * three view modes, but the ordered list of navigable siblings differs:
 *
 *   list   -> the sorted entries of the current directory
 *   column -> the entries of whichever column holds the cursor
 *   tree   -> the depth-first flattening of the visible expanded rows
 *
 * The order itself is deliberately NOT stored in zustand. Publishing a
 * 10,000-element array into the store on every re-render would be a disaster.
 * Instead the active view registers an imperative provider in module state, and
 * a version counter is what reactive consumers subscribe to.
 *
 * This module imports nothing from the store, so there is no import cycle: the
 * selection slice depends on the registry, never the reverse.
 */

import { useSyncExternalStore } from "react";

import type { DirEntry } from "../ipc/types";

export type ViewMode = "list" | "column" | "tree";

export interface KeyCtx {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export interface VisibleOrder {
  /** Ordered, filtered and sorted -- exactly what the user sees. */
  paths: string[];
  /** path -> position, O(1). */
  index: ReadonlyMap<string, number>;
  /**
   * The container a path lives in: `cwd` in list mode, that column's directory
   * in column mode, the parent directory in tree mode.
   */
  scopeOf(path: string): string;
  /** Entry lookup without going back to the directory cache. */
  entryOf(path: string): DirEntry | undefined;
}

export interface OrderSource {
  view: ViewMode;
  getOrder(): VisibleOrder;
  /** Scroll an index into view, i.e. `virtualizer.scrollToIndex`. */
  reveal(index: number): void;
  /**
   * View-specific horizontal semantics. These three callbacks are the ONLY
   * escape hatches a view gets; everything else -- ~40 shortcuts, Quick Look,
   * marquee selection, type-to-select -- it inherits for free.
   *
   * Return true when the key was handled.
   */
  onArrowLeft?(ctx: KeyCtx): boolean;
  onArrowRight?(ctx: KeyCtx): boolean;
  /** Enter or double-click on a directory. */
  activateDir?(path: string): boolean;
}

export const EMPTY_ORDER: VisibleOrder = {
  paths: [],
  index: new Map(),
  scopeOf: () => "",
  entryOf: () => undefined,
};

let active: OrderSource | null = null;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  for (const fn of listeners) fn();
}

export const orderRegistry = {
  /**
   * Install a view as the active order source. Returns the unregister function;
   * a stale source unregistering after another has taken over is a no-op, which
   * is what makes mount/unmount ordering during a view switch harmless.
   */
  register(src: OrderSource): () => void {
    active = src;
    emit();
    return () => {
      if (active === src) {
        active = null;
        emit();
      }
    };
  },

  /** Called by a view when the CONTENT of its order changed. */
  publish(): void {
    emit();
  },

  get(): VisibleOrder {
    return active ? active.getOrder() : EMPTY_ORDER;
  },

  source(): OrderSource | null {
    return active;
  },

  getVersion(): number {
    return version;
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },

  /** Test-only: drop all state between cases. */
  reset(): void {
    active = null;
    listeners.clear();
    version = 0;
  },
};

/**
 * Build a `VisibleOrder` from a flat entry list belonging to one directory.
 * Used by list mode and by each column.
 */
export function makeOrder(dir: string, entries: readonly DirEntry[], toPath: (dir: string, e: DirEntry) => string): VisibleOrder {
  const paths: string[] = new Array(entries.length);
  const index = new Map<string, number>();
  const byPath = new Map<string, DirEntry>();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const p = toPath(dir, e);
    paths[i] = p;
    index.set(p, i);
    byPath.set(p, e);
  }

  return {
    paths,
    index,
    scopeOf: () => dir,
    entryOf: (p) => byPath.get(p),
  };
}

/**
 * Build a `VisibleOrder` from pre-flattened rows that already know their own
 * path and parent. Used by tree mode and by search results.
 */
export interface OrderRow {
  path: string;
  parent: string;
  entry: DirEntry;
  /** Rows that render but are not keyboard targets, e.g. a loading placeholder. */
  skip?: boolean;
}

export function makeOrderFromRows(rows: readonly OrderRow[]): VisibleOrder {
  const paths: string[] = [];
  const index = new Map<string, number>();
  const byPath = new Map<string, OrderRow>();

  for (const row of rows) {
    byPath.set(row.path, row);
    if (row.skip) continue;
    index.set(row.path, paths.length);
    paths.push(row.path);
  }

  return {
    paths,
    index,
    scopeOf: (p) => byPath.get(p)?.parent ?? "",
    entryOf: (p) => byPath.get(p)?.entry,
  };
}

/**
 * Subscribe to order changes. Returns the version, not the order itself, so the
 * snapshot is a primitive and `useSyncExternalStore` stays happy; call
 * `orderRegistry.get()` inside a `useMemo` keyed on it.
 */
export function useOrderVersion(): number {
  return useSyncExternalStore(orderRegistry.subscribe, orderRegistry.getVersion, () => 0);
}

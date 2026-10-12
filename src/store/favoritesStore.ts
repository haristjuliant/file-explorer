/**
 * Sidebar favourites: one ordered, persisted list covering both the fixed OS
 * locations (Home, Desktop, ...) and anything dragged or right-clicked in
 * afterwards. Unlike `persist.ts`'s view prefs this survives a restart
 * forever, and unlike the OS locations it is fully user-owned -- reordered
 * by dragging, and removable even for a built-in entry (Finder allows the
 * same: nothing in the Favourites section is really "built-in", it is just
 * pre-seeded once).
 */

import { create } from "zustand";
import type { DragEvent } from "react";

import { basename, normalize } from "../lib/path";
import { orderRegistry } from "../order/registry";
import { appState } from "./appStore";

export interface Favorite {
  path: string;
  label: string;
}

/** Where a moved or added entry lands, relative to an existing row. */
export interface FavoriteAnchor {
  path: string;
  before: boolean;
}

const KEY = "finder-fm.favorites.v1";

interface Loaded {
  favorites: Favorite[];
  /** False only when `KEY` has never been written -- see `seedIfEmpty`. */
  initialized: boolean;
}

function load(): Loaded {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return { favorites: [], initialized: false };
  }
  if (raw === null) return { favorites: [], initialized: false };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { favorites: [], initialized: false };

    const out: Favorite[] = [];
    const seen = new Set<string>();
    for (const item of parsed as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;
      if (typeof r.path !== "string" || typeof r.label !== "string") continue;
      const path = normalize(r.path);
      if (path === "" || r.label === "" || seen.has(path)) continue;
      seen.add(path);
      out.push({ path, label: r.label });
    }
    return { favorites: out, initialized: true };
  } catch {
    return { favorites: [], initialized: false };
  }
}

function save(favorites: Favorite[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(favorites));
  } catch {
    // Storage full or unavailable: favourites simply do not persist.
  }
}

/** `beforePath`'s index, or the end of the list when it is absent or gone. */
function anchorIndex(list: readonly Favorite[], anchor: FavoriteAnchor | null | undefined): number {
  if (!anchor) return list.length;
  const i = list.findIndex((f) => f.path === anchor.path);
  if (i < 0) return list.length;
  return anchor.before ? i : i + 1;
}

interface FavoritesState {
  favorites: Favorite[];
  /**
   * Seeds the list from the OS locations, but ONLY the very first time the
   * app runs on this machine (`KEY` has never been saved). After that the
   * list is entirely the user's: seeding again would resurrect a built-in
   * favourite the user deliberately removed.
   */
  seedIfEmpty(defaults: readonly Favorite[]): void;
  /** Adds every path not already favourited; silently ignores the rest. */
  addFavorites(paths: readonly string[], anchor?: FavoriteAnchor | null): void;
  removeFavorite(path: string): void;
  /** Reorder: moves an existing favourite next to `anchor` (or to the end). */
  moveFavorite(path: string, anchor?: FavoriteAnchor | null): void;
}

const initial = load();

export const useFavoritesStore = create<FavoritesState>()((set, get) => ({
  favorites: initial.favorites,

  seedIfEmpty(defaults) {
    if (get().favorites.length > 0) return;
    // `initialized` (i.e. KEY already saved, just currently empty) beats an
    // in-memory check alone: without it, a user who removes every favourite
    // would see them all come back on the next launch.
    if (load().initialized) return;

    const seen = new Set<string>();
    const seeded: Favorite[] = [];
    for (const f of defaults) {
      const path = normalize(f.path);
      if (path === "" || seen.has(path)) continue;
      seen.add(path);
      seeded.push({ path, label: f.label });
    }
    if (seeded.length === 0) return;
    set({ favorites: seeded });
    save(seeded);
  },

  addFavorites(paths, anchor) {
    const list = get().favorites.slice();
    const existing = new Set(list.map((f) => f.path));
    const additions: Favorite[] = [];
    for (const raw of paths) {
      const path = normalize(raw);
      if (path === "" || existing.has(path)) continue;
      existing.add(path);
      additions.push({ path, label: basename(path) });
    }
    if (additions.length === 0) return;
    list.splice(anchorIndex(list, anchor), 0, ...additions);
    set({ favorites: list });
    save(list);
  },

  removeFavorite(path) {
    const target = normalize(path);
    const next = get().favorites.filter((f) => f.path !== target);
    if (next.length === get().favorites.length) return;
    set({ favorites: next });
    save(next);
  },

  moveFavorite(path, anchor) {
    if (anchor?.path === path) return; // dropped on itself: no-op
    const list = get().favorites.slice();
    const fromIdx = list.findIndex((f) => f.path === path);
    if (fromIdx < 0) return;
    const [item] = list.splice(fromIdx, 1);
    list.splice(anchorIndex(list, anchor), 0, item);
    set({ favorites: list });
    save(list);
  },
}));

/* ------------------------------------------------------------------------- */
/* Drag and drop                                                             */
/*                                                                            */
/* Every other interaction in this app -- selection, marquee, column resize  */
/* -- is pointer-event driven, on purpose (see `appStore.ts`). This is the   */
/* exception: dragging a row out to the sidebar, or a favourite within it,   */
/* is simplest done with the browser's native HTML5 drag and drop, and it is */
/* scoped to exactly this feature rather than wired into a general           */
/* move-by-drag system that does not otherwise exist here.                   */
/*                                                                            */
/* Two distinct drags share the sidebar as a drop target, so they get two    */
/* MIME types: adding a new favourite from a file view, and reordering an    */
/* existing one within the list.                                             */
/* ------------------------------------------------------------------------- */

const ADD_MIME = "application/x-fm-favorite-add";
const REORDER_MIME = "application/x-fm-favorite-reorder";

/**
 * Folders to carry when dragging `path` out of a file view: the whole
 * selection when `path` is part of a multi-selection, else just `path`
 * alone. Files drop out of the set -- favourites are folders only.
 */
function foldersForDrag(path: string): string[] {
  const order = orderRegistry.get();
  if (!order.entryOf(path)?.isDir) return [];

  const s = appState();
  if (!s.selection.has(path) || s.selection.size <= 1) return [path];

  const dirs: string[] = [];
  for (const p of s.selection) {
    if (order.entryOf(p)?.isDir) dirs.push(p);
  }
  return dirs.length > 0 ? dirs : [path];
}

/** Wire onto a folder row's `onDragStart` in a file view. A no-op (and cancelled) for files. */
export function startFavoriteAddDrag(e: DragEvent<Element>, path: string): void {
  const dirs = foldersForDrag(path);
  if (dirs.length === 0) {
    e.preventDefault();
    return;
  }
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(ADD_MIME, JSON.stringify(dirs));
}

export function isFavoriteAddDrag(e: DragEvent<Element>): boolean {
  return e.dataTransfer.types.includes(ADD_MIME);
}

export function readFavoriteAddDrag(e: DragEvent<Element>): string[] {
  const raw = e.dataTransfer.getData(ADD_MIME);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Wire onto a favourite row's own `onDragStart`, for reordering. */
export function startFavoriteReorderDrag(e: DragEvent<Element>, path: string): void {
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData(REORDER_MIME, path);
}

export function isFavoriteReorderDrag(e: DragEvent<Element>): boolean {
  return e.dataTransfer.types.includes(REORDER_MIME);
}

export function readFavoriteReorderDrag(e: DragEvent<Element>): string | null {
  const raw = e.dataTransfer.getData(REORDER_MIME);
  return raw === "" ? null : raw;
}

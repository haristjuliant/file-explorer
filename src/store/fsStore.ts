/**
 * The directory cache.
 *
 * Column mode holds one directory per column and tree mode holds one per
 * expanded node, so directory contents cannot live in a single "current
 * entries" array.
 *
 * Reactivity contract: `dirs` is replaced with `new Map(prev)` on every change,
 * but untouched `DirState` objects keep their identity. So a component doing
 * `useFsStore(s => s.dirs.get(path))` re-renders only when THAT directory
 * changes -- a tree with forty expanded nodes has forty subscriptions, and one
 * change wakes one of them.
 *
 * Refcounts, in-flight promises and LRU order deliberately live in module state
 * OUTSIDE the store: they change on mount and unmount, and if they were reactive
 * they would cause renders.
 *
 * Why hand-rolled rather than TanStack Query: invalidation here is push (a
 * watcher event names the exact directory) not pull; lifetime is reference
 * counted (a directory is watched exactly while at least one column or tree node
 * is mounted for it) rather than governed by a `gcTime` timer; and the keyboard
 * handler needs synchronous reads from outside React.
 */

import { create } from "zustand";

import { readDir } from "../ipc/fs";
import { asFsError, type DirEntry, type FsError } from "../ipc/types";
import { normalize } from "../lib/path";
import * as watch from "./watchBridge";

export type DirStatus = "idle" | "loading" | "ready" | "error";

export interface DirState {
  path: string;
  status: DirStatus;
  /** As returned by the backend: unsorted, hidden and system entries included. */
  entries: DirEntry[];
  error: FsError | null;
  /** Full count on disk, which exceeds `entries.length` when truncated. */
  total: number;
  truncated: boolean;
  loadedAt: number;
  /** Bumped on every content change; a cheap `useMemo` dependency. */
  generation: number;
}

interface FsStore {
  dirs: Map<string, DirState>;
}

export const useFsStore = create<FsStore>()(() => ({
  dirs: new Map<string, DirState>(),
}));

// ---------------------------------------------------------------------------
// Non-reactive side tables
// ---------------------------------------------------------------------------

/** path -> number of mounted consumers. */
const refs = new Map<string, number>();
/** In-flight reads, so N columns opening the same directory make one call. */
const inflight = new Map<string, Promise<void>>();
/** Pending unwatch timers, keyed by path. */
const unwatchTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Most-recently-touched last. */
const lru: string[] = [];

/** How long a `ready` directory is trusted without re-reading. */
const STALE_MS = 2_000;
/**
 * Unwatching is deferred so that React 19 StrictMode's double effect
 * invocation, and the rapid chain truncation of arrowing through column mode,
 * do not produce a watch/unwatch round trip per keypress.
 */
const UNWATCH_DELAY_MS = 2_000;
const MAX_DIRS = 256;

function emptyDir(path: string): DirState {
  return {
    path,
    status: "idle",
    entries: [],
    error: null,
    total: 0,
    truncated: false,
    loadedAt: 0,
    generation: 0,
  };
}

function setDir(path: string, fn: (prev: DirState | undefined) => DirState): void {
  useFsStore.setState((s) => {
    const dirs = new Map(s.dirs);
    dirs.set(path, fn(dirs.get(path)));
    return { dirs };
  });
}

function touchLru(path: string): void {
  const i = lru.indexOf(path);
  if (i >= 0) lru.splice(i, 1);
  lru.push(path);
}

/**
 * Evict least-recently-used directories, skipping anything that is retained,
 * loading, or a protected ancestor. Because a watched directory always has
 * `refs > 0`, eviction can never orphan a watcher.
 */
function maybeEvict(protectedPaths: ReadonlySet<string>): void {
  const state = useFsStore.getState();
  if (state.dirs.size <= MAX_DIRS) return;

  const dirs = new Map(state.dirs);
  let over = dirs.size - MAX_DIRS;

  for (const path of [...lru]) {
    if (over <= 0) break;
    if ((refs.get(path) ?? 0) > 0) continue;
    if (protectedPaths.has(path)) continue;
    const d = dirs.get(path);
    if (!d || d.status === "loading") continue;
    dirs.delete(path);
    const i = lru.indexOf(path);
    if (i >= 0) lru.splice(i, 1);
    over--;
  }
  useFsStore.setState({ dirs });
}

/** Paths eviction must never drop, supplied by the app shell. */
let protectedPaths: ReadonlySet<string> = new Set();
export function setProtectedPaths(paths: Iterable<string>): void {
  protectedPaths = new Set(paths);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Load a directory if it is missing or stale.
 *
 * Stale-while-revalidate: when entries are already cached they stay visible and
 * the status stays `ready`, so the view shows a thin progress line rather than
 * blanking to a skeleton.
 */
export function ensureDir(input: string, opts?: { force?: boolean }): Promise<void> {
  const path = normalize(input);
  if (path === "") return Promise.resolve();

  const existing = inflight.get(path);
  if (existing) return existing;

  const cur = useFsStore.getState().dirs.get(path);
  if (!opts?.force && cur?.status === "ready" && Date.now() - cur.loadedAt < STALE_MS) {
    touchLru(path);
    return Promise.resolve();
  }

  setDir(path, (prev) => ({
    ...(prev ?? emptyDir(path)),
    status: prev?.status === "ready" ? "ready" : "loading",
    error: null,
  }));

  const promise = (async () => {
    try {
      const page = await readDir(path);
      setDir(path, (prev) => ({
        ...(prev ?? emptyDir(path)),
        status: "ready",
        entries: page.entries,
        total: page.total,
        truncated: page.truncated,
        error: null,
        loadedAt: Date.now(),
        generation: (prev?.generation ?? 0) + 1,
      }));
    } catch (e) {
      setDir(path, (prev) => ({
        ...(prev ?? emptyDir(path)),
        status: "error",
        error: asFsError(e),
        loadedAt: Date.now(),
      }));
    } finally {
      inflight.delete(path);
      touchLru(path);
      maybeEvict(protectedPaths);
    }
  })();

  inflight.set(path, promise);
  return promise;
}

/** Force a re-read on the next `ensureDir`, and start one now if retained. */
export function invalidate(input: string): void {
  const path = normalize(input);
  const d = useFsStore.getState().dirs.get(path);
  if (!d) return;
  if ((refs.get(path) ?? 0) > 0) {
    void ensureDir(path, { force: true });
  } else {
    setDir(path, (prev) => ({ ...(prev ?? emptyDir(path)), loadedAt: 0 }));
  }
}

/**
 * Register a consumer for a directory: loads it, starts a watch, and returns an
 * idempotent release function.
 *
 * `release` must be safe to call twice, because StrictMode invokes effect
 * cleanups twice; a refcount that can go negative silently stops watching a
 * directory that is still on screen.
 */
export function retainDir(input: string): () => void {
  const path = normalize(input);
  if (path === "") return () => {};

  const pendingUnwatch = unwatchTimers.get(path);
  if (pendingUnwatch !== undefined) {
    clearTimeout(pendingUnwatch);
    unwatchTimers.delete(path);
  }

  const n = (refs.get(path) ?? 0) + 1;
  refs.set(path, n);
  if (n === 1) watch.start(path);
  void ensureDir(path);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const m = (refs.get(path) ?? 1) - 1;
    if (m > 0) {
      refs.set(path, m);
      return;
    }
    refs.delete(path);
    const timer = setTimeout(() => {
      unwatchTimers.delete(path);
      // Re-check: the directory may have been retained again in the meantime.
      if ((refs.get(path) ?? 0) === 0) watch.stop(path);
    }, UNWATCH_DELAY_MS);
    unwatchTimers.set(path, timer);
  };
}

// ---------------------------------------------------------------------------
// Incremental patching
// ---------------------------------------------------------------------------

/**
 * Apply a local change to one entry: `patch` merges, `null` removes.
 *
 * Used for optimistic rename and new-folder. Watcher events themselves trigger a
 * full re-read instead -- see `watchBridge`.
 */
export function patchEntry(
  dirInput: string,
  name: string,
  patch: Partial<DirEntry> | null,
): void {
  const dir = normalize(dirInput);
  const d = useFsStore.getState().dirs.get(dir);
  if (!d) return;

  let entries: DirEntry[];
  if (patch === null) {
    entries = d.entries.filter((e) => e.name !== name);
  } else {
    const i = d.entries.findIndex((e) => e.name === name);
    if (i < 0) return;
    entries = d.entries.slice();
    entries[i] = { ...entries[i], ...patch };
  }

  setDir(dir, (prev) => ({
    ...(prev ?? emptyDir(dir)),
    entries,
    total: patch === null ? Math.max(0, (prev?.total ?? 1) - 1) : (prev?.total ?? entries.length),
    generation: (prev?.generation ?? 0) + 1,
  }));
}

/** Insert an entry locally, for an optimistic new folder or file. */
export function insertEntry(dirInput: string, entry: DirEntry): void {
  const dir = normalize(dirInput);
  const d = useFsStore.getState().dirs.get(dir);
  if (!d) return;
  if (d.entries.some((e) => e.name === entry.name)) return;

  setDir(dir, (prev) => ({
    ...(prev ?? emptyDir(dir)),
    entries: [...(prev?.entries ?? []), entry],
    total: (prev?.total ?? 0) + 1,
    generation: (prev?.generation ?? 0) + 1,
  }));
}

// ---------------------------------------------------------------------------
// Introspection, for tests and diagnostics
// ---------------------------------------------------------------------------

export const fsCacheDebug = {
  refCount: (path: string) => refs.get(normalize(path)) ?? 0,
  retainedCount: () => refs.size,
  inflightCount: () => inflight.size,
  cachedCount: () => useFsStore.getState().dirs.size,
  pendingUnwatchCount: () => unwatchTimers.size,
  reset(): void {
    for (const t of unwatchTimers.values()) clearTimeout(t);
    unwatchTimers.clear();
    refs.clear();
    inflight.clear();
    lru.length = 0;
    protectedPaths = new Set();
    useFsStore.setState({ dirs: new Map() });
  },
};

/**
 * Filesystem-watch bridge.
 *
 * The refcounted lifecycle lives in `fsStore`; this owns the IPC and the
 * incoming change events, so the two concerns stay separable and testable.
 *
 * A change triggers a full RE-READ of the affected directory, never a delta.
 * Reading a typical directory costs 1-5 ms, so delta application saves nothing
 * perceptible -- while `notify` on Windows genuinely drops and reorders events
 * under load, and a delta-only frontend would desync and show rows that are not
 * there.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { unwatchDir, watchDir } from "../ipc/fs";
import type { FsChange } from "../ipc/types";
import { normalize } from "../lib/path";

const watched = new Set<string>();

/** Begin watching a directory. Called when its refcount reaches 1. */
export function start(path: string): void {
  const key = normalize(path);
  if (watched.has(key)) return;
  watched.add(key);
  void watchDir(key).catch(() => {
    // A directory that cannot be watched still displays; it just will not
    // refresh by itself. Dropping it from the set lets a later mount retry.
    watched.delete(key);
  });
}

/** Stop watching. Called after the unwatch debounce, if still unreferenced. */
export function stop(path: string): void {
  const key = normalize(path);
  if (!watched.delete(key)) return;
  void unwatchDir(key).catch(() => {});
}

/**
 * Subscribe to backend change events.
 *
 * Mounted once by the app shell. `invalidate` is injected rather than imported
 * so this module has no dependency back on the store, which keeps the import
 * graph one-directional.
 */
export async function subscribe(handlers: {
  invalidate(path: string): void;
  onGone(path: string): void;
}): Promise<UnlistenFn> {
  const unlistenChange = await listen<FsChange>("fs:change", ({ payload }) => {
    if (payload.rescan) {
      // Events were lost -- during an unzip, say. Reconstructing the missing
      // deltas is impossible, so every watched directory is re-read.
      for (const dir of watched) handlers.invalidate(dir);
    }
    for (const dir of payload.dirs) handlers.invalidate(dir);
    for (const dir of payload.gone) handlers.onGone(dir);
  });

  const unlistenDropped = await listen<string[]>("fs:watch-dropped", ({ payload }) => {
    // Over the watch cap: those directories go stale silently unless refreshed.
    for (const dir of payload) {
      watched.delete(normalize(dir));
      handlers.invalidate(dir);
    }
  });

  return () => {
    unlistenChange();
    unlistenDropped();
  };
}

export const watchDebug = {
  count: () => watched.size,
  has: (path: string) => watched.has(normalize(path)),
  reset: () => watched.clear(),
};

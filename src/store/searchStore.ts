/**
 * Recursive search results.
 *
 * Three rules, all learned from how this goes wrong:
 *
 *   1. The backend already batches; the frontend buffers again and flushes on
 *      an animation frame, so the store is written at most once per frame no
 *      matter how fast events arrive.
 *   2. Live growth stops at a cap. The virtualizer copes with far more, but
 *      re-rendering and later sorting half a million rows does not.
 *   3. Results are NOT sorted while the search runs. Appending to a sorted list
 *      moves every row's position, so items jump around under the pointer --
 *      exactly what Explorer gets wrong and Finder gets right.
 */

import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { cancelSearch as cancelSearchIpc, startSearch } from "../ipc/fs";
import type { DirEntry, SearchBatch } from "../ipc/types";

/** Beyond this the count keeps rising but the list stops growing. */
export const MAX_LIVE_HITS = 5_000;

export interface SearchHitRow {
  /** Absolute path, used as the row key and the `OrderSource` entry. */
  path: string;
  dir: string;
  entry: DirEntry;
}

interface SearchStore {
  jobId: number | null;
  query: string;
  root: string;
  /** Arrival order while running. Sorting is offered only once done. */
  hits: SearchHitRow[];
  status: "idle" | "running" | "done" | "cancelled";
  hitTotal: number;
  scannedEntries: number;
  capReached: boolean;
}

export const useSearchStore = create<SearchStore>()(() => ({
  jobId: null,
  query: "",
  root: "",
  hits: [],
  status: "idle",
  hitTotal: 0,
  scannedEntries: 0,
  capReached: false,
}));

/* ------------------------------------------------------------------------- */

/** Buffered between animation frames, outside the store so buffering costs no render. */
let buffer: SearchHitRow[] = [];
let frame: number | null = null;
let latest: { hitTotal: number; scannedEntries: number; capReached: boolean } | null = null;

function scheduleFlush(): void {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const incoming = buffer;
    buffer = [];
    const stats = latest;
    latest = null;

    useSearchStore.setState((s) => {
      if (s.status !== "running") return s;
      const room = Math.max(0, MAX_LIVE_HITS - s.hits.length);
      const hits = room > 0 && incoming.length > 0 ? [...s.hits, ...incoming.slice(0, room)] : s.hits;
      return {
        hits,
        hitTotal: stats?.hitTotal ?? s.hitTotal,
        scannedEntries: stats?.scannedEntries ?? s.scannedEntries,
        capReached: (stats?.capReached ?? s.capReached) || hits.length >= MAX_LIVE_HITS,
      };
    });
  });
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("\\") ? dir + name : `${dir}\\${name}`;
}

/** Subscribe to streaming results. Mounted once by the app shell. */
export async function subscribeToSearch(): Promise<UnlistenFn> {
  return listen<SearchBatch>("search:batch", ({ payload }) => {
    // A late batch from a search the user has already replaced must not
    // contaminate the current results.
    if (payload.jobId !== useSearchStore.getState().jobId) return;

    for (const hit of payload.hits) {
      buffer.push({ path: joinPath(hit.dir, hit.entry.name), dir: hit.dir, entry: hit.entry });
    }
    latest = {
      hitTotal: payload.hitTotal,
      scannedEntries: payload.scannedEntries,
      capReached: payload.hitCapReached,
    };

    if (payload.done) {
      // Flush whatever is buffered, then settle the status in the same frame.
      scheduleFlush();
      requestAnimationFrame(() => {
        useSearchStore.setState((s) =>
          s.jobId === payload.jobId
            ? { status: payload.cancelled ? "cancelled" : "done" }
            : s,
        );
      });
      return;
    }
    scheduleFlush();
  });
}

export async function beginSearch(root: string, query: string): Promise<void> {
  if (query.trim() === "") {
    reset();
    return;
  }

  // Drop anything buffered from the previous run before the new id is set.
  buffer = [];
  latest = null;
  useSearchStore.setState({
    hits: [],
    status: "running",
    query,
    root,
    hitTotal: 0,
    scannedEntries: 0,
    capReached: false,
  });

  try {
    const jobId = await startSearch({ root, query });
    useSearchStore.setState({ jobId });
  } catch {
    useSearchStore.setState({ status: "done" });
  }
}

export function cancelSearch(): void {
  const { jobId, status } = useSearchStore.getState();
  if (jobId !== null && status === "running") void cancelSearchIpc(jobId).catch(() => {});
  useSearchStore.setState({ status: "cancelled" });
}

/** Leave search mode entirely. */
export function reset(): void {
  const { jobId, status } = useSearchStore.getState();
  if (jobId !== null && status === "running") void cancelSearchIpc(jobId).catch(() => {});
  if (frame !== null) {
    cancelAnimationFrame(frame);
    frame = null;
  }
  buffer = [];
  latest = null;
  useSearchStore.setState({
    jobId: null,
    query: "",
    root: "",
    hits: [],
    status: "idle",
    hitTotal: 0,
    scannedEntries: 0,
    capReached: false,
  });
}

export const searchDebug = {
  bufferSize: () => buffer.length,
  hasPendingFrame: () => frame !== null,
  reset,
};

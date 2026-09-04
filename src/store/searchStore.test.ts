import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DirEntry, SearchBatch } from "../ipc/types";

const invoke = vi.fn();
type BatchHandler = (e: { payload: SearchBatch }) => void;
let emitBatch: BatchHandler = () => {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: BatchHandler) => {
    emitBatch = handler;
    return Promise.resolve(() => {});
  },
}));

const { beginSearch, cancelSearch, MAX_LIVE_HITS, reset, searchDebug, subscribeToSearch, useSearchStore } =
  await import("./searchStore");

const D = "\\";
const ROOT = `C:${D}Users${D}User`;

function entry(name: string): DirEntry {
  return {
    name,
    isDir: false,
    flags: 0,
    size: 1,
    modifiedMs: 0,
    ext: "txt",
    category: "text",
  };
}

function batch(over: Partial<SearchBatch> & { jobId: number }): SearchBatch {
  return {
    hits: [],
    scannedDirs: 0,
    scannedEntries: 0,
    hitTotal: 0,
    hitCapReached: false,
    done: false,
    cancelled: false,
    ...over,
  };
}

const hits = (names: string[]) =>
  names.map((n) => ({ dir: `${ROOT}${D}Docs`, entry: entry(n) }));

const s = () => useSearchStore.getState();

/** Let the queued animation frame (and any follow-up frame) run. */
async function flushFrames(): Promise<void> {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

async function startRunning(jobId = 1): Promise<void> {
  invoke.mockResolvedValue(jobId);
  await beginSearch(ROOT, "report");
}

beforeEach(async () => {
  // reset() cancels whatever the previous test left running, which itself
  // calls invoke -- so it must happen BEFORE the mock is cleared, or every
  // call-count assertion starts at one.
  reset();
  invoke.mockReset();
  await subscribeToSearch();
});

describe("streaming results", () => {
  it("appends hits and reports the running total", async () => {
    await startRunning();
    emitBatch({ payload: batch({ jobId: 1, hits: hits(["a.txt", "b.txt"]), hitTotal: 2 }) });
    await flushFrames();

    expect(s().hits.map((h) => h.entry.name)).toEqual(["a.txt", "b.txt"]);
    expect(s().hitTotal).toBe(2);
    expect(s().status).toBe("running");
  });

  it("builds an absolute path for each hit, since the row key depends on it", async () => {
    await startRunning();
    emitBatch({ payload: batch({ jobId: 1, hits: hits(["a.txt"]), hitTotal: 1 }) });
    await flushFrames();

    expect(s().hits[0].path).toBe(`${ROOT}${D}Docs${D}a.txt`);
  });

  it("writes the store once per frame no matter how many batches arrive", async () => {
    await startRunning();
    let writes = 0;
    const unsub = useSearchStore.subscribe(() => {
      writes++;
    });

    for (let i = 0; i < 20; i++) {
      emitBatch({ payload: batch({ jobId: 1, hits: hits([`f${i}.txt`]), hitTotal: i + 1 }) });
    }
    // Buffered outside the store, so nothing has been written yet.
    expect(writes).toBe(0);
    expect(searchDebug.bufferSize()).toBe(20);

    await flushFrames();
    unsub();

    expect(writes).toBe(1);
    expect(s().hits).toHaveLength(20);
  });

  it("keeps results in arrival order rather than sorting as they stream", async () => {
    await startRunning();
    emitBatch({ payload: batch({ jobId: 1, hits: hits(["zebra.txt", "apple.txt"]), hitTotal: 2 }) });
    await flushFrames();

    // Sorting while appending moves every row's position, so items jump around
    // under the pointer. Arrival order is deliberate.
    expect(s().hits.map((h) => h.entry.name)).toEqual(["zebra.txt", "apple.txt"]);
  });

  it("stops growing at the cap but keeps counting", async () => {
    await startRunning();
    const many = Array.from({ length: MAX_LIVE_HITS + 500 }, (_, i) => `f${i}.txt`);
    emitBatch({
      payload: batch({ jobId: 1, hits: hits(many), hitTotal: many.length }),
    });
    await flushFrames();

    expect(s().hits).toHaveLength(MAX_LIVE_HITS);
    expect(s().hitTotal).toBe(many.length);
    expect(s().capReached).toBe(true);
  });

  it("settles to done when the final batch arrives", async () => {
    await startRunning();
    emitBatch({ payload: batch({ jobId: 1, hits: hits(["a.txt"]), hitTotal: 1, done: true }) });
    await flushFrames();

    expect(s().status).toBe("done");
    expect(s().hits).toHaveLength(1);
  });

  it("records a cancelled search as cancelled, not done", async () => {
    await startRunning();
    emitBatch({ payload: batch({ jobId: 1, done: true, cancelled: true }) });
    await flushFrames();

    expect(s().status).toBe("cancelled");
  });
});

describe("stale batches", () => {
  it("ignores results from a search that has been replaced", async () => {
    await startRunning(1);
    emitBatch({ payload: batch({ jobId: 1, hits: hits(["old.txt"]), hitTotal: 1 }) });
    await flushFrames();
    expect(s().hits).toHaveLength(1);

    // The user typed again: a new search id supersedes the old one.
    await startRunning(2);
    emitBatch({ payload: batch({ jobId: 1, hits: hits(["stale.txt"]), hitTotal: 99 }) });
    await flushFrames();

    // Two searches streaming into one list is exactly what the id check stops.
    expect(s().hits).toHaveLength(0);
    expect(s().hitTotal).toBe(0);
  });

  it("clears previous results the moment a new search starts", async () => {
    await startRunning(1);
    emitBatch({ payload: batch({ jobId: 1, hits: hits(["a.txt"]), hitTotal: 1 }) });
    await flushFrames();

    await startRunning(2);
    expect(s().hits).toEqual([]);
    expect(s().status).toBe("running");
  });
});

describe("lifecycle", () => {
  it("does nothing at all for an empty query", async () => {
    await beginSearch(ROOT, "   ");
    expect(invoke).not.toHaveBeenCalled();
    expect(s().status).toBe("idle");
  });

  it("cancels the running search on the backend", async () => {
    await startRunning(5);
    invoke.mockClear();
    cancelSearch();

    expect(invoke).toHaveBeenCalledWith("cancel_search", { jobId: 5 });
    expect(s().status).toBe("cancelled");
  });

  it("reset cancels, drops the buffer and clears the frame", async () => {
    await startRunning(7);
    emitBatch({ payload: batch({ jobId: 7, hits: hits(["a.txt"]), hitTotal: 1 }) });
    expect(searchDebug.bufferSize()).toBe(1);

    reset();

    expect(searchDebug.bufferSize()).toBe(0);
    expect(searchDebug.hasPendingFrame()).toBe(false);
    expect(s().status).toBe("idle");
    expect(s().jobId).toBeNull();
  });

  it("survives a start that the backend refuses", async () => {
    invoke.mockRejectedValue({ code: "accessDenied", message: "nope", path: null, osError: null });
    await beginSearch(ROOT, "report");
    expect(s().status).toBe("done");
    expect(s().hits).toEqual([]);
  });
});

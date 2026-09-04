import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirEntry, DirPage } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

const {
  ensureDir,
  fsCacheDebug,
  insertEntry,
  invalidate,
  patchEntry,
  retainDir,
  setProtectedPaths,
  useFsStore,
} = await import("./fsStore");
const { watchDebug } = await import("./watchBridge");

const D = "\\";
const DIR = `C:${D}Users${D}User`;

function entry(name: string, over: Partial<DirEntry> = {}): DirEntry {
  return {
    name,
    isDir: false,
    flags: 0,
    size: 1,
    modifiedMs: 1_700_000_000_000,
    ext: "txt",
    category: "text",
    ...over,
  };
}

function page(dir: string, names: string[]): DirPage {
  const entries = names.map((n) => entry(n));
  return {
    dir,
    entries,
    total: entries.length,
    truncated: false,
    elapsedMs: 1,
    warnings: [],
  };
}

/** A read whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const dirOf = (p: string) => useFsStore.getState().dirs.get(p);

beforeEach(() => {
  invoke.mockReset();
  fsCacheDebug.reset();
  watchDebug.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ensureDir", () => {
  it("loads a directory and records status, entries and generation", async () => {
    invoke.mockResolvedValue(page(DIR, ["a.txt", "b.txt"]));
    await ensureDir(DIR);

    const d = dirOf(DIR);
    expect(d?.status).toBe("ready");
    expect(d?.entries.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
    expect(d?.total).toBe(2);
    expect(d?.generation).toBe(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("de-duplicates concurrent reads, so N columns make one call", async () => {
    const d = deferred<DirPage>();
    invoke.mockReturnValue(d.promise);

    const all = Promise.all([ensureDir(DIR), ensureDir(DIR), ensureDir(DIR)]);
    expect(fsCacheDebug.inflightCount()).toBe(1);
    d.resolve(page(DIR, ["a.txt"]));
    await all;

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("normalises the path so two spellings share one cache entry", async () => {
    invoke.mockResolvedValue(page(DIR, ["a.txt"]));
    await ensureDir("C:/Users/User");
    await ensureDir(`c:${D}Users${D}User${D}`);

    expect(fsCacheDebug.cachedCount()).toBe(1);
    expect(dirOf(DIR)).toBeDefined();
  });

  it("serves a fresh directory from cache without another call", async () => {
    invoke.mockResolvedValue(page(DIR, ["a.txt"]));
    await ensureDir(DIR);
    await ensureDir(DIR);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("re-reads when forced", async () => {
    invoke.mockResolvedValue(page(DIR, ["a.txt"]));
    await ensureDir(DIR);
    await ensureDir(DIR, { force: true });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(dirOf(DIR)?.generation).toBe(2);
  });

  it("keeps existing entries visible while revalidating", async () => {
    invoke.mockResolvedValue(page(DIR, ["a.txt"]));
    await ensureDir(DIR);

    const second = deferred<DirPage>();
    invoke.mockReturnValue(second.promise);
    const pending = ensureDir(DIR, { force: true });

    // Stale-while-revalidate: status stays ready and the old rows remain, so
    // the view shows a thin progress line instead of blanking to a skeleton.
    expect(dirOf(DIR)?.status).toBe("ready");
    expect(dirOf(DIR)?.entries).toHaveLength(1);

    second.resolve(page(DIR, ["a.txt", "b.txt"]));
    await pending;
    expect(dirOf(DIR)?.entries).toHaveLength(2);
  });

  it("shows loading only when there is nothing cached yet", async () => {
    const d = deferred<DirPage>();
    invoke.mockReturnValue(d.promise);
    const pending = ensureDir(DIR);
    expect(dirOf(DIR)?.status).toBe("loading");
    d.resolve(page(DIR, []));
    await pending;
  });

  it("records a typed error without throwing", async () => {
    invoke.mockRejectedValue({
      code: "accessDenied",
      message: "You don't have permission to access this item.",
      path: DIR,
      osError: 5,
    });
    await expect(ensureDir(DIR)).resolves.toBeUndefined();

    const d = dirOf(DIR);
    expect(d?.status).toBe("error");
    expect(d?.error?.code).toBe("accessDenied");
    expect(fsCacheDebug.inflightCount()).toBe(0);
  });

  it("wraps a non-FsError rejection rather than leaking a bare string", async () => {
    invoke.mockRejectedValue("boom");
    await ensureDir(DIR);
    expect(dirOf(DIR)?.error?.code).toBe("internal");
  });

  it("ignores an empty path", async () => {
    await ensureDir("   ");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("retainDir", () => {
  it("starts a watch on the first consumer and loads the directory", async () => {
    invoke.mockResolvedValue(page(DIR, ["a.txt"]));
    const release = retainDir(DIR);
    expect(fsCacheDebug.refCount(DIR)).toBe(1);
    expect(watchDebug.has(DIR)).toBe(true);
    await vi.waitFor(() => expect(dirOf(DIR)?.status).toBe("ready"));
    release();
  });

  it("counts multiple consumers and watches only once", async () => {
    invoke.mockResolvedValue(page(DIR, []));
    const r1 = retainDir(DIR);
    const r2 = retainDir(DIR);
    const r3 = retainDir(DIR);
    expect(fsCacheDebug.refCount(DIR)).toBe(3);
    expect(watchDebug.count()).toBe(1);
    r1();
    r2();
    r3();
  });

  it("defers the unwatch, so fast arrowing does not thrash watch/unwatch", () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue(page(DIR, []));

    const release = retainDir(DIR);
    release();

    // Still watched immediately after release.
    expect(watchDebug.has(DIR)).toBe(true);
    expect(fsCacheDebug.pendingUnwatchCount()).toBe(1);

    vi.advanceTimersByTime(2100);
    expect(watchDebug.has(DIR)).toBe(false);
    expect(fsCacheDebug.pendingUnwatchCount()).toBe(0);
  });

  it("cancels a pending unwatch when the directory is retained again", () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue(page(DIR, []));

    retainDir(DIR)();
    expect(fsCacheDebug.pendingUnwatchCount()).toBe(1);

    const again = retainDir(DIR);
    expect(fsCacheDebug.pendingUnwatchCount()).toBe(0);

    vi.advanceTimersByTime(5000);
    expect(watchDebug.has(DIR)).toBe(true);
    again();
  });

  it("release is idempotent, because StrictMode runs cleanups twice", () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue(page(DIR, []));

    const a = retainDir(DIR);
    const b = retainDir(DIR);
    a();
    a();
    a();
    // A refcount that could go negative would silently stop watching a
    // directory that is still on screen.
    expect(fsCacheDebug.refCount(DIR)).toBe(1);

    b();
    vi.advanceTimersByTime(2100);
    expect(watchDebug.has(DIR)).toBe(false);
  });

  it("survives a StrictMode double mount and unmount", () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue(page(DIR, []));

    const first = retainDir(DIR);
    first();
    const second = retainDir(DIR);
    expect(watchDebug.has(DIR)).toBe(true);
    second();
    vi.advanceTimersByTime(2100);
    expect(watchDebug.has(DIR)).toBe(false);
    expect(fsCacheDebug.retainedCount()).toBe(0);
  });

  it("ignores an empty path and returns a usable release", () => {
    const release = retainDir("");
    expect(() => release()).not.toThrow();
    expect(watchDebug.count()).toBe(0);
  });
});

describe("patchEntry and insertEntry", () => {
  beforeEach(async () => {
    invoke.mockResolvedValue(page(DIR, ["a.txt", "b.txt"]));
    await ensureDir(DIR);
  });

  it("merges a patch and bumps the generation", () => {
    patchEntry(DIR, "a.txt", { name: "renamed.txt", ext: "txt" });
    const d = dirOf(DIR);
    expect(d?.entries.map((e) => e.name)).toEqual(["renamed.txt", "b.txt"]);
    expect(d?.generation).toBe(2);
  });

  it("removes an entry and decrements the total", () => {
    patchEntry(DIR, "a.txt", null);
    const d = dirOf(DIR);
    expect(d?.entries.map((e) => e.name)).toEqual(["b.txt"]);
    expect(d?.total).toBe(1);
  });

  it("is a no-op for an unknown entry or an uncached directory", () => {
    const before = dirOf(DIR)?.generation;
    patchEntry(DIR, "missing.txt", { size: 5 });
    patchEntry(`C:${D}Nope`, "a.txt", { size: 5 });
    expect(dirOf(DIR)?.generation).toBe(before);
  });

  it("inserts an optimistic entry once", () => {
    insertEntry(DIR, entry("New Folder", { isDir: true, category: "folder", ext: "" }));
    expect(dirOf(DIR)?.entries).toHaveLength(3);
    insertEntry(DIR, entry("New Folder", { isDir: true, category: "folder", ext: "" }));
    expect(dirOf(DIR)?.entries).toHaveLength(3);
  });
});

describe("invalidate", () => {
  it("re-reads immediately when the directory is retained", async () => {
    invoke.mockResolvedValue(page(DIR, ["a.txt"]));
    const release = retainDir(DIR);
    await vi.waitFor(() => expect(dirOf(DIR)?.status).toBe("ready"));

    invalidate(DIR);
    await vi.waitFor(() => expect(dirOf(DIR)?.generation).toBe(2));
    release();
  });

  it("only marks an unretained directory stale, deferring the cost", async () => {
    invoke.mockResolvedValue(page(DIR, ["a.txt"]));
    await ensureDir(DIR);
    const calls = invoke.mock.calls.length;

    invalidate(DIR);
    expect(invoke.mock.calls.length).toBe(calls);
    expect(dirOf(DIR)?.loadedAt).toBe(0);

    await ensureDir(DIR);
    expect(invoke.mock.calls.length).toBe(calls + 1);
  });

  it("ignores an unknown directory", () => {
    expect(() => invalidate(`C:${D}Nope`)).not.toThrow();
  });
});

describe("eviction", () => {
  it("never evicts a retained directory, so a watcher cannot be orphaned", async () => {
    invoke.mockImplementation((_cmd: string, args: { req: { dir: string } }) =>
      Promise.resolve(page(args.req.dir, ["x.txt"])),
    );

    const keep = `C:${D}Keep`;
    setProtectedPaths([]);
    const release = retainDir(keep);
    await vi.waitFor(() => expect(dirOf(keep)?.status).toBe("ready"));

    // Push well past the 256-entry cap.
    for (let i = 0; i < 300; i++) {
      await ensureDir(`C:${D}Filler${D}d${i}`);
    }

    expect(fsCacheDebug.cachedCount()).toBeLessThanOrEqual(256);
    expect(dirOf(keep), "a retained directory must survive eviction").toBeDefined();
    release();
  });

  it("never evicts a protected ancestor", async () => {
    invoke.mockImplementation((_cmd: string, args: { req: { dir: string } }) =>
      Promise.resolve(page(args.req.dir, [])),
    );

    const ancestor = `C:${D}`;
    await ensureDir(ancestor);
    setProtectedPaths([ancestor]);

    for (let i = 0; i < 300; i++) {
      await ensureDir(`C:${D}Filler${D}e${i}`);
    }
    expect(dirOf(ancestor)).toBeDefined();
  });
});

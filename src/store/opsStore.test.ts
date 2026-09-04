import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirEntry, DirPage, Preflight } from "../ipc/types";

const invoke = vi.fn();
const listen = vi.fn(async (..._args: unknown[]) => () => {});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listen(...args),
}));

const { beginTransfer, commitRename, opsDebug, useOpsStore } = await import("./opsStore");
const { useAppStore } = await import("./appStore");
const { ensureDir, fsCacheDebug, useFsStore } = await import("./fsStore");
const { watchDebug } = await import("./watchBridge");

const D = "\\";
const DIR = `C:${D}Users${D}User`;

function entry(name: string, over: Partial<DirEntry> = {}): DirEntry {
  return {
    name,
    isDir: false,
    flags: 0,
    size: 1,
    modifiedMs: 0,
    ext: "txt",
    category: "text",
    ...over,
  };
}

function page(dir: string, names: string[]): DirPage {
  const entries = names.map((n) => entry(n));
  return { dir, entries, total: entries.length, truncated: false, elapsedMs: 1, warnings: [] };
}

function emptyPreflight(over: Partial<Preflight> = {}): Preflight {
  return {
    sourceCount: 1,
    totalBytes: 10,
    conflicts: [],
    blockers: [],
    destFreeBytes: 1_000_000,
    sameVolume: true,
    instant: false,
    ...over,
  };
}

const INITIAL_APP = useAppStore.getState();
const s = () => useAppStore.getState();
const ops = () => useOpsStore.getState();
const namesIn = (dir: string) =>
  useFsStore.getState().dirs.get(dir)?.entries.map((e) => e.name) ?? [];

beforeEach(() => {
  invoke.mockReset();
  listen.mockClear();
  fsCacheDebug.reset();
  watchDebug.reset();
  opsDebug.reset();
  useAppStore.setState(INITIAL_APP, true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("commitRename", () => {
  async function seed() {
    invoke.mockImplementation((cmd: string, args: { req?: { dir: string } }) => {
      if (cmd === "read_dir") return Promise.resolve(page(args.req!.dir, ["a.txt", "b.txt"]));
      return Promise.resolve(null);
    });
    await ensureDir(DIR);
    invoke.mockReset();
  }

  it("patches the row immediately and moves the selection with it", async () => {
    await seed();
    invoke.mockResolvedValue(`${DIR}${D}renamed.txt`);

    await commitRename(`${DIR}${D}a.txt`, "renamed.txt");

    expect(namesIn(DIR)).toEqual(["renamed.txt", "b.txt"]);
    expect(s().cursor).toBe(`${DIR}${D}renamed.txt`);
    expect([...s().selection]).toEqual([`${DIR}${D}renamed.txt`]);
    expect(s().renamingPath).toBeNull();
  });

  it("rolls back and re-opens the editor when the backend refuses", async () => {
    await seed();
    invoke.mockRejectedValue({
      code: "alreadyExists",
      message: "An item with that name already exists.",
      path: null,
      osError: null,
    });

    await commitRename(`${DIR}${D}a.txt`, "b.txt");

    expect(namesIn(DIR)).toEqual(["a.txt", "b.txt"]);
    expect([...s().selection]).toEqual([`${DIR}${D}a.txt`]);
    // Fixing a rejected name should be one keystroke away, not a fresh hunt
    // for the row.
    expect(s().renamingPath).toBe(`${DIR}${D}a.txt`);
    expect(ops().toasts).toHaveLength(1);
    expect(ops().toasts[0].tone).toBe("error");
  });

  it("does nothing at all when the name is unchanged", async () => {
    await seed();
    await commitRename(`${DIR}${D}a.txt`, "a.txt");

    expect(invoke).not.toHaveBeenCalled();
    expect(namesIn(DIR)).toEqual(["a.txt", "b.txt"]);
    expect(s().renamingPath).toBeNull();
  });

  it("treats an emptied name as a cancel rather than an error", async () => {
    await seed();
    await commitRename(`${DIR}${D}a.txt`, "   ");
    expect(invoke).not.toHaveBeenCalled();
    expect(namesIn(DIR)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("beginTransfer", () => {
  it("starts straight away when nothing collides", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "preflight_transfer") return Promise.resolve(emptyPreflight());
      if (cmd === "start_transfer") return Promise.resolve(7);
      return Promise.resolve(null);
    });

    await beginTransfer({ sources: [`${DIR}${D}a.txt`], destDir: `C:${D}Other`, mode: "copy" });

    expect(invoke.mock.calls.map(([c]) => c)).toContain("start_transfer");
    expect(ops().pending).toBeNull();
  });

  it("pauses for one decision when there are collisions", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "preflight_transfer") {
        return Promise.resolve(
          emptyPreflight({
            conflicts: [
              {
                src: `${DIR}${D}a.txt`,
                dest: `C:${D}Other${D}a.txt`,
                name: "a.txt",
                srcIsDir: false,
                destIsDir: false,
                srcSize: 10,
                destSize: 5,
                srcModifiedMs: 2,
                destModifiedMs: 1,
                identical: false,
                mergePossible: false,
                suggestedKeepBothName: "a (2).txt",
              },
            ],
          }),
        );
      }
      return Promise.resolve(null);
    });

    await beginTransfer({ sources: [`${DIR}${D}a.txt`], destDir: `C:${D}Other`, mode: "copy" });

    // One dialog for the whole job, and nothing written until it is answered.
    expect(ops().pending).not.toBeNull();
    expect(invoke.mock.calls.map(([c]) => c)).not.toContain("start_transfer");
  });

  it("refuses a blocker outright instead of offering a resolution", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "preflight_transfer") {
        return Promise.resolve(
          emptyPreflight({
            blockers: [{ kind: "destinationInsideSource", source: `${DIR}${D}A` }],
          }),
        );
      }
      return Promise.resolve(null);
    });

    await beginTransfer({ sources: [`${DIR}${D}A`], destDir: `${DIR}${D}A${D}B`, mode: "copy" });

    // Copying a folder into itself is not a conflict to resolve; it is a
    // request that cannot be honoured.
    expect(ops().pending).toBeNull();
    expect(invoke.mock.calls.map(([c]) => c)).not.toContain("start_transfer");
    expect(ops().toasts[0].message).toMatch(/can't be copied into itself/i);
  });

  it("surfaces a pre-flight failure as an error rather than starting blind", async () => {
    invoke.mockRejectedValue({
      code: "accessDenied",
      message: "You don't have permission to access this item.",
      path: null,
      osError: 5,
    });

    await beginTransfer({ sources: [`${DIR}${D}a.txt`], destDir: `C:${D}Other`, mode: "copy" });

    expect(invoke.mock.calls.map(([c]) => c)).not.toContain("start_transfer");
    expect(ops().toasts[0].tone).toBe("error");
  });
});

describe("toasts", () => {
  it("expire on their own, errors lasting longer than notices", () => {
    vi.useFakeTimers();
    ops().toast("info", "Copied 3 items");
    ops().toast("error", "Something went wrong");
    expect(ops().toasts).toHaveLength(2);

    vi.advanceTimersByTime(4100);
    expect(ops().toasts.map((t) => t.tone)).toEqual(["error"]);

    vi.advanceTimersByTime(4100);
    expect(ops().toasts).toHaveLength(0);
  });

  it("can be dismissed by hand", () => {
    ops().toast("info", "hello");
    const id = ops().toasts[0].id;
    ops().dismissToast(id);
    expect(ops().toasts).toHaveLength(0);
  });

  it("summarises several errors without stacking a toast per failure", () => {
    ops().reportErrors(
      [
        { code: "accessDenied", message: "Denied A", path: null, osError: null },
        { code: "accessDenied", message: "Denied B", path: null, osError: null },
      ],
      "Copy",
    );
    expect(ops().toasts).toHaveLength(1);
    expect(ops().toasts[0].message).toBe("Denied A (and 1 more)");
  });
});

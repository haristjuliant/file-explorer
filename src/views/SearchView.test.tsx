import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DirEntry, PreviewPlan, SearchBatch } from "../ipc/types";

const invoke = vi.fn();
type BatchHandler = (e: { payload: SearchBatch }) => void;
let emitBatch: BatchHandler = () => {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: BatchHandler) => {
    emitBatch = handler;
    return Promise.resolve(() => {});
  },
}));

const { SearchView } = await import("./SearchView");
const { useAppStore } = await import("../store/appStore");
const { orderRegistry } = await import("../order/registry");
const { beginSearch, reset, subscribeToSearch } = await import("../store/searchStore");
const { Harness, assertQuickLookContract } = await import("../../tests/quickLookContract");

const D = "\\";
const ROOT = `C:${D}Users${D}User`;
const DOCS = `${ROOT}${D}Docs`;

function entry(name: string, over: Partial<DirEntry> = {}): DirEntry {
  return {
    name,
    isDir: false,
    flags: 0,
    size: 2048,
    modifiedMs: 1_700_000_000_000,
    ext: "txt",
    category: "text",
    ...over,
  };
}

function textPlan(path: string): PreviewPlan {
  return {
    mode: "text",
    head: {
      text: `contents of ${path}`,
      bytesRead: 8,
      truncated: false,
      encoding: "utf-8",
      isBinary: false,
      lineCount: 1,
    },
  };
}

const INITIAL = useAppStore.getState();
const s = () => useAppStore.getState();

/** Mount the results view and stream three hits into it. */
async function mount(names = ["alpha.txt", "beta.txt", "gamma.txt"]) {
  invoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "start_search":
        return Promise.resolve(1);
      case "preview_plan":
        return Promise.resolve(textPlan(args.path as string));
      case "stat":
        return Promise.resolve({
          path: args.path,
          name: String(args.path).split(D).pop(),
          isDir: false,
          flags: 0,
          size: 2048,
          createdMs: 1_700_000_000_000,
          modifiedMs: 1_700_000_000_000,
          accessedMs: 1_700_000_000_000,
          ext: "txt",
          category: "text",
          linkTarget: null,
        });
      default:
        return Promise.resolve(null);
    }
  });

  useAppStore.setState({ ...INITIAL, cwd: ROOT, searchMode: "recursive" }, true);
  await subscribeToSearch();
  await beginSearch(ROOT, "a");

  const user = userEvent.setup();
  render(<Harness view={<SearchView />} />);

  emitBatch({
    payload: {
      jobId: 1,
      hits: names.map((n) => ({ dir: DOCS, entry: entry(n) })),
      scannedDirs: 4,
      scannedEntries: 40,
      hitTotal: names.length,
      hitCapReached: false,
      done: true,
      cancelled: false,
    },
  });

  await waitFor(() => expect(orderRegistry.get().paths.length).toBe(names.length));
  return user;
}

beforeEach(() => {
  reset();
  invoke.mockReset();
  orderRegistry.reset();
  useAppStore.setState(INITIAL, true);
});

describe("SearchView", () => {
  it("lists each hit with its folder shown relative to the search root", async () => {
    await mount();
    expect(screen.getByText("alpha.txt")).toBeInTheDocument();
    // The Path column is relative, so a deep result stays readable.
    expect(screen.getAllByText("Docs").length).toBeGreaterThan(0);
  });

  it("reports how many were found", async () => {
    await mount();
    expect(screen.getByText(/Found 3 items/)).toBeInTheDocument();
  });

  it("says so plainly when nothing matched", async () => {
    await mount([]);
    await waitFor(() => expect(screen.getByText("No matches")).toBeInTheDocument());
  });

  it("publishes results to the registry as an ordinary order source", async () => {
    await mount();
    expect(orderRegistry.get().paths).toEqual([
      `${DOCS}${D}alpha.txt`,
      `${DOCS}${D}beta.txt`,
      `${DOCS}${D}gamma.txt`,
    ]);
  });

  it("arrows through results without leaving the list", async () => {
    const user = await mount();
    s().select(`${DOCS}${D}alpha.txt`);
    await user.keyboard("{ArrowDown}");
    expect(s().cursor).toBe(`${DOCS}${D}beta.txt`);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(s().cursor).toBe(`${DOCS}${D}gamma.txt`);
  });

  it("opening a result leaves search and reveals it in its folder", async () => {
    const user = await mount();
    await user.dblClick(screen.getByText("beta.txt"));

    await waitFor(() => expect(s().cwd).toBe(DOCS));
    expect(s().searchMode).toBe("off");
    expect([...s().selection]).toEqual([`${DOCS}${D}beta.txt`]);
  });
});

describe("Quick Look in search results", () => {
  it("satisfies the same contract as list, column and tree view", async () => {
    const user = await mount();
    // The payoff of keeping the order abstraction view-agnostic: search results
    // are just another OrderSource, so Quick Look needs no code of its own.
    await assertQuickLookContract({
      user,
      startPath: `${DOCS}${D}alpha.txt`,
      expectedForward: ["alpha.txt", "beta.txt", "gamma.txt"],
    });
  });
});

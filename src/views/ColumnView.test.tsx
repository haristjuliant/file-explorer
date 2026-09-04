import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DirEntry, DirPage, PreviewPlan } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
}));

const { ColumnView, columnViewDebug } = await import("./ColumnView");
const { useAppStore, PREVIEW_COLUMN } = await import("../store/appStore");
const { orderRegistry } = await import("../order/registry");
const { fsCacheDebug } = await import("../store/fsStore");
const { watchDebug } = await import("../store/watchBridge");
const { Harness, assertQuickLookContract } = await import("../../tests/quickLookContract");

const D = "\\";
const ROOT = `C:${D}Users`;
const USER = `${ROOT}${D}User`;
const DOCS = `${USER}${D}Documents`;

function entry(name: string, over: Partial<DirEntry> = {}): DirEntry {
  return {
    name,
    isDir: false,
    flags: 0,
    size: 10,
    modifiedMs: 1_700_000_000_000,
    ext: "txt",
    category: "text",
    ...over,
  };
}

const folder = (name: string) =>
  entry(name, { isDir: true, category: "folder", ext: "", size: 0 });

/** A small three-level tree, so descending and ascending both have somewhere to go. */
const TREE: Record<string, DirEntry[]> = {
  [`C:${D}`]: [folder("Users"), folder("Windows")],
  [ROOT]: [folder("Public"), folder("User")],
  [USER]: [folder("Documents"), entry("notes.txt"), entry("todo.txt")],
  [DOCS]: [entry("alpha.txt"), entry("beta.txt"), entry("gamma.txt")],
};

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

function mockBackend() {
  invoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "read_dir": {
        const req = args.req as { dir: string };
        const entries = TREE[req.dir] ?? [];
        const page: DirPage = {
          dir: req.dir,
          entries,
          total: entries.length,
          truncated: false,
          elapsedMs: 1,
          warnings: [],
        };
        return Promise.resolve(page);
      }
      case "preview_plan":
        return Promise.resolve(textPlan(args.path as string));
      case "stat":
        return Promise.resolve({
          path: args.path,
          name: String(args.path).split(D).pop(),
          isDir: false,
          flags: 0,
          size: 10,
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
}

/** Mount column view at `USER`, whose chain is C:\ -> C:\Users -> C:\Users\User. */
async function mount() {
  mockBackend();
  useAppStore.setState({ ...INITIAL, viewMode: "column" }, true);
  s().navigate(USER);

  const user = userEvent.setup();
  render(<Harness view={<ColumnView />} />);
  await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(2));
  return user;
}

const columnCount = () => document.querySelectorAll(".fm-column").length;
const rowByName = (name: string) => screen.getByText(name).closest('[role="row"]')!;

beforeEach(() => {
  invoke.mockReset();
  fsCacheDebug.reset();
  watchDebug.reset();
  orderRegistry.reset();
  columnViewDebug.resetLastChild();
  useAppStore.setState(INITIAL, true);
});

describe("ColumnView layout", () => {
  it("renders one column per ancestor of the current directory", async () => {
    await mount();
    expect(s().columnChain).toEqual([`C:${D}`, ROOT, USER]);
    await waitFor(() => expect(columnCount()).toBe(3));
  });

  it("shows each column's own contents", async () => {
    await mount();
    await waitFor(() => expect(screen.getByText("Windows")).toBeInTheDocument());
    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
  });

  it("marks directory rows with a chevron and files without one", async () => {
    await mount();
    await waitFor(() => expect(screen.getByText("Documents")).toBeInTheDocument());
    expect(rowByName("Documents").querySelector(".fm-chevron-right")).not.toBeNull();
    expect(rowByName("notes.txt").querySelector(".fm-chevron-right")).toBeNull();
  });
});

describe("ColumnView chain behaviour", () => {
  it("selecting a folder spawns the next column", async () => {
    const user = await mount();
    await user.click(rowByName("Documents"));

    await waitFor(() => expect(s().columnChain).toEqual([`C:${D}`, ROOT, USER, DOCS]));
    await waitFor(() => expect(screen.getByText("alpha.txt")).toBeInTheDocument());
  });

  it("selecting a file replaces the trailing column with a preview", async () => {
    const user = await mount();
    await user.click(rowByName("notes.txt"));

    await waitFor(() => expect(s().columnChain[3]).toBe(PREVIEW_COLUMN));
    await waitFor(() =>
      expect(screen.getByText(`contents of ${USER}${D}notes.txt`)).toBeInTheDocument(),
    );
  });

  it("moving back to a folder truncates the columns to its right", async () => {
    const user = await mount();
    await user.click(rowByName("Documents"));
    await waitFor(() => expect(s().columnChain).toHaveLength(4));

    await user.click(rowByName("notes.txt"));
    // The Documents column is replaced by the preview, not kept alongside it.
    await waitFor(() => expect(s().columnChain).toHaveLength(4));
    expect(s().columnChain[3]).toBe(PREVIEW_COLUMN);
  });

  it("right arrow descends into the first child of the next column", async () => {
    const user = await mount();
    s().select(`${USER}${D}Documents`);
    await waitFor(() => expect(s().columnChain).toHaveLength(4));

    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(s().cursor).toBe(`${DOCS}${D}alpha.txt`));
  });

  it("left arrow puts the cursor back on the folder one column left", async () => {
    const user = await mount();
    s().select(`${USER}${D}Documents`);
    await waitFor(() => expect(s().columnChain).toHaveLength(4));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(s().cursor).toBe(`${DOCS}${D}alpha.txt`));

    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(s().cursor).toBe(`${USER}${D}Documents`));
  });

  it("remembers which child was last selected, as Finder does", async () => {
    const user = await mount();
    s().select(`${USER}${D}Documents`);
    await waitFor(() => expect(s().columnChain).toHaveLength(4));

    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(s().cursor).toBe(`${DOCS}${D}alpha.txt`));
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(s().cursor).toBe(`${DOCS}${D}gamma.txt`);

    // Go left, then right again: Finder returns you to gamma, not alpha.
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(s().cursor).toBe(`${USER}${D}Documents`));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(s().cursor).toBe(`${DOCS}${D}gamma.txt`));
  });

  it("left arrow at the leftmost column brings the parent into view", async () => {
    const user = await mount();
    // Put the cursor in the very first column.
    s().select(`C:${D}Users`);
    await waitFor(() => expect(s().cursor).toBe(ROOT));

    await user.keyboard("{ArrowLeft}");
    // C:\ has no parent, so the chain is unchanged rather than growing a
    // bogus column -- the guard that keeps this from looping.
    await waitFor(() => expect(s().columnChain[0]).toBe(`C:${D}`));
  });

  it("keeps up and down inside one column", async () => {
    const user = await mount();
    s().select(`${USER}${D}Documents`);
    await waitFor(() => expect(orderRegistry.get().paths.length).toBe(3));

    await user.keyboard("{ArrowDown}");
    expect(s().cursor).toBe(`${USER}${D}notes.txt`);
    await user.keyboard("{ArrowDown}");
    expect(s().cursor).toBe(`${USER}${D}todo.txt`);
    // Clamped at the end of THIS column, never spilling into another.
    await user.keyboard("{ArrowDown}");
    expect(s().cursor).toBe(`${USER}${D}todo.txt`);
  });

  it("publishes only the column holding the cursor", async () => {
    await mount();
    s().select(`${USER}${D}notes.txt`);
    await waitFor(() => {
      const paths = orderRegistry.get().paths;
      expect(paths).toContain(`${USER}${D}notes.txt`);
      // Not the sibling column's contents.
      expect(paths).not.toContain(`${ROOT}${D}Public`);
    });

    s().select(`${ROOT}${D}Public`);
    await waitFor(() => {
      const paths = orderRegistry.get().paths;
      expect(paths).toContain(`${ROOT}${D}Public`);
      expect(paths).not.toContain(`${USER}${D}notes.txt`);
    });
  });
});

describe("Quick Look in column view", () => {
  it("satisfies the same contract as list view, with no Quick Look changes", async () => {
    const user = await mount();
    // Order inside the User column: Documents (folder first), notes, todo.
    await assertQuickLookContract({
      user,
      startPath: `${USER}${D}Documents`,
      expectedForward: ["Documents", "notes.txt", "todo.txt"],
    });
  });

  it("steps within the column that holds the cursor, not across columns", async () => {
    const user = await mount();
    s().select(`${USER}${D}Documents`);
    await waitFor(() => expect(s().columnChain).toHaveLength(4));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(s().cursor).toBe(`${DOCS}${D}alpha.txt`));

    await user.keyboard(" ");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    await user.keyboard("{ArrowDown}");
    // beta, not something from the User column.
    await waitFor(() => expect(s().cursor).toBe(`${DOCS}${D}beta.txt`));
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DirEntry, DirPage, PreviewPlan } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
}));

const { TreeView } = await import("./TreeView");
const { useAppStore } = await import("../store/appStore");
const { orderRegistry } = await import("../order/registry");
const { fsCacheDebug } = await import("../store/fsStore");
const { watchDebug } = await import("../store/watchBridge");
const { Harness, assertQuickLookContract } = await import("../../tests/quickLookContract");

const D = "\\";
const USER = `C:${D}Users${D}User`;
const DOCS = `${USER}${D}Documents`;
const EMPTY = `${USER}${D}Empty`;

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

const TREE: Record<string, DirEntry[]> = {
  [USER]: [folder("Documents"), folder("Empty"), entry("notes.txt"), entry("todo.txt")],
  [DOCS]: [entry("alpha.txt"), entry("beta.txt"), entry("gamma.txt")],
  [EMPTY]: [],
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

async function mount() {
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

  useAppStore.setState({ ...INITIAL, viewMode: "tree" }, true);
  s().navigate(USER);

  const user = userEvent.setup();
  render(<Harness view={<TreeView />} />);
  await waitFor(() => expect(screen.getByText("notes.txt")).toBeInTheDocument());
  return user;
}

const rowByName = (name: string) => screen.getByText(name).closest('[role="row"]')!;
const visibleNames = () =>
  Array.from(document.querySelectorAll(".fm-tree-row .fm-name")).map((n) => n.textContent);

/** Expand Documents and wait for its children to appear. */
async function expandDocs(user: Awaited<ReturnType<typeof mount>>) {
  const twisty = rowByName("Documents").querySelector(".fm-twisty")!;
  await user.click(twisty);
  await waitFor(() => expect(screen.getByText("alpha.txt")).toBeInTheDocument());
}

beforeEach(() => {
  invoke.mockReset();
  fsCacheDebug.reset();
  watchDebug.reset();
  orderRegistry.reset();
  useAppStore.setState(INITIAL, true);
});

describe("TreeView rendering", () => {
  it("shows the current folder's contents at depth 0, folders first", async () => {
    await mount();
    expect(visibleNames()).toEqual(["Documents", "Empty", "notes.txt", "todo.txt"]);
  });

  it("renders one flat list, not nested scroll containers", async () => {
    await mount();
    // Nested containers would break virtualization, keyboard order and
    // scrollToIndex all at once, so there must be exactly one scroller.
    expect(document.querySelectorAll(".fm-tree-scroll").length).toBe(1);
    expect(document.querySelectorAll(".fm-tree-rows").length).toBe(1);
  });

  it("indents children under their parent", async () => {
    const user = await mount();
    await expandDocs(user);

    const indentOf = (name: string) =>
      (rowByName(name).querySelector(".fm-tree-indent") as HTMLElement).style.width;
    expect(indentOf("Documents")).toBe("0px");
    expect(indentOf("alpha.txt")).toBe("16px");
  });

  it("hides the triangle for a folder confirmed empty", async () => {
    const user = await mount();
    const twisty = rowByName("Empty").querySelector(".fm-twisty") as HTMLElement;
    // Optimistic before it is known...
    expect(twisty.dataset.hidden).toBeUndefined();

    await user.click(twisty);
    // ...and gone once the read comes back empty.
    await waitFor(() =>
      expect(
        (rowByName("Empty").querySelector(".fm-twisty") as HTMLElement).dataset.hidden,
      ).toBe("true"),
    );
  });
});

describe("TreeView expansion", () => {
  it("expands and collapses on the triangle", async () => {
    const user = await mount();
    await expandDocs(user);
    expect(visibleNames()).toEqual([
      "Documents",
      "alpha.txt",
      "beta.txt",
      "gamma.txt",
      "Empty",
      "notes.txt",
      "todo.txt",
    ]);

    await user.click(rowByName("Documents").querySelector(".fm-twisty")!);
    await waitFor(() => expect(screen.queryByText("alpha.txt")).not.toBeInTheDocument());
  });

  it("clicking the triangle does not change the selection", async () => {
    const user = await mount();
    await user.click(rowByName("notes.txt"));
    expect(s().cursor).toBe(`${USER}${D}notes.txt`);

    await expandDocs(user);
    // Opening a folder to look inside must not cost you your selection.
    expect(s().cursor).toBe(`${USER}${D}notes.txt`);
  });

  it("right arrow expands, then steps into the first child", async () => {
    const user = await mount();
    s().select(DOCS);

    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(screen.getByText("alpha.txt")).toBeInTheDocument());
    expect(s().cursor).toBe(DOCS);

    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(s().cursor).toBe(`${DOCS}${D}alpha.txt`));
  });

  it("left arrow collapses, then climbs to the parent", async () => {
    const user = await mount();
    await expandDocs(user);
    s().select(`${DOCS}${D}beta.txt`);

    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(s().cursor).toBe(DOCS));

    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(screen.queryByText("beta.txt")).not.toBeInTheDocument());
  });

  it("rescues the cursor when collapsing the subtree it sits in", async () => {
    const user = await mount();
    await expandDocs(user);
    s().select(`${DOCS}${D}gamma.txt`);

    await user.click(rowByName("Documents").querySelector(".fm-twisty")!);
    // Otherwise the cursor vanishes from the visible order and every arrow
    // press restarts at the top of the list.
    await waitFor(() => expect(s().cursor).toBe(DOCS));
    expect([...s().selection]).toEqual([DOCS]);
  });

  it("keeps arrow navigation flowing across depth levels", async () => {
    const user = await mount();
    await expandDocs(user);
    s().select(DOCS);

    await user.keyboard("{ArrowDown}");
    expect(s().cursor).toBe(`${DOCS}${D}alpha.txt`);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(s().cursor).toBe(`${DOCS}${D}gamma.txt`);
    // Down again leaves the subtree and lands on the next sibling of Documents.
    await user.keyboard("{ArrowDown}");
    expect(s().cursor).toBe(EMPTY);
  });
});

describe("Quick Look in tree view", () => {
  it("satisfies the same contract as list and column view", async () => {
    const user = await mount();
    await expandDocs(user);
    // Deliberately crossing a depth boundary: Documents is depth 0 and the two
    // that follow are depth 1. Quick Look knows nothing about that.
    await assertQuickLookContract({
      user,
      startPath: DOCS,
      expectedForward: ["Documents", "alpha.txt", "beta.txt"],
    });
  });

  it("never lands on a loading placeholder", async () => {
    const user = await mount();
    s().select(DOCS);
    // Expand without letting the child read settle.
    await user.keyboard("{ArrowRight}");

    const paths = orderRegistry.get().paths;
    expect(paths.some((p) => p.endsWith(" loading"))).toBe(false);
  });
});

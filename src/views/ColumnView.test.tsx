import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DirEntry, DirPage, PreviewPlan } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
}));

const { ColumnView } = await import("./ColumnView");
const { resetColumnMemory } = await import("./columnMemory");
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

/** Longer than any column may become, so the cap and the elision both apply. */
const LONG_NAME =
  "quarterly-revenue-breakdown-by-region-and-product-line-with-appendices-2026-final-approved-v7.xlsx";

const TREE: Record<string, DirEntry[]> = {
  [`C:${D}`]: [folder("Users"), folder("Windows")],
  [ROOT]: [folder("Public"), folder("User")],
  [USER]: [folder("Documents"), folder("Wide"), entry("notes.txt"), entry("todo.txt")],
  [DOCS]: [entry("alpha.txt"), entry("beta.txt"), entry("gamma.txt")],
  [`${USER}${D}Wide`]: [entry(LONG_NAME, { ext: "xlsx", category: "spreadsheet" })],
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

/** Mount column view rooted at `C:\Users\User`. */
async function mount() {
  mockBackend();
  useAppStore.setState({ ...INITIAL, viewMode: "column" }, true);
  s().navigate(USER);

  const user = userEvent.setup();
  render(<Harness view={<ColumnView />} />);
  await waitFor(() => expect(screen.getByText("notes.txt")).toBeInTheDocument());
  return user;
}

const columnCount = () => document.querySelectorAll(".fm-column").length;
const rowByName = (name: string) => screen.getByText(name).closest('[role="row"]')!;

beforeEach(() => {
  invoke.mockReset();
  fsCacheDebug.reset();
  watchDebug.reset();
  orderRegistry.reset();
  resetColumnMemory();
  useAppStore.setState(INITIAL, true);
});

describe("ColumnView roots at the folder you arrived in", () => {
  it("opens with a single column, not the whole ancestry", async () => {
    await mount();
    // Rebuilding C:\ -> C:\Users -> C:\Users\User would leave the strip already
    // scrolled to the right before the user has opened anything.
    expect(s().columnChain).toEqual([USER]);
    await waitFor(() => expect(columnCount()).toBe(1));
  });

  it("shows that folder's contents", async () => {
    await mount();
    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    // Nothing from a parent folder is on screen.
    expect(screen.queryByText("Public")).not.toBeInTheDocument();
  });

  it("marks directory rows with a chevron and files without one", async () => {
    await mount();
    expect(rowByName("Documents").querySelector(".fm-chevron-right")).not.toBeNull();
    expect(rowByName("notes.txt").querySelector(".fm-chevron-right")).toBeNull();
  });

  it("re-roots when the user navigates, however deep the strip had grown", async () => {
    const user = await mount();
    await user.click(rowByName("Documents"));
    await waitFor(() => expect(s().columnChain).toEqual([USER, DOCS]));

    // What clicking a sidebar place does.
    s().navigate(DOCS);
    await waitFor(() => expect(s().columnChain).toEqual([DOCS]));
    await waitFor(() => expect(columnCount()).toBe(1));
  });
});

describe("browsing versus opening", () => {
  it("a single click spawns the next column and keeps the root", async () => {
    const user = await mount();
    await user.click(rowByName("Documents"));

    await waitFor(() => expect(s().columnChain).toEqual([USER, DOCS]));
    // Browsing must not move the working directory.
    expect(s().cwd).toBe(USER);
    await waitFor(() => expect(screen.getByText("alpha.txt")).toBeInTheDocument());
  });

  it("selecting a file replaces the trailing column with a preview", async () => {
    const user = await mount();
    await user.click(rowByName("notes.txt"));

    await waitFor(() => expect(s().columnChain).toEqual([USER, PREVIEW_COLUMN]));
    await waitFor(() =>
      expect(screen.getByText(`contents of ${USER}${D}notes.txt`)).toBeInTheDocument(),
    );
  });

  it("a double click OPENS the folder and re-roots the strip", async () => {
    const user = await mount();
    await user.dblClick(rowByName("Documents"));

    await waitFor(() => expect(s().cwd).toBe(DOCS));
    expect(s().columnChain).toEqual([DOCS]);
    await waitFor(() => expect(columnCount()).toBe(1));
    await waitFor(() => expect(screen.getByText("alpha.txt")).toBeInTheDocument());
  });

  it("Enter opens the folder the same way a double click does", async () => {
    const user = await mount();
    s().select(`${USER}${D}Documents`);
    await waitFor(() => expect(orderRegistry.get().paths.length).toBe(4));

    await user.keyboard("{Enter}");
    await waitFor(() => expect(s().cwd).toBe(DOCS));
    expect(s().columnChain).toEqual([DOCS]);
  });

  it("an arrow key browses without re-rooting", async () => {
    const user = await mount();
    s().select(`${USER}${D}Documents`);
    await waitFor(() => expect(s().columnChain).toEqual([USER, DOCS]));

    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(s().cursor).toBe(`${DOCS}${D}alpha.txt`));
    // Still browsing: the root and the working directory are untouched.
    expect(s().cwd).toBe(USER);
    expect(s().columnChain[0]).toBe(USER);
  });
});

describe("keyboard navigation within the strip", () => {
  it("left arrow puts the cursor back on the folder one column left", async () => {
    const user = await mount();
    s().select(`${USER}${D}Documents`);
    await waitFor(() => expect(s().columnChain).toHaveLength(2));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(s().cursor).toBe(`${DOCS}${D}alpha.txt`));

    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(s().cursor).toBe(`${USER}${D}Documents`));
  });

  it("remembers which child was last selected, as Finder does", async () => {
    const user = await mount();
    s().select(`${USER}${D}Documents`);
    await waitFor(() => expect(s().columnChain).toHaveLength(2));

    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(s().cursor).toBe(`${DOCS}${D}alpha.txt`));
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(s().cursor).toBe(`${DOCS}${D}gamma.txt`);

    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(s().cursor).toBe(`${USER}${D}Documents`));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(s().cursor).toBe(`${DOCS}${D}gamma.txt`));
  });

  it("left arrow at the leftmost column brings the parent into view", async () => {
    const user = await mount();
    s().select(`${USER}${D}notes.txt`);
    await waitFor(() => expect(s().cursor).toBe(`${USER}${D}notes.txt`));

    await user.keyboard("{ArrowLeft}");
    // Walking up is how you leave the root you landed on.
    await waitFor(() => expect(s().columnChain[0]).toBe(ROOT));
  });

  it("keeps up and down inside one column", async () => {
    const user = await mount();
    s().select(`${USER}${D}Documents`);
    await waitFor(() => expect(orderRegistry.get().paths.length).toBe(4));

    await user.keyboard("{ArrowDown}");
    expect(s().cursor).toBe(`${USER}${D}Wide`);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(s().cursor).toBe(`${USER}${D}todo.txt`);
    await user.keyboard("{ArrowDown}");
    expect(s().cursor).toBe(`${USER}${D}todo.txt`);
  });

  it("publishes only the column holding the cursor", async () => {
    const user = await mount();
    await user.click(rowByName("Documents"));
    await waitFor(() => expect(screen.getByText("alpha.txt")).toBeInTheDocument());

    s().select(`${DOCS}${D}beta.txt`);
    await waitFor(() => {
      const paths = orderRegistry.get().paths;
      expect(paths).toContain(`${DOCS}${D}beta.txt`);
      expect(paths).not.toContain(`${USER}${D}notes.txt`);
    });
  });
});

describe("horizontal auto-scroll", () => {
  it("brings the newest column into view when the chain grows", async () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const user = await mount();
    scrollIntoView.mockClear();

    await user.click(rowByName("Documents"));

    // Without this the user has to scroll by hand as soon as the strip is
    // wider than the window.
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.calls[0][0]).toMatchObject({ inline: "end" });
    scrollIntoView.mockRestore();
  });

  it("also scrolls when the trailing column becomes a preview", async () => {
    // The old implementation keyed off chain LENGTH, so swapping a folder
    // column for a preview of the same length scrolled nowhere.
    const user = await mount();
    await user.click(rowByName("Documents"));
    await waitFor(() => expect(s().columnChain).toHaveLength(2));

    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    await user.click(rowByName("notes.txt"));
    await waitFor(() => expect(s().columnChain).toEqual([USER, PREVIEW_COLUMN]));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockRestore();
  });

  it("keeps scrolling on later changes rather than latching off", async () => {
    // The old flag, once set by a wheel event, disabled auto-scroll for the
    // rest of the session.
    const user = await mount();
    await user.click(rowByName("Documents"));
    await waitFor(() => expect(screen.getByText("alpha.txt")).toBeInTheDocument());

    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    s().navigate(DOCS);
    await waitFor(() => expect(s().columnChain).toEqual([DOCS]));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockRestore();
  });
});

describe("Quick Look in column view", () => {
  it("satisfies the same contract as list, tree and search view", async () => {
    const user = await mount();
    await assertQuickLookContract({
      user,
      startPath: `${USER}${D}Documents`,
      expectedForward: ["Documents", "Wide", "notes.txt"],
    });
  });
});

describe("column width and long names", () => {
  const widthOf = (index: number) =>
    parseFloat(
      (document.querySelectorAll<HTMLElement>(".fm-column")[index]?.style.width ?? "0").replace(
        "px",
        "",
      ),
    );

  it("sizes a column to its longest entry rather than a fixed width", async () => {
    const user = await mount();
    const narrow = widthOf(0);

    await user.click(rowByName("Wide"));
    await waitFor(() => expect(document.querySelectorAll(".fm-column").length).toBe(2));

    // The column holding a very long name is wider than the one holding short
    // ones -- that is the whole point of measuring.
    await waitFor(() => expect(widthOf(1)).toBeGreaterThan(narrow));
  });

  it("caps the width so one absurd name cannot swallow the window", async () => {
    const user = await mount();
    await user.click(rowByName("Wide"));
    await waitFor(() => expect(document.querySelectorAll(".fm-column").length).toBe(2));

    // Windows allows 255-character names; honouring one would push every other
    // column off-screen.
    await waitFor(() => expect(widthOf(1)).toBeLessThanOrEqual(400));
    expect(widthOf(1)).toBeGreaterThanOrEqual(150);
  });

  it("never goes below the minimum, even for a folder of one-letter names", async () => {
    await mount();
    expect(widthOf(0)).toBeGreaterThanOrEqual(150);
  });

  it("elides the middle of a name that does not fit, keeping both ends", async () => {
    const user = await mount();
    await user.click(rowByName("Wide"));

    const row = await waitFor(() => {
      const el = document.querySelectorAll<HTMLElement>(".fm-column")[1]?.querySelector(".fm-name");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    const shown = row.textContent ?? "";
    expect(shown).not.toBe(LONG_NAME);
    expect(shown).toContain("…");
    expect(shown.startsWith("quarterly")).toBe(true);
    // An end-ellipsis would have taken the extension; a middle one keeps it.
    expect(shown.endsWith("xlsx")).toBe(true);
  });

  it("keeps the whole name in the tooltip, so nothing is truly hidden", async () => {
    const user = await mount();
    await user.click(rowByName("Wide"));

    const row = await waitFor(() => {
      const el = document.querySelectorAll<HTMLElement>(".fm-column")[1]?.querySelector(".fm-name");
      expect(el?.getAttribute("title")).toBeTruthy();
      return el as HTMLElement;
    });
    expect(row.getAttribute("title")).toBe(LONG_NAME);
  });

  it("leaves a name that fits alone, with no tooltip", async () => {
    await mount();
    const el = screen.getByText("notes.txt");
    expect(el.textContent).toBe("notes.txt");
    expect(el.getAttribute("title")).toBeNull();
  });
});

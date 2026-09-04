import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DirEntry, DirPage } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

const { ListView } = await import("./ListView");
const { useAppStore } = await import("./../store/appStore");
const { fsCacheDebug } = await import("../store/fsStore");
const { orderRegistry } = await import("../order/registry");
const { watchDebug } = await import("../store/watchBridge");

const D = "\\";
const DIR = `C:${D}Users${D}User`;
const p = (name: string) => `${DIR}${D}${name}`;

function entry(name: string, over: Partial<DirEntry> = {}): DirEntry {
  return {
    name,
    isDir: false,
    flags: 0,
    size: 1024,
    modifiedMs: Date.now(),
    ext: "txt",
    category: "text",
    ...over,
  };
}

const ENTRIES: DirEntry[] = [
  entry("Documents", { isDir: true, category: "folder", ext: "", size: 0 }),
  entry("Downloads", { isDir: true, category: "folder", ext: "", size: 0 }),
  entry("alpha.txt"),
  entry("beta.txt"),
  entry("gamma.txt"),
  entry("delta.png", { ext: "png", category: "image" }),
];

function pageFor(dir: string, entries: DirEntry[]): DirPage {
  return { dir, entries, total: entries.length, truncated: false, elapsedMs: 1, warnings: [] };
}

const INITIAL = useAppStore.getState();
const s = () => useAppStore.getState();
const sel = () => [...s().selection].sort();

async function renderList(entries = ENTRIES) {
  invoke.mockImplementation((cmd: string, args: { req?: { dir: string } }) => {
    if (cmd === "read_dir") return Promise.resolve(pageFor(args.req!.dir, entries));
    return Promise.resolve(null);
  });
  useAppStore.setState({ ...INITIAL, cwd: DIR, columnChain: [], treeRoots: [DIR] }, true);
  const utils = render(<ListView />);
  // Rows appear only after the directory read resolves.
  if (entries.length > 0) {
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
  }
  return utils;
}

const rowByName = (name: string) => screen.getByText(name).closest('[role="row"]')!;

beforeEach(() => {
  invoke.mockReset();
  fsCacheDebug.reset();
  watchDebug.reset();
  orderRegistry.reset();
  useAppStore.setState(INITIAL, true);
});

describe("ListView rendering", () => {
  it("renders a header and one row per entry, folders first", async () => {
    await renderList();

    expect(screen.getByRole("columnheader", { name: /Name/ })).toBeInTheDocument();
    for (const e of ENTRIES) expect(screen.getByText(e.name)).toBeInTheDocument();

    // Folders sort above files regardless of name.
    const names = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.querySelector(".fm-name")?.textContent);
    expect(names.slice(0, 2)).toEqual(["Documents", "Downloads"]);
  });

  it("shows a human size for files and a dash for folders", async () => {
    await renderList();
    expect(rowByName("alpha.txt")).toHaveTextContent("1 KB");
    expect(rowByName("Documents")).toHaveTextContent("--");
  });

  it("labels kinds the way Finder words them", async () => {
    await renderList();
    expect(rowByName("delta.png")).toHaveTextContent("PNG image");
    expect(rowByName("Documents")).toHaveTextContent("Folder");
  });

  it("publishes its order to the registry so the keyboard layer can act", async () => {
    await renderList();
    await waitFor(() => expect(orderRegistry.get().paths.length).toBe(ENTRIES.length));
    expect(orderRegistry.source()?.view).toBe("list");
    expect(orderRegistry.get().paths[0]).toBe(p("Documents"));
  });

  it("shows an empty state rather than a bare grid", async () => {
    await renderList([]);
    await waitFor(() => expect(screen.getByText(/This folder is empty/)).toBeInTheDocument());
  });

  it("explains a permission error and offers a retry", async () => {
    invoke.mockRejectedValue({
      code: "accessDenied",
      message: "You don't have permission to access this item.",
      path: DIR,
      osError: 5,
    });
    useAppStore.setState({ ...INITIAL, cwd: DIR }, true);
    render(<ListView />);

    await waitFor(() =>
      expect(screen.getByText(/don't have permission to see this folder/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument();
  });
});

describe("ListView selection", () => {
  it("click selects a single row", async () => {
    const user = userEvent.setup();
    await renderList();

    await user.click(rowByName("beta.txt"));
    expect(sel()).toEqual([p("beta.txt")]);
    expect(s().cursor).toBe(p("beta.txt"));
    expect(rowByName("beta.txt")).toHaveAttribute("aria-selected", "true");
  });

  it("shift+click selects the range between anchor and target", async () => {
    const user = userEvent.setup();
    await renderList();

    await user.click(rowByName("Downloads"));
    await user.keyboard("{Shift>}");
    await user.click(rowByName("beta.txt"));
    await user.keyboard("{/Shift}");

    // Sorted order is Documents, Downloads, alpha, beta, delta, gamma.
    expect(sel()).toEqual([p("Downloads"), p("alpha.txt"), p("beta.txt")].sort());
  });

  it("ctrl+click adds and removes individual rows", async () => {
    const user = userEvent.setup();
    await renderList();

    await user.click(rowByName("alpha.txt"));
    await user.keyboard("{Control>}");
    await user.click(rowByName("gamma.txt"));
    await user.keyboard("{/Control}");
    expect(sel()).toEqual([p("alpha.txt"), p("gamma.txt")].sort());

    await user.keyboard("{Control>}");
    await user.click(rowByName("gamma.txt"));
    await user.keyboard("{/Control}");
    expect(sel()).toEqual([p("alpha.txt")]);
  });

  it("select-all covers every visible row", async () => {
    await renderList();
    await waitFor(() => expect(orderRegistry.get().paths.length).toBe(ENTRIES.length));
    s().selectAll();
    expect(sel().length).toBe(ENTRIES.length);
  });

  it("arrowing moves through the published order", async () => {
    await renderList();
    await waitFor(() => expect(orderRegistry.get().paths.length).toBe(ENTRIES.length));

    s().moveCursor(1, false);
    expect(s().cursor).toBe(p("Documents"));
    s().moveCursor(1, false);
    expect(s().cursor).toBe(p("Downloads"));
    s().moveCursor("end", false);
    expect(s().cursor).toBe(p("gamma.txt"));
  });
});

describe("ListView navigation", () => {
  it("double-clicking a folder navigates into it", async () => {
    const user = userEvent.setup();
    await renderList();

    await user.dblClick(rowByName("Documents"));
    await waitFor(() => expect(s().cwd).toBe(p("Documents")));
  });

  it("sorting by size flips direction on a second header click", async () => {
    const user = userEvent.setup();
    await renderList();

    const header = screen.getByRole("columnheader", { name: /Size/ });
    await user.click(header);
    // Size starts descending: biggest first, as in Finder.
    expect(s().sortKey).toBe("size");
    expect(s().sortDir).toBe(-1);

    await user.click(header);
    expect(s().sortDir).toBe(1);
  });
});

describe("ListView hidden entries", () => {
  const withHidden = [...ENTRIES, entry(".gitignore", { flags: 1, ext: "" })];

  it("hides dotfiles until asked", async () => {
    await renderList(withHidden);
    expect(screen.queryByText(".gitignore")).not.toBeInTheDocument();
  });

  it("reveals them instantly, with no further backend call", async () => {
    await renderList(withHidden);
    const callsBefore = invoke.mock.calls.length;

    s().toggleHidden();
    await waitFor(() => expect(screen.getByText(".gitignore")).toBeInTheDocument());
    // The point of returning every entry with flags: the toggle costs no IPC.
    expect(invoke.mock.calls.length).toBe(callsBefore);
  });
});

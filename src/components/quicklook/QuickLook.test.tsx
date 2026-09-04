import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DirEntry, DirPage, PreviewPlan } from "../../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
}));

const { ListView } = await import("../../views/ListView");
const { useAppStore } = await import("../../store/appStore");
const { orderRegistry } = await import("../../order/registry");
const { fsCacheDebug } = await import("../../store/fsStore");
const { watchDebug } = await import("../../store/watchBridge");
const { Harness, assertQuickLookContract, dialogTitle } = await import(
  "../../../tests/quickLookContract"
);

const D = "\\";
const DIR = `C:${D}Users${D}User`;

function entry(name: string, over: Partial<DirEntry> = {}): DirEntry {
  return {
    name,
    isDir: false,
    flags: 0,
    size: 100,
    modifiedMs: 1_700_000_000_000,
    ext: "txt",
    category: "text",
    ...over,
  };
}

const ENTRIES: DirEntry[] = [
  entry("one.txt"),
  entry("two.txt"),
  entry("three.txt"),
  entry("photo.png", { ext: "png", category: "image" }),
];

function textPlan(path: string): PreviewPlan {
  return {
    mode: "text",
    head: {
      text: `contents of ${path}`,
      bytesRead: 20,
      truncated: false,
      encoding: "utf-8",
      isBinary: false,
      lineCount: 1,
    },
  };
}

const INITIAL = useAppStore.getState();
const s = () => useAppStore.getState();

async function mount(entries = ENTRIES) {
  invoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "read_dir": {
        const req = args.req as { dir: string };
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
          size: 100,
          createdMs: 1_700_000_000_000,
          modifiedMs: 1_700_000_000_000,
          accessedMs: 1_700_000_000_000,
          ext: "txt",
          category: "text",
          linkTarget: null,
        });
      case "prefetch_thumbnails":
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  });

  useAppStore.setState({ ...INITIAL, cwd: DIR }, true);
  const user = userEvent.setup();
  render(<Harness view={<ListView />} />);
  await waitFor(() => expect(orderRegistry.get().paths.length).toBe(entries.length));
  return user;
}

beforeEach(() => {
  invoke.mockReset();
  fsCacheDebug.reset();
  watchDebug.reset();
  orderRegistry.reset();
  useAppStore.setState(INITIAL, true);
});

describe("Quick Look in list view", () => {
  it("satisfies the shared contract, the same routine column view runs", async () => {
    const user = await mount();
    await assertQuickLookContract({
      user,
      startPath: `${DIR}${D}one.txt`,
      expectedForward: ["one.txt", "photo.png", "three.txt"],
    });
  });

  it("does not open without a cursor to preview", async () => {
    const user = await mount();
    await user.keyboard(" ");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens on Space and shows the cursor's file", async () => {
    const user = await mount();
    s().select(`${DIR}${D}two.txt`);

    await user.keyboard(" ");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(dialogTitle()).toBe("two.txt");
  });

  it("advances with the arrow keys and the preview follows", async () => {
    const user = await mount();
    s().select(`${DIR}${D}one.txt`);
    await user.keyboard(" ");
    await waitFor(() => expect(dialogTitle()).toBe("one.txt"));

    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(dialogTitle()).toBe("photo.png"));
    // The cursor in the view moved too, so closing leaves you where you expect.
    expect(s().cursor).toBe(`${DIR}${D}photo.png`);

    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(dialogTitle()).toBe("three.txt"));

    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(dialogTitle()).toBe("photo.png"));
  });

  it("treats left and right as previous and next, as Finder does", async () => {
    const user = await mount();
    s().select(`${DIR}${D}one.txt`);
    await user.keyboard(" ");
    await waitFor(() => expect(dialogTitle()).toBe("one.txt"));

    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(dialogTitle()).toBe("photo.png"));
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(dialogTitle()).toBe("one.txt"));
  });

  it("jumps to the ends with Home and End", async () => {
    const user = await mount();
    s().select(`${DIR}${D}photo.png`);
    await user.keyboard(" ");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    await user.keyboard("{End}");
    await waitFor(() => expect(dialogTitle()).toBe("two.txt"));
    await user.keyboard("{Home}");
    await waitFor(() => expect(dialogTitle()).toBe("one.txt"));
  });

  it("stops at the last item rather than wrapping", async () => {
    const user = await mount();
    s().select(`${DIR}${D}two.txt`);
    await user.keyboard(" ");
    await waitFor(() => expect(dialogTitle()).toBe("two.txt"));

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(dialogTitle()).toBe("two.txt");
  });

  it("shows the position within the folder", async () => {
    const user = await mount();
    s().select(`${DIR}${D}one.txt`);
    await user.keyboard(" ");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByText("1 of 4")).toBeInTheDocument();
  });

  it("renders the preview content the backend planned", async () => {
    const user = await mount();
    s().select(`${DIR}${D}one.txt`);
    await user.keyboard(" ");
    await waitFor(() =>
      expect(screen.getByText(`contents of ${DIR}${D}one.txt`)).toBeInTheDocument(),
    );
  });

  it("closes on Space and on Escape", async () => {
    const user = await mount();
    s().select(`${DIR}${D}one.txt`);

    await user.keyboard(" ");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    await user.keyboard(" ");
    await waitFor(() => expect(s().quickLookOpen).toBe(false));

    await user.keyboard(" ");
    await waitFor(() => expect(s().quickLookOpen).toBe(true));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(s().quickLookOpen).toBe(false));
  });

  it("keeps the selection intact when it closes", async () => {
    const user = await mount();
    s().select(`${DIR}${D}three.txt`);
    await user.keyboard(" ");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    await user.keyboard("{Escape}");

    await waitFor(() => expect(s().quickLookOpen).toBe(false));
    expect([...s().selection]).toEqual([`${DIR}${D}three.txt`]);
  });

  it("is an accessible modal dialog labelled by the file name", async () => {
    const user = await mount();
    s().select(`${DIR}${D}two.txt`);
    await user.keyboard(" ");

    const dialog = await waitFor(() => screen.getByRole("dialog"));
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "two.txt");
  });

  it("warms the neighbouring previews so stepping feels instant", async () => {
    const user = await mount();
    s().select(`${DIR}${D}photo.png`);
    await user.keyboard(" ");

    await waitFor(() =>
      expect(invoke.mock.calls.some(([cmd]) => cmd === "prefetch_thumbnails")).toBe(true),
    );
  });

  it("does not swallow arrow keys once it is closed", async () => {
    const user = await mount();
    s().select(`${DIR}${D}one.txt`);
    await user.keyboard(" ");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(s().quickLookOpen).toBe(false));

    // Back to ordinary list navigation, replacing the selection.
    await user.keyboard("{ArrowDown}");
    expect(s().cursor).toBe(`${DIR}${D}photo.png`);
    expect([...s().selection]).toEqual([`${DIR}${D}photo.png`]);
  });
});

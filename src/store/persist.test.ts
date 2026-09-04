import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

const { hydratePrefs, prefsDebug, watchPrefs } = await import("./persist");
const { useAppStore } = await import("./appStore");

const INITIAL = useAppStore.getState();
const s = () => useAppStore.getState();
const KEY = prefsDebug.key;

function store(value: unknown): void {
  localStorage.setItem(KEY, JSON.stringify(value));
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState(INITIAL, true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hydratePrefs", () => {
  it("restores the preferences that should outlive a restart", () => {
    store({
      viewMode: "tree",
      sortKey: "size",
      sortDir: -1,
      showHidden: true,
      previewVisible: true,
      sidebarWidth: 260,
    });
    hydratePrefs();

    expect(s().viewMode).toBe("tree");
    expect(s().sortKey).toBe("size");
    expect(s().sortDir).toBe(-1);
    expect(s().showHidden).toBe(true);
    expect(s().previewVisible).toBe(true);
    expect(s().sidebarWidth).toBe(260);
  });

  it("does nothing when there is nothing stored", () => {
    hydratePrefs();
    expect(s().viewMode).toBe(INITIAL.viewMode);
  });

  it("survives a corrupt blob and throws it away", () => {
    localStorage.setItem(KEY, "{not json at all");
    expect(() => hydratePrefs()).not.toThrow();
    expect(s().viewMode).toBe(INITIAL.viewMode);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("ignores fields of the wrong shape rather than trusting them", () => {
    // Stored preferences outlive the code that wrote them, so an old or
    // hand-edited value must degrade to the default instead of putting the
    // store somewhere no code path expects.
    store({
      viewMode: "gallery",
      sortKey: "colour",
      sortDir: 7,
      showHidden: "yes",
      sidebarWidth: "wide",
    });
    hydratePrefs();

    expect(s().viewMode).toBe(INITIAL.viewMode);
    expect(s().sortKey).toBe(INITIAL.sortKey);
    expect(s().sortDir).toBe(INITIAL.sortDir);
    expect(s().showHidden).toBe(INITIAL.showHidden);
    expect(s().sidebarWidth).toBe(INITIAL.sidebarWidth);
  });

  it("clamps widths into their allowed range", () => {
    store({ sidebarWidth: 9999, previewWidth: 1, listColumnWidths: { name: 5, size: 8000 } });
    hydratePrefs();

    expect(s().sidebarWidth).toBe(420);
    expect(s().previewWidth).toBe(200);
    expect(s().listColumnWidths.name).toBe(120);
    expect(s().listColumnWidths.size).toBe(1200);
    // Columns absent from the blob keep their defaults.
    expect(s().listColumnWidths.modified).toBe(INITIAL.listColumnWidths.modified);
  });

  it("accepts a partial blob without disturbing anything else", () => {
    store({ showSystem: true });
    hydratePrefs();
    expect(s().showSystem).toBe(true);
    expect(s().viewMode).toBe(INITIAL.viewMode);
  });

  it("does not restore anything that could point at a deleted folder", () => {
    // Directory, selection and expanded tree are deliberately session-only:
    // restoring them would open the app somewhere that may no longer exist.
    store({ cwd: "C:\\Nope", selection: ["C:\\Nope\\a.txt"], treeRoots: ["C:\\Nope"] });
    hydratePrefs();

    expect(s().cwd).toBe(INITIAL.cwd);
    expect(s().selection.size).toBe(0);
    expect(s().treeRoots).toEqual(INITIAL.treeRoots);
  });

  it("degrades to defaults when storage itself is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(() => hydratePrefs()).not.toThrow();
    expect(s().viewMode).toBe(INITIAL.viewMode);
  });
});

describe("watchPrefs", () => {
  it("writes once after a burst of changes rather than on every one", () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const stop = watchPrefs();

    // A column drag commits many updates in quick succession.
    for (let i = 0; i < 30; i++) s().setSidebarWidth(200 + i);
    expect(setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(setItem).toHaveBeenCalledTimes(1);
    stop();
  });

  it("persists what it saved, ready for the next launch", () => {
    vi.useFakeTimers();
    const stop = watchPrefs();
    s().setViewMode("column");
    s().toggleHidden();
    vi.advanceTimersByTime(500);
    stop();

    useAppStore.setState(INITIAL, true);
    hydratePrefs();
    expect(s().viewMode).toBe("column");
    expect(s().showHidden).toBe(true);
  });

  it("stops writing once unsubscribed", () => {
    vi.useFakeTimers();
    const stop = watchPrefs();
    stop();

    const setItem = vi.spyOn(Storage.prototype, "setItem");
    s().setViewMode("tree");
    vi.advanceTimersByTime(1000);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("does not throw when storage refuses the write", () => {
    vi.useFakeTimers();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const stop = watchPrefs();
    s().setViewMode("tree");
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    stop();
  });
});

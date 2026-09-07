/**
 * The UI store: navigation, view mode, selection, clipboard, chrome.
 *
 * Two stores exist, not one. This one is small and changes on every click and
 * keystroke; `fsStore` is large and changes only on I/O. Merging them would mean
 * every arrow-key press wakes every component that reads directory contents.
 *
 * The slices live in one file on purpose: they are mutually dependent --
 * changing directory clears the selection, closes Quick Look, resets the column
 * chain and drops the filter -- and coordinating that inside a single `set` call
 * is far cleaner than orchestrating it from a component, or than five files with
 * circular type imports.
 *
 * zustand 5 uses `useSyncExternalStore` with strict `Object.is` on the selector
 * result. There is no automatic shallow compare. Therefore:
 *
 *   1. Selectors return primitives, or a reference already stored here. Never
 *      `.map` / `.filter` / `.sort` / `Array.from` / an object literal.
 *   2. `useShallow` for multi-field pulls (it is depth-1 only).
 *   3. `Set` and `Map` values are immutable -- replaced wholesale, never mutated.
 *   4. Rows subscribe to their own boolean (`s.selection.has(path)`), never to
 *      the Set itself. Ten thousand rows each watching a stable boolean is far
 *      cheaper than ten thousand rows woken by a new Set reference. This is the
 *      single most important performance decision in the frontend.
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import { orderRegistry, type ViewMode } from "../order/registry";
import {
  rangeBetween,
  stepIndex,
  toggleIn,
  unionRange,
} from "../order/selectionMath";
import { initialDirFor, type SortDir, type SortKey } from "../lib/sort";
import { normalize, parentOf } from "../lib/path";

/** Sentinel occupying the trailing slot of the column chain when a file is selected. */
export const PREVIEW_COLUMN = "";

const HISTORY_CAP = 200;

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

interface NavSlice {
  cwd: string;
  history: string[];
  historyIndex: number;
  /**
   * Stored rather than derived: the toolbar re-renders on any navigation change
   * anyway, and a stored boolean is `Object.is`-stable where a computed one in a
   * selector would not be.
   */
  canBack: boolean;
  canForward: boolean;

  navigate(path: string, opts?: { replace?: boolean }): void;
  back(): void;
  forward(): void;
  up(): void;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export type ListColumn = "name" | "modified" | "size" | "kind";

interface ViewSlice {
  viewMode: ViewMode;
  sortKey: SortKey;
  sortDir: SortDir;
  showHidden: boolean;
  showSystem: boolean;
  /** Instant client-side filter over already-loaded entries. */
  filterQuery: string;
  listColumnWidths: Record<ListColumn, number>;
  /** Per-depth column widths in column mode. */
  columnWidths: number[];
  /** Directory chain, one entry per column; a trailing `PREVIEW_COLUMN` is the file preview. */
  columnChain: string[];
  treeRoots: string[];
  treeExpanded: Set<string>;

  setViewMode(m: ViewMode): void;
  setSort(key: SortKey): void;
  toggleHidden(): void;
  toggleSystem(): void;
  setFilterQuery(q: string): void;
  setListColumnWidth(col: ListColumn, w: number): void;
  setColumnWidth(depth: number, w: number): void;
  /** Truncate the chain to `depth` and put `dir` there (or the preview sentinel). */
  pushColumn(depth: number, dir: string): void;
  prependColumn(dir: string): void;
  toggleTreeExpanded(path: string, force?: boolean): void;
  collapseAll(): void;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

interface SelectionSlice {
  selection: Set<string>;
  /** The focused row. Quick Look always previews this. */
  cursor: string | null;
  /** Origin of a shift-range. Must NOT move on shift+arrow, or ranges cannot shrink. */
  anchor: string | null;

  select(path: string): void;
  toggle(path: string): void;
  selectRange(path: string): void;
  addRange(path: string): void;
  selectAll(): void;
  clearSelection(): void;
  setSelection(paths: readonly string[], cursor?: string | null): void;
  /** Move the cursor within the active `OrderSource`. `delta` may be a row count. */
  moveCursor(delta: number | "home" | "end", extend: boolean): void;
  /** Ctrl+arrow: move focus without changing what is selected. */
  moveCursorOnly(delta: number): void;
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

export interface Clipboard {
  mode: "copy" | "cut";
  paths: string[];
  stamp: number;
}

interface ClipboardSlice {
  clipboard: Clipboard | null;
  copySelection(): void;
  cutSelection(): void;
  clearClipboard(): void;
}

// ---------------------------------------------------------------------------
// Chrome / UI
// ---------------------------------------------------------------------------

export interface ContextMenuState {
  x: number;
  y: number;
  paths: string[];
}

interface UiSlice {
  previewVisible: boolean;
  sidebarWidth: number;
  previewWidth: number;
  quickLookOpen: boolean;
  renamingPath: string | null;
  searchMode: "off" | "filter" | "recursive";
  contextMenu: ContextMenuState | null;
  /**
   * Selection greys out when the window loses focus. It is one of the strongest
   * "this looks like Finder" cues and costs a single boolean.
   */
  windowFocused: boolean;

  togglePreview(): void;
  setSidebarWidth(w: number): void;
  setPreviewWidth(w: number): void;
  openQuickLook(): void;
  closeQuickLook(): void;
  toggleQuickLook(): void;
  beginRename(path: string): void;
  endRename(): void;
  setSearchMode(m: UiSlice["searchMode"]): void;
  openContextMenu(s: ContextMenuState): void;
  closeContextMenu(): void;
  setWindowFocused(v: boolean): void;
}

export type AppStore = NavSlice & ViewSlice & SelectionSlice & ClipboardSlice & UiSlice;

/**
 * Everything that must reset when the user lands in a different directory.
 *
 * The column chain becomes JUST that directory, not its whole ancestry. Landing
 * somewhere -- from the sidebar, the breadcrumb, back/forward -- makes it the
 * leftmost column, exactly as Finder does. Rebuilding the full ancestry instead
 * would leave the strip already scrolled far to the right before the user has
 * opened anything, which is the opposite of a fresh start. Arrow-left still
 * walks upwards by prepending the parent.
 */
function resetForDirectory(path: string) {
  return {
    selection: new Set<string>(),
    cursor: null,
    anchor: null,
    quickLookOpen: false,
    renamingPath: null,
    contextMenu: null,
    filterQuery: "",
    searchMode: "off" as const,
    columnChain: [path],
    treeRoots: [path],
  };
}

export const useAppStore = create<AppStore>()(
  subscribeWithSelector((set, get) => ({
    // -- nav ----------------------------------------------------------------
    cwd: "",
    history: [],
    historyIndex: -1,
    canBack: false,
    canForward: false,

    navigate(path, opts) {
      const target = normalize(path);
      if (target === "") return;
      const s = get();
      if (target === s.cwd && !opts?.replace) return;

      let history: string[];
      let historyIndex: number;
      if (opts?.replace && s.historyIndex >= 0) {
        history = s.history.slice();
        history[s.historyIndex] = target;
        historyIndex = s.historyIndex;
      } else {
        // Navigating after going back truncates the forward tail, like a browser.
        history = s.history.slice(0, s.historyIndex + 1);
        history.push(target);
        if (history.length > HISTORY_CAP) history = history.slice(-HISTORY_CAP);
        historyIndex = history.length - 1;
      }

      set({
        cwd: target,
        history,
        historyIndex,
        canBack: historyIndex > 0,
        canForward: historyIndex < history.length - 1,
        ...resetForDirectory(target),
      });
    },

    back() {
      const s = get();
      if (s.historyIndex <= 0) return;
      const historyIndex = s.historyIndex - 1;
      const cwd = s.history[historyIndex];
      set({
        cwd,
        historyIndex,
        canBack: historyIndex > 0,
        canForward: true,
        ...resetForDirectory(cwd),
      });
    },

    forward() {
      const s = get();
      if (s.historyIndex >= s.history.length - 1) return;
      const historyIndex = s.historyIndex + 1;
      const cwd = s.history[historyIndex];
      set({
        cwd,
        historyIndex,
        canBack: true,
        canForward: historyIndex < s.history.length - 1,
        ...resetForDirectory(cwd),
      });
    },

    up() {
      const parent = parentOf(get().cwd);
      if (parent) get().navigate(parent);
    },

    // -- view ---------------------------------------------------------------
    viewMode: "list",
    sortKey: "name",
    sortDir: 1,
    showHidden: false,
    showSystem: false,
    filterQuery: "",
    listColumnWidths: { name: 320, modified: 160, size: 96, kind: 140 },
    columnWidths: [],
    columnChain: [],
    treeRoots: [],
    treeExpanded: new Set(),

    setViewMode(m) {
      const s = get();
      if (s.viewMode === m) return;
      // Handing off from tree mode: the cursor may sit several levels deep, so
      // the least surprising new cwd is the cursor's own parent.
      let cwd = s.cwd;
      if (s.viewMode === "tree" && m !== "tree" && s.cursor) {
        cwd = parentOf(s.cursor) ?? s.cwd;
      }
      // Switching into column view roots the strip at the current folder, for
      // the same reason navigating does: a fresh view should start at the left.
      set({
        viewMode: m,
        cwd,
        columnChain: [m === "column" && s.cursor ? (parentOf(s.cursor) ?? cwd) : cwd],
        treeRoots: [cwd],
      });
    },

    setSort(key) {
      const s = get();
      set(
        s.sortKey === key
          ? { sortDir: (s.sortDir === 1 ? -1 : 1) as SortDir }
          : { sortKey: key, sortDir: initialDirFor(key) },
      );
    },

    toggleHidden() {
      set({ showHidden: !get().showHidden });
    },

    toggleSystem() {
      set({ showSystem: !get().showSystem });
    },

    setFilterQuery(q) {
      set({ filterQuery: q });
    },

    setListColumnWidth(col, w) {
      const min = col === "name" ? 120 : 60;
      set({ listColumnWidths: { ...get().listColumnWidths, [col]: Math.max(min, Math.round(w)) } });
    },

    setColumnWidth(depth, w) {
      const widths = get().columnWidths.slice();
      while (widths.length <= depth) widths.push(220);
      widths[depth] = Math.max(120, Math.round(w));
      set({ columnWidths: widths });
    },

    pushColumn(depth, dir) {
      const chain = get().columnChain.slice(0, depth);
      chain[depth] = dir;
      set({ columnChain: chain });
    },

    prependColumn(dir) {
      const s = get();
      const d = normalize(dir);
      if (s.columnChain[0] === d) return;
      set({ columnChain: [d, ...s.columnChain] });
    },

    toggleTreeExpanded(path, force) {
      const s = get();
      const p = normalize(path);
      const want = force ?? !s.treeExpanded.has(p);
      if (want === s.treeExpanded.has(p)) return;

      const next = new Set(s.treeExpanded);
      if (want) {
        next.add(p);
        set({ treeExpanded: next });
        return;
      }

      next.delete(p);
      // Collapsing a subtree that contains the cursor must move the cursor onto
      // the collapsed node -- otherwise the cursor vanishes from the visible
      // order and every arrow press restarts at the top of the list.
      const cursorInside =
        s.cursor !== null && s.cursor !== p && s.cursor.toLowerCase().startsWith(p.toLowerCase() + "\\");
      set(
        cursorInside
          ? { treeExpanded: next, cursor: p, anchor: p, selection: new Set([p]) }
          : { treeExpanded: next },
      );
    },

    collapseAll() {
      set({ treeExpanded: new Set() });
    },

    // -- selection ----------------------------------------------------------
    selection: new Set(),
    cursor: null,
    anchor: null,

    select(path) {
      set({ selection: new Set([path]), cursor: path, anchor: path });
    },

    toggle(path) {
      const s = get();
      const selection = toggleIn(s.selection, path);
      set({
        selection,
        cursor: path,
        // The anchor follows only when the path was ADDED; removing an item
        // should not relocate the origin of a later shift-range.
        anchor: selection.has(path) ? path : s.anchor,
      });
    },

    selectRange(path) {
      const s = get();
      const { paths } = orderRegistry.get();
      const anchor = s.anchor ?? s.cursor ?? path;
      set({ selection: new Set(rangeBetween(paths, anchor, path)), cursor: path, anchor });
    },

    addRange(path) {
      const s = get();
      const { paths } = orderRegistry.get();
      const anchor = s.anchor ?? path;
      set({ selection: unionRange(s.selection, paths, anchor, path), cursor: path, anchor });
    },

    selectAll() {
      const s = get();
      const { paths } = orderRegistry.get();
      if (paths.length === 0) return;
      set({
        selection: new Set(paths),
        cursor: s.cursor ?? paths[0],
        anchor: s.anchor ?? paths[0],
      });
    },

    clearSelection() {
      set({ selection: new Set(), cursor: null, anchor: null });
    },

    setSelection(paths, cursor) {
      const next = new Set(paths);
      const c = cursor === undefined ? (paths.length > 0 ? paths[paths.length - 1] : null) : cursor;
      set({ selection: next, cursor: c, anchor: c });
    },

    moveCursor(delta, extend) {
      const s = get();
      const order = orderRegistry.get();
      const { paths } = order;
      if (paths.length === 0) return;

      const from = s.cursor === null ? -1 : (order.index.get(s.cursor) ?? -1);
      const to =
        delta === "home"
          ? 0
          : delta === "end"
            ? paths.length - 1
            : stepIndex(paths.length, from, delta);

      const target = paths[to];
      if (target === undefined) return;

      if (extend) {
        // The anchor stays put. That is what lets a range shrink again: extend
        // five rows down, then Shift+Up walks back. Re-anchoring on every move
        // is the classic bug here.
        const anchor = s.anchor ?? (from >= 0 ? paths[from] : target);
        set({ selection: new Set(rangeBetween(paths, anchor, target)), cursor: target, anchor });
      } else {
        set({ selection: new Set([target]), cursor: target, anchor: target });
      }

      // Revealing happens in a microtask so the virtualizer sees the committed
      // count, not the one from the render that is still in flight.
      queueMicrotask(() => orderRegistry.source()?.reveal(to));
    },

    moveCursorOnly(delta) {
      const s = get();
      const order = orderRegistry.get();
      const { paths } = order;
      if (paths.length === 0) return;
      const from = s.cursor === null ? -1 : (order.index.get(s.cursor) ?? -1);
      const to = stepIndex(paths.length, from, delta);
      const target = paths[to];
      if (target === undefined) return;
      set({ cursor: target });
      queueMicrotask(() => orderRegistry.source()?.reveal(to));
    },

    // -- clipboard ----------------------------------------------------------
    clipboard: null,

    copySelection() {
      const paths = [...get().selection];
      if (paths.length === 0) return;
      set({ clipboard: { mode: "copy", paths, stamp: Date.now() } });
    },

    cutSelection() {
      const paths = [...get().selection];
      if (paths.length === 0) return;
      set({ clipboard: { mode: "cut", paths, stamp: Date.now() } });
    },

    clearClipboard() {
      set({ clipboard: null });
    },

    // -- ui -----------------------------------------------------------------
    previewVisible: false,
    sidebarWidth: 200,
    previewWidth: 280,
    quickLookOpen: false,
    renamingPath: null,
    searchMode: "off",
    contextMenu: null,
    windowFocused: true,

    togglePreview() {
      set({ previewVisible: !get().previewVisible });
    },

    setSidebarWidth(w) {
      set({ sidebarWidth: Math.min(420, Math.max(150, Math.round(w))) });
    },

    setPreviewWidth(w) {
      set({ previewWidth: Math.min(600, Math.max(200, Math.round(w))) });
    },

    openQuickLook() {
      // Quick Look previews the cursor, so there is nothing to show without one.
      if (get().cursor === null) return;
      set({ quickLookOpen: true });
    },

    closeQuickLook() {
      set({ quickLookOpen: false });
    },

    toggleQuickLook() {
      const s = get();
      if (s.quickLookOpen) set({ quickLookOpen: false });
      else s.openQuickLook();
    },

    beginRename(path) {
      set({ renamingPath: path, quickLookOpen: false, contextMenu: null });
    },

    endRename() {
      set({ renamingPath: null });
    },

    setSearchMode(m) {
      set({ searchMode: m, filterQuery: m === "off" ? "" : get().filterQuery });
    },

    openContextMenu(s) {
      set({ contextMenu: s });
    },

    closeContextMenu() {
      set({ contextMenu: null });
    },

    setWindowFocused(v) {
      set({ windowFocused: v });
    },
  })),
);

/** Non-reactive access, for event handlers and imperative code. */
export const appState = () => useAppStore.getState();

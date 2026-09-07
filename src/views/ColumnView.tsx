import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useShallow } from "zustand/react/shallow";

import { PreviewBody } from "../components/preview/PreviewBody";
import { FileIcon, Glyph } from "../components/common/Icon";
import type { DirEntry } from "../ipc/types";
import { Attr, hasFlag } from "../ipc/types";
import { entryPath, parentOf } from "../lib/path";
import { visibleSorted } from "../lib/sort";
import { makeOrder } from "../order/registry";
import { usePublishOrderIf } from "../order/usePublishOrder";
import { appState, PREVIEW_COLUMN, useAppStore } from "../store/appStore";
import { ensureDir, useFsStore } from "../store/fsStore";
import { DirStates } from "./DirStates";
import { RenameInput, ROW_H } from "./ListView";
import { useRetainedDir, useVisibleEntries } from "./useVisibleEntries";

import "./column.css";

const DEFAULT_COLUMN_W = 220;
const PREVIEW_COLUMN_W = 300;

/**
 * Which child was last selected in each directory.
 *
 * Finder remembers this: go back to the left and forward again, and you land on
 * the same item. Module state rather than store state because it is a memory
 * aid, not something any component should re-render for.
 */
const lastChildOf = new Map<string, string>();

/* ------------------------------------------------------------------------- */

interface ColumnRowProps {
  entry: DirEntry;
  path: string;
  top: number;
  onActivate(path: string, isDir: boolean): void;
}

const ColumnRow = memo(function ColumnRow({ entry, path, top, onActivate }: ColumnRowProps) {
  const selected = useAppStore((s) => s.selection.has(path));
  const isCursor = useAppStore((s) => s.cursor === path);
  const cut = useAppStore((s) => s.clipboard?.mode === "cut" && s.clipboard.paths.includes(path));
  const renaming = useAppStore((s) => s.renamingPath === path);
  const dimmed = hasFlag(entry.flags, Attr.Hidden) || hasFlag(entry.flags, Attr.System);

  return (
    <div
      role="row"
      aria-selected={selected}
      className="fm-column-row fm-row"
      style={{ transform: `translateY(${top}px)` }}
      data-selected={selected ? "true" : undefined}
      data-cursor={isCursor ? "true" : undefined}
      data-cut={cut ? "true" : undefined}
      data-dimmed={dimmed ? "true" : undefined}
      onPointerDown={(e) => {
        const s = appState();
        if (e.button === 2) {
          if (!s.selection.has(path)) s.select(path);
          return;
        }
        if (e.shiftKey) s.selectRange(path);
        else if (e.ctrlKey || e.metaKey) s.toggle(path);
        else s.select(path);
      }}
      onDoubleClick={() => onActivate(path, entry.isDir)}
      onContextMenu={(e) => {
        e.preventDefault();
        appState().openContextMenu({ x: e.clientX, y: e.clientY, paths: [...appState().selection] });
      }}
    >
      <FileIcon category={entry.category} />
      {renaming ? (
        <RenameInput path={path} name={entry.name} />
      ) : (
        <span className="fm-name">{entry.name}</span>
      )}
      {/* The Finder affordance that says "there is more to the right". */}
      {entry.isDir && (
        <span className="fm-chevron-right">
          <Glyph name="chevron-tiny-right" size={11} strokeWidth={1.6} />
        </span>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------------- */

function ColumnResizer({ depth }: { depth: number }) {
  const setColumnWidth = useAppStore((s) => s.setColumnWidth);
  const startX = useRef(0);
  const startW = useRef(DEFAULT_COLUMN_W);
  const live = useRef(DEFAULT_COLUMN_W);
  const selfRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={selfRef}
      className="fm-column-resize"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const column = selfRef.current?.parentElement;
        startW.current = column?.getBoundingClientRect().width ?? DEFAULT_COLUMN_W;
        live.current = startW.current;
        startX.current = e.clientX;
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const column = selfRef.current?.parentElement;
        if (!column) return;
        const next = Math.max(120, startW.current + (e.clientX - startX.current));
        live.current = next;
        // Written straight to the element: committing per move would re-render
        // every visible row in the column, every frame.
        column.style.width = `${next}px`;
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        setColumnWidth(depth, live.current);
      }}
    />
  );
}

/* ------------------------------------------------------------------------- */

function Column({ dir, depth, width }: { dir: string; depth: number; width: number }) {
  const state = useRetainedDir(dir);
  const entries = useVisibleEntries(dir);
  const scrollRef = useRef<HTMLDivElement>(null);

  const cursor = useAppStore((s) => s.cursor);
  const viewOpts = useAppStore(
    useShallow((s) => ({
      showHidden: s.showHidden,
      showSystem: s.showSystem,
      filter: s.filterQuery,
      sortKey: s.sortKey,
      sortDir: s.sortDir,
    })),
  );

  // Exactly one column holds the cursor, so exactly one source is ever active.
  const holdsCursor = cursor !== null && parentOf(cursor) === dir;

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
    getItemKey: (i) => entryPath(dir, entries[i]),
  });

  const order = useMemo(() => makeOrder(dir, entries, entryPath), [dir, entries]);
  const buildOrder = useCallback(() => order, [order]);

  /**
   * Double-click or Enter on a folder OPENS it: the strip re-roots so that
   * folder becomes the leftmost column.
   *
   * A single click, or an arrow key, deliberately does not -- that just spawns
   * the next column to the right, which is how you browse. The two gestures
   * mean different things, and conflating them is what leaves the strip
   * scrolled far off to the right with no way back but manual scrolling.
   */
  const onActivate = useCallback((path: string, isDir: boolean) => {
    if (isDir) appState().navigate(path);
    // Opening files is handled by the shared Enter action in App.
  }, []);

  /** Descend: move the cursor into the first (or remembered) child. */
  const descend = useCallback((): boolean => {
    const s = appState();
    const c = s.cursor;
    if (!c) return false;
    const entry = order.entryOf(c);
    if (!entry?.isDir) return false;

    const selectChild = () => {
      const child = useFsStore.getState().dirs.get(c);
      if (!child || child.status !== "ready") return;
      const visible = visibleSorted(child.entries, viewOpts);
      if (visible.length === 0) return;

      const remembered = lastChildOf.get(c);
      const target =
        remembered && visible.some((e) => entryPath(c, e) === remembered)
          ? remembered
          : entryPath(c, visible[0]);
      appState().select(target);
    };

    const child = useFsStore.getState().dirs.get(c);
    if (child?.status === "ready") selectChild();
    // Not loaded yet: fetch, then land on the first child.
    else void ensureDir(c).then(selectChild);
    return true;
  }, [order, viewOpts]);

  /** Ascend: put the cursor on this column's own directory, one column left. */
  const ascend = useCallback((): boolean => {
    const s = appState();
    if (depth > 0) {
      s.select(dir);
      return true;
    }
    // Already leftmost: bring the parent into view first, as Finder does.
    const parent = parentOf(dir);
    if (!parent) return true;
    s.prependColumn(parent);
    void ensureDir(parent).then(() => appState().select(dir));
    return true;
  }, [depth, dir]);

  usePublishOrderIf(holdsCursor, "column", buildOrder, {
    reveal: (i) => virtualizer.scrollToIndex(i, { align: "auto" }),
    onArrowRight: descend,
    onArrowLeft: ascend,
    // Enter matches double-click: it opens the folder and re-roots the strip.
    activateDir: (p) => {
      appState().navigate(p);
      return true;
    },
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div className="fm-column" style={{ width }} data-active={holdsCursor ? "true" : undefined}>
      <DirStates
        dir={state}
        visibleCount={entries.length}
        onRetry={() => void ensureDir(dir, { force: true })}
      >
        <div className="fm-column-scroll fm-scroll" ref={scrollRef} tabIndex={-1}>
          <div className="fm-column-rows" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((vi) => (
              <ColumnRow
                key={vi.key}
                entry={entries[vi.index]}
                path={String(vi.key)}
                top={vi.start}
                onActivate={onActivate}
              />
            ))}
          </div>
        </div>
      </DirStates>
      <ColumnResizer depth={depth} />
    </div>
  );
}

/* ------------------------------------------------------------------------- */

/**
 * Look up an entry by its absolute path, straight from the directory cache.
 *
 * Deliberately NOT via `orderRegistry`: a column only registers as the order
 * source after it re-renders with the cursor inside it, so the registry lags one
 * render behind a selection. Reading the cache has no such ordering dependency,
 * which is what makes the very first click into a column behave like every
 * later one.
 */
function entryAt(path: string): DirEntry | undefined {
  const parent = parentOf(path);
  if (!parent) return undefined;
  const dir = useFsStore.getState().dirs.get(parent);
  if (!dir) return undefined;
  const name = path.slice(parent.length).replace(/^\\/, "");
  return dir.entries.find((e) => e.name === name);
}

/**
 * Couple the cursor to the column chain.
 *
 * Deliberately ONE subscription, mounted once, rather than logic spread across
 * the column components: the chain is the thing most likely to develop a
 * feedback loop, and a single writer is what keeps it traceable.
 */
function useCursorDrivesChain() {
  useEffect(() => {
    return useAppStore.subscribe(
      (s) => s.cursor,
      (cursor) => {
        const s = appState();
        if (s.viewMode !== "column" || !cursor) return;

        const parent = parentOf(cursor);
        if (!parent) return;
        const depth = s.columnChain.indexOf(parent);
        if (depth < 0) return;

        lastChildOf.set(parent, cursor);

        const entry = entryAt(cursor);
        if (!entry) return;
        // A directory spawns the next column; a file replaces it with preview.
        s.pushColumn(depth + 1, entry.isDir ? cursor : PREVIEW_COLUMN);
      },
    );
  }, []);
}

/**
 * Test hook for the module-level `lastChildOf` memory.
 *
 * Module state survives between test cases in a file, so one case's remembered
 * child would silently change what a later case sees. Anything module-scoped
 * needs a reset like this.
 */
export const columnViewDebug = {
  resetLastChild: () => lastChildOf.clear(),
};

export function ColumnView() {
  const chain = useAppStore(useShallow((s) => s.columnChain));
  const widths = useAppStore(useShallow((s) => s.columnWidths));
  const cursor = useAppStore((s) => s.cursor);

  const stripRef = useRef<HTMLDivElement>(null);

  useCursorDrivesChain();

  /**
   * Bring the newest column into view whenever the chain changes.
   *
   * Three things were wrong before. It latched a `userScrolled` flag that, once
   * set, disabled auto-scroll for the rest of the session; it keyed off
   * `chain.length`, so replacing the trailing column with a preview scrolled
   * nowhere; and it read `scrollWidth` before the new column had been laid out.
   *
   * Scrolling the last element into view sidesteps all three: the browser knows
   * where the element actually is, and because this only runs when the chain
   * itself changes, scrolling by hand in between is never fought.
   */
  const chainKey = chain.join(" ");
  useEffect(() => {
    const el = stripRef.current;
    const last = el?.lastElementChild;
    if (!(last instanceof HTMLElement)) return;
    last.scrollIntoView({ inline: "end", block: "nearest", behavior: "smooth" });
  }, [chainKey]);

  const previewEntry = useMemo(() => (cursor ? entryAt(cursor) : undefined), [cursor]);

  return (
    <div
      className="fm-columns fm-scroll"
      ref={stripRef}
      role="grid"
      aria-label="Columns"
    >
      {chain.map((path, i) =>
        path === PREVIEW_COLUMN ? (
          <div
            key="preview"
            className="fm-column-preview fm-scroll"
            style={{ width: widths[i] ?? PREVIEW_COLUMN_W }}
          >
            <PreviewBody path={cursor} entry={previewEntry} variant="column" />
          </div>
        ) : (
          <Column key={path} dir={path} depth={i} width={widths[i] ?? DEFAULT_COLUMN_W} />
        ),
      )}
    </div>
  );
}

import { memo, useCallback, useMemo, useRef, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useShallow } from "zustand/react/shallow";

import { FileIcon, Glyph } from "../components/common/Icon";
import { Attr, hasFlag } from "../ipc/types";
import { formatBytes, formatDate } from "../lib/format";
import { parentOf } from "../lib/path";
import { flattenTree, type TreeRow } from "../lib/treeFlatten";
import { makeOrderFromRows } from "../order/registry";
import { usePublishOrder } from "../order/usePublishOrder";
import { appState, useAppStore } from "../store/appStore";
import { ensureDir, useFsStore } from "../store/fsStore";
import { DirStates } from "./DirStates";
import { RenameInput, ROW_H } from "./ListView";
import { useDir, useRetainedDirs } from "./useVisibleEntries";

import "./tree.css";

const INDENT_PX = 16;

/* ------------------------------------------------------------------------- */

const Row = memo(function Row({
  row,
  top,
  onToggle,
  onActivate,
}: {
  row: TreeRow;
  top: number;
  onToggle(path: string, e: React.MouseEvent): void;
  onActivate(path: string, isDir: boolean): void;
}) {
  const selected = useAppStore((s) => s.selection.has(row.path));
  const isCursor = useAppStore((s) => s.cursor === row.path);
  const cut = useAppStore(
    (s) => s.clipboard?.mode === "cut" && s.clipboard.paths.includes(row.path),
  );
  const renaming = useAppStore((s) => s.renamingPath === row.path);
  const dimmed = hasFlag(row.entry.flags, Attr.Hidden) || hasFlag(row.entry.flags, Attr.System);

  const indent = <span className="fm-tree-indent" style={{ width: row.depth * INDENT_PX }} />;

  if (row.placeholder) {
    return (
      <div className="fm-tree-row" style={{ transform: `translateY(${top}px)` }} aria-hidden="true">
        <div className="fm-tree-name">
          {indent}
          <span className="fm-twisty" data-hidden="true" />
          <span className="fm-tree-placeholder">{row.name}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      role="row"
      aria-selected={selected}
      aria-expanded={row.isDir ? row.expanded : undefined}
      aria-level={row.depth + 1}
      className="fm-tree-row fm-row"
      style={{ transform: `translateY(${top}px)` }}
      data-selected={selected ? "true" : undefined}
      data-cursor={isCursor ? "true" : undefined}
      data-cut={cut ? "true" : undefined}
      data-dimmed={dimmed ? "true" : undefined}
      onPointerDown={(e) => {
        const s = appState();
        if (e.button === 2) {
          if (!s.selection.has(row.path)) s.select(row.path);
          return;
        }
        if (e.shiftKey) s.selectRange(row.path);
        else if (e.ctrlKey || e.metaKey) s.toggle(row.path);
        else s.select(row.path);
      }}
      onDoubleClick={() => onActivate(row.path, row.isDir)}
      onContextMenu={(e) => {
        e.preventDefault();
        appState().openContextMenu({ x: e.clientX, y: e.clientY, paths: [...appState().selection] });
      }}
    >
      <div className="fm-tree-name">
        {indent}
        <span
          className="fm-twisty"
          data-expanded={row.expanded ? "true" : undefined}
          data-hidden={row.isDir && row.hasChildren === false ? "true" : undefined}
          // Clicking the triangle toggles WITHOUT changing the selection, which
          // is what lets you open a folder to look inside it without losing
          // whatever you had selected.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => row.isDir && onToggle(row.path, e)}
        >
          {row.isDir && <Glyph name="chevron-tiny-right" size={10} strokeWidth={1.8} />}
        </span>
        <FileIcon category={row.entry.category} />
        {renaming ? (
          <RenameInput path={row.path} name={row.name} />
        ) : (
          <span className="fm-name">{row.name}</span>
        )}
      </div>
      <div className="fm-cell fm-cell--secondary">{formatDate(row.entry.modifiedMs)}</div>
      <div className="fm-cell fm-cell--secondary fm-cell--num">
        {row.isDir ? "--" : formatBytes(row.entry.size)}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------------- */

export function TreeView() {
  const { roots, expanded, showHidden, showSystem, filter, sortKey, sortDir } = useAppStore(
    useShallow((s) => ({
      roots: s.treeRoots,
      expanded: s.treeExpanded,
      showHidden: s.showHidden,
      showSystem: s.showSystem,
      filter: s.filterQuery,
      sortKey: s.sortKey,
      sortDir: s.sortDir,
    })),
  );
  const widths = useAppStore((s) => s.listColumnWidths);
  const cwd = useAppStore((s) => s.cwd);

  // Subscribing to the whole map is deliberate: the flattening genuinely depends
  // on every expanded directory, and the Map reference changes only on real I/O,
  // never per keystroke. The memo below then does the work once.
  const dirs = useFsStore((s) => s.dirs);
  const rootState = useDir(roots[0] ?? null);

  // Every root and every expanded node must stay loaded and watched.
  const retained = useMemo(() => [...roots, ...expanded], [roots, expanded]);
  useRetainedDirs(retained);

  const rows = useMemo(
    () => flattenTree(roots, expanded, dirs, { showHidden, showSystem, filter, sortKey, sortDir }),
    [roots, expanded, dirs, showHidden, showSystem, filter, sortKey, sortDir],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 16,
    getItemKey: (i) => rows[i].path,
  });

  const order = useMemo(() => makeOrderFromRows(rows), [rows]);
  const buildOrder = useCallback(() => order, [order]);
  const rowOf = useCallback(
    (path: string) => rows.find((r) => r.path === path && !r.placeholder),
    [rows],
  );

  const toggle = useCallback((path: string, force?: boolean) => {
    const s = appState();
    const willExpand = force ?? !s.treeExpanded.has(path);
    if (willExpand) void ensureDir(path);
    s.toggleTreeExpanded(path, force);
  }, []);

  const onToggleClick = useCallback(
    (path: string, e: React.MouseEvent) => {
      e.stopPropagation();
      toggle(path);
    },
    [toggle],
  );

  const onActivate = useCallback(
    (path: string, isDir: boolean) => {
      // Tree mode changes the working directory only on Enter or double-click,
      // never on mere selection.
      if (isDir) toggle(path);
      else appState().navigate(parentOf(path) ?? path);
    },
    [toggle],
  );

  usePublishOrder("tree", buildOrder, {
    reveal: (i) => virtualizer.scrollToIndex(i, { align: "auto" }),
    onArrowRight: () => {
      const cursor = appState().cursor;
      if (!cursor) return false;
      const row = rowOf(cursor);
      if (!row?.isDir) return false;

      if (!row.expanded) {
        toggle(cursor, true);
        return true;
      }
      // Already open: step into the first child.
      const i = order.index.get(cursor);
      if (i === undefined) return true;
      const next = order.paths[i + 1];
      if (next && (rowOf(next)?.depth ?? -1) > row.depth) appState().select(next);
      return true;
    },
    onArrowLeft: () => {
      const s = appState();
      const cursor = s.cursor;
      if (!cursor) return false;
      const row = rowOf(cursor);
      if (!row) return false;

      if (row.isDir && row.expanded) {
        toggle(cursor, false);
        return true;
      }
      // Otherwise climb to the parent, if it is a visible row.
      const parent = parentOf(cursor);
      if (parent && order.index.has(parent)) s.select(parent);
      return true;
    },
    activateDir: (p) => {
      toggle(p);
      return true;
    },
  });

  const style: CSSProperties = {
    ["--fm-col-name" as string]: `${widths.name}px`,
    ["--fm-col-modified" as string]: `${widths.modified}px`,
    ["--fm-col-size" as string]: `${widths.size}px`,
  };

  const items = virtualizer.getVirtualItems();

  return (
    <div className="fm-tree" style={style} role="treegrid" aria-label="Files">
      <DirStates
        dir={rootState}
        visibleCount={rows.length}
        onRetry={() => void ensureDir(cwd, { force: true })}
      >
        <div className="fm-tree-scroll fm-scroll" ref={scrollRef} tabIndex={0}>
          <div className="fm-tree-rows" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((vi) => (
              <Row
                key={vi.key}
                row={rows[vi.index]}
                top={vi.start}
                onToggle={onToggleClick}
                onActivate={onActivate}
              />
            ))}
          </div>
        </div>
      </DirStates>
    </div>
  );
}

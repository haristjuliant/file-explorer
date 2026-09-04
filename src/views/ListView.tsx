import { memo, useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { FileIcon, Glyph } from "../components/common/Icon";
import type { DirEntry } from "../ipc/types";
import { Attr, hasFlag } from "../ipc/types";
import { formatBytes, formatDate } from "../lib/format";
import { kindLabel } from "../lib/kind";
import { entryPath } from "../lib/path";
import type { SortKey } from "../lib/sort";
import { makeOrder } from "../order/registry";
import { marqueeRange } from "../order/selectionMath";
import { usePublishOrder } from "../order/usePublishOrder";
import { appState, useAppStore, type ListColumn } from "../store/appStore";
import { ensureDir } from "../store/fsStore";
import { commitRename } from "../store/opsStore";
import { DirStates } from "./DirStates";
import { useRetainedDir, useVisibleEntries } from "./useVisibleEntries";

import "./list.css";

export const ROW_H = 24;

const COLUMNS: Array<{ key: ListColumn; sort: SortKey; label: string; numeric?: boolean }> = [
  { key: "name", sort: "name", label: "Name" },
  { key: "modified", sort: "modified", label: "Date Modified" },
  { key: "size", sort: "size", label: "Size", numeric: true },
  { key: "kind", sort: "kind", label: "Kind" },
];

/* ------------------------------------------------------------------------- */

function ColumnResizer({ column }: { column: ListColumn }) {
  const startX = useRef(0);
  const startW = useRef(0);
  const live = useRef(0);
  const cssVar = `--fm-col-${column}`;

  return (
    <div
      className="fm-th-resize"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const current = getComputedStyle(document.documentElement).getPropertyValue(cssVar);
        startW.current = parseFloat(current) || 120;
        live.current = startW.current;
        startX.current = e.clientX;
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const min = column === "name" ? 120 : 60;
        const next = Math.max(min, startW.current + (e.clientX - startX.current));
        live.current = next;
        // Written straight to the custom property: committing to the store on
        // every move would re-render every visible row, every frame.
        document.documentElement.style.setProperty(cssVar, `${next}px`);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        appState().setListColumnWidth(column, live.current);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        const w = column === "name" ? 320 : column === "modified" ? 160 : column === "size" ? 96 : 140;
        document.documentElement.style.setProperty(cssVar, `${w}px`);
        appState().setListColumnWidth(column, w);
      }}
    />
  );
}

function ListHeader() {
  const sortKey = useAppStore((s) => s.sortKey);
  const sortDir = useAppStore((s) => s.sortDir);
  const setSort = useAppStore((s) => s.setSort);

  return (
    <div className="fm-list-header" role="row">
      {COLUMNS.map((c) => {
        const active = sortKey === c.sort;
        return (
          <div
            key={c.key}
            role="columnheader"
            className={`fm-th${c.numeric ? " fm-th--num" : ""}`}
            aria-sort={active ? (sortDir === 1 ? "ascending" : "descending") : undefined}
            onClick={() => setSort(c.sort)}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{c.label}</span>
            {active && <Glyph name={sortDir === 1 ? "sort-up" : "sort-down"} size={9} strokeWidth={1.8} />}
            <ColumnResizer column={c.key} />
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------------- */

interface RowProps {
  entry: DirEntry;
  path: string;
  index: number;
  top: number;
  onOpen(path: string, isDir: boolean): void;
}

/**
 * Each row subscribes to its OWN booleans, never to the selection Set.
 *
 * Ten thousand rows watching an `Object.is`-stable boolean is far cheaper than
 * ten thousand rows woken because the Set reference changed.
 */
const Row = memo(function Row({ entry, path, index, top, onOpen }: RowProps) {
  const selected = useAppStore((s) => s.selection.has(path));
  const isCursor = useAppStore((s) => s.cursor === path);
  const cut = useAppStore((s) => s.clipboard?.mode === "cut" && s.clipboard.paths.includes(path));
  const renaming = useAppStore((s) => s.renamingPath === path);

  const dimmed = hasFlag(entry.flags, Attr.Hidden) || hasFlag(entry.flags, Attr.System);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Right-click on an unselected row selects it first, so the context menu
      // always acts on something visible.
      const s = appState();
      if (e.button === 2) {
        if (!s.selection.has(path)) s.select(path);
        return;
      }
      if (e.shiftKey) s.selectRange(path);
      else if (e.ctrlKey || e.metaKey) s.toggle(path);
      else s.select(path);
    },
    [path],
  );

  return (
    <div
      role="row"
      aria-selected={selected}
      className="fm-list-row fm-row"
      style={{ transform: `translateY(${top}px)` }}
      // Absolute index parity, not DOM order: virtualization would otherwise
      // scramble the stripes as you scroll.
      data-odd={index % 2 === 1 ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-cursor={isCursor ? "true" : undefined}
      data-cut={cut ? "true" : undefined}
      data-dimmed={dimmed ? "true" : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onOpen(path, entry.isDir)}
      onContextMenu={(e) => {
        e.preventDefault();
        appState().openContextMenu({ x: e.clientX, y: e.clientY, paths: [...appState().selection] });
      }}
    >
      <div className="fm-list-name">
        <FileIcon category={entry.category} />
        {renaming ? (
          <RenameInput path={path} name={entry.name} />
        ) : (
          <span className="fm-name">{entry.name}</span>
        )}
      </div>
      <div className="fm-cell fm-cell--secondary">{formatDate(entry.modifiedMs)}</div>
      <div className="fm-cell fm-cell--secondary fm-cell--num">
        {entry.isDir ? "--" : formatBytes(entry.size)}
      </div>
      <div className="fm-cell fm-cell--secondary">{kindLabel(entry)}</div>
    </div>
  );
});

/** Inline rename field. */
export function RenameInput({ path, name }: { path: string; name: string }) {
  const [value, setValue] = useState(name);
  const endRename = useAppStore((s) => s.endRename);
  const committed = useRef(false);

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    void commitRename(path, value.trim());
  };

  return (
    <input
      className="fm-rename-input"
      data-keys-off=""
      autoFocus
      spellCheck={false}
      value={value}
      aria-label={`Rename ${name}`}
      onChange={(e) => setValue(e.target.value)}
      // Blur commits, matching Explorer and Finder: clicking away accepts the
      // name rather than quietly discarding what was typed.
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          committed.current = true;
          endRename();
        }
        e.stopPropagation();
      }}
      onFocus={(e) => {
        // Select the stem, leaving the extension alone -- what Finder and
        // Explorer both do, and what makes renaming one keystroke of work.
        const dot = value.lastIndexOf(".");
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : value.length);
      }}
    />
  );
}

/* ------------------------------------------------------------------------- */

export function ListView() {
  const cwd = useAppStore((s) => s.cwd);
  const navigate = useAppStore((s) => s.navigate);
  const widths = useAppStore((s) => s.listColumnWidths);

  const dir = useRetainedDir(cwd || null);
  const entries = useVisibleEntries(cwd || null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<{ top: number; height: number } | null>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    getItemKey: (i) => entryPath(cwd, entries[i]),
  });

  const order = useMemo(() => makeOrder(cwd, entries, entryPath), [cwd, entries]);
  const buildOrder = useCallback(() => order, [order]);

  const onOpen = useCallback(
    (path: string, isDir: boolean) => {
      if (isDir) navigate(path);
      // Opening files in their default app is wired with the rest of the shell
      // actions in the file-operations phase.
    },
    [navigate],
  );

  usePublishOrder("list", buildOrder, {
    reveal: (i) => virtualizer.scrollToIndex(i, { align: "auto" }),
    activateDir: (p) => {
      navigate(p);
      return true;
    },
  });

  const onBackgroundPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains("fm-list-rows")) {
      return;
    }
    const el = scrollRef.current;
    if (!el) return;

    appState().clearSelection();
    const rect = el.getBoundingClientRect();
    const startY = e.clientY - rect.top + el.scrollTop;
    el.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const y = ev.clientY - rect.top + el.scrollTop;
      setMarquee({ top: Math.min(startY, y), height: Math.abs(y - startY) });
      const range = marqueeRange(startY, y, ROW_H, entries.length);
      if (!range) return;
      const paths = order.paths.slice(range.from, range.to + 1);
      appState().setSelection(paths, order.paths[range.to]);
    };
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      setMarquee(null);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  const style: CSSProperties = {
    ["--fm-col-name" as string]: `${widths.name}px`,
    ["--fm-col-modified" as string]: `${widths.modified}px`,
    ["--fm-col-size" as string]: `${widths.size}px`,
    ["--fm-col-kind" as string]: `${widths.kind}px`,
  };

  const items = virtualizer.getVirtualItems();

  return (
    <div className="fm-list" style={style} role="grid" aria-label="Files">
      <ListHeader />

      {dir?.status === "ready" && dir.truncated && (
        <div className="fm-truncation-banner">
          <Glyph name="warning" size={11} />
          Showing {entries.length.toLocaleString()} of {dir.total.toLocaleString()} items -- sort or
          filter to narrow this down.
        </div>
      )}

      <DirStates
        dir={dir}
        visibleCount={entries.length}
        onRetry={() => void ensureDir(cwd, { force: true })}
      >
        <div className="fm-list-scroll fm-scroll" ref={scrollRef} tabIndex={0}>
          <div
            className="fm-list-rows"
            style={{ height: virtualizer.getTotalSize() }}
            onPointerDown={onBackgroundPointerDown}
          >
            {items.map((vi) => {
              const entry = entries[vi.index];
              return (
                <Row
                  key={vi.key}
                  entry={entry}
                  path={String(vi.key)}
                  index={vi.index}
                  top={vi.start}
                  onOpen={onOpen}
                />
              );
            })}
            {marquee && (
              <div className="fm-marquee" style={{ top: marquee.top, height: marquee.height, left: 0, right: 0 }} />
            )}
          </div>
        </div>
      </DirStates>
    </div>
  );
}

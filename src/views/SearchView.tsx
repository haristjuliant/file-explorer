import { memo, useCallback, useMemo, useRef, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useShallow } from "zustand/react/shallow";

import { FileIcon, Glyph } from "../components/common/Icon";
import { formatBytes, formatDate } from "../lib/format";
import { isInside, parentOf } from "../lib/path";
import { makeOrderFromRows, type OrderRow } from "../order/registry";
import { usePublishOrder } from "../order/usePublishOrder";
import { appState, useAppStore } from "../store/appStore";
import { cancelSearch, useSearchStore, type SearchHitRow } from "../store/searchStore";
import { ROW_H } from "./ListView";

import "./search.css";

/** The path shown in the results, relative to what was searched. */
function relativeDir(dir: string, root: string): string {
  if (dir === root) return ".";
  if (isInside(root, dir)) return dir.slice(root.length).replace(/^\\/, "");
  return dir;
}

const Row = memo(function Row({
  hit,
  root,
  top,
  onOpen,
}: {
  hit: SearchHitRow;
  root: string;
  top: number;
  onOpen(path: string, isDir: boolean): void;
}) {
  const selected = useAppStore((s) => s.selection.has(hit.path));
  const isCursor = useAppStore((s) => s.cursor === hit.path);

  return (
    <div
      role="row"
      aria-selected={selected}
      className="fm-search-row fm-row"
      style={{ transform: `translateY(${top}px)` }}
      data-selected={selected ? "true" : undefined}
      data-cursor={isCursor ? "true" : undefined}
      onPointerDown={(e) => {
        const s = appState();
        if (e.shiftKey) s.selectRange(hit.path);
        else if (e.ctrlKey || e.metaKey) s.toggle(hit.path);
        else s.select(hit.path);
      }}
      onDoubleClick={() => onOpen(hit.path, hit.entry.isDir)}
      onContextMenu={(e) => {
        e.preventDefault();
        appState().openContextMenu({ x: e.clientX, y: e.clientY, paths: [...appState().selection] });
      }}
    >
      <div className="fm-search-name">
        <FileIcon category={hit.entry.category} />
        <span className="fm-name">{hit.entry.name}</span>
      </div>
      <div className="fm-cell fm-cell--secondary" title={hit.dir}>
        {relativeDir(hit.dir, root)}
      </div>
      <div className="fm-cell fm-cell--secondary fm-cell--num">
        {hit.entry.isDir ? "--" : formatBytes(hit.entry.size)}
      </div>
      <div className="fm-cell fm-cell--secondary">{formatDate(hit.entry.modifiedMs)}</div>
    </div>
  );
});

/**
 * Streaming search results.
 *
 * Registered as an ordinary `OrderSource`, so arrow navigation and Quick Look
 * work inside the results with no code of their own. That is the payoff of
 * keeping the order abstraction view-agnostic.
 */
export function SearchView() {
  const { hits, status, query, root, hitTotal, capReached } = useSearchStore(
    useShallow((s) => ({
      hits: s.hits,
      status: s.status,
      query: s.query,
      root: s.root,
      hitTotal: s.hitTotal,
      capReached: s.capReached,
    })),
  );
  const widths = useAppStore((s) => s.listColumnWidths);
  const navigate = useAppStore((s) => s.navigate);
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: hits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    getItemKey: (i) => hits[i].path,
  });

  const rows = useMemo<OrderRow[]>(
    () => hits.map((h) => ({ path: h.path, parent: h.dir, entry: h.entry })),
    [hits],
  );
  const order = useMemo(() => makeOrderFromRows(rows), [rows]);
  const buildOrder = useCallback(() => order, [order]);

  const onOpen = useCallback(
    (path: string, isDir: boolean) => {
      // Opening a result leaves search behind and shows it in place, which is
      // almost always what "I found it" means.
      const target = isDir ? path : parentOf(path);
      if (target) {
        navigate(target);
        appState().setSearchMode("off");
        if (!isDir) appState().setSelection([path], path);
      }
    },
    [navigate],
  );

  usePublishOrder("list", buildOrder, {
    reveal: (i) => virtualizer.scrollToIndex(i, { align: "auto" }),
    activateDir: (p) => {
      onOpen(p, true);
      return true;
    },
  });

  const style: CSSProperties = {
    ["--fm-col-name" as string]: `${widths.name}px`,
    ["--fm-col-modified" as string]: `${widths.modified}px`,
    ["--fm-col-size" as string]: `${widths.size}px`,
  };

  return (
    <div className="fm-search-view" style={style} role="grid" aria-label="Search results">
      <div className="fm-search-status">
        <span>
          {status === "running" ? "Searching" : "Found"} {hitTotal.toLocaleString()} item
          {hitTotal === 1 ? "" : "s"} for “{query}”
        </span>
        {status === "running" && (
          <button type="button" className="fm-btn" onClick={cancelSearch}>
            Stop
          </button>
        )}
        {status === "cancelled" && <span className="fm-search-note">Stopped</span>}
      </div>

      {capReached && (
        <div className="fm-truncation-banner">
          <Glyph name="warning" size={11} />
          Showing the first {hits.length.toLocaleString()} results — narrow the search to see more.
        </div>
      )}

      <div className="fm-search-header" role="row">
        <div className="fm-th">Name</div>
        <div className="fm-th">Path</div>
        <div className="fm-th fm-th--num">Size</div>
        <div className="fm-th">Date Modified</div>
      </div>

      {hits.length === 0 ? (
        <div className="fm-center">
          <div>
            <h3>{status === "running" ? "Searching…" : "No matches"}</h3>
            {status !== "running" && <p>Nothing under this folder matches “{query}”.</p>}
          </div>
        </div>
      ) : (
        <div className="fm-search-scroll fm-scroll" ref={scrollRef} tabIndex={0}>
          <div className="fm-search-rows" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((vi) => (
              <Row
                key={vi.key}
                hit={hits[vi.index]}
                root={root}
                top={vi.start}
                onOpen={onOpen}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

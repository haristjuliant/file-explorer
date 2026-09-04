import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { Glyph } from "../common/Icon";
import { normalize, segments } from "../../lib/path";
import type { ViewMode } from "../../order/registry";
import { useAppStore } from "../../store/appStore";
import { WindowControls } from "./WindowControls";

const VIEW_ORDER: ViewMode[] = ["list", "column", "tree"];

function ViewSwitcher() {
  const viewMode = useAppStore((s) => s.viewMode);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const index = VIEW_ORDER.indexOf(viewMode);

  return (
    <div
      className="fm-segmented"
      role="group"
      aria-label="View mode"
      // The lozenge slides via a single transform on ::after, so switching does
      // not re-layout three buttons.
      style={{ ["--fm-seg-index" as string]: String(index) }}
    >
      <button
        type="button"
        aria-pressed={viewMode === "list"}
        title="List view (Ctrl+1)"
        onClick={() => setViewMode("list")}
      >
        <Glyph name="view-list" />
      </button>
      <button
        type="button"
        aria-pressed={viewMode === "column"}
        title="Column view (Ctrl+2)"
        onClick={() => setViewMode("column")}
      >
        <Glyph name="view-column" />
      </button>
      <button
        type="button"
        aria-pressed={viewMode === "tree"}
        title="Tree view (Ctrl+3)"
        onClick={() => setViewMode("tree")}
      >
        <Glyph name="view-tree" />
      </button>
    </div>
  );
}

export interface PathBarHandle {
  focusInput(): void;
}

/**
 * Breadcrumb, collapsing from the left when it runs out of room.
 *
 * Ctrl+L swaps the whole thing for a text input holding the raw path.
 */
function PathBar({ editRef }: { editRef: React.MutableRefObject<PathBarHandle | null> }) {
  const cwd = useAppStore((s) => s.cwd);
  const navigate = useAppStore((s) => s.navigate);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [visibleFrom, setVisibleFrom] = useState(0);

  const crumbs = segments(cwd);

  editRef.current = {
    focusInput() {
      setDraft(cwd);
      setEditing(true);
    },
  };

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // Hide leading crumbs until the bar fits. Measured rather than estimated,
  // because segment widths vary wildly with folder names.
  useLayoutEffect(() => {
    setVisibleFrom(0);
  }, [cwd]);

  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el || editing) return;
    if (el.scrollWidth > el.clientWidth && visibleFrom < crumbs.length - 1) {
      setVisibleFrom((n) => n + 1);
    }
  }, [cwd, editing, visibleFrom, crumbs.length]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="fm-pathbar-input"
        // Keeps the global keyboard handler out of the way while typing.
        data-keys-off=""
        value={draft}
        spellCheck={false}
        aria-label="Path"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const target = normalize(draft);
            setEditing(false);
            if (target !== "") navigate(target);
          } else if (e.key === "Escape") {
            setEditing(false);
          }
          e.stopPropagation();
        }}
      />
    );
  }

  const shown = crumbs.slice(visibleFrom);

  return (
    <div className="fm-pathbar" ref={barRef} onDoubleClick={() => editRef.current?.focusInput()}>
      {visibleFrom > 0 && (
        <>
          <button
            type="button"
            className="fm-crumb"
            title={crumbs[visibleFrom - 1]?.path}
            onClick={() => navigate(crumbs[visibleFrom - 1].path)}
          >
            …
          </button>
          <span className="fm-crumb-sep" aria-hidden="true">
            ›
          </span>
        </>
      )}
      {shown.map((seg, i) => {
        const last = i === shown.length - 1;
        return (
          <span key={seg.path} style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
            <button
              type="button"
              className="fm-crumb"
              aria-current={last ? "page" : undefined}
              title={seg.path}
              onClick={() => !last && navigate(seg.path)}
            >
              {seg.label}
            </button>
            {!last && (
              <span className="fm-crumb-sep" aria-hidden="true">
                ›
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

export interface SearchHandle {
  focusInput(): void;
}

function SearchField({ handleRef }: { handleRef: React.MutableRefObject<SearchHandle | null> }) {
  const filterQuery = useAppStore((s) => s.filterQuery);
  const setFilterQuery = useAppStore((s) => s.setFilterQuery);
  const searchMode = useAppStore((s) => s.searchMode);
  const inputRef = useRef<HTMLInputElement>(null);

  handleRef.current = {
    focusInput() {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  };

  return (
    <div className="fm-search">
      <Glyph name="search" size={12} strokeWidth={1.6} />
      <input
        ref={inputRef}
        // Filtering silently changes what the arrow keys and Quick Look
        // traverse, so it is always explicit -- never triggered by bare typing,
        // which does type-to-select instead.
        data-keys-off=""
        type="text"
        value={filterQuery}
        placeholder={searchMode === "recursive" ? "Search subfolders" : "Filter"}
        spellCheck={false}
        aria-label={
          searchMode === "recursive" ? "Search subfolders" : "Filter this folder"
        }
        onChange={(e) => setFilterQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Leave search entirely rather than just blanking the box, which
            // would strand the user on an empty results list.
            useAppStore.getState().setSearchMode("off");
            setFilterQuery("");
            inputRef.current?.blur();
          }
          e.stopPropagation();
        }}
      />
      {filterQuery !== "" && (
        <button type="button" title="Clear" onClick={() => setFilterQuery("")}>
          <Glyph name="close" size={11} strokeWidth={1.6} />
        </button>
      )}
    </div>
  );
}

export function Toolbar({
  pathBarRef,
  searchRef,
}: {
  pathBarRef: React.MutableRefObject<PathBarHandle | null>;
  searchRef: React.MutableRefObject<SearchHandle | null>;
}) {
  const { canBack, canForward, previewVisible } = useAppStore(
    useShallow((s) => ({
      canBack: s.canBack,
      canForward: s.canForward,
      previewVisible: s.previewVisible,
    })),
  );
  const back = useAppStore((s) => s.back);
  const forward = useAppStore((s) => s.forward);
  const togglePreview = useAppStore((s) => s.togglePreview);

  return (
    // The toolbar background is the window drag region, giving the unified
    // titlebar feel once the frame is removed in the polish phase.
    <header className="fm-toolbar" data-tauri-drag-region="">
      <div className="fm-tb-group">
        <button
          type="button"
          className="fm-icon-btn"
          disabled={!canBack}
          title="Back (Alt+Left)"
          aria-label="Back"
          onClick={back}
        >
          <Glyph name="chevron-left" />
        </button>
        <button
          type="button"
          className="fm-icon-btn"
          disabled={!canForward}
          title="Forward (Alt+Right)"
          aria-label="Forward"
          onClick={forward}
        >
          <Glyph name="chevron-right" />
        </button>
      </div>

      <ViewSwitcher />
      <PathBar editRef={pathBarRef} />
      <SearchField handleRef={searchRef} />

      <button
        type="button"
        className="fm-icon-btn fm-icon-btn--standalone"
        aria-pressed={previewVisible}
        title="Show preview pane (Ctrl+,)"
        aria-label="Show preview pane"
        onClick={togglePreview}
      >
        <Glyph name="sidebar-right" />
      </button>

      <WindowControls />
    </header>
  );
}

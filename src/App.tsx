import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ConfirmDeleteDialog,
  ConflictDialog,
  ContextMenu,
  ProgressPopover,
  Toasts,
  type MenuAction,
} from "./components/common/Ops";
import { ShortcutsSheet } from "./components/common/ShortcutsSheet";
import { PreviewPane } from "./components/preview/PreviewPane";
import { QuickLook } from "./components/quicklook/QuickLook";
import { Sidebar } from "./components/shell/Sidebar";
import { StatusBar } from "./components/shell/StatusBar";
import { Toolbar, type PathBarHandle, type SearchHandle } from "./components/shell/Toolbar";
import {
  createFolder,
  deletePermanently,
  duplicateEntries,
  knownFolders,
  openPath,
  revealInExplorer,
  trashEntries,
  undo as undoIpc,
} from "./ipc/fs";
import type { FsError, JobFinished } from "./ipc/types";
import {
  useGlobalKeyboard,
  useSuppressNativeContextMenu,
  useWindowFocusTracking,
} from "./keys/useGlobalKeyboard";
import type { KeyDeps } from "./keys/keymap";
import { basename, join, parentOf } from "./lib/path";
import { orderRegistry } from "./order/registry";
import { appState, useAppStore } from "./store/appStore";
import { ensureDir, insertEntry, invalidate } from "./store/fsStore";
import { beginTransfer, subscribeToJobs, useOpsStore } from "./store/opsStore";
import { watchPrefs } from "./store/persist";
import {
  beginSearch,
  reset as resetSearch,
  subscribeToSearch,
} from "./store/searchStore";
import { subscribe as subscribeToWatcher } from "./store/watchBridge";
import { ColumnView } from "./views/ColumnView";
import { ListView, ROW_H } from "./views/ListView";
import { SearchView } from "./views/SearchView";
import { TreeView } from "./views/TreeView";
import { useVisibleEntries } from "./views/useVisibleEntries";

import "./styles/tokens.css";
import "./styles/base.css";

/** Land somewhere sensible on first run. */
function useInitialDirectory() {
  const cwd = useAppStore((s) => s.cwd);
  const navigate = useAppStore((s) => s.navigate);

  useEffect(() => {
    if (cwd !== "") return;
    let cancelled = false;
    void (async () => {
      try {
        const kf = await knownFolders();
        if (cancelled) return;
        navigate(kf.home ?? "C:\\");
      } catch {
        if (!cancelled) navigate("C:\\");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, navigate]);
}

/**
 * Keep the live layout custom properties in step with the store, so the values
 * survive a re-render after a drag committed them.
 */
function useLayoutVars() {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const previewWidth = useAppStore((s) => s.previewWidth);
  const windowFocused = useAppStore((s) => s.windowFocused);

  useEffect(() => {
    document.documentElement.style.setProperty("--fm-sidebar-w", `${sidebarWidth}px`);
  }, [sidebarWidth]);

  useEffect(() => {
    document.documentElement.style.setProperty("--fm-preview-w", `${previewWidth}px`);
  }, [previewWidth]);

  useEffect(() => {
    // Read by the selection styles: focused windows get the accent colour,
    // unfocused ones the grey that makes this feel like Finder.
    document.body.dataset.windowFocused = String(windowFocused);
  }, [windowFocused]);
}

/** Summarise a finished job in one line, the way Finder reports one. */
function describeFinished(f: JobFinished): string {
  const verb = f.kind === "move" ? "Moved" : "Copied";
  if (f.status === "cancelled") {
    return `${verb} ${f.itemsDone.toLocaleString()} items before stopping`;
  }
  if (f.status === "failed") return f.errors[0]?.message ?? "That operation failed.";

  const parts = [`${verb} ${f.itemsDone.toLocaleString()} item${f.itemsDone === 1 ? "" : "s"}`];
  if (f.replaced > 0) parts.push(`${f.replaced} replaced`);
  if (f.skipped > 0) parts.push(`${f.skipped} skipped`);
  if (f.renamed > 0) parts.push(`${f.renamed} renamed`);
  if (f.errorCount > 0) parts.push(`${f.errorCount} failed`);
  return parts.join(" · ");
}

/** Wire backend job and watcher events. Mounted once. */
function useBackendEvents() {
  useEffect(() => {
    let disposeJobs: (() => void) | undefined;
    let disposeWatch: (() => void) | undefined;

    void subscribeToJobs((finished) => {
      for (const dir of finished.touchedDirs) invalidate(dir);
      const ops = useOpsStore.getState();
      void ops.refreshUndo();
      ops.toast(finished.errorCount > 0 ? "error" : "info", describeFinished(finished));
    }).then((d) => {
      disposeJobs = d;
    });

    void subscribeToWatcher({
      invalidate,
      onGone: (path) => {
        // A watched directory disappeared under us: refresh its parent so the
        // row vanishes rather than lingering as a ghost.
        const parent = parentOf(path);
        if (parent) invalidate(parent);
      },
    }).then((d) => {
      disposeWatch = d;
    });

    let disposeSearch: (() => void) | undefined;
    void subscribeToSearch().then((d) => {
      disposeSearch = d;
    });

    void useOpsStore.getState().refreshUndo();

    return () => {
      disposeJobs?.();
      disposeWatch?.();
      disposeSearch?.();
    };
  }, []);
}

export default function App() {
  useInitialDirectory();
  useLayoutVars();
  useWindowFocusTracking();
  useSuppressNativeContextMenu();
  useBackendEvents();

  const cwd = useAppStore((s) => s.cwd);
  const viewMode = useAppStore((s) => s.viewMode);
  const previewVisible = useAppStore((s) => s.previewVisible);
  const entries = useVisibleEntries(cwd || null);

  const searchMode = useAppStore((s) => s.searchMode);
  const filterQuery = useAppStore((s) => s.filterQuery);

  // Leaving search mode abandons the results.
  useEffect(() => {
    if (searchMode !== "recursive") resetSearch();
  }, [searchMode]);

  // Navigating away ends the search too: results from a folder you have left
  // are no longer what you are looking at.
  useEffect(() => {
    resetSearch();
    appState().setSearchMode("off");
  }, [cwd]);

  // Re-run on every keystroke, debounced. Each run cancels the one before it,
  // so a fast typist never has two searches streaming into one list.
  useEffect(() => {
    if (searchMode !== "recursive" || !cwd) return;
    const timer = setTimeout(() => {
      void beginSearch(cwd, filterQuery);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchMode, cwd, filterQuery]);

  const pathBarRef = useRef<PathBarHandle | null>(null);
  const searchRef = useRef<SearchHandle | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => watchPrefs(), []);

  const toast = useOpsStore((s) => s.toast);

  const openCursor = useCallback(() => {
    const s = appState();
    const cursor = s.cursor;
    if (!cursor) return;
    const entry = orderRegistry.get().entryOf(cursor);
    if (entry?.isDir) {
      if (!orderRegistry.source()?.activateDir?.(cursor)) s.navigate(cursor);
    } else {
      void openPath(cursor).catch((e: FsError) => toast("error", e.message));
    }
  }, [toast]);

  const newFolder = useCallback(() => {
    if (!cwd) return;
    void (async () => {
      try {
        const entry = await createFolder(cwd);
        // Insert locally and arm the editor at once, so the folder is named in
        // one gesture rather than hunted down again afterwards.
        insertEntry(cwd, entry);
        const path = join(cwd, entry.name);
        appState().setSelection([path], path);
        appState().beginRename(path);
        void useOpsStore.getState().refreshUndo();
      } catch (e) {
        toast("error", (e as FsError).message);
      }
    })();
  }, [cwd, toast]);

  const deleteSelection = useCallback(
    (permanent: boolean) => {
      const paths = [...appState().selection];
      if (paths.length === 0) return;
      if (permanent) {
        setConfirmDelete(paths);
        return;
      }
      void (async () => {
        try {
          const touched = await trashEntries(paths);
          for (const dir of touched) invalidate(dir);
          appState().clearSelection();
          void useOpsStore.getState().refreshUndo();
        } catch (e) {
          toast("error", (e as FsError).message);
        }
      })();
    },
    [toast],
  );

  const paste = useCallback(() => {
    const s = appState();
    const clipboard = s.clipboard;
    if (!clipboard || !s.cwd) return;
    void beginTransfer({
      sources: clipboard.paths,
      destDir: s.cwd,
      mode: clipboard.mode === "cut" ? "move" : "copy",
    });
    // A cut is consumed by its paste; a copy stays on the clipboard.
    if (clipboard.mode === "cut") s.clearClipboard();
  }, []);

  const duplicateSelection = useCallback(() => {
    const paths = [...appState().selection];
    if (paths.length === 0) return;
    void (async () => {
      try {
        const created = await duplicateEntries(paths);
        const dir = parentOf(created[0] ?? "");
        if (dir) invalidate(dir);
        void useOpsStore.getState().refreshUndo();
      } catch (e) {
        toast("error", (e as FsError).message);
      }
    })();
  }, [toast]);

  const runUndo = useCallback(() => {
    void (async () => {
      try {
        const outcome = await undoIpc();
        for (const dir of outcome.touchedDirs) invalidate(dir);
        void useOpsStore.getState().refreshUndo();
        if (outcome.errors.length > 0) {
          useOpsStore.getState().reportErrors(outcome.errors, outcome.label);
        } else {
          toast("info", outcome.label);
        }
      } catch (e) {
        // A tombstone lands here: the reason explains why this one cannot go
        // back, rather than silently undoing the operation before it.
        toast("error", (e as FsError).message);
      }
    })();
  }, [toast]);

  const deps: Partial<KeyDeps> = {
    openCursor,
    newFolder,
    deleteSelection,
    paste,
    duplicateSelection,
    undo: runUndo,
    renameCursor: () => {
      const cursor = appState().cursor;
      if (cursor) appState().beginRename(cursor);
    },
    reload: () => {
      if (cwd) void ensureDir(cwd, { force: true });
    },
    focusFilter: () => searchRef.current?.focusInput(),
    startRecursiveSearch: () => {
      const s = appState();
      if (!s.cwd) return;
      s.setSearchMode("recursive");
      // Seed from whatever is already in the filter box, so escalating a quick
      // filter into a full search does not mean typing it again.
      const seed = s.filterQuery.trim();
      if (seed !== "") void beginSearch(s.cwd, seed);
      searchRef.current?.focusInput();
    },
    focusPathBar: () => pathBarRef.current?.focusInput(),
    showShortcuts: () => setShortcutsOpen((v) => !v),
    revealCursor: () => {
      const cursor = appState().cursor;
      if (cursor) void revealInExplorer(cursor).catch(() => {});
    },
    // A page is a viewport of rows, minus one so there is visual overlap
    // between pages -- the same convention Explorer uses.
    pageSize: () => Math.max(1, Math.floor(window.innerHeight / ROW_H) - 1),
  };

  useGlobalKeyboard(deps);

  // Rebuilt when the menu opens, so enablement reflects the live selection.
  const contextMenu = useAppStore((s) => s.contextMenu);
  const menuActions = useMemo<MenuAction[]>(() => {
    const s = appState();
    const count = s.selection.size;
    const cursor = s.cursor;
    const hasClipboard = s.clipboard !== null;
    const sep = (id: string): MenuAction => ({ id, label: "", run: () => {} });

    return [
      { id: "open", label: "Open", disabled: !cursor, run: openCursor },
      {
        id: "quicklook",
        label: cursor ? `Quick Look "${basename(cursor)}"` : "Quick Look",
        shortcut: "Space",
        disabled: !cursor,
        run: () => appState().openQuickLook(),
      },
      sep("sep1"),
      {
        id: "rename",
        label: "Rename",
        shortcut: "F2",
        disabled: count !== 1 || !cursor,
        run: () => {
          if (cursor) appState().beginRename(cursor);
        },
      },
      {
        id: "duplicate",
        label: "Duplicate",
        shortcut: "Ctrl+D",
        disabled: count === 0,
        run: duplicateSelection,
      },
      sep("sep2"),
      {
        id: "copy",
        label: "Copy",
        shortcut: "Ctrl+C",
        disabled: count === 0,
        run: () => appState().copySelection(),
      },
      {
        id: "cut",
        label: "Cut",
        shortcut: "Ctrl+X",
        disabled: count === 0,
        run: () => appState().cutSelection(),
      },
      { id: "paste", label: "Paste", shortcut: "Ctrl+V", disabled: !hasClipboard, run: paste },
      sep("sep3"),
      { id: "newfolder", label: "New Folder", shortcut: "Ctrl+Shift+N", run: newFolder },
      {
        id: "reveal",
        label: "Reveal in Explorer",
        disabled: !cursor,
        run: () => {
          if (cursor) void revealInExplorer(cursor).catch(() => {});
        },
      },
      sep("sep4"),
      {
        id: "trash",
        label: "Move to Recycle Bin",
        shortcut: "Del",
        danger: true,
        disabled: count === 0,
        run: () => deleteSelection(false),
      },
    ];
  }, [contextMenu, openCursor, duplicateSelection, paste, newFolder, deleteSelection]);

  return (
    <div className="fm-app">
      <Toolbar pathBarRef={pathBarRef} searchRef={searchRef} />
      <Sidebar />

      <main className="fm-content">
        {searchMode === "recursive" && <SearchView />}
        {searchMode !== "recursive" && viewMode === "list" && <ListView />}
        {searchMode !== "recursive" && viewMode === "column" && <ColumnView />}
        {searchMode !== "recursive" && viewMode === "tree" && <TreeView />}
      </main>

      {previewVisible && <PreviewPane />}

      <StatusBar visibleCount={entries.length} />

      <QuickLook />
      <ContextMenu actions={menuActions} />
      <ConflictDialog />
      <ConfirmDeleteDialog
        paths={confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const paths = confirmDelete ?? [];
          setConfirmDelete(null);
          void (async () => {
            try {
              const touched = await deletePermanently(paths);
              for (const dir of touched) invalidate(dir);
              appState().clearSelection();
              void useOpsStore.getState().refreshUndo();
            } catch (e) {
              toast("error", (e as FsError).message);
            }
          })();
        }}
      />
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <ProgressPopover />
      <Toasts />
    </div>
  );
}

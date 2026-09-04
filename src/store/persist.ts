/**
 * Persist the handful of view preferences that should outlive a restart.
 *
 * Hand-rolled rather than zustand's `persist` middleware, for two reasons: the
 * store holds `Set`s that do not survive JSON, and rehydration must happen
 * before the first render rather than asynchronously afterwards, which the
 * middleware's timing makes awkward to guarantee.
 *
 * Anything not listed here is deliberately session-only. Restoring the last
 * directory, selection or expanded tree on launch would mean the app opens
 * somewhere the user has since deleted.
 */

import type { ListColumn } from "./appStore";
import { useAppStore } from "./appStore";
import type { SortDir, SortKey } from "../lib/sort";
import type { ViewMode } from "../order/registry";

const KEY = "finder-fm.prefs.v1";
/** Coalesce bursts of changes -- dragging a column emits one write, not sixty. */
const SAVE_DEBOUNCE_MS = 400;

interface Prefs {
  viewMode: ViewMode;
  sortKey: SortKey;
  sortDir: SortDir;
  showHidden: boolean;
  showSystem: boolean;
  previewVisible: boolean;
  sidebarWidth: number;
  previewWidth: number;
  listColumnWidths: Record<ListColumn, number>;
}

const VIEW_MODES: ViewMode[] = ["list", "column", "tree"];
const SORT_KEYS: SortKey[] = ["name", "modified", "size", "kind"];

/**
 * Validate every field rather than trusting the blob.
 *
 * Stored preferences outlive the code that wrote them: a shape from an older
 * build, or a hand-edited value, must degrade to the default instead of
 * putting the store into a state no code path expects.
 */
function sanitize(raw: unknown): Partial<Prefs> {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<Prefs> = {};

  if (typeof r.viewMode === "string" && VIEW_MODES.includes(r.viewMode as ViewMode)) {
    out.viewMode = r.viewMode as ViewMode;
  }
  if (typeof r.sortKey === "string" && SORT_KEYS.includes(r.sortKey as SortKey)) {
    out.sortKey = r.sortKey as SortKey;
  }
  if (r.sortDir === 1 || r.sortDir === -1) out.sortDir = r.sortDir;
  if (typeof r.showHidden === "boolean") out.showHidden = r.showHidden;
  if (typeof r.showSystem === "boolean") out.showSystem = r.showSystem;
  if (typeof r.previewVisible === "boolean") out.previewVisible = r.previewVisible;

  const width = (v: unknown, min: number, max: number): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;

  const sidebar = width(r.sidebarWidth, 150, 420);
  if (sidebar !== undefined) out.sidebarWidth = sidebar;
  const preview = width(r.previewWidth, 200, 600);
  if (preview !== undefined) out.previewWidth = preview;

  if (typeof r.listColumnWidths === "object" && r.listColumnWidths !== null) {
    const c = r.listColumnWidths as Record<string, unknown>;
    const cols: Record<string, number> = {};
    for (const [key, min] of [
      ["name", 120],
      ["modified", 60],
      ["size", 60],
      ["kind", 60],
    ] as const) {
      const w = width(c[key], min, 1200);
      if (w !== undefined) cols[key] = w;
    }
    if (Object.keys(cols).length > 0) {
      out.listColumnWidths = {
        ...useAppStore.getState().listColumnWidths,
        ...cols,
      } as Record<ListColumn, number>;
    }
  }
  return out;
}

/** Apply stored preferences. Call once, before the first render. */
export function hydratePrefs(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // Private mode, or storage disabled. Defaults are a fine outcome.
    return;
  }
  if (!raw) return;

  try {
    const prefs = sanitize(JSON.parse(raw));
    if (Object.keys(prefs).length > 0) useAppStore.setState(prefs);
  } catch {
    // A corrupt blob is not worth keeping.
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing further to do */
    }
  }
}

function snapshot(): Prefs {
  const s = useAppStore.getState();
  return {
    viewMode: s.viewMode,
    sortKey: s.sortKey,
    sortDir: s.sortDir,
    showHidden: s.showHidden,
    showSystem: s.showSystem,
    previewVisible: s.previewVisible,
    sidebarWidth: s.sidebarWidth,
    previewWidth: s.previewWidth,
    listColumnWidths: s.listColumnWidths,
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Start saving on change. Returns an unsubscribe function. */
export function watchPrefs(): () => void {
  const unsub = useAppStore.subscribe(() => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        localStorage.setItem(KEY, JSON.stringify(snapshot()));
      } catch {
        // Storage full or unavailable: preferences simply do not persist.
      }
    }, SAVE_DEBOUNCE_MS);
  });

  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    unsub();
  };
}

export const prefsDebug = {
  key: KEY,
  sanitize,
  snapshot,
  flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(snapshot()));
    } catch {
      /* ignored */
    }
  },
};

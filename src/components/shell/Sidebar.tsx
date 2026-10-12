import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";

import { knownFolders, listDrives } from "../../ipc/fs";
import { asFsError, type DriveInfo, type FsError } from "../../ipc/types";
import { formatBytes } from "../../lib/format";
import { basename, isInside, normalize } from "../../lib/path";
import { setProtectedPaths } from "../../store/fsStore";
import { useAppStore } from "../../store/appStore";
import {
  isFavoriteAddDrag,
  isFavoriteReorderDrag,
  readFavoriteAddDrag,
  readFavoriteReorderDrag,
  startFavoriteReorderDrag,
  useFavoritesStore,
  type Favorite,
} from "../../store/favoritesStore";
import { ContextMenu, type MenuAction } from "../common/Ops";
import { FileIcon, Glyph } from "../common/Icon";
import type { Category } from "../../ipc/types";

const FAVOURITE_ORDER: Array<{ key: keyof PlacesPayload; label: string }> = [
  { key: "home", label: "Home" },
  { key: "desktop", label: "Desktop" },
  { key: "documents", label: "Documents" },
  { key: "downloads", label: "Downloads" },
  { key: "pictures", label: "Pictures" },
  { key: "music", label: "Music" },
  { key: "videos", label: "Videos" },
  { key: "oneDrive", label: "OneDrive" },
];

type PlacesPayload = Awaited<ReturnType<typeof knownFolders>>;

/**
 * Resolve the OS locations and drives once per session, and seed the
 * favourites list from the former the very first time the app ever runs
 * (see `seedIfEmpty`).
 */
function useSidebarData() {
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [error, setError] = useState<FsError | null>(null);
  const seedIfEmpty = useFavoritesStore((s) => s.seedIfEmpty);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [kf, ds] = await Promise.all([knownFolders(), listDrives()]);
        if (cancelled) return;

        const defaults: Favorite[] = [];
        for (const { key, label } of FAVOURITE_ORDER) {
          const value = kf[key];
          if (typeof value === "string" && value !== "") {
            defaults.push({ label, path: normalize(value) });
          }
        }
        seedIfEmpty(defaults);
        setDrives(ds);

        // Ancestors of the places the user reaches most are worth keeping in
        // the directory cache even under eviction pressure.
        setProtectedPaths([
          ...useFavoritesStore.getState().favorites.map((f) => f.path),
          ...ds.map((d) => normalize(d.root)),
        ]);
      } catch (e) {
        if (!cancelled) setError(asFsError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seedIfEmpty]);

  return { drives, error };
}

function driveCategory(d: DriveInfo): Category {
  return d.driveType === "cdRom" ? "disk" : "volume";
}

function PlaceRow({
  label,
  path,
  category,
  sub,
  offline,
  draggable,
  onDragStart,
  onContextMenu,
}: {
  label: string;
  path: string;
  category: Category;
  sub?: string;
  offline?: boolean;
  draggable?: boolean;
  onDragStart?: (e: DragEvent<HTMLButtonElement>) => void;
  onContextMenu?: (e: MouseEvent) => void;
}) {
  const cwd = useAppStore((s) => s.cwd);
  const navigate = useAppStore((s) => s.navigate);
  // Highlight the favourite the current directory sits under, the way Finder
  // keeps "Documents" lit while you are three folders deep inside it.
  const current = cwd === path || (path !== "" && isInside(path, cwd));

  return (
    <button
      type="button"
      className="fm-place"
      aria-current={current}
      data-offline={offline ? "true" : undefined}
      title={path}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={() => navigate(path)}
      onContextMenu={onContextMenu}
    >
      <FileIcon category={category} />
      <span className="fm-place-label">{label}</span>
      {sub && <span className="fm-place-sub">{sub}</span>}
    </button>
  );
}

/** Which half of a row a drag is currently hovering, for the insertion line. */
function dropsBefore(e: DragEvent<HTMLElement>): boolean {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2;
}

/**
 * A favourite: draggable to reorder, removable with a hover "x" or
 * right-click -- even the ones seeded from the OS locations. Also a drop
 * target in its own right, so a folder or another favourite can land exactly
 * next to it rather than only at the end of the list.
 */
function FavoriteRow({
  path,
  label,
  dropBefore,
  dropAfter,
  onHover,
  onLeave,
}: {
  path: string;
  label: string;
  dropBefore: boolean;
  dropAfter: boolean;
  onHover(path: string, before: boolean): void;
  onLeave(): void;
}) {
  const removeFavorite = useFavoritesStore((s) => s.removeFavorite);
  const moveFavorite = useFavoritesStore((s) => s.moveFavorite);
  const addFavorites = useFavoritesStore((s) => s.addFavorites);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const actions: MenuAction[] = [
    {
      id: "removeFavorite",
      label: "Remove from Favourites",
      run: () => removeFavorite(path),
    },
  ];

  return (
    <div
      className="fm-place-wrap"
      data-drop-before={dropBefore ? "true" : undefined}
      data-drop-after={dropAfter ? "true" : undefined}
      onDragOver={(e) => {
        if (!isFavoriteReorderDrag(e) && !isFavoriteAddDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = isFavoriteReorderDrag(e) ? "move" : "copy";
        onHover(path, dropsBefore(e));
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        onLeave();
      }}
      onDrop={(e) => {
        if (isFavoriteReorderDrag(e)) {
          e.preventDefault();
          e.stopPropagation();
          const dragged = readFavoriteReorderDrag(e);
          if (dragged && dragged !== path) moveFavorite(dragged, { path, before: dropsBefore(e) });
        } else if (isFavoriteAddDrag(e)) {
          e.preventDefault();
          e.stopPropagation();
          const paths = readFavoriteAddDrag(e);
          if (paths.length > 0) addFavorites(paths, { path, before: dropsBefore(e) });
        }
        onLeave();
      }}
    >
      <PlaceRow
        label={label}
        path={path}
        category="folder"
        draggable
        onDragStart={(e) => startFavoriteReorderDrag(e, path)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      <button
        type="button"
        className="fm-place-remove"
        title={`Remove "${label}" from Favourites`}
        aria-label={`Remove ${label} from Favourites`}
        onClick={(e) => {
          e.stopPropagation();
          removeFavorite(path);
        }}
      >
        <Glyph name="close" size={9} strokeWidth={1.6} />
      </button>
      <ContextMenu
        actions={actions}
        state={menu ? { x: menu.x, y: menu.y, paths: [] } : null}
        onClose={() => setMenu(null)}
      />
    </div>
  );
}

/**
 * Width drag handle. The live value is written straight to a CSS custom
 * property, so dragging costs zero React renders; the store is updated once on
 * release.
 */
function WidthHandle({
  side,
  cssVar,
  initial,
  min,
  max,
  commit,
}: {
  side: "left" | "right";
  cssVar: string;
  initial: number;
  min: number;
  max: number;
  commit: (w: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const startW = useRef(initial);
  const live = useRef(initial);

  return (
    <div
      ref={ref}
      className={`fm-resize-v fm-resize-v--${side}`}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        startX.current = e.clientX;
        startW.current = live.current;
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const delta = side === "right" ? e.clientX - startX.current : startX.current - e.clientX;
        const next = Math.min(max, Math.max(min, startW.current + delta));
        live.current = next;
        document.documentElement.style.setProperty(cssVar, `${next}px`);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        commit(live.current);
      }}
    />
  );
}

export function Sidebar() {
  const { drives, error } = useSidebarData();
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);

  const favorites = useFavoritesStore((s) => s.favorites);
  const addFavorites = useFavoritesStore((s) => s.addFavorites);

  const [groupDragOver, setGroupDragOver] = useState(false);
  const [dropTarget, setDropTarget] = useState<{ path: string; before: boolean } | null>(null);

  return (
    <nav className="fm-sidebar fm-scroll" aria-label="Places">
      <div
        className="fm-sidebar-group"
        data-dragover={groupDragOver ? "true" : undefined}
        onDragOver={(e: DragEvent) => {
          // A reorder drag is handled per-row instead, which is always
          // reached first since rows are nested inside this group.
          if (!isFavoriteAddDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setGroupDragOver(true);
        }}
        onDragLeave={(e: DragEvent<HTMLDivElement>) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setGroupDragOver(false);
        }}
        onDrop={(e: DragEvent) => {
          setGroupDragOver(false);
          // Dropped on a specific row: that row's own handler already placed
          // it (and reorders never bubble here to begin with).
          if (!isFavoriteAddDrag(e)) return;
          e.preventDefault();
          const paths = readFavoriteAddDrag(e);
          if (paths.length > 0) addFavorites(paths);
        }}
      >
        <div className="fm-sidebar-section">Favourites</div>
        {favorites.map((f) => (
          <FavoriteRow
            key={f.path}
            path={f.path}
            label={f.label}
            dropBefore={dropTarget?.path === f.path && dropTarget.before}
            dropAfter={dropTarget?.path === f.path && !dropTarget.before}
            onHover={(path, before) => setDropTarget({ path, before })}
            onLeave={() => setDropTarget(null)}
          />
        ))}
      </div>

      <div className="fm-sidebar-section">Locations</div>
      {drives.map((d) => (
        <PlaceRow
          key={d.root}
          label={d.label === basename(d.root) ? d.root : `${d.label} (${d.root.slice(0, 2)})`}
          path={normalize(d.root)}
          category={driveCategory(d)}
          // A not-ready drive shows no size, and reads greyed.
          sub={d.ready && d.totalBytes > 0 ? formatBytes(d.freeBytes) : undefined}
          offline={!d.ready}
        />
      ))}

      {error && (
        <div className="fm-sidebar-section" style={{ color: "var(--fm-danger)" }}>
          <Glyph name="warning" size={11} /> {error.message}
        </div>
      )}

      <WidthHandle
        side="right"
        cssVar="--fm-sidebar-w"
        initial={sidebarWidth}
        min={150}
        max={420}
        commit={setSidebarWidth}
      />
    </nav>
  );
}

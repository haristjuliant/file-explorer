import { useEffect, useRef, useState } from "react";

import { knownFolders, listDrives } from "../../ipc/fs";
import { asFsError, type DriveInfo, type FsError } from "../../ipc/types";
import { formatBytes } from "../../lib/format";
import { basename, isInside, normalize } from "../../lib/path";
import { setProtectedPaths } from "../../store/fsStore";
import { useAppStore } from "../../store/appStore";
import { FileIcon, Glyph } from "../common/Icon";
import type { Category } from "../../ipc/types";

interface Place {
  label: string;
  path: string;
  category: Category;
}

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

/** Load favourites and drives once; both are effectively static per session. */
function usePlaces() {
  const [favourites, setFavourites] = useState<Place[]>([]);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [error, setError] = useState<FsError | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [kf, ds] = await Promise.all([knownFolders(), listDrives()]);
        if (cancelled) return;

        const favs: Place[] = [];
        for (const { key, label } of FAVOURITE_ORDER) {
          const value = kf[key];
          if (typeof value === "string" && value !== "") {
            favs.push({ label, path: normalize(value), category: "folder" });
          }
        }
        setFavourites(favs);
        setDrives(ds);

        // Ancestors of the places the user reaches most are worth keeping in
        // the directory cache even under eviction pressure.
        setProtectedPaths([...favs.map((f) => f.path), ...ds.map((d) => normalize(d.root))]);
      } catch (e) {
        if (!cancelled) setError(asFsError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { favourites, drives, error };
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
}: {
  label: string;
  path: string;
  category: Category;
  sub?: string;
  offline?: boolean;
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
      onClick={() => navigate(path)}
    >
      <FileIcon category={category} />
      <span className="fm-place-label">{label}</span>
      {sub && <span className="fm-place-sub">{sub}</span>}
    </button>
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
  const { favourites, drives, error } = usePlaces();
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);

  return (
    <nav className="fm-sidebar fm-scroll" aria-label="Places">
      <div className="fm-sidebar-section">Favourites</div>
      {favourites.map((f) => (
        <PlaceRow key={f.path} label={f.label} path={f.path} category={f.category} />
      ))}

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

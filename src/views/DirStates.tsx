import type { ReactNode } from "react";

import type { DirState } from "../store/fsStore";
import { Glyph } from "../components/common/Icon";
import { useAppStore } from "../store/appStore";

/**
 * Loading, error and empty presentation for one directory.
 *
 * Deliberately never a full-view spinner. With nothing cached the view shows
 * skeleton rows whose fade-in is delayed 120 ms, so a local read -- typically
 * under 10 ms -- shows nothing at all rather than a flash. With entries already
 * cached the rows stay put and only a 2 px progress line appears.
 *
 * In column and tree mode this renders INSIDE the affected column or subtree, so
 * one unreadable `System Volume Information` cannot blank the whole window.
 */
export function DirStates({
  dir,
  visibleCount,
  onRetry,
  children,
}: {
  dir: DirState | undefined;
  visibleCount: number;
  onRetry: () => void;
  children: ReactNode;
}) {
  const filterQuery = useAppStore((s) => s.filterQuery);
  const showHidden = useAppStore((s) => s.showHidden);
  const toggleHidden = useAppStore((s) => s.toggleHidden);
  const up = useAppStore((s) => s.up);

  if (dir?.status === "error") {
    const code = dir.error?.code;
    return (
      <div className="fm-center">
        <div>
          <div style={{ color: "var(--fm-text-tertiary)", marginBottom: 8 }}>
            <Glyph name="warning" size={28} strokeWidth={1.2} />
          </div>
          <h3>
            {code === "accessDenied"
              ? "You don't have permission to see this folder"
              : code === "notFound"
                ? "This folder no longer exists"
                : code === "deviceNotReady"
                  ? "The drive isn't ready"
                  : "This folder couldn't be opened"}
          </h3>
          <p>{dir.error?.message}</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button type="button" className="fm-btn" onClick={onRetry}>
              Try again
            </button>
            {code === "notFound" && (
              <button type="button" className="fm-btn" onClick={up}>
                Go to enclosing folder
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const loadingFresh = (dir === undefined || dir.status === "loading") && dir?.entries.length === 0;
  if (loadingFresh) {
    return (
      <div className="fm-skeleton" aria-busy="true" aria-label="Loading folder">
        {Array.from({ length: 12 }, (_, i) => (
          <div className="fm-skeleton-row" key={i}>
            <div
              className="fm-skeleton-bar"
              style={{ width: `${34 - (i % 4) * 6}%`, animationDelay: `${120 + i * 12}ms` }}
            />
          </div>
        ))}
      </div>
    );
  }

  const revalidating = dir?.status === "loading" && dir.entries.length > 0;

  if (dir?.status === "ready" && visibleCount === 0) {
    const hiddenExist = dir.entries.length > 0;
    return (
      <div className="fm-center">
        <div>
          <h3>
            {filterQuery !== ""
              ? "No matches"
              : hiddenExist
                ? "Nothing visible here"
                : "This folder is empty"}
          </h3>
          {filterQuery !== "" && <p>Nothing in this folder matches “{filterQuery}”.</p>}
          {filterQuery === "" && hiddenExist && !showHidden && (
            <>
              <p>Everything in this folder is hidden or a system item.</p>
              <button type="button" className="fm-btn" onClick={toggleHidden}>
                Show hidden files
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {revalidating && <div className="fm-revalidating" aria-hidden="true" />}
      {children}
    </>
  );
}

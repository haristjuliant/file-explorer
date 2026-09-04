import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { openPath, prefetchThumbnails } from "../../ipc/fs";
import { basename } from "../../lib/path";
import { orderRegistry, useOrderVersion } from "../../order/registry";
import { useAppStore } from "../../store/appStore";
import { Glyph } from "../common/Icon";
import { PreviewBody } from "../preview/PreviewBody";

import "../preview/preview.css";

/** Matches the exit transition in preview.css. */
const CLOSE_MS = 110;

type Phase = "closed" | "open" | "closing";

/**
 * Warm the neighbouring previews so arrow-key stepping feels instant.
 *
 * Runs at idle and is capped by the backend, so a fast walk through a photo
 * folder cannot queue hundreds of decodes ahead of the visible one.
 */
function usePreloadNeighbours(paths: readonly string[], index: number) {
  useEffect(() => {
    if (index < 0) return;
    const wanted = [1, -1, 2, -2]
      .map((d) => paths[index + d])
      .filter((p): p is string => typeof p === "string");
    if (wanted.length === 0) return;

    const idle = requestIdleCallback(
      () => {
        void prefetchThumbnails(wanted, 1600).catch(() => {
          /* a cold neighbour just renders a moment later */
        });
      },
      { timeout: 300 },
    );
    return () => cancelIdleCallback(idle);
  }, [paths, index]);
}

/** Keep Tab inside the dialog, and hand focus back where it came from. */
function useFocusTrap(active: boolean, panelRef: React.RefObject<HTMLDivElement | null>) {
  const previous = useRef<Element | null>(null);

  useEffect(() => {
    if (!active) return;
    previous.current = document.activeElement;
    panelRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      const target = previous.current;
      // Focus goes back to the view so the arrow keys keep working.
      if (target instanceof HTMLElement) target.focus();
    };
  }, [active, panelRef]);
}

/**
 * Quick Look.
 *
 * Deliberately knows nothing about which view is underneath. It reads the
 * cursor and the active `OrderSource`, and its arrow keys call the very same
 * `moveCursor` the views use -- which is the whole point of the registry, and
 * why it works unchanged in list, column and tree mode.
 *
 * Not built on `<dialog>`: its native Escape and backdrop behaviour fights the
 * keyboard precedence chain, and `::backdrop` styling is inconsistent in
 * WebView2.
 */
export function QuickLook() {
  const open = useAppStore((s) => s.quickLookOpen);
  const cursor = useAppStore((s) => s.cursor);
  const closeQuickLook = useAppStore((s) => s.closeQuickLook);
  const version = useOrderVersion();

  const [phase, setPhase] = useState<Phase>("closed");
  const panelRef = useRef<HTMLDivElement>(null);
  /** Held so the exit animation still has something to render. */
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (open) {
      setPhase("open");
      return;
    }
    setPhase((current) => (current === "closed" ? "closed" : "closing"));
    const timer = setTimeout(() => setPhase("closed"), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  const order = useMemo(() => orderRegistry.get(), [version, cursor]);
  const path = open ? cursor : lastPath.current;
  if (open && cursor) lastPath.current = cursor;

  const index = path ? (order.index.get(path) ?? -1) : -1;
  usePreloadNeighbours(order.paths, open ? index : -1);
  useFocusTrap(phase === "open", panelRef);

  if (phase === "closed" || !path) return null;

  const entry = order.entryOf(path);
  const name = basename(path);

  return createPortal(
    <div
      className="fm-ql-backdrop"
      data-state={phase}
      onPointerDown={closeQuickLook}
      role="presentation"
    >
      <div
        className="fm-ql-panel"
        role="dialog"
        aria-modal="true"
        aria-label={name}
        ref={panelRef}
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="fm-ql-titlebar">
          <button
            type="button"
            className="fm-icon-btn fm-icon-btn--standalone"
            aria-label="Close"
            title="Close (Space or Esc)"
            onClick={closeQuickLook}
          >
            <Glyph name="close" size={12} strokeWidth={1.6} />
          </button>
          <span className="fm-ql-title">{name}</span>
          {order.paths.length > 1 && index >= 0 && (
            <span className="fm-ql-count">
              {index + 1} of {order.paths.length}
            </span>
          )}
        </header>

        <div className="fm-ql-body">
          {/* Keyed on the path so the body cross-fades as the cursor steps. */}
          <div className="fm-ql-fade" key={path}>
            <PreviewBody path={path} entry={entry} variant="quicklook" />
          </div>
        </div>

        <footer className="fm-ql-footer">
          <button
            type="button"
            className="fm-btn"
            onClick={() => {
              void openPath(path).catch(() => {});
            }}
          >
            Open in default app
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

/**
 * Minimise / maximise / close for an undecorated window.
 *
 * The maximise button reports its rectangle to Rust, which uses it to answer
 * `WM_NCHITTEST` with `HTMAXBUTTON`. Without that, removing the native frame
 * also silently removes Windows 11's Snap Layouts -- the flyout that appears
 * when you hover the maximise button of any normal window.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const maxRef = useRef<HTMLButtonElement>(null);

  const appWindow = useRef<ReturnType<typeof getCurrentWindow> | null>(null);
  if (appWindow.current === null) {
    try {
      appWindow.current = getCurrentWindow();
    } catch {
      // Running outside Tauri (a browser, or a test): the controls simply do
      // nothing rather than throwing during render.
      appWindow.current = null;
    }
  }

  const syncMaximized = useCallback(async () => {
    try {
      const win = appWindow.current;
      if (win) setMaximized(await win.isMaximized());
    } catch {
      /* ignored */
    }
  }, []);

  /** Report the button's physical-pixel rectangle to the hit test. */
  const reportRect = useCallback(() => {
    const el = maxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // The hit test works in physical pixels; CSS does not.
    const dpr = window.devicePixelRatio || 1;
    void invoke("set_caption_button_rect", {
      x: Math.round(r.left * dpr),
      y: Math.round(r.top * dpr),
      w: Math.round(r.width * dpr),
      h: Math.round(r.height * dpr),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    void syncMaximized();
    reportRect();

    const onResize = () => {
      reportRect();
      void syncMaximized();
    };
    window.addEventListener("resize", onResize);

    // The toolbar reflows for reasons other than a window resize -- the
    // breadcrumb collapsing, for one -- so observe the button itself too.
    let observer: ResizeObserver | undefined;
    if (maxRef.current && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(reportRect);
      observer.observe(maxRef.current);
    }

    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
    };
  }, [reportRect, syncMaximized]);

  const win = appWindow.current;

  return (
    <div className="fm-wincontrols">
      <button
        type="button"
        className="fm-wincontrol"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void win?.minimize().catch(() => {})}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
        </svg>
      </button>

      <button
        ref={maxRef}
        type="button"
        className="fm-wincontrol"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => {
          void win
            ?.toggleMaximize()
            .then(syncMaximized)
            .catch(() => {});
        }}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" />
            <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="fm-wincontrol fm-wincontrol--close"
        aria-label="Close"
        title="Close"
        onClick={() => void win?.close().catch(() => {})}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}

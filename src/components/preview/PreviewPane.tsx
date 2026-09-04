import { useMemo, useRef } from "react";

import { orderRegistry, useOrderVersion } from "../../order/registry";
import { useAppStore } from "../../store/appStore";
import { PreviewBody } from "./PreviewBody";

/**
 * Width drag handle. The live value goes straight to a CSS custom property, so
 * dragging costs no React renders; the store is updated once on release.
 */
function WidthHandle() {
  const setPreviewWidth = useAppStore((s) => s.setPreviewWidth);
  const previewWidth = useAppStore((s) => s.previewWidth);
  const startX = useRef(0);
  const startW = useRef(previewWidth);
  const live = useRef(previewWidth);

  return (
    <div
      className="fm-resize-v fm-resize-v--left"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        startX.current = e.clientX;
        startW.current = live.current;
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        // Dragging left widens the pane, because it grows from the right edge.
        const next = Math.min(600, Math.max(200, startW.current + (startX.current - e.clientX)));
        live.current = next;
        document.documentElement.style.setProperty("--fm-preview-w", `${next}px`);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        setPreviewWidth(live.current);
      }}
    />
  );
}

/**
 * The right-hand preview pane.
 *
 * Follows the cursor rather than the selection, so it agrees with Quick Look:
 * both preview the focused item, and both read it from the same store field.
 */
export function PreviewPane() {
  const cursor = useAppStore((s) => s.cursor);
  const selectionSize = useAppStore((s) => s.selection.size);
  const version = useOrderVersion();

  const entry = useMemo(
    () => (cursor ? orderRegistry.get().entryOf(cursor) : undefined),
    [cursor, version],
  );

  return (
    <aside className="fm-preview fm-scroll" aria-label="Preview">
      {selectionSize > 1 ? (
        <div className="fm-pv-empty">{selectionSize.toLocaleString()} items selected</div>
      ) : (
        <PreviewBody path={cursor} entry={entry} variant="pane" />
      )}
      <WidthHandle />
    </aside>
  );
}

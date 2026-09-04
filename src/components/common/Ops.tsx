import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";

import { formatBytes, formatDateFull } from "../../lib/format";
import { basename } from "../../lib/path";
import {
  cancelJob,
  resolveTransfer,
  useOpsStore,
  type Toast,
} from "../../store/opsStore";
import { useAppStore } from "../../store/appStore";
import { Glyph } from "./Icon";

import "./ops.css";

/* ------------------------------------------------------------------------- */
/* Context menu                                                               */
/* ------------------------------------------------------------------------- */

export interface MenuAction {
  id: string;
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  run(): void;
}

export function ContextMenu({ actions }: { actions: MenuAction[] }) {
  const menu = useAppStore((s) => s.contextMenu);
  const close = useAppStore((s) => s.closeContextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Flip the menu back on screen once its real size is known, rather than
  // guessing at a size before it renders.
  useEffect(() => {
    if (!menu) {
      setPos(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, Math.max(0, window.innerWidth - rect.width - 8)),
      y: Math.min(menu.y, Math.max(0, window.innerHeight - rect.height - 8)),
    });
  }, [menu]);

  if (!menu) return null;

  return createPortal(
    <div
      style={{ position: "fixed", inset: 0, zIndex: 199 }}
      onPointerDown={close}
      onContextMenu={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div
        ref={ref}
        className="fm-menu"
        role="menu"
        style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? "visible" : "hidden" }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {actions.map((a) =>
          a.id.startsWith("sep") ? (
            <div className="fm-menu-sep" key={a.id} />
          ) : (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              className={`fm-menu-item${a.danger ? " fm-menu-item--danger" : ""}`}
              disabled={a.disabled}
              onClick={() => {
                close();
                a.run();
              }}
            >
              {a.label}
              {a.shortcut && <span className="fm-menu-shortcut">{a.shortcut}</span>}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------------- */
/* Conflict dialog                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Shown once, before the transfer starts, listing every top-level collision.
 *
 * One dialog for the whole job rather than one per file: merging a folder with
 * three hundred same-named files must not mean three hundred modals.
 */
export function ConflictDialog() {
  const pending = useOpsStore((s) => s.pending);
  const setPending = useOpsStore((s) => s.setPending);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pending) ref.current?.focus();
  }, [pending]);

  if (!pending) return null;
  const { conflicts } = pending.preflight;
  const mergeable = conflicts.filter((c) => c.mergePossible).length;

  return createPortal(
    <div className="fm-modal-backdrop" role="presentation">
      <div
        className="fm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Items with the same name"
        ref={ref}
        tabIndex={-1}
        onKeyDown={(e) => {
          // Escape is the non-destructive way out; Enter takes the
          // non-destructive default.
          if (e.key === "Escape") setPending(null);
          if (e.key === "Enter") void resolveTransfer("keepBoth");
          e.stopPropagation();
        }}
      >
        <h2>
          {conflicts.length === 1
            ? "An item with that name already exists"
            : `${conflicts.length} items already exist there`}
        </h2>
        <p>
          {mergeable > 0
            ? "Folders will be merged; files need a decision."
            : "Choose what to do with the existing items."}
        </p>

        <div className="fm-modal-body">
          {conflicts.slice(0, 20).map((c) => (
            <div className="fm-conflict" key={c.dest}>
              <div className="fm-conflict-name">{c.name}</div>
              <div className="fm-conflict-side">
                <strong>Existing</strong>
                {c.destIsDir ? "Folder" : formatBytes(c.destSize)}
                <br />
                {formatDateFull(c.destModifiedMs)}
              </div>
              <div className="fm-conflict-side">
                <strong>New</strong>
                {c.srcIsDir ? "Folder" : formatBytes(c.srcSize)}
                <br />
                {formatDateFull(c.srcModifiedMs)}
              </div>
              {c.identical && (
                <div className="fm-conflict-note">These two look identical.</div>
              )}
              {c.mergePossible && (
                <div className="fm-conflict-note">Both are folders, so they will be merged.</div>
              )}
            </div>
          ))}
          {conflicts.length > 20 && (
            <div className="fm-conflict-note">
              …and {conflicts.length - 20} more, all handled the same way.
            </div>
          )}
        </div>

        <div className="fm-modal-actions fm-modal-actions--split">
          <button type="button" className="fm-btn" onClick={() => setPending(null)}>
            Stop
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="fm-btn" onClick={() => void resolveTransfer("skip")}>
              Skip
            </button>
            <button
              type="button"
              className="fm-btn"
              title="The existing items go to the Recycle Bin, so this can be undone"
              onClick={() => void resolveTransfer("replace")}
            >
              Replace
            </button>
            <button
              type="button"
              className="fm-btn fm-btn--primary"
              onClick={() => void resolveTransfer("keepBoth")}
            >
              Keep Both
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------------- */
/* Permanent delete confirmation                                              */
/* ------------------------------------------------------------------------- */

export function ConfirmDeleteDialog({
  paths,
  onCancel,
  onConfirm,
}: {
  paths: string[] | null;
  onCancel(): void;
  onConfirm(): void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (paths) ref.current?.focus();
  }, [paths]);

  if (!paths || paths.length === 0) return null;

  return createPortal(
    <div className="fm-modal-backdrop" role="presentation">
      <div
        className="fm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Delete permanently"
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          e.stopPropagation();
        }}
      >
        <h2>
          {paths.length === 1
            ? `Delete “${basename(paths[0])}” permanently?`
            : `Delete ${paths.length} items permanently?`}
        </h2>
        {/* The one operation with no way back, said plainly. */}
        <p>This can't be undone. The items won't go to the Recycle Bin.</p>
        <div className="fm-modal-actions">
          <button type="button" className="fm-btn" ref={ref} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="fm-btn fm-btn--danger" onClick={onConfirm}>
            Delete Permanently
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------------- */
/* Progress                                                                   */
/* ------------------------------------------------------------------------- */

function formatEta(secs: number | null): string {
  if (secs === null) return "";
  if (secs < 60) return `about ${Math.max(1, secs)} seconds remaining`;
  const mins = Math.round(secs / 60);
  return `about ${mins} minute${mins === 1 ? "" : "s"} remaining`;
}

export function ProgressPopover() {
  const { jobs, visibleJobs } = useOpsStore(
    useShallow((s) => ({ jobs: s.jobs, visibleJobs: s.visibleJobs })),
  );

  const shown = [...jobs.values()].filter((j) => visibleJobs.has(j.jobId));
  if (shown.length === 0) return null;

  return createPortal(
    <>
      {shown.slice(0, 2).map((job) => {
        const pct =
          job.bytesTotal && job.bytesTotal > 0
            ? Math.min(100, (job.bytesDone / job.bytesTotal) * 100)
            : null;
        return (
          <div className="fm-progress" key={job.jobId} role="status" aria-live="polite">
            <div className="fm-progress-title">
              <strong>{job.kind === "move" ? "Moving" : "Copying"}</strong>
              <span className="fm-progress-detail">
                {job.current ? basename(job.current) : ""}
              </span>
            </div>
            <div className="fm-progress-bar">
              <div
                className={`fm-progress-fill${pct === null ? " fm-progress-fill--indeterminate" : ""}`}
                style={pct === null ? undefined : { width: `${pct}%` }}
              />
            </div>
            <div className="fm-progress-row">
              <span className="fm-progress-detail">
                {formatBytes(job.bytesDone)}
                {job.bytesTotal ? ` of ${formatBytes(job.bytesTotal)}` : ""}
                {job.etaSecs !== null ? ` — ${formatEta(job.etaSecs)}` : ""}
              </span>
              <button type="button" className="fm-btn" onClick={() => cancelJob(job.jobId)}>
                Cancel
              </button>
            </div>
          </div>
        );
      })}
    </>,
    document.body,
  );
}

/* ------------------------------------------------------------------------- */
/* Toasts                                                                     */
/* ------------------------------------------------------------------------- */

export function Toasts() {
  const toasts = useOpsStore(useShallow((s) => s.toasts));
  const dismiss = useOpsStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;

  return createPortal(
    <div className="fm-toasts">
      {toasts.map((t: Toast) => (
        <div className="fm-toast" data-tone={t.tone} key={t.id} role="status">
          {t.tone === "error" && <Glyph name="warning" size={12} />}
          <span>{t.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <Glyph name="close" size={10} strokeWidth={1.6} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

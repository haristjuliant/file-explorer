/**
 * File-operation state: running jobs, the pending conflict decision, and the
 * label of what Ctrl+Z would undo.
 *
 * Kept apart from `useAppStore` on purpose. Progress events arrive at up to
 * 10 Hz, and the file views must never re-render because of them -- only the
 * progress popover subscribes here.
 */

import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  cancelJob as cancelJobIpc,
  preflightTransfer,
  renameEntry,
  startTransfer,
  undoPeek,
  type TransferArgs,
} from "../ipc/fs";
import { basename, join, parentOf } from "../lib/path";
import { appState } from "./appStore";
import { patchEntry, useFsStore } from "./fsStore";
import type {
  ConflictPolicy,
  FsError,
  JobFinished,
  JobProgress,
  Preflight,
  UndoLabel,
} from "../ipc/types";

/**
 * Nothing is shown for the first half second.
 *
 * Most local copies finish inside it, and putting a modal on screen for a
 * three-millisecond operation is the cheapest way to make an app feel clumsy.
 */
export const PROGRESS_DELAY_MS = 500;

export interface PendingTransfer {
  args: TransferArgs;
  preflight: Preflight;
}

export interface Toast {
  id: number;
  tone: "info" | "error";
  message: string;
}

interface OpsStore {
  jobs: Map<number, JobProgress>;
  /** Jobs that have run long enough to be worth showing. */
  visibleJobs: Set<number>;
  /** A transfer waiting on the user's conflict decision. */
  pending: PendingTransfer | null;
  undoLabel: UndoLabel | null;
  toasts: Toast[];

  setPending(p: PendingTransfer | null): void;
  refreshUndo(): Promise<void>;
  toast(tone: Toast["tone"], message: string): void;
  dismissToast(id: number): void;
  reportErrors(errors: FsError[], fallback: string): void;
}

let nextToastId = 1;

export const useOpsStore = create<OpsStore>()((set, get) => ({
  jobs: new Map(),
  visibleJobs: new Set(),
  pending: null,
  undoLabel: null,
  toasts: [],

  setPending(p) {
    set({ pending: p });
  },

  async refreshUndo() {
    try {
      set({ undoLabel: await undoPeek() });
    } catch {
      set({ undoLabel: null });
    }
  },

  toast(tone, message) {
    const id = nextToastId++;
    set({ toasts: [...get().toasts, { id, tone, message }] });
    setTimeout(() => get().dismissToast(id), tone === "error" ? 8000 : 4000);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  reportErrors(errors, fallback) {
    if (errors.length === 0) return;
    const first = errors[0].message;
    get().toast(
      "error",
      errors.length === 1 ? first : `${first} (and ${errors.length - 1} more)`,
    );
    void fallback;
  },
}));

/* ------------------------------------------------------------------------- */

const progressTimers = new Map<number, ReturnType<typeof setTimeout>>();

function upsertJob(p: JobProgress): void {
  useOpsStore.setState((s) => {
    const jobs = new Map(s.jobs);
    jobs.set(p.jobId, p);
    return { jobs };
  });

  if (progressTimers.has(p.jobId) || useOpsStore.getState().visibleJobs.has(p.jobId)) return;
  const timer = setTimeout(() => {
    progressTimers.delete(p.jobId);
    useOpsStore.setState((s) => {
      if (!s.jobs.has(p.jobId)) return s;
      const visibleJobs = new Set(s.visibleJobs);
      visibleJobs.add(p.jobId);
      return { visibleJobs };
    });
  }, PROGRESS_DELAY_MS);
  progressTimers.set(p.jobId, timer);
}

function removeJob(jobId: number): void {
  const timer = progressTimers.get(jobId);
  if (timer !== undefined) {
    clearTimeout(timer);
    progressTimers.delete(jobId);
  }
  useOpsStore.setState((s) => {
    const jobs = new Map(s.jobs);
    jobs.delete(jobId);
    const visibleJobs = new Set(s.visibleJobs);
    visibleJobs.delete(jobId);
    return { jobs, visibleJobs };
  });
}

/** Wire the backend job events. Mounted once by the app shell. */
export async function subscribeToJobs(onFinished: (f: JobFinished) => void): Promise<UnlistenFn> {
  const unlistenProgress = await listen<JobProgress>("job:progress", ({ payload }) => {
    upsertJob(payload);
  });

  const unlistenFinished = await listen<JobFinished>("job:finished", ({ payload }) => {
    removeJob(payload.jobId);
    onFinished(payload);
  });

  return () => {
    unlistenProgress();
    unlistenFinished();
  };
}

export function cancelJob(jobId: number): void {
  void cancelJobIpc(jobId).catch(() => {});
}

/**
 * Begin a transfer, pausing for a conflict decision only when there is one.
 *
 * Blockers stop the operation outright -- copying a folder into itself is not a
 * conflict to resolve, it is a request that cannot be honoured.
 */
export async function beginTransfer(args: TransferArgs): Promise<void> {
  const ops = useOpsStore.getState();
  try {
    const pf = await preflightTransfer(args);

    if (pf.blockers.length > 0) {
      ops.toast("error", describeBlocker(pf.blockers[0]));
      return;
    }
    if (pf.conflicts.length > 0) {
      ops.setPending({ args, preflight: pf });
      return;
    }
    await startTransfer({ ...args, policy: "skip" });
  } catch (e) {
    const err = e as FsError;
    ops.toast("error", err.message ?? "That operation could not be started.");
  }
}

/** Resume a transfer once the user has chosen how to resolve the conflicts. */
export async function resolveTransfer(policy: ConflictPolicy): Promise<void> {
  const ops = useOpsStore.getState();
  const pending = ops.pending;
  if (!pending) return;
  ops.setPending(null);
  try {
    await startTransfer({ ...pending.args, policy });
  } catch (e) {
    const err = e as FsError;
    ops.toast("error", err.message ?? "That operation could not be started.");
  }
}

export function describeBlocker(b: Preflight["blockers"][number]): string {
  switch (b.kind) {
    case "destinationInsideSource":
      return "A folder can't be copied into itself.";
    case "destinationIsSource":
      return "Those items are already in that folder.";
    case "sourceMissing":
      return "Some of those items no longer exist.";
    case "destinationMissing":
      return "That destination folder no longer exists.";
    case "destinationNotAFolder":
      return "The destination isn't a folder.";
    case "notEnoughSpace":
      return "There isn't enough space on the destination drive.";
  }
}

export const opsDebug = {
  reset(): void {
    for (const t of progressTimers.values()) clearTimeout(t);
    progressTimers.clear();
    nextToastId = 1;
    useOpsStore.setState({
      jobs: new Map(),
      visibleJobs: new Set(),
      pending: null,
      undoLabel: null,
      toasts: [],
    });
  },
};

/* ------------------------------------------------------------------------- */
/* Optimistic rename                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Commit an inline rename.
 *
 * Optimistic: the row is patched locally first so the name changes under the
 * cursor immediately, and the selection follows to the new path. On failure it
 * rolls back AND re-opens the editor, so fixing a bad name is one keystroke
 * away rather than a fresh hunt for the row.
 */
export async function commitRename(path: string, nextName: string): Promise<void> {
  const s = appState();
  const previousName = basename(path);
  if (nextName === previousName || nextName.trim() === "") {
    s.endRename();
    return;
  }

  const dir = parentOf(path);
  if (!dir) {
    s.endRename();
    return;
  }
  const nextPath = join(dir, nextName);
  const entry = useFsStore.getState().dirs.get(dir)?.entries.find((e) => e.name === previousName);

  patchEntry(dir, previousName, { name: nextName });
  s.setSelection([nextPath], nextPath);
  s.endRename();

  try {
    await renameEntry(path, nextName);
    await useOpsStore.getState().refreshUndo();
  } catch (e) {
    // Roll back to exactly what was there, then re-arm the editor.
    if (entry) patchEntry(dir, nextName, { name: previousName });
    s.setSelection([path], path);
    const err = e as FsError;
    useOpsStore.getState().toast("error", err.message ?? "That item could not be renamed.");
    s.beginRename(path);
  }
}

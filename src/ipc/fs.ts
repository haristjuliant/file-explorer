/**
 * Typed `invoke` wrappers -- the ONLY place paths cross the IPC boundary.
 *
 * Everything going out is canonicalized; everything coming back is asserted
 * canonical in dev. That single choke point is what keeps path identity (the
 * key for every cache, Set and watcher) from fragmenting.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import { assertCanonical, normalize } from "../lib/path";
import {
  asFsError,
  type DirPage,
  type DriveInfo,
  type FileMeta,
  type KnownFolders,
  type ConflictPolicy,
  type DirEntry,
  type JobProgress,
  type Preflight,
  type PreviewPlan,
  type SearchRequest,
  type TextHead,
  type ThumbResult,
  type TransferMode,
  type UndoLabel,
  type UndoOutcome,
} from "./types";

/** Wrap `invoke` so every rejection is a typed `FsError`, never a bare string. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw asFsError(e);
  }
}

export async function readDir(dir: string, limit?: number): Promise<DirPage> {
  const page = await call<DirPage>("read_dir", {
    req: { dir: normalize(dir), limit: limit ?? null },
  });
  assertCanonical(page.dir);
  return page;
}

/** Lazy disclosure-triangle resolution. Never call this in bulk. */
export function hasChildren(dir: string): Promise<boolean> {
  return call<boolean>("has_children", { dir: normalize(dir) });
}

export async function stat(path: string): Promise<FileMeta> {
  const meta = await call<FileMeta>("stat", { path: normalize(path) });
  assertCanonical(meta.path);
  return meta;
}

export async function listDrives(): Promise<DriveInfo[]> {
  const drives = await call<DriveInfo[]>("list_drives");
  for (const d of drives) assertCanonical(d.root);
  return drives;
}

export function knownFolders(): Promise<KnownFolders> {
  return call<KnownFolders>("known_folders");
}

export function openPath(path: string): Promise<void> {
  return call<void>("open_path", { path: normalize(path) });
}

export function revealInExplorer(path: string): Promise<void> {
  return call<void>("reveal_in_explorer", { path: normalize(path) });
}

/* ------------------------------------------------------------------------- */
/* Preview                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Turn a plain path into an `asset:` URL the WebView can load.
 *
 * Only ever called on paths returned by a preview command, because those have
 * already had their directory granted to the asset protocol. Building a URL for
 * an ungranted path yields a request that is silently blocked, showing an empty
 * box and logging nothing anywhere.
 */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

export function previewPlan(
  path: string,
  maxPx: number,
  allowHydrate = false,
): Promise<PreviewPlan> {
  return call<PreviewPlan>("preview_plan", {
    path: normalize(path),
    maxPx,
    allowHydrate,
  });
}

export function readTextHead(path: string, maxBytes?: number): Promise<TextHead> {
  return call<TextHead>("read_text_head", { path: normalize(path), maxBytes: maxBytes ?? null });
}

export function thumbnail(path: string, size: number): Promise<ThumbResult> {
  return call<ThumbResult>("thumbnail", { path: normalize(path), size });
}

/** Fire and forget: warms the cache either side of the Quick Look cursor. */
export function prefetchThumbnails(paths: string[], size: number): Promise<void> {
  return call<void>("prefetch_thumbnails", { paths: paths.map(normalize), size });
}

/* ------------------------------------------------------------------------- */
/* File operations                                                            */
/* ------------------------------------------------------------------------- */

export function createFolder(parent: string, name?: string): Promise<DirEntry> {
  return call<DirEntry>("create_folder", { parent: normalize(parent), name: name ?? null });
}

export function renameEntry(path: string, newName: string): Promise<string> {
  return call<string>("rename_entry", { path: normalize(path), newName });
}

/** Returns the directories the caller should refresh. */
export function trashEntries(paths: string[]): Promise<string[]> {
  return call<string[]>("trash_entries", { paths: paths.map(normalize) });
}

/**
 * Permanent deletion. The token is a deliberate speed bump: this is the one
 * operation with no way back.
 */
export function deletePermanently(paths: string[]): Promise<string[]> {
  return call<string[]>("delete_permanently", {
    paths: paths.map(normalize),
    confirmToken: "PERMANENT",
  });
}

export interface TransferArgs {
  sources: string[];
  destDir: string;
  mode: TransferMode;
  policy?: ConflictPolicy;
  overrides?: Record<string, ConflictPolicy>;
}

export function preflightTransfer(args: TransferArgs): Promise<Preflight> {
  return call<Preflight>("preflight_transfer", {
    args: { ...args, sources: args.sources.map(normalize), destDir: normalize(args.destDir) },
  });
}

/** Returns the job id; progress arrives on `job:progress`. */
export function startTransfer(args: TransferArgs): Promise<number> {
  return call<number>("start_transfer", {
    args: { ...args, sources: args.sources.map(normalize), destDir: normalize(args.destDir) },
  });
}

export function duplicateEntries(paths: string[]): Promise<string[]> {
  return call<string[]>("duplicate_entries", { paths: paths.map(normalize) });
}

export function cancelJob(jobId: number): Promise<void> {
  return call<void>("cancel_job", { jobId });
}

export function activeJobs(): Promise<JobProgress[]> {
  return call<JobProgress[]>("active_jobs");
}

export function undoPeek(): Promise<UndoLabel | null> {
  return call<UndoLabel | null>("undo_peek");
}

export function undo(): Promise<UndoOutcome> {
  return call<UndoOutcome>("undo");
}

export function watchDir(dir: string): Promise<void> {
  return call<void>("watch_dir", { dir: normalize(dir) });
}

export function unwatchDir(dir: string): Promise<void> {
  return call<void>("unwatch_dir", { dir: normalize(dir) });
}

/* ------------------------------------------------------------------------- */
/* Search                                                                     */
/* ------------------------------------------------------------------------- */

/** Returns the job id; results stream in on `search:batch`. */
export function startSearch(req: SearchRequest): Promise<number> {
  return call<number>("start_search", { req: { ...req, root: normalize(req.root) } });
}

export function cancelSearch(jobId: number): Promise<void> {
  return call<void>("cancel_search", { jobId });
}

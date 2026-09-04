/**
 * Mirror of `src-tauri/src/ipc.rs`. Keep the two in sync -- there is one Rust
 * file and one TypeScript file, deliberately, so a drift is a two-file diff.
 */

/** Attribute bit flags. Mirrors `ipc::attr` in Rust. */
export const Attr = {
  Hidden: 1 << 0,
  System: 1 << 1,
  ReadOnly: 1 << 2,
  Symlink: 1 << 3,
  Junction: 1 << 4,
  CloudStub: 1 << 5,
  Offline: 1 << 6,
  Compressed: 1 << 7,
  Encrypted: 1 << 8,
  Sparse: 1 << 9,
  Reparse: 1 << 10,
} as const;

export const hasFlag = (flags: number, f: number): boolean => (flags & f) !== 0;

/**
 * True when this entry must never be opened for preview or thumbnailing.
 * Opening a OneDrive placeholder triggers a synchronous download of a
 * possibly-gigabyte file.
 */
export const isStalling = (flags: number): boolean =>
  hasFlag(flags, Attr.CloudStub | Attr.Offline | Attr.Reparse | Attr.Junction);

export type Category =
  | "folder"
  | "volume"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "code"
  | "archive"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "font"
  | "executable"
  | "shortcut"
  | "disk"
  | "package"
  | "unknown";

/**
 * One directory entry as it arrives from Rust.
 *
 * Note there is no `path`: the page carries `dir` once and the frontend joins.
 * Use `entryPath(dir, entry)` from `lib/path.ts` -- never string-concatenate.
 */
export interface DirEntry {
  name: string;
  isDir: boolean;
  flags: number;
  /** 0 for directories. */
  size: number;
  /** Unix epoch milliseconds, UTC. */
  modifiedMs: number;
  /** Lowercase, no leading dot. Empty for directories and extensionless files. */
  ext: string;
  category: Category;
}

export interface DirPage {
  /** Canonical display form -- never carries a verbatim prefix. */
  dir: string;
  entries: DirEntry[];
  /** Full count even when `entries` was truncated. */
  total: number;
  truncated: boolean;
  elapsedMs: number;
  warnings: FsError[];
}

export type DriveKind = "fixed" | "removable" | "network" | "cdRom" | "ramDisk" | "unknown";

export interface DriveInfo {
  /** `"C:\\"` */
  root: string;
  label: string;
  filesystem: string;
  driveType: DriveKind;
  totalBytes: number;
  freeBytes: number;
  /** False for an empty optical drive or a disconnected network mapping. */
  ready: boolean;
  isSystem: boolean;
}

export interface KnownFolders {
  home: string | null;
  desktop: string | null;
  documents: string | null;
  downloads: string | null;
  pictures: string | null;
  music: string | null;
  videos: string | null;
  oneDrive: string | null;
}

export interface FileMeta {
  path: string;
  name: string;
  isDir: boolean;
  flags: number;
  size: number;
  createdMs: number;
  modifiedMs: number;
  accessedMs: number;
  ext: string;
  category: Category;
  linkTarget: string | null;
}

export type ErrCode =
  | "notFound"
  | "accessDenied"
  | "alreadyExists"
  | "invalidName"
  | "reservedName"
  | "notADirectory"
  | "isADirectory"
  | "notEmpty"
  | "diskFull"
  | "deviceNotReady"
  | "networkUnavailable"
  | "pathTooLong"
  | "cancelled"
  | "unsupported"
  | "restoreCollision"
  | "trashUnavailable"
  | "decodeFailed"
  | "timeout"
  | "internal";

export interface FsError {
  code: ErrCode;
  message: string;
  path: string | null;
  osError: number | null;
}

/** Narrow an unknown rejection from `invoke` into an `FsError`. */
export function asFsError(e: unknown): FsError {
  if (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    "message" in e &&
    typeof (e as { message: unknown }).message === "string"
  ) {
    return e as FsError;
  }
  return {
    code: "internal",
    message: typeof e === "string" ? e : "An unexpected error occurred.",
    path: null,
    osError: null,
  };
}

/* ------------------------------------------------------------------------- */
/* Preview                                                                    */
/* ------------------------------------------------------------------------- */

export type NoPreviewReason =
  | "notDownloaded"
  | "codecUnsupported"
  | "unsupportedFormat"
  | "tooLarge"
  | "decodeFailed"
  | "noAccess";

export interface TextHead {
  text: string;
  bytesRead: number;
  truncated: boolean;
  encoding: string;
  isBinary: boolean;
  lineCount: number;
}

/**
 * How to preview one file, decided by the backend.
 *
 * Every `path` is a plain filesystem path whose directory has ALREADY been
 * granted to the asset protocol by the backend. Convert it with `assetUrl()`
 * before putting it in a `src`.
 */
export type PreviewPlan =
  | { mode: "image"; path: string; width: number; height: number; bytes: number }
  | {
      mode: "imageThumb";
      path: string;
      width: number;
      height: number;
      sourceWidth: number;
      sourceHeight: number;
    }
  | { mode: "video"; path: string; mime: string; poster: string | null }
  | { mode: "audio"; path: string; mime: string }
  | { mode: "pdf"; path: string }
  | { mode: "text"; head: TextHead }
  | { mode: "folder"; childCount: number | null }
  | { mode: "none"; reason: NoPreviewReason };

export interface ThumbResult {
  path: string;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------------- */
/* File operations                                                            */
/* ------------------------------------------------------------------------- */

export type TransferMode = "copy" | "move";

export type ConflictPolicy =
  | "ask"
  /** The existing item goes to the Recycle Bin first, so this is undoable. */
  | "replace"
  /** Overwrite in place: faster, and NOT undoable. */
  | "replaceInPlace"
  | "skip"
  | "keepBoth"
  | "replaceIfNewer";

export type Blocker =
  | { kind: "destinationInsideSource"; source: string }
  | { kind: "destinationIsSource"; source: string }
  | { kind: "sourceMissing"; source: string }
  | { kind: "destinationMissing" }
  | { kind: "destinationNotAFolder" }
  | { kind: "notEnoughSpace"; needed: number; available: number };

export interface Conflict {
  src: string;
  dest: string;
  name: string;
  srcIsDir: boolean;
  destIsDir: boolean;
  srcSize: number;
  destSize: number;
  srcModifiedMs: number;
  destModifiedMs: number;
  identical: boolean;
  /** Both sides are folders, so replacing means merging. */
  mergePossible: boolean;
  suggestedKeepBothName: string;
}

export interface Preflight {
  sourceCount: number;
  totalBytes: number;
  conflicts: Conflict[];
  /** Hard problems that stop the operation rather than being resolved. */
  blockers: Blocker[];
  destFreeBytes: number;
  sameVolume: boolean;
  /** A same-volume move is a rename: effectively instantaneous. */
  instant: boolean;
}

export type JobKind = "copy" | "move" | "delete" | "duplicate";
export type JobStatus = "completed" | "cancelled" | "failed";

export interface JobProgress {
  jobId: number;
  kind: JobKind;
  itemsDone: number;
  itemsTotal: number | null;
  bytesDone: number;
  bytesTotal: number | null;
  current: string | null;
  bytesPerSec: number;
  etaSecs: number | null;
  errorsSoFar: number;
}

export interface JobFinished {
  jobId: number;
  kind: JobKind;
  status: JobStatus;
  itemsDone: number;
  bytesDone: number;
  elapsedMs: number;
  replaced: number;
  skipped: number;
  renamed: number;
  errors: FsError[];
  errorsTruncated: boolean;
  errorCount: number;
  touchedDirs: string[];
  undoLabel: string | null;
}

export interface UndoLabel {
  label: string;
  undoable: boolean;
  reason: string | null;
}

export interface UndoOutcome {
  label: string;
  touchedDirs: string[];
  errors: FsError[];
}

/** Emitted by the watcher after coalescing. */
export interface FsChange {
  dirs: string[];
  /** Watched directories that have themselves disappeared. */
  gone: string[];
  /** Events were lost; re-read regardless of the dirs list. */
  rescan: boolean;
}

/* ------------------------------------------------------------------------- */
/* Search                                                                     */
/* ------------------------------------------------------------------------- */

export type MatchMode = "substring" | "glob";

export interface SearchRequest {
  root: string;
  query: string;
  matchMode?: MatchMode;
  caseSensitive?: boolean;
  maxDepth?: number | null;
  includeHidden?: boolean;
  maxHits?: number | null;
}

export interface SearchHit {
  /** The directory holding the item, so the UI can show a relative path. */
  dir: string;
  entry: DirEntry;
}

export interface SearchBatch {
  jobId: number;
  hits: SearchHit[];
  scannedDirs: number;
  scannedEntries: number;
  hitTotal: number;
  hitCapReached: boolean;
  done: boolean;
  cancelled: boolean;
}

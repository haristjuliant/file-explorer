//! The copy and move engine.
//!
//! Deliberately a pure function of `(sources, dest, policy, cancel)` with a
//! progress callback and no UI, no Tauri types and no channels. That is what
//! makes the one subsystem capable of destroying user data exercisable against
//! a real temp tree, which is the only way to have any confidence in it.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::error::{ErrCode, FsError};

use super::conflicts::{require_resolved, same_volume, ConflictPolicy, TransferMode};
use super::names;

/// Files at or below this size go through `std::fs::copy`, which on Windows is
/// `CopyFileExW` and takes the kernel's fast path. Larger files are chunked so
/// they can report progress and be cancelled part-way.
const SMALL_FILE_MAX: u64 = 8 * 1024 * 1024;
const CHUNK: usize = 1024 * 1024;
/// Errors beyond this are counted but not carried, so one unreadable subtree
/// cannot produce a hundred-megabyte outcome payload.
const MAX_ERRORS: usize = 100;

pub struct TransferRequest {
    pub sources: Vec<PathBuf>,
    pub dest: PathBuf,
    pub mode: TransferMode,
    pub policy: ConflictPolicy,
    /// Per-source overrides chosen in the conflict dialog, keyed by source path.
    pub overrides: HashMap<String, ConflictPolicy>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Progress {
    pub items_done: u64,
    pub bytes_done: u64,
}

#[derive(Debug, Default)]
pub struct TransferOutcome {
    pub items_done: u64,
    pub bytes_done: u64,
    pub replaced: u64,
    pub skipped: u64,
    pub renamed: u64,
    pub cancelled: bool,
    pub errors: Vec<FsError>,
    pub errors_truncated: bool,
    pub error_count: u64,
    /// Everything this job created, for undoing a copy.
    pub created_files: Vec<PathBuf>,
    pub created_dirs: Vec<PathBuf>,
    /// Every (from, to) pair, for undoing a move.
    pub moved: Vec<(PathBuf, PathBuf)>,
    /// Items sent to the Recycle Bin to make room, for undoing a replace.
    pub trashed: Vec<PathBuf>,
    pub touched_dirs: Vec<PathBuf>,
}

impl TransferOutcome {
    fn record_error(&mut self, e: FsError) {
        self.error_count += 1;
        if self.errors.len() < MAX_ERRORS {
            self.errors.push(e);
        } else {
            self.errors_truncated = true;
        }
    }
}

struct Ctx<'a> {
    cancel: &'a AtomicBool,
    on_progress: &'a mut dyn FnMut(Progress),
    progress: Progress,
}

impl Ctx<'_> {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    fn add_bytes(&mut self, n: u64) {
        self.progress.bytes_done += n;
        (self.on_progress)(self.progress);
    }

    fn finish_item(&mut self) {
        self.progress.items_done += 1;
        (self.on_progress)(self.progress);
    }
}

pub fn run(
    req: TransferRequest,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<TransferOutcome, FsError> {
    require_resolved(req.policy)?;

    let mut out = TransferOutcome::default();
    out.touched_dirs.push(req.dest.clone());

    let mut ctx = Ctx { cancel, on_progress, progress: Progress::default() };

    for src in &req.sources {
        if ctx.cancelled() {
            out.cancelled = true;
            break;
        }

        let policy = req
            .overrides
            .get(&crate::paths::to_display(src))
            .copied()
            .unwrap_or(req.policy);

        if let Some(parent) = src.parent() {
            let p = parent.to_path_buf();
            if !out.touched_dirs.contains(&p) {
                out.touched_dirs.push(p);
            }
        }

        if let Err(e) = transfer_one(src, &req.dest, req.mode, policy, &mut ctx, &mut out) {
            out.record_error(e);
        }
    }

    out.items_done = ctx.progress.items_done;
    out.bytes_done = ctx.progress.bytes_done;
    if ctx.cancelled() {
        out.cancelled = true;
    }
    Ok(out)
}

/// Decide the destination path for one source, applying the conflict policy.
///
/// Returns `None` when the item should be skipped.
fn resolve_target(
    src: &Path,
    dest_dir: &Path,
    policy: ConflictPolicy,
    out: &mut TransferOutcome,
) -> Result<Option<PathBuf>, FsError> {
    let name = src
        .file_name()
        .ok_or_else(|| FsError::new(ErrCode::InvalidName, "That item has no name.").with_path(src))?
        .to_string_lossy()
        .into_owned();

    let target = dest_dir.join(&name);
    let existing = std::fs::symlink_metadata(&target);
    if existing.is_err() {
        return Ok(Some(target));
    }
    let existing = match existing {
        Ok(md) => md,
        Err(e) => return Err(FsError::from_io(&e, &target)),
    };

    // Two folders merge rather than collide: the contents are walked and each
    // inner collision is resolved by the same policy.
    let src_is_dir = std::fs::symlink_metadata(src).map(|m| m.is_dir()).unwrap_or(false);
    if src_is_dir && existing.is_dir() {
        return Ok(Some(target));
    }

    match policy {
        ConflictPolicy::Ask => Err(FsError::new(
            ErrCode::Unsupported,
            "The conflict policy must be resolved before the transfer starts.",
        )),
        ConflictPolicy::Skip => {
            out.skipped += 1;
            Ok(None)
        }
        ConflictPolicy::KeepBoth => {
            let free = names::keep_both_name(dest_dir, &name)?;
            out.renamed += 1;
            Ok(Some(dest_dir.join(free)))
        }
        ConflictPolicy::ReplaceIfNewer => {
            use std::os::windows::fs::MetadataExt;
            let src_md = std::fs::symlink_metadata(src).map_err(|e| FsError::from_io(&e, src))?;
            let newer = super::attrs::filetime_to_ms(src_md.last_write_time())
                > super::attrs::filetime_to_ms(existing.last_write_time()) + 2_000;
            if newer {
                trash_victim(&target, out)?;
                out.replaced += 1;
                Ok(Some(target))
            } else {
                out.skipped += 1;
                Ok(None)
            }
        }
        ConflictPolicy::Replace => {
            // The victim goes to the Recycle Bin FIRST. That costs one trash
            // call and turns the most destructive operation in a file manager
            // into a recoverable one.
            trash_victim(&target, out)?;
            out.replaced += 1;
            Ok(Some(target))
        }
        ConflictPolicy::ReplaceInPlace => {
            // Overwritten bytes are gone. The dialog offering this says so.
            if existing.is_dir() {
                std::fs::remove_dir_all(&target).map_err(|e| FsError::from_io(&e, &target))?;
            } else {
                std::fs::remove_file(&target).map_err(|e| FsError::from_io(&e, &target))?;
            }
            out.replaced += 1;
            Ok(Some(target))
        }
    }
}

fn trash_victim(target: &Path, out: &mut TransferOutcome) -> Result<(), FsError> {
    trash::delete(target).map_err(|e| {
        FsError::new(
            ErrCode::TrashUnavailable,
            format!("The existing item could not be moved to the Recycle Bin: {e}"),
        )
        .with_path(target)
    })?;
    out.trashed.push(target.to_path_buf());
    Ok(())
}

fn transfer_one(
    src: &Path,
    dest_dir: &Path,
    mode: TransferMode,
    policy: ConflictPolicy,
    ctx: &mut Ctx<'_>,
    out: &mut TransferOutcome,
) -> Result<(), FsError> {
    let Some(target) = resolve_target(src, dest_dir, policy, out)? else {
        return Ok(());
    };

    let md = std::fs::symlink_metadata(src).map_err(|e| FsError::from_io(&e, src))?;

    if mode == TransferMode::Move && same_volume(src, dest_dir) {
        // A same-volume move is a rename: no bytes travel at all.
        match std::fs::rename(src, &target) {
            Ok(()) => {
                out.moved.push((src.to_path_buf(), target.clone()));
                ctx.finish_item();
                return Ok(());
            }
            // Fall through to copy-then-delete: a rename across mount points
            // inside one drive letter still fails with a cross-device error.
            Err(e) if e.raw_os_error() == Some(17) => {}
            Err(e) => return Err(FsError::from_io(&e, src)),
        }
    }

    if md.is_dir() {
        copy_dir(src, &target, policy, ctx, out)?;
    } else {
        copy_file(src, &target, ctx, out)?;
    }

    if mode == TransferMode::Move && !ctx.cancelled() {
        // Only remove the source once the copy is complete; a cancelled move
        // must never delete anything.
        let removed = if md.is_dir() {
            std::fs::remove_dir_all(src)
        } else {
            std::fs::remove_file(src)
        };
        match removed {
            Ok(()) => out.moved.push((src.to_path_buf(), target)),
            Err(e) => out.record_error(FsError::from_io(&e, src)),
        }
    }
    Ok(())
}

fn copy_dir(
    src: &Path,
    target: &Path,
    policy: ConflictPolicy,
    ctx: &mut Ctx<'_>,
    out: &mut TransferOutcome,
) -> Result<(), FsError> {
    if ctx.cancelled() {
        return Ok(());
    }

    let existed = target.is_dir();
    std::fs::create_dir_all(target).map_err(|e| FsError::from_io(&e, target))?;
    if !existed {
        out.created_dirs.push(target.to_path_buf());
    }

    let entries = std::fs::read_dir(src).map_err(|e| FsError::from_io(&e, src))?;
    for entry in entries {
        if ctx.cancelled() {
            return Ok(());
        }
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                out.record_error(FsError::from_io(&e, src));
                continue;
            }
        };

        let child = entry.path();
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(e) => {
                out.record_error(FsError::from_io(&e, &child));
                continue;
            }
        };

        // Never follow a reparse point while recursing. This is the only thing
        // between "copy my home folder" and an endless loop through the legacy
        // AppData junctions.
        use std::os::windows::fs::MetadataExt;
        if super::attrs::decode(md.file_attributes()) & crate::ipc::attr::REPARSE != 0 {
            continue;
        }

        let name = entry.file_name();
        let child_target = target.join(&name);

        let result = if md.is_dir() {
            copy_dir(&child, &child_target, policy, ctx, out)
        } else {
            // A deep collision inside a merged folder is resolved silently by
            // the job policy and reported in the outcome counts.
            match resolve_deep_target(&child, &child_target, policy, out)? {
                Some(t) => copy_file(&child, &t, ctx, out),
                None => Ok(()),
            }
        };
        if let Err(e) = result {
            out.record_error(e);
        }
    }
    Ok(())
}

/// Deep-collision resolution, sharing the policy but not the pre-flight.
fn resolve_deep_target(
    src: &Path,
    target: &Path,
    policy: ConflictPolicy,
    out: &mut TransferOutcome,
) -> Result<Option<PathBuf>, FsError> {
    if !target.exists() {
        return Ok(Some(target.to_path_buf()));
    }
    let Some(dir) = target.parent() else {
        return Ok(Some(target.to_path_buf()));
    };
    resolve_target(src, dir, policy, out)
}

fn copy_file(
    src: &Path,
    target: &Path,
    ctx: &mut Ctx<'_>,
    out: &mut TransferOutcome,
) -> Result<(), FsError> {
    if ctx.cancelled() {
        return Ok(());
    }

    let md = std::fs::symlink_metadata(src).map_err(|e| FsError::from_io(&e, src))?;
    let size = md.len();

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| FsError::from_io(&e, parent))?;
    }

    if size <= SMALL_FILE_MAX {
        std::fs::copy(src, target).map_err(|e| FsError::from_io(&e, src))?;
        out.created_files.push(target.to_path_buf());
        ctx.add_bytes(size);
        ctx.finish_item();
        return Ok(());
    }

    // Large file: chunked, so it reports progress and can be cancelled part-way.
    let mut reader = std::fs::File::open(src).map_err(|e| FsError::from_io(&e, src))?;
    let mut writer = std::fs::File::create(target).map_err(|e| FsError::from_io(&e, target))?;
    let mut buf = vec![0u8; CHUNK];

    loop {
        if ctx.cancelled() {
            // A cancelled copy leaves a partial file behind unless we remove
            // it. Nothing else will.
            drop(writer);
            let _ = std::fs::remove_file(target);
            return Ok(());
        }
        let read = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                drop(writer);
                let _ = std::fs::remove_file(target);
                return Err(FsError::from_io(&e, src));
            }
        };
        if let Err(e) = writer.write_all(&buf[..read]) {
            drop(writer);
            let _ = std::fs::remove_file(target);
            return Err(FsError::from_io(&e, target));
        }
        ctx.add_bytes(read as u64);
    }

    writer.flush().map_err(|e| FsError::from_io(&e, target))?;
    out.created_files.push(target.to_path_buf());
    ctx.finish_item();
    Ok(())
}

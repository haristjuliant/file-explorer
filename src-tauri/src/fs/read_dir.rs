//! The directory read hot loop.
//!
//! On Windows `std::fs::read_dir` is backed by `FindFirstFileW`/`FindNextFileW`,
//! which return a `WIN32_FIND_DATAW` per entry already containing the name,
//! attributes, all three FILETIMEs and the 64-bit size. So `entry.metadata()`
//! and `entry.file_type()` cost NO syscall here -- std documents that it reuses
//! the enumeration data.
//!
//! What is expensive and therefore absent from this loop:
//!   * `fs::metadata(entry.path())` -- 1 open + 1 query, and it follows links
//!   * `path.canonicalize()`        -- 1 open + GetFinalPathNameByHandleW
//!   * probing subdirectories for children -- 1 open + 1 enumerate EACH
//!
//! Throughput on NTFS/NVMe is roughly 250-500k entries/s; the bottleneck is
//! UTF-16 -> UTF-8 conversion and allocation, not I/O.

use std::os::windows::fs::{FileTypeExt, MetadataExt};
use std::path::Path;
use std::time::Instant;

use crate::error::FsError;
use crate::ipc::{attr, DirEntry, DirPage, FileMeta, ReadDirRequest, DEFAULT_LIMIT};

pub fn run(req: ReadDirRequest) -> Result<DirPage, FsError> {
    let started = Instant::now();
    let dir = crate::paths::validate_dir(&req.dir)?;
    let rd = std::fs::read_dir(&dir).map_err(|e| FsError::from_io(&e, &dir))?;

    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).min(DEFAULT_LIMIT);
    let mut entries: Vec<DirEntry> = Vec::with_capacity(limit.min(4096));
    let mut warnings: Vec<FsError> = Vec::new();
    let mut total = 0usize;

    for res in rd {
        let ent = match res {
            Ok(e) => e,
            // A single bad entry -- deleted mid-enumeration, ACL weirdness --
            // must never abort the whole read. Record a few and carry on.
            Err(e) => {
                if warnings.len() < 16 {
                    warnings.push(FsError::from_io(&e, &dir));
                }
                continue;
            }
        };

        let md = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let raw = md.file_attributes();
        let is_dir = super::attrs::is_dir(raw);
        let mut flags = super::attrs::decode(raw);

        // Symlink vs plain reparse point, from the free file_type().
        if let Ok(ft) = ent.file_type() {
            if ft.is_symlink_dir() || ft.is_symlink_file() {
                flags |= attr::SYMLINK;
            } else if flags & attr::REPARSE != 0 && is_dir {
                // A directory reparse point that is not a symlink is, in
                // practice, a mount point / junction.
                flags |= attr::JUNCTION;
            }
        }

        let name = ent.file_name().to_string_lossy().into_owned();
        if super::attrs::is_dotfile(&name) {
            flags |= attr::HIDDEN;
        }

        total += 1;
        // Past the cap we keep counting so the UI can say "50,000 of 137,412",
        // but stop allocating.
        if entries.len() >= limit {
            continue;
        }

        let ext = super::category::ext_of(&name, is_dir);
        let category = super::category::of(is_dir, &ext, flags);

        entries.push(DirEntry {
            size: if is_dir { 0 } else { md.file_size() },
            modified_ms: super::attrs::filetime_to_ms(md.last_write_time()),
            name,
            is_dir,
            flags,
            ext,
            category,
        });
    }

    Ok(DirPage {
        dir: crate::paths::to_display(&dir),
        truncated: total > entries.len(),
        total,
        entries,
        elapsed_ms: u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX),
        warnings,
    })
}

/// Lazy single-shot: "does this directory contain at least one entry?"
///
/// Only ever called on demand (tree hover), never in bulk. Access denied maps
/// to `false` -- no disclosure triangle -- which is what Explorer does.
pub fn has_children(dir: &Path) -> bool {
    match std::fs::read_dir(dir) {
        Ok(mut rd) => rd.next().is_some(),
        Err(_) => false,
    }
}

/// Full metadata for one item. Here the extra syscalls are affordable, so this
/// is where creation/access time and reparse-target resolution happen.
pub fn stat(path: &Path) -> Result<FileMeta, FsError> {
    // symlink_metadata: describe the link itself, not its target.
    let md = std::fs::symlink_metadata(path).map_err(|e| FsError::from_io(&e, path))?;
    let raw = md.file_attributes();
    let is_dir = super::attrs::is_dir(raw);
    let mut flags = super::attrs::decode(raw);

    let ft = md.file_type();
    if ft.is_symlink_dir() || ft.is_symlink_file() {
        flags |= attr::SYMLINK;
    } else if flags & attr::REPARSE != 0 && is_dir {
        flags |= attr::JUNCTION;
    }

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        // A drive root has no file_name; show "C:\" itself.
        .unwrap_or_else(|| crate::paths::to_display(path));

    if super::attrs::is_dotfile(&name) {
        flags |= attr::HIDDEN;
    }

    let link_target = if flags & (attr::SYMLINK | attr::JUNCTION) != 0 {
        std::fs::read_link(path).ok().map(|t| crate::paths::to_display(&t))
    } else {
        None
    };

    let ext = super::category::ext_of(&name, is_dir);
    let category = super::category::of(is_dir, &ext, flags);

    Ok(FileMeta {
        path: crate::paths::to_display(path),
        size: if is_dir { 0 } else { md.file_size() },
        created_ms: super::attrs::filetime_to_ms(md.creation_time()),
        modified_ms: super::attrs::filetime_to_ms(md.last_write_time()),
        accessed_ms: super::attrs::filetime_to_ms(md.last_access_time()),
        name,
        is_dir,
        flags,
        ext,
        category,
        link_target,
    })
}

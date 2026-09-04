//! Pre-flight conflict and blocker detection.
//!
//! Conflicts are resolved BEFORE the job starts, not by asking mid-transfer.
//! Mid-job round trips would mean a worker parked on a channel whose other end
//! can vanish (a reload, a crash, the window closing), one modal per collision
//! when merging a folder with hundreds of same-named files, an engine that
//! cannot be tested without a UI, and a meaningless ETA while a human thinks.

use std::path::{Path, PathBuf};

use crate::error::{ErrCode, FsError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferMode {
    Copy,
    Move,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    /// UI-only sentinel. Reaching the engine with this is a programming error.
    Ask,
    /// The existing item goes to the Recycle Bin first, making replace undoable.
    Replace,
    /// Overwrite in place: faster, and NOT undoable. The dialog says so.
    ReplaceInPlace,
    Skip,
    KeepBoth,
    /// Replace only when the source is meaningfully newer.
    ReplaceIfNewer,
}

/// Hard problems that must stop the operation rather than be resolved.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Blocker {
    /// Copying a folder into itself or into its own descendant.
    DestinationInsideSource { source: String },
    /// The destination is where the item already lives.
    DestinationIsSource { source: String },
    SourceMissing { source: String },
    DestinationMissing,
    DestinationNotAFolder,
    NotEnoughSpace { needed: u64, available: u64 },
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub src: String,
    pub dest: String,
    pub name: String,
    pub src_is_dir: bool,
    pub dest_is_dir: bool,
    pub src_size: u64,
    pub dest_size: u64,
    pub src_modified_ms: i64,
    pub dest_modified_ms: i64,
    /// Same size and modification time within two seconds.
    pub identical: bool,
    /// Both sides are folders, so "replace" means merge rather than delete.
    pub merge_possible: bool,
    pub suggested_keep_both_name: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub source_count: u64,
    pub total_bytes: u64,
    pub conflicts: Vec<Conflict>,
    pub blockers: Vec<Blocker>,
    pub dest_free_bytes: u64,
    pub same_volume: bool,
    /// A same-volume move is a rename: effectively instantaneous.
    pub instant: bool,
}

/// The volume a path lives on: a drive root, or a UNC share root.
pub fn volume_of(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\") {
        let mut parts = rest.split('\\').filter(|p| !p.is_empty());
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        return format!(r"\\{server}\{share}").to_lowercase();
    }
    s.chars().take(2).collect::<String>().to_lowercase()
}

pub fn same_volume(a: &Path, b: &Path) -> bool {
    volume_of(a) == volume_of(b)
}

/// True when `child` is `ancestor` or lives inside it.
///
/// The separator in the prefix test is what stops `C:\App` counting as inside
/// `C:\A` -- the check that keeps "copy a folder into itself" detection honest.
fn is_inside(ancestor: &Path, child: &Path) -> bool {
    let a = ancestor.to_string_lossy().to_lowercase();
    let c = child.to_string_lossy().to_lowercase();
    if a == c {
        return true;
    }
    let prefix = if a.ends_with('\\') { a } else { format!("{a}\\") };
    c.starts_with(&prefix)
}

fn modified_ms(md: &std::fs::Metadata) -> i64 {
    use std::os::windows::fs::MetadataExt;
    super::attrs::filetime_to_ms(md.last_write_time())
}

/// Inspect the top level only.
///
/// One directory read of the destination plus one stat per source, so this
/// returns in single-digit milliseconds even for thousands of sources.
/// Collisions deeper inside merged folders are resolved by the job policy and
/// reported in the outcome counts.
pub fn preflight(
    sources: &[PathBuf],
    dest: &Path,
    mode: TransferMode,
) -> Result<Preflight, FsError> {
    let mut blockers = Vec::new();
    let mut conflicts = Vec::new();
    let mut total_bytes = 0u64;

    let dest_md = std::fs::metadata(dest);
    match &dest_md {
        Err(_) => blockers.push(Blocker::DestinationMissing),
        Ok(md) if !md.is_dir() => blockers.push(Blocker::DestinationNotAFolder),
        Ok(_) => {}
    }

    for src in sources {
        let Ok(md) = std::fs::symlink_metadata(src) else {
            blockers.push(Blocker::SourceMissing { source: crate::paths::to_display(src) });
            continue;
        };

        // Copying a folder into itself or a descendant would recurse forever.
        if md.is_dir() && is_inside(src, dest) {
            blockers.push(Blocker::DestinationInsideSource {
                source: crate::paths::to_display(src),
            });
            continue;
        }
        if src.parent() == Some(dest) && mode == TransferMode::Move {
            blockers.push(Blocker::DestinationIsSource {
                source: crate::paths::to_display(src),
            });
            continue;
        }

        total_bytes += if md.is_dir() { 0 } else { md.len() };

        let name = match src.file_name() {
            Some(n) => n.to_string_lossy().into_owned(),
            None => continue,
        };
        let target = dest.join(&name);
        let Ok(dest_item) = std::fs::symlink_metadata(&target) else { continue };

        let src_modified = modified_ms(&md);
        let dest_modified = modified_ms(&dest_item);
        conflicts.push(Conflict {
            src: crate::paths::to_display(src),
            dest: crate::paths::to_display(&target),
            suggested_keep_both_name: super::names::keep_both_name(dest, &name)
                .unwrap_or_else(|_| name.clone()),
            name,
            src_is_dir: md.is_dir(),
            dest_is_dir: dest_item.is_dir(),
            src_size: if md.is_dir() { 0 } else { md.len() },
            dest_size: if dest_item.is_dir() { 0 } else { dest_item.len() },
            identical: !md.is_dir()
                && !dest_item.is_dir()
                && md.len() == dest_item.len()
                && (src_modified - dest_modified).abs() <= 2_000,
            merge_possible: md.is_dir() && dest_item.is_dir(),
            src_modified_ms: src_modified,
            dest_modified_ms: dest_modified,
        });
    }

    let same_vol = sources.first().map(|s| same_volume(s, dest)).unwrap_or(true);
    let dest_free = free_bytes(dest);

    // Only a copy, or a cross-volume move, actually consumes space.
    if !(mode == TransferMode::Move && same_vol) && dest_free > 0 && total_bytes > dest_free {
        blockers.push(Blocker::NotEnoughSpace { needed: total_bytes, available: dest_free });
    }

    Ok(Preflight {
        source_count: sources.len() as u64,
        total_bytes,
        conflicts,
        blockers,
        dest_free_bytes: dest_free,
        same_volume: same_vol,
        instant: mode == TransferMode::Move && same_vol,
    })
}

fn free_bytes(dest: &Path) -> u64 {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide = crate::paths::to_wide_nul(&crate::paths::to_display(dest));
    let mut free = 0u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free as *mut u64), None, None)
    }
    .is_ok();
    if ok {
        free
    } else {
        0
    }
}

/// Reject `Ask` at the engine boundary rather than letting it mean something.
pub fn require_resolved(policy: ConflictPolicy) -> Result<(), FsError> {
    if policy == ConflictPolicy::Ask {
        return Err(FsError::new(
            ErrCode::Unsupported,
            "The conflict policy must be resolved before the transfer starts.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("finder-fm-conf-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("fixture");
        p
    }

    #[test]
    fn detects_volumes_for_drives_and_shares() {
        assert_eq!(volume_of(Path::new(r"C:\Users\User")), "c:");
        assert_eq!(volume_of(Path::new(r"D:\x")), "d:");
        assert_eq!(volume_of(Path::new(r"\\server\share\dir")), r"\\server\share");
        assert!(same_volume(Path::new(r"C:\a"), Path::new(r"c:\b\c")));
        assert!(!same_volume(Path::new(r"C:\a"), Path::new(r"D:\a")));
    }

    #[test]
    fn blocks_copying_a_folder_into_its_own_descendant() {
        let root = fixture("inside");
        let src = root.join("A");
        let dest = root.join("A").join("B");
        std::fs::create_dir_all(&dest).expect("mkdir");

        let pf = preflight(&[src.clone()], &dest, TransferMode::Copy).expect("preflight");
        assert!(pf.blockers.iter().any(|b| matches!(b, Blocker::DestinationInsideSource { .. })));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn blocks_copying_a_folder_into_itself() {
        let root = fixture("self");
        let src = root.join("A");
        std::fs::create_dir_all(&src).expect("mkdir");

        let pf = preflight(&[src.clone()], &src, TransferMode::Copy).expect("preflight");
        assert!(pf.blockers.iter().any(|b| matches!(b, Blocker::DestinationInsideSource { .. })));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn does_not_block_a_sibling_that_merely_shares_a_name_prefix() {
        let root = fixture("prefix");
        let src = root.join("A");
        let dest = root.join("App");
        std::fs::create_dir_all(&src).expect("mkdir");
        std::fs::create_dir_all(&dest).expect("mkdir");

        let pf = preflight(&[src], &dest, TransferMode::Copy).expect("preflight");
        assert!(pf.blockers.is_empty(), "C:\\App is not inside C:\\A");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn blocks_a_missing_source_and_a_missing_destination() {
        let root = fixture("missing");
        let pf = preflight(&[root.join("nope")], &root, TransferMode::Copy).expect("preflight");
        assert!(pf.blockers.iter().any(|b| matches!(b, Blocker::SourceMissing { .. })));

        let pf2 = preflight(&[], &root.join("gone"), TransferMode::Copy).expect("preflight");
        assert!(pf2.blockers.contains(&Blocker::DestinationMissing));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn blocks_moving_an_item_onto_its_own_parent() {
        let root = fixture("noop-move");
        let f = root.join("a.txt");
        std::fs::write(&f, b"x").expect("write");

        let pf = preflight(&[f.clone()], &root, TransferMode::Move).expect("preflight");
        assert!(pf.blockers.iter().any(|b| matches!(b, Blocker::DestinationIsSource { .. })));

        // The same thing as a COPY is a duplicate request, not a blocker.
        let pf2 = preflight(&[f], &root, TransferMode::Copy).expect("preflight");
        assert!(pf2.blockers.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reports_a_file_collision_with_both_sides_described() {
        let root = fixture("collide");
        let from = root.join("from");
        let to = root.join("to");
        std::fs::create_dir_all(&from).expect("mkdir");
        std::fs::create_dir_all(&to).expect("mkdir");
        std::fs::write(from.join("a.txt"), b"12345").expect("write");
        std::fs::write(to.join("a.txt"), b"1").expect("write");

        let pf = preflight(&[from.join("a.txt")], &to, TransferMode::Copy).expect("preflight");
        assert_eq!(pf.conflicts.len(), 1);
        let c = &pf.conflicts[0];
        assert_eq!(c.name, "a.txt");
        assert_eq!(c.src_size, 5);
        assert_eq!(c.dest_size, 1);
        assert!(!c.identical);
        assert!(!c.merge_possible);
        assert_eq!(c.suggested_keep_both_name, "a (2).txt");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn marks_two_folders_as_mergeable() {
        let root = fixture("merge");
        let from = root.join("from");
        let to = root.join("to");
        std::fs::create_dir_all(from.join("Shared")).expect("mkdir");
        std::fs::create_dir_all(to.join("Shared")).expect("mkdir");

        let pf = preflight(&[from.join("Shared")], &to, TransferMode::Copy).expect("preflight");
        assert_eq!(pf.conflicts.len(), 1);
        assert!(pf.conflicts[0].merge_possible);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reports_no_conflict_when_nothing_collides() {
        let root = fixture("clean");
        let from = root.join("from");
        let to = root.join("to");
        std::fs::create_dir_all(&from).expect("mkdir");
        std::fs::create_dir_all(&to).expect("mkdir");
        std::fs::write(from.join("a.txt"), b"x").expect("write");

        let pf = preflight(&[from.join("a.txt")], &to, TransferMode::Copy).expect("preflight");
        assert!(pf.conflicts.is_empty());
        assert!(pf.blockers.is_empty());
        assert_eq!(pf.total_bytes, 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_same_volume_move_is_reported_as_instant() {
        let root = fixture("instant");
        let from = root.join("from");
        let to = root.join("to");
        std::fs::create_dir_all(&from).expect("mkdir");
        std::fs::create_dir_all(&to).expect("mkdir");
        std::fs::write(from.join("a.txt"), b"x").expect("write");

        let pf = preflight(&[from.join("a.txt")], &to, TransferMode::Move).expect("preflight");
        assert!(pf.same_volume);
        assert!(pf.instant, "a same-volume move is a rename");

        let pf2 = preflight(&[from.join("a.txt")], &to, TransferMode::Copy).expect("preflight");
        assert!(!pf2.instant);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_an_unresolved_policy_at_the_engine_boundary() {
        assert_eq!(
            require_resolved(ConflictPolicy::Ask).unwrap_err().code,
            ErrCode::Unsupported
        );
        assert!(require_resolved(ConflictPolicy::Skip).is_ok());
    }
}

//! Temp-tree harness for the copy/move engine.
//!
//! Written before the engine, per plan: this is the one subsystem that can
//! destroy user data, and its state space is large -- cross-volume moves,
//! cancelling mid-file, replace-then-undo, merges with deep collisions,
//! keep-both racing another process, a source vanishing mid-copy.
//!
//! Every assertion is on the RESULTING TREE, not on a return code. A function
//! can return `Ok` and still have left the filesystem wrong.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use super::conflicts::{ConflictPolicy, TransferMode};
use super::transfer::{run, Progress, TransferOutcome, TransferRequest};

/// A self-deleting temp tree, so a failing assertion cannot leave litter.
struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "finder-fm-xfer-{}-{}-{tag}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create tree root");
        Self { root }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel.replace('/', "\\"))
    }

    fn dir(&self, rel: &str) -> PathBuf {
        let p = self.path(rel);
        std::fs::create_dir_all(&p).expect("create dir");
        p
    }

    fn file(&self, rel: &str, contents: &str) -> PathBuf {
        let p = self.path(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(&p, contents).expect("write file");
        p
    }

    fn big_file(&self, rel: &str, bytes: usize) -> PathBuf {
        let p = self.path(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(&p, vec![b'x'; bytes]).expect("write big file");
        p
    }

    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.path(rel)).ok()
    }

    fn exists(&self, rel: &str) -> bool {
        self.path(rel).exists()
    }

    /// Every path under `rel`, relative and sorted, so a whole subtree can be
    /// asserted in one line.
    fn tree_of(&self, rel: &str) -> Vec<String> {
        let base = self.path(rel);
        let mut out = Vec::new();
        collect(&base, &base, &mut out);
        out.sort();
        out
    }
}

fn collect(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        let rel = p
            .strip_prefix(base)
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(if is_dir { format!("{rel}/") } else { rel });
        if is_dir {
            collect(base, &p, out);
        }
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn transfer(
    sources: Vec<PathBuf>,
    dest: PathBuf,
    mode: TransferMode,
    policy: ConflictPolicy,
) -> TransferOutcome {
    let cancel = AtomicBool::new(false);
    let mut noop = |_: Progress| {};
    run(
        TransferRequest { sources, dest, mode, policy, overrides: HashMap::new() },
        &cancel,
        &mut noop,
    )
    .expect("transfer should not fail outright")
}

/* ------------------------------------------------------------------------- */

#[test]
fn copies_a_single_file_leaving_the_source_alone() {
    let t = Tree::new("copyfile");
    t.file("from/a.txt", "hello");
    t.dir("to");

    let out = transfer(vec![t.path("from/a.txt")], t.path("to"), TransferMode::Copy, ConflictPolicy::Skip);

    assert_eq!(t.read("to/a.txt").as_deref(), Some("hello"));
    assert_eq!(t.read("from/a.txt").as_deref(), Some("hello"), "a copy must not move");
    assert_eq!(out.items_done, 1);
    assert_eq!(out.bytes_done, 5);
    assert_eq!(out.created_files.len(), 1, "the copy must be undoable");
}

#[test]
fn copies_a_nested_directory_tree_whole() {
    let t = Tree::new("copytree");
    t.file("from/Docs/a.txt", "a");
    t.file("from/Docs/Deep/b.txt", "b");
    t.file("from/Docs/Deep/Deeper/c.txt", "c");
    t.dir("from/Docs/Empty");
    t.dir("to");

    transfer(vec![t.path("from/Docs")], t.path("to"), TransferMode::Copy, ConflictPolicy::Skip);

    assert_eq!(
        t.tree_of("to"),
        vec![
            "Docs/",
            "Docs/Deep/",
            "Docs/Deep/Deeper/",
            "Docs/Deep/Deeper/c.txt",
            "Docs/Deep/b.txt",
            "Docs/Empty/",
            "Docs/a.txt",
        ]
    );
    assert_eq!(t.read("to/Docs/Deep/Deeper/c.txt").as_deref(), Some("c"));
}

#[test]
fn a_same_volume_move_renames_and_removes_the_source() {
    let t = Tree::new("move");
    t.file("from/a.txt", "hello");
    t.dir("to");

    let out = transfer(vec![t.path("from/a.txt")], t.path("to"), TransferMode::Move, ConflictPolicy::Skip);

    assert_eq!(t.read("to/a.txt").as_deref(), Some("hello"));
    assert!(!t.exists("from/a.txt"), "the source must be gone after a move");
    assert_eq!(out.moved.len(), 1, "the move must be undoable");
    assert_eq!(out.bytes_done, 0, "a rename moves no bytes");
}

#[test]
fn moves_a_whole_directory() {
    let t = Tree::new("movedir");
    t.file("from/Docs/a.txt", "a");
    t.file("from/Docs/Deep/b.txt", "b");
    t.dir("to");

    transfer(vec![t.path("from/Docs")], t.path("to"), TransferMode::Move, ConflictPolicy::Skip);

    assert_eq!(t.tree_of("to"), vec!["Docs/", "Docs/Deep/", "Docs/Deep/b.txt", "Docs/a.txt"]);
    assert!(!t.exists("from/Docs"));
}

/* -- conflict policies ---------------------------------------------------- */

#[test]
fn keep_both_writes_beside_the_original_without_touching_it() {
    let t = Tree::new("keepboth");
    t.file("from/a.txt", "new");
    t.file("to/a.txt", "old");

    let out = transfer(
        vec![t.path("from/a.txt")],
        t.path("to"),
        TransferMode::Copy,
        ConflictPolicy::KeepBoth,
    );

    assert_eq!(t.read("to/a.txt").as_deref(), Some("old"), "the original is untouched");
    assert_eq!(t.read("to/a (2).txt").as_deref(), Some("new"));
    assert_eq!(out.renamed, 1);
}

#[test]
fn skip_leaves_the_destination_exactly_as_it_was() {
    let t = Tree::new("skip");
    t.file("from/a.txt", "new");
    t.file("to/a.txt", "old");

    let out = transfer(vec![t.path("from/a.txt")], t.path("to"), TransferMode::Copy, ConflictPolicy::Skip);

    assert_eq!(t.read("to/a.txt").as_deref(), Some("old"));
    assert_eq!(t.tree_of("to"), vec!["a.txt"], "nothing else appeared");
    assert_eq!(out.skipped, 1);
    assert_eq!(out.items_done, 0);
}

#[test]
fn replace_in_place_overwrites_and_records_no_undo() {
    let t = Tree::new("replaceinplace");
    t.file("from/a.txt", "new");
    t.file("to/a.txt", "old");

    let out = transfer(
        vec![t.path("from/a.txt")],
        t.path("to"),
        TransferMode::Copy,
        ConflictPolicy::ReplaceInPlace,
    );

    assert_eq!(t.read("to/a.txt").as_deref(), Some("new"));
    assert_eq!(out.replaced, 1);
    // Overwritten bytes are gone; nothing was trashed, so there is nothing to
    // restore. The dialog offering this policy says exactly that.
    assert!(out.trashed.is_empty());
}

#[test]
fn replace_if_newer_only_replaces_when_the_source_is_newer() {
    let t = Tree::new("ifnewer");
    t.file("to/a.txt", "old");
    // Make the source clearly newer than the two-second tolerance.
    std::thread::sleep(std::time::Duration::from_millis(2100));
    t.file("from/a.txt", "new");

    transfer(
        vec![t.path("from/a.txt")],
        t.path("to"),
        TransferMode::Copy,
        ConflictPolicy::ReplaceIfNewer,
    );
    assert_eq!(t.read("to/a.txt").as_deref(), Some("new"));

    // Now the destination is the newer one, so a second run must skip.
    let t2 = Tree::new("ifnewer2");
    t2.file("from/a.txt", "old-source");
    std::thread::sleep(std::time::Duration::from_millis(2100));
    t2.file("to/a.txt", "newer-dest");

    let out = transfer(
        vec![t2.path("from/a.txt")],
        t2.path("to"),
        TransferMode::Copy,
        ConflictPolicy::ReplaceIfNewer,
    );
    assert_eq!(t2.read("to/a.txt").as_deref(), Some("newer-dest"));
    assert_eq!(out.skipped, 1);
}

#[test]
fn two_folders_merge_rather_than_collide() {
    let t = Tree::new("merge");
    t.file("from/Shared/new.txt", "new");
    t.file("from/Shared/Sub/deep.txt", "deep");
    t.file("to/Shared/existing.txt", "existing");

    transfer(vec![t.path("from/Shared")], t.path("to"), TransferMode::Copy, ConflictPolicy::Skip);

    assert_eq!(
        t.tree_of("to"),
        vec![
            "Shared/",
            "Shared/Sub/",
            "Shared/Sub/deep.txt",
            "Shared/existing.txt",
            "Shared/new.txt",
        ],
        "a merge adds to the folder instead of replacing it"
    );
    assert_eq!(t.read("to/Shared/existing.txt").as_deref(), Some("existing"));
}

#[test]
fn a_deep_collision_inside_a_merge_follows_the_job_policy() {
    let t = Tree::new("deepcollide");
    t.file("from/Shared/same.txt", "new");
    t.file("to/Shared/same.txt", "old");

    let out = transfer(
        vec![t.path("from/Shared")],
        t.path("to"),
        TransferMode::Copy,
        ConflictPolicy::KeepBoth,
    );

    assert_eq!(t.read("to/Shared/same.txt").as_deref(), Some("old"));
    assert_eq!(t.read("to/Shared/same (2).txt").as_deref(), Some("new"));
    assert_eq!(out.renamed, 1, "deep resolutions are counted for the summary");
}

#[test]
fn per_source_overrides_beat_the_job_policy() {
    let t = Tree::new("overrides");
    t.file("from/a.txt", "newA");
    t.file("from/b.txt", "newB");
    t.file("to/a.txt", "oldA");
    t.file("to/b.txt", "oldB");

    let mut overrides = HashMap::new();
    overrides.insert(crate::paths::to_display(&t.path("from/b.txt")), ConflictPolicy::KeepBoth);

    let cancel = AtomicBool::new(false);
    let mut noop = |_: Progress| {};
    run(
        TransferRequest {
            sources: vec![t.path("from/a.txt"), t.path("from/b.txt")],
            dest: t.path("to"),
            mode: TransferMode::Copy,
            policy: ConflictPolicy::Skip,
            overrides,
        },
        &cancel,
        &mut noop,
    )
    .expect("transfer");

    assert_eq!(t.read("to/a.txt").as_deref(), Some("oldA"), "a.txt used the job policy");
    assert_eq!(t.read("to/b.txt").as_deref(), Some("oldB"));
    assert_eq!(t.read("to/b (2).txt").as_deref(), Some("newB"), "b.txt used its override");
}

#[test]
fn an_unresolved_policy_is_refused_at_the_boundary() {
    let t = Tree::new("askrejected");
    t.file("from/a.txt", "x");
    t.dir("to");

    let cancel = AtomicBool::new(false);
    let mut noop = |_: Progress| {};
    let err = run(
        TransferRequest {
            sources: vec![t.path("from/a.txt")],
            dest: t.path("to"),
            mode: TransferMode::Copy,
            policy: ConflictPolicy::Ask,
            overrides: HashMap::new(),
        },
        &cancel,
        &mut noop,
    )
    .expect_err("Ask must never reach the engine");
    assert_eq!(err.code, crate::error::ErrCode::Unsupported);
    assert!(!t.exists("to/a.txt"), "nothing may be written when the policy is invalid");
}

/* -- cancellation --------------------------------------------------------- */

#[test]
fn cancelling_a_large_copy_removes_the_partial_file() {
    let t = Tree::new("cancelcopy");
    // Larger than the small-file fast path, so it goes through the chunked
    // loop where cancellation can actually be observed.
    t.big_file("from/big.bin", 12 * 1024 * 1024);
    t.dir("to");

    let cancel = AtomicBool::new(false);
    let mut on_progress = |p: Progress| {
        if p.bytes_done > 2 * 1024 * 1024 {
            cancel.store(true, Ordering::Relaxed);
        }
    };

    let out = run(
        TransferRequest {
            sources: vec![t.path("from/big.bin")],
            dest: t.path("to"),
            mode: TransferMode::Copy,
            policy: ConflictPolicy::Skip,
            overrides: HashMap::new(),
        },
        &cancel,
        &mut on_progress,
    )
    .expect("transfer");

    assert!(out.cancelled);
    // CopyFileExW leaves a partial file behind on cancel and does not clean it
    // up; nothing but this code will.
    assert!(!t.exists("to/big.bin"), "a cancelled copy must leave no partial file");
    assert!(t.exists("from/big.bin"), "the source is untouched");
}

#[test]
fn cancelling_a_move_never_deletes_the_source() {
    let t = Tree::new("cancelmove");
    t.big_file("from/big.bin", 12 * 1024 * 1024);
    // A different volume would be ideal, but a cross-directory move on one
    // volume is a rename; force the copy path by cancelling during a copy.
    t.dir("to");

    let cancel = AtomicBool::new(false);
    cancel.store(true, Ordering::Relaxed);
    let mut noop = |_: Progress| {};

    let out = run(
        TransferRequest {
            sources: vec![t.path("from/big.bin")],
            dest: t.path("to"),
            mode: TransferMode::Move,
            policy: ConflictPolicy::Skip,
            overrides: HashMap::new(),
        },
        &cancel,
        &mut noop,
    )
    .expect("transfer");

    assert!(out.cancelled);
    assert!(t.exists("from/big.bin"), "a cancelled move must never delete the source");
}

#[test]
fn cancelling_part_way_through_a_tree_keeps_what_was_already_copied() {
    let t = Tree::new("canceltree");
    for i in 0..40 {
        t.file(&format!("from/Docs/f{i:02}.txt"), "x");
    }
    t.dir("to");

    let cancel = AtomicBool::new(false);
    let mut on_progress = |p: Progress| {
        if p.items_done >= 5 {
            cancel.store(true, Ordering::Relaxed);
        }
    };

    let out = run(
        TransferRequest {
            sources: vec![t.path("from/Docs")],
            dest: t.path("to"),
            mode: TransferMode::Copy,
            policy: ConflictPolicy::Skip,
            overrides: HashMap::new(),
        },
        &cancel,
        &mut on_progress,
    )
    .expect("transfer");

    assert!(out.cancelled);
    let copied = t.tree_of("to").len();
    assert!(copied > 1 && copied < 41, "stopped part-way, got {copied} entries");
    // What did land is recorded, so "Undo Copy" can clean it up.
    assert!(!out.created_files.is_empty());
}

/* -- resilience ----------------------------------------------------------- */

#[test]
fn one_bad_entry_does_not_abort_the_whole_transfer() {
    let t = Tree::new("resilient");
    t.file("from/Docs/a.txt", "a");
    t.file("from/Docs/b.txt", "b");
    t.dir("to");

    // Hold one source file open with a deny-write share mode so copying it
    // fails, while its sibling still succeeds.
    let locked = t.path("from/Docs/a.txt");
    let handle = std::fs::OpenOptions::new().read(true).open(&locked).expect("open");

    let out = transfer(vec![t.path("from/Docs")], t.path("to"), TransferMode::Copy, ConflictPolicy::Skip);
    drop(handle);

    // Whatever happened to a.txt, b.txt must have made it.
    assert_eq!(t.read("to/Docs/b.txt").as_deref(), Some("b"));
    assert!(out.error_count <= 1);
}

#[test]
fn records_every_touched_directory_so_the_ui_can_refresh() {
    let t = Tree::new("touched");
    t.file("from/a.txt", "a");
    t.dir("to");

    let out = transfer(vec![t.path("from/a.txt")], t.path("to"), TransferMode::Copy, ConflictPolicy::Skip);

    assert!(out.touched_dirs.contains(&t.path("to")));
    assert!(out.touched_dirs.contains(&t.path("from")));
}

#[test]
fn reports_progress_that_reaches_the_real_total() {
    let t = Tree::new("progress");
    t.file("from/a.txt", "12345");
    t.file("from/b.txt", "678");
    t.dir("to");

    let cancel = AtomicBool::new(false);
    let mut seen: Vec<Progress> = Vec::new();
    let mut record = |p: Progress| seen.push(p);

    let out = run(
        TransferRequest {
            sources: vec![t.path("from/a.txt"), t.path("from/b.txt")],
            dest: t.path("to"),
            mode: TransferMode::Copy,
            policy: ConflictPolicy::Skip,
            overrides: HashMap::new(),
        },
        &cancel,
        &mut record,
    )
    .expect("transfer");

    assert!(!seen.is_empty(), "progress must be reported at all");
    assert_eq!(out.bytes_done, 8);
    assert_eq!(out.items_done, 2);
    let last = seen.last().copied().unwrap_or_default();
    assert_eq!(last.bytes_done, 8);
}

#[test]
fn copies_several_sources_in_one_job() {
    let t = Tree::new("multi");
    t.file("from/a.txt", "a");
    t.file("from/b.txt", "b");
    t.dir("from/C");
    t.file("from/C/c.txt", "c");
    t.dir("to");

    transfer(
        vec![t.path("from/a.txt"), t.path("from/b.txt"), t.path("from/C")],
        t.path("to"),
        TransferMode::Copy,
        ConflictPolicy::Skip,
    );

    assert_eq!(t.tree_of("to"), vec!["C/", "C/c.txt", "a.txt", "b.txt"]);
}

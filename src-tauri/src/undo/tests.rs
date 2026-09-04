//! Undo tests against a real temp tree.
//!
//! The Recycle Bin cases genuinely trash files and restore them, because a
//! mocked Recycle Bin would prove nothing about the one claim that matters:
//! that delete and replace are recoverable.

use std::path::PathBuf;

use super::*;

struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "finder-fm-undo-{}-{}-{tag}",
            std::process::id(),
            now_secs()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");
        Self { root }
    }
    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel.replace('/', "\\"))
    }
    fn file(&self, rel: &str, body: &str) -> PathBuf {
        let p = self.path(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).expect("parent");
        }
        std::fs::write(&p, body).expect("write");
        p
    }
    fn dir(&self, rel: &str) -> PathBuf {
        let p = self.path(rel);
        std::fs::create_dir_all(&p).expect("mkdir");
        p
    }
    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.path(rel)).ok()
    }
    fn exists(&self, rel: &str) -> bool {
        self.path(rel).exists()
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/* -- rename --------------------------------------------------------------- */

#[test]
fn undoes_a_rename() {
    let t = Tree::new("rename");
    let from = t.path("a.txt");
    let to = t.file("b.txt", "body");

    let mut stack = UndoStack::default();
    stack.push("Undo Rename", UndoAction::Rename { from: from.clone(), to }, vec![t.root.clone()]);

    let out = stack.undo().expect("undo");
    assert!(out.errors.is_empty(), "{:?}", out.errors);
    assert_eq!(t.read("a.txt").as_deref(), Some("body"));
    assert!(!t.exists("b.txt"));
}

#[test]
fn refuses_a_rename_undo_when_the_old_name_is_taken() {
    let t = Tree::new("rename-taken");
    let from = t.file("a.txt", "someone else");
    let to = t.file("b.txt", "body");

    let mut stack = UndoStack::default();
    stack.push("Undo Rename", UndoAction::Rename { from, to }, vec![]);

    let out = stack.undo().expect("undo");
    assert_eq!(out.errors.len(), 1);
    assert_eq!(out.errors[0].code, ErrCode::AlreadyExists);
    // Never force it: both files survive exactly as they were.
    assert_eq!(t.read("a.txt").as_deref(), Some("someone else"));
    assert_eq!(t.read("b.txt").as_deref(), Some("body"));
}

#[test]
fn refuses_a_rename_undo_when_the_item_vanished() {
    let t = Tree::new("rename-gone");
    let mut stack = UndoStack::default();
    stack.push(
        "Undo Rename",
        UndoAction::Rename { from: t.path("a.txt"), to: t.path("b.txt") },
        vec![],
    );

    let out = stack.undo().expect("undo");
    assert_eq!(out.errors[0].code, ErrCode::NotFound);
}

/* -- move ----------------------------------------------------------------- */

#[test]
fn undoes_a_move_of_several_items() {
    let t = Tree::new("move");
    t.dir("from");
    let a_to = t.file("to/a.txt", "a");
    let b_to = t.file("to/b.txt", "b");

    let mut stack = UndoStack::default();
    stack.push(
        "Undo Move",
        UndoAction::Move {
            pairs: vec![(t.path("from/a.txt"), a_to), (t.path("from/b.txt"), b_to)],
        },
        vec![],
    );

    let out = stack.undo().expect("undo");
    assert!(out.errors.is_empty(), "{:?}", out.errors);
    assert_eq!(t.read("from/a.txt").as_deref(), Some("a"));
    assert_eq!(t.read("from/b.txt").as_deref(), Some("b"));
    assert!(!t.exists("to/a.txt"));
}

#[test]
fn a_partially_broken_move_undo_restores_what_it_can() {
    let t = Tree::new("move-partial");
    t.dir("from");
    let a_to = t.file("to/a.txt", "a");
    // b was already deleted by something else.
    let b_to = t.path("to/b.txt");

    let mut stack = UndoStack::default();
    stack.push(
        "Undo Move",
        UndoAction::Move {
            pairs: vec![(t.path("from/a.txt"), a_to), (t.path("from/b.txt"), b_to)],
        },
        vec![],
    );

    let out = stack.undo().expect("undo");
    assert_eq!(out.errors.len(), 1, "one failure should not abandon the rest");
    assert_eq!(t.read("from/a.txt").as_deref(), Some("a"));
}

/* -- create folder -------------------------------------------------------- */

#[test]
fn undoes_a_new_folder_only_while_it_is_empty() {
    let t = Tree::new("mkdir");
    let path = t.dir("New Folder");

    let mut stack = UndoStack::default();
    stack.push("Undo New Folder", UndoAction::CreateFolder { path: path.clone() }, vec![]);
    let out = stack.undo().expect("undo");
    assert!(out.errors.is_empty());
    assert!(!t.exists("New Folder"));

    // Now with something inside: the user's file is not ours to delete.
    let path2 = t.dir("Another");
    t.file("Another/mine.txt", "mine");
    stack.push("Undo New Folder", UndoAction::CreateFolder { path: path2 }, vec![]);
    let out2 = stack.undo().expect("undo");
    assert_eq!(out2.errors[0].code, ErrCode::NotEmpty);
    assert_eq!(t.read("Another/mine.txt").as_deref(), Some("mine"));
}

/* -- copy ----------------------------------------------------------------- */

#[test]
fn undoing_a_copy_removes_exactly_what_was_created() {
    let t = Tree::new("copy");
    let dir = t.dir("to/Docs");
    let f1 = t.file("to/Docs/a.txt", "a");
    let f2 = t.file("to/Docs/b.txt", "b");
    // A file that was already there before the copy.
    t.file("to/pre-existing.txt", "keep me");

    let mut stack = UndoStack::default();
    stack.push(
        "Undo Copy",
        UndoAction::Copy { files: vec![f1, f2], dirs: vec![dir] },
        vec![],
    );

    let out = stack.undo().expect("undo");
    assert!(out.errors.is_empty(), "{:?}", out.errors);
    assert!(!t.exists("to/Docs"));
    assert_eq!(
        t.read("to/pre-existing.txt").as_deref(),
        Some("keep me"),
        "undo must never touch a sibling it did not create"
    );
}

#[test]
fn undoing_a_copy_leaves_a_directory_the_user_added_to() {
    let t = Tree::new("copy-dirty");
    let dir = t.dir("to/Docs");
    let f1 = t.file("to/Docs/a.txt", "a");
    // The user dropped something else in afterwards.
    t.file("to/Docs/mine.txt", "mine");

    let mut stack = UndoStack::default();
    stack.push("Undo Copy", UndoAction::Copy { files: vec![f1], dirs: vec![dir] }, vec![]);

    let out = stack.undo().expect("undo");
    assert!(out.errors.is_empty(), "a non-empty directory is skipped, not an error");
    assert_eq!(t.read("to/Docs/mine.txt").as_deref(), Some("mine"));
}

#[test]
fn undoing_a_copy_removes_nested_directories_deepest_first() {
    let t = Tree::new("copy-nested");
    let outer = t.dir("to/Docs");
    let inner = t.dir("to/Docs/Deep");
    let f = t.file("to/Docs/Deep/c.txt", "c");

    let mut stack = UndoStack::default();
    stack.push(
        "Undo Copy",
        // Given in the wrong order on purpose: the reversal must sort them.
        UndoAction::Copy { files: vec![f], dirs: vec![outer, inner] },
        vec![],
    );

    let out = stack.undo().expect("undo");
    assert!(out.errors.is_empty(), "{:?}", out.errors);
    assert!(!t.exists("to/Docs"));
}

/* -- tombstones and stack behaviour --------------------------------------- */

#[test]
fn a_tombstone_explains_itself_instead_of_undoing_the_previous_action() {
    let t = Tree::new("tombstone");
    let from = t.path("a.txt");
    let to = t.file("b.txt", "body");

    let mut stack = UndoStack::default();
    stack.push("Undo Rename", UndoAction::Rename { from, to }, vec![]);
    stack.push_tombstone("Undo Replace", "Replacing in place overwrites the file permanently.");

    let peek = stack.peek().expect("peek");
    assert!(!peek.undoable);
    assert!(peek.reason.is_some());

    let err = stack.undo().expect_err("a tombstone cannot be undone");
    assert_eq!(err.code, ErrCode::Unsupported);
    // The rename below it must NOT have been undone by mistake.
    assert_eq!(t.read("b.txt").as_deref(), Some("body"));
    assert_eq!(stack.len(), 1);
}

#[test]
fn undoing_an_empty_stack_says_so() {
    let mut stack = UndoStack::default();
    let err = stack.undo().expect_err("nothing to undo");
    assert_eq!(err.code, ErrCode::Unsupported);
    assert!(stack.peek().is_none());
}

#[test]
fn the_stack_is_capped_and_drops_the_oldest_first() {
    let mut stack = UndoStack::default();
    for i in 0..60 {
        stack.push(
            format!("Undo {i}"),
            UndoAction::CreateFolder { path: PathBuf::from(format!(r"C:\x{i}")) },
            vec![],
        );
    }
    assert_eq!(stack.len(), 50);
    assert_eq!(stack.peek().expect("peek").label, "Undo 59");
}

#[test]
fn purges_entries_for_a_volume_that_went_away() {
    let mut stack = UndoStack::default();
    stack.push(
        "Undo Move",
        UndoAction::Move { pairs: vec![(PathBuf::from(r"E:\a"), PathBuf::from(r"E:\b"))] },
        vec![],
    );
    stack.push(
        "Undo New Folder",
        UndoAction::CreateFolder { path: PathBuf::from(r"C:\keep") },
        vec![],
    );

    stack.purge_volume("e:");
    assert_eq!(stack.len(), 1);
    assert_eq!(stack.peek().expect("peek").label, "Undo New Folder");
}

/* -- Recycle Bin ---------------------------------------------------------- */

#[test]
fn undoes_a_delete_by_restoring_from_the_recycle_bin() {
    let t = Tree::new("trash");
    let f = t.file("recoverable.txt", "precious");

    let stamp = now_secs();
    trash::delete(&f).expect("trash the file");
    assert!(!t.exists("recoverable.txt"), "it really went to the Recycle Bin");

    let mut stack = UndoStack::default();
    stack.push(
        "Undo Delete",
        UndoAction::Trash { refs: vec![TrashRef::new(&f, stamp)] },
        vec![t.root.clone()],
    );

    let out = stack.undo().expect("undo");
    assert!(out.errors.is_empty(), "{:?}", out.errors);
    assert_eq!(
        t.read("recoverable.txt").as_deref(),
        Some("precious"),
        "delete must be recoverable -- this is the whole point of using the bin"
    );
}

#[test]
fn refuses_to_restore_over_something_that_took_the_original_place() {
    let t = Tree::new("trash-collide");
    let f = t.file("taken.txt", "original");

    let stamp = now_secs();
    trash::delete(&f).expect("trash");
    // Something else now occupies the path.
    t.file("taken.txt", "usurper");

    let mut stack = UndoStack::default();
    stack.push("Undo Delete", UndoAction::Trash { refs: vec![TrashRef::new(&f, stamp)] }, vec![]);

    let out = stack.undo().expect("undo");
    assert_eq!(out.errors.len(), 1);
    assert_eq!(out.errors[0].code, ErrCode::RestoreCollision);
    assert_eq!(t.read("taken.txt").as_deref(), Some("usurper"), "the newcomer survives");
}

#[test]
fn undoes_a_replace_by_restoring_the_victim_and_removing_the_replacement() {
    let t = Tree::new("replace");
    let victim = t.file("a.txt", "original");

    // Simulate what the transfer engine does for ConflictPolicy::Replace:
    // trash the victim, then write the replacement in its place.
    let stamp = now_secs();
    trash::delete(&victim).expect("trash victim");
    let replacement = t.file("a.txt", "replacement");

    let mut stack = UndoStack::default();
    stack.push(
        "Undo Replace",
        UndoAction::Replace {
            victims: vec![TrashRef::new(&victim, stamp)],
            inner: Box::new(UndoAction::Copy { files: vec![replacement], dirs: vec![] }),
        },
        vec![t.root.clone()],
    );

    let out = stack.undo().expect("undo");
    assert!(out.errors.is_empty(), "{:?}", out.errors);
    assert_eq!(
        t.read("a.txt").as_deref(),
        Some("original"),
        "trashing the victim first is what makes replace recoverable"
    );
}

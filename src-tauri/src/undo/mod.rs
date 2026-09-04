//! The undo stack.
//!
//! It lives in Rust, not the frontend, for four reasons in order of weight:
//!
//!   1. Entries hold Recycle Bin references only `trash::os_limited` can act on,
//!      and reversing a copy needs the exact created-path list, which only the
//!      transfer engine knows.
//!   2. It survives a webview reload. Vite HMR reloads the window constantly in
//!      development, and a frontend-resident stack would silently vanish.
//!   3. Preconditions are revalidated against the filesystem at undo time; doing
//!      that from the frontend would be N extra IPC round trips.
//!   4. It puts the "is this even undoable" judgement next to the code that
//!      performed the operation, which is the only place that knows.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{ErrCode, FsError};

const CAP: usize = 50;

/// Enough to find one item again in the Recycle Bin.
///
/// `trash::delete_all` returns no identifiers, so the only way to find an item
/// later is to record where it came from and roughly when it went.
#[derive(Debug, Clone)]
pub struct TrashRef {
    pub original_path: PathBuf,
    pub name: OsString,
    /// Unix seconds, taken just before the delete.
    pub deleted_after: i64,
}

impl TrashRef {
    pub fn new(original_path: &Path, deleted_after: i64) -> Self {
        Self {
            name: original_path
                .file_name()
                .map(|n| n.to_os_string())
                .unwrap_or_default(),
            original_path: original_path.to_path_buf(),
            deleted_after,
        }
    }
}

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
pub enum UndoAction {
    Rename { from: PathBuf, to: PathBuf },
    /// Both same-volume renames and cross-volume copy-then-delete reverse as a move.
    Move { pairs: Vec<(PathBuf, PathBuf)> },
    CreateFolder { path: PathBuf },
    /// Reversing a copy deletes exactly what the job created -- never a sibling
    /// that happened to be there already.
    Copy { files: Vec<PathBuf>, dirs: Vec<PathBuf> },
    Trash { refs: Vec<TrashRef> },
    /// Restore the victims, then reverse whatever replaced them.
    Replace { victims: Vec<TrashRef>, inner: Box<UndoAction> },
}

#[derive(Debug, Clone)]
pub struct UndoEntry {
    pub label: String,
    /// `None` marks a tombstone: an operation that occupied a stack slot but
    /// cannot be reversed.
    pub action: Option<UndoAction>,
    pub reason: Option<String>,
    pub touched_dirs: Vec<PathBuf>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoLabel {
    pub label: String,
    pub undoable: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    pub label: String,
    pub touched_dirs: Vec<String>,
    pub errors: Vec<FsError>,
}

#[derive(Default)]
pub struct UndoStack {
    entries: VecDeque<UndoEntry>,
}

impl UndoStack {
    pub fn push(&mut self, label: impl Into<String>, action: UndoAction, touched_dirs: Vec<PathBuf>) {
        self.entries.push_back(UndoEntry {
            label: label.into(),
            action: Some(action),
            reason: None,
            touched_dirs,
        });
        while self.entries.len() > CAP {
            self.entries.pop_front();
        }
    }

    /// Record an operation that cannot be reversed.
    ///
    /// A tombstone occupies the slot so that Ctrl+Z explains itself instead of
    /// silently undoing the operation BEFORE it -- a classic and infuriating bug.
    pub fn push_tombstone(&mut self, label: impl Into<String>, reason: impl Into<String>) {
        self.entries.push_back(UndoEntry {
            label: label.into(),
            action: None,
            reason: Some(reason.into()),
            touched_dirs: Vec::new(),
        });
        while self.entries.len() > CAP {
            self.entries.pop_front();
        }
    }

    pub fn peek(&self) -> Option<UndoLabel> {
        self.entries.back().map(|e| UndoLabel {
            label: e.label.clone(),
            undoable: e.action.is_some(),
            reason: e.reason.clone(),
        })
    }

    #[allow(dead_code)] // used by tests, and by the shortcut sheet later
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Drop every entry referring to a volume that has gone away.
    #[allow(dead_code)] // wired to drive removal in the polish phase
    pub fn purge_volume(&mut self, volume: &str) {
        let v = volume.to_lowercase();
        self.entries.retain(|e| !entry_touches_volume(e, &v));
    }

    #[allow(dead_code)]
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn undo(&mut self) -> Result<UndoOutcome, FsError> {
        let Some(entry) = self.entries.pop_back() else {
            return Err(FsError::new(ErrCode::Unsupported, "There is nothing to undo."));
        };

        let Some(action) = entry.action else {
            let reason = entry
                .reason
                .unwrap_or_else(|| "That action can't be undone.".to_owned());
            return Err(FsError::new(ErrCode::Unsupported, reason));
        };

        let mut errors = Vec::new();
        let mut touched: Vec<PathBuf> = entry.touched_dirs.clone();
        apply(&action, &mut errors, &mut touched);

        Ok(UndoOutcome {
            label: entry.label,
            touched_dirs: touched.iter().map(|p| crate::paths::to_display(p)).collect(),
            errors,
        })
    }
}

#[allow(dead_code)] // reachable only through purge_volume
fn entry_touches_volume(entry: &UndoEntry, volume: &str) -> bool {
    let on_volume = |p: &Path| {
        crate::fs::conflicts::volume_of(p) == volume
    };
    if entry.touched_dirs.iter().any(|p| on_volume(p)) {
        return true;
    }
    match &entry.action {
        Some(UndoAction::Rename { from, to }) => on_volume(from) || on_volume(to),
        Some(UndoAction::Move { pairs }) => pairs.iter().any(|(a, b)| on_volume(a) || on_volume(b)),
        Some(UndoAction::CreateFolder { path }) => on_volume(path),
        Some(UndoAction::Copy { files, dirs }) => {
            files.iter().chain(dirs.iter()).any(|p| on_volume(p))
        }
        Some(UndoAction::Trash { refs }) => refs.iter().any(|r| on_volume(&r.original_path)),
        Some(UndoAction::Replace { victims, .. }) => {
            victims.iter().any(|r| on_volume(&r.original_path))
        }
        None => false,
    }
}

fn note(touched: &mut Vec<PathBuf>, path: &Path) {
    if let Some(parent) = path.parent() {
        let p = parent.to_path_buf();
        if !touched.contains(&p) {
            touched.push(p);
        }
    }
}

fn apply(action: &UndoAction, errors: &mut Vec<FsError>, touched: &mut Vec<PathBuf>) {
    match action {
        UndoAction::Rename { from, to } => {
            // Revalidate: the file must still be where we left it, and the old
            // name must be free. Never force it.
            if !to.exists() {
                errors.push(
                    FsError::new(ErrCode::NotFound, "That item has changed since the rename.")
                        .with_path(to),
                );
                return;
            }
            if from.exists() {
                errors.push(
                    FsError::new(ErrCode::AlreadyExists, "Something else now has the old name.")
                        .with_path(from),
                );
                return;
            }
            if let Err(e) = std::fs::rename(to, from) {
                errors.push(FsError::from_io(&e, to));
            }
            note(touched, from);
        }

        UndoAction::Move { pairs } => {
            for (from, to) in pairs {
                if !to.exists() {
                    errors.push(
                        FsError::new(ErrCode::NotFound, "A moved item is no longer there.")
                            .with_path(to),
                    );
                    continue;
                }
                if from.exists() {
                    errors.push(
                        FsError::new(ErrCode::AlreadyExists, "The original location is occupied.")
                            .with_path(from),
                    );
                    continue;
                }
                if let Some(parent) = from.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::rename(to, from) {
                    errors.push(FsError::from_io(&e, to));
                }
                note(touched, from);
                note(touched, to);
            }
        }

        UndoAction::CreateFolder { path } => {
            // Only remove it if it is still empty: the user may have put
            // something in it since, and that is theirs, not ours to delete.
            match std::fs::read_dir(path) {
                Ok(mut rd) => {
                    if rd.next().is_some() {
                        errors.push(
                            FsError::new(ErrCode::NotEmpty, "That folder is no longer empty.")
                                .with_path(path),
                        );
                        return;
                    }
                    if let Err(e) = std::fs::remove_dir(path) {
                        errors.push(FsError::from_io(&e, path));
                    }
                    note(touched, path);
                }
                Err(e) => errors.push(FsError::from_io(&e, path)),
            }
        }

        UndoAction::Copy { files, dirs } => {
            // Exactly what was created, files first, then directories deepest
            // first so each is empty by the time it is removed.
            for f in files {
                if f.exists() {
                    if let Err(e) = std::fs::remove_file(f) {
                        errors.push(FsError::from_io(&e, f));
                    }
                }
                note(touched, f);
            }
            let mut sorted = dirs.clone();
            sorted.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
            for d in sorted {
                // remove_dir, never remove_dir_all: anything the user added
                // since must survive.
                if d.exists() {
                    if let Err(e) = std::fs::remove_dir(&d) {
                        if e.raw_os_error() != Some(145) {
                            errors.push(FsError::from_io(&e, &d));
                        }
                    }
                }
                note(touched, &d);
            }
        }

        UndoAction::Trash { refs } => {
            restore_from_trash(refs, errors, touched);
        }

        UndoAction::Replace { victims, inner } => {
            // Reverse the replacement first, then put the victims back.
            apply(inner, errors, touched);
            restore_from_trash(victims, errors, touched);
        }
    }
}

/// Match recorded references against the Recycle Bin and restore them.
///
/// `os_limited::list()` enumerates the WHOLE bin, which is slow with thousands
/// of items -- hence it is called once, lazily, only when an undo actually
/// happens.
fn restore_from_trash(refs: &[TrashRef], errors: &mut Vec<FsError>, touched: &mut Vec<PathBuf>) {
    if refs.is_empty() {
        return;
    }

    let items = match trash::os_limited::list() {
        Ok(items) => items,
        Err(e) => {
            errors.push(FsError::new(
                ErrCode::TrashUnavailable,
                format!("The Recycle Bin could not be read: {e}"),
            ));
            return;
        }
    };

    let mut to_restore = Vec::new();
    for r in refs {
        // Something else may now occupy the original path; restoring would
        // fail, so say so precisely instead of losing the rest of the batch.
        if r.original_path.exists() {
            errors.push(
                FsError::new(
                    ErrCode::RestoreCollision,
                    "Something else is now in that item's original place.",
                )
                .with_path(&r.original_path),
            );
            continue;
        }

        let best = items
            .iter()
            .filter(|item| {
                item.name == r.name
                    && item.original_path() == r.original_path
                    && item.time_deleted >= r.deleted_after - 2
            })
            // Trashed twice in the same second: the newest is the one we mean.
            .max_by_key(|item| item.time_deleted);

        match best {
            Some(item) => {
                note(touched, &r.original_path);
                to_restore.push(item.clone());
            }
            None => errors.push(
                FsError::new(
                    ErrCode::NotFound,
                    "That item is no longer in the Recycle Bin.",
                )
                .with_path(&r.original_path),
            ),
        }
    }

    if to_restore.is_empty() {
        return;
    }
    if let Err(e) = trash::os_limited::restore_all(to_restore) {
        errors.push(FsError::new(
            ErrCode::RestoreCollision,
            format!("Some items could not be restored: {e}"),
        ));
    }
}

#[cfg(test)]
mod tests;

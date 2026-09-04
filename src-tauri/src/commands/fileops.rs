use std::collections::HashMap;
use std::path::PathBuf;

use tauri::Emitter as _;

use crate::error::{ErrCode, FsError};
use crate::fs::conflicts::{preflight, ConflictPolicy, Preflight, TransferMode};
use crate::fs::{names, transfer};
use crate::ipc::DirEntry;
use crate::jobs::{Emitter, JobFinished, JobKind, JobStatus, EVENT_FINISHED};
use crate::state::AppState;
use crate::undo::{now_secs, TrashRef, UndoAction, UndoLabel, UndoOutcome};

/// Guard against a stray call deleting something irrecoverably.
const PERMANENT_TOKEN: &str = "PERMANENT";

fn validated_paths(raw: &[String]) -> Result<Vec<PathBuf>, FsError> {
    raw.iter().map(|p| crate::paths::validate_existing(p)).collect()
}

/* -- create, rename ------------------------------------------------------- */

#[tauri::command]
pub async fn create_folder(
    parent: String,
    name: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<DirEntry, FsError> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::paths::validate_dir(&parent)?;
        let base = name.unwrap_or_else(|| "New Folder".to_owned());
        names::validate_name(&base)?;

        let free = names::new_folder_name(&dir, &base)?;
        let path = dir.join(&free);
        std::fs::create_dir(&path).map_err(|e| FsError::from_io(&e, &path))?;

        st.undo_stack().push(
            format!("Undo New Folder \"{free}\""),
            UndoAction::CreateFolder { path: path.clone() },
            vec![dir],
        );

        let meta = crate::fs::read_dir::stat(&path)?;
        Ok(DirEntry {
            name: meta.name,
            is_dir: true,
            flags: meta.flags,
            size: 0,
            modified_ms: meta.modified_ms,
            ext: String::new(),
            category: crate::ipc::Category::Folder,
        })
    })
    .await
    .map_err(|_| FsError::internal("The folder worker stopped unexpectedly."))?
}

#[tauri::command]
pub async fn rename_entry(
    path: String,
    new_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, FsError> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let from = crate::paths::validate_existing(&path)?;
        names::validate_name(&new_name)?;

        let dir = from
            .parent()
            .ok_or_else(|| FsError::new(ErrCode::Unsupported, "That item has no parent folder."))?;
        let to = dir.join(&new_name);

        // A pure case change is a rename to "itself" on a case-insensitive
        // filesystem and must be allowed through.
        let same_name = from
            .file_name()
            .map(|n| n.to_string_lossy().eq_ignore_ascii_case(&new_name))
            .unwrap_or(false);
        if to.exists() && !same_name {
            return Err(
                FsError::new(ErrCode::AlreadyExists, "An item with that name already exists.")
                    .with_path(&to),
            );
        }

        std::fs::rename(&from, &to).map_err(|e| FsError::from_io(&e, &from))?;

        st.undo_stack().push(
            format!("Undo Rename to \"{new_name}\""),
            UndoAction::Rename { from: from.clone(), to: to.clone() },
            vec![dir.to_path_buf()],
        );
        Ok(crate::paths::to_display(&to))
    })
    .await
    .map_err(|_| FsError::internal("The rename worker stopped unexpectedly."))?
}

/* -- delete --------------------------------------------------------------- */

#[tauri::command]
pub async fn trash_entries(
    paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, FsError> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let items = validated_paths(&paths)?;
        if items.is_empty() {
            return Ok(Vec::new());
        }

        // Recorded BEFORE the delete: `trash::delete_all` returns no
        // identifiers, so where-and-roughly-when is the only way back.
        let stamp = now_secs();
        let refs: Vec<TrashRef> = items.iter().map(|p| TrashRef::new(p, stamp)).collect();

        trash::delete_all(&items).map_err(|e| {
            // Silently deleting permanently because the bin is unavailable
            // would be the worst possible behaviour: say so and let the user
            // choose.
            FsError::new(
                ErrCode::TrashUnavailable,
                format!("These items could not be moved to the Recycle Bin: {e}"),
            )
        })?;

        let touched: Vec<PathBuf> = items
            .iter()
            .filter_map(|p| p.parent().map(|d| d.to_path_buf()))
            .collect();

        st.undo_stack().push(
            if items.len() == 1 {
                "Undo Delete".to_owned()
            } else {
                format!("Undo Delete of {} items", items.len())
            },
            UndoAction::Trash { refs },
            touched.clone(),
        );

        Ok(touched.iter().map(|p| crate::paths::to_display(p)).collect())
    })
    .await
    .map_err(|_| FsError::internal("The delete worker stopped unexpectedly."))?
}

#[tauri::command]
pub async fn delete_permanently(
    paths: Vec<String>,
    confirm_token: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, FsError> {
    if confirm_token != PERMANENT_TOKEN {
        return Err(FsError::new(
            ErrCode::Unsupported,
            "Permanent deletion requires explicit confirmation.",
        ));
    }

    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let items = validated_paths(&paths)?;
        let mut touched = Vec::new();

        for path in &items {
            let md = std::fs::symlink_metadata(path).map_err(|e| FsError::from_io(&e, path))?;
            let result = if md.is_dir() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            };
            result.map_err(|e| FsError::from_io(&e, path))?;
            if let Some(parent) = path.parent() {
                touched.push(parent.to_path_buf());
            }
        }

        // A tombstone, not silence: Ctrl+Z must explain itself rather than
        // undoing whatever came before this.
        st.undo_stack().push_tombstone(
            "Undo Delete",
            "Permanently deleted items can't be restored.",
        );

        Ok(touched.iter().map(|p| crate::paths::to_display(p)).collect())
    })
    .await
    .map_err(|_| FsError::internal("The delete worker stopped unexpectedly."))?
}

/* -- transfer ------------------------------------------------------------- */

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferArgs {
    pub sources: Vec<String>,
    pub dest_dir: String,
    pub mode: TransferMode,
    #[serde(default = "default_policy")]
    pub policy: ConflictPolicy,
    #[serde(default)]
    pub overrides: HashMap<String, ConflictPolicy>,
}

fn default_policy() -> ConflictPolicy {
    ConflictPolicy::Ask
}

#[tauri::command]
pub async fn preflight_transfer(args: TransferArgs) -> Result<Preflight, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let sources = validated_paths(&args.sources).unwrap_or_default();
        let dest = crate::paths::validate(&args.dest_dir)?;
        preflight(&sources, &dest, args.mode)
    })
    .await
    .map_err(|_| FsError::internal("The pre-flight worker stopped unexpectedly."))?
}

#[tauri::command]
pub async fn start_transfer(
    args: TransferArgs,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<u64, FsError> {
    crate::fs::conflicts::require_resolved(args.policy)?;

    let sources = validated_paths(&args.sources)?;
    let dest = crate::paths::validate_dir(&args.dest_dir)?;
    let mode = args.mode;
    let kind = if mode == TransferMode::Copy { JobKind::Copy } else { JobKind::Move };

    // Totals come from the pre-flight walk of the top level, so the bar starts
    // determinate for the common case and simply has no total for deep trees.
    let pf = preflight(&sources, &dest, mode)?;
    let st = state.inner().clone();
    let (job_id, cancel, snapshot) =
        st.jobs.start(kind, (Some(pf.source_count), Some(pf.total_bytes)));

    let policy = args.policy;
    let overrides = args.overrides;

    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let mut emitter = Emitter::new(app.clone(), snapshot);
        let mut on_progress = |p: transfer::Progress| {
            emitter.tick(p.items_done, p.bytes_done, None);
        };

        let outcome = transfer::run(
            transfer::TransferRequest { sources, dest, mode, policy, overrides },
            &cancel,
            &mut on_progress,
        );
        emitter.flush();

        let finished = match outcome {
            Ok(out) => {
                let undo_label = push_transfer_undo(&st, kind, &out);
                JobFinished {
                    job_id,
                    kind,
                    status: if out.cancelled { JobStatus::Cancelled } else { JobStatus::Completed },
                    items_done: out.items_done,
                    bytes_done: out.bytes_done,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    replaced: out.replaced,
                    skipped: out.skipped,
                    renamed: out.renamed,
                    errors: out.errors,
                    errors_truncated: out.errors_truncated,
                    error_count: out.error_count,
                    touched_dirs: out
                        .touched_dirs
                        .iter()
                        .map(|p| crate::paths::to_display(p))
                        .collect(),
                    undo_label,
                }
            }
            Err(e) => JobFinished {
                job_id,
                kind,
                status: JobStatus::Failed,
                items_done: 0,
                bytes_done: 0,
                elapsed_ms: started.elapsed().as_millis() as u64,
                replaced: 0,
                skipped: 0,
                renamed: 0,
                errors: vec![e],
                errors_truncated: false,
                error_count: 1,
                touched_dirs: Vec::new(),
                undo_label: None,
            },
        };

        st.jobs.finish(job_id);
        let _ = app.emit_to("main", EVENT_FINISHED, &finished);
    });

    Ok(job_id)
}

/// Turn an outcome into the single undo entry that reverses it.
fn push_transfer_undo(
    st: &AppState,
    kind: JobKind,
    out: &transfer::TransferOutcome,
) -> Option<String> {
    let stamp = now_secs();
    let inner = if kind == JobKind::Move && !out.moved.is_empty() {
        UndoAction::Move { pairs: out.moved.clone() }
    } else if !out.created_files.is_empty() || !out.created_dirs.is_empty() {
        UndoAction::Copy {
            files: out.created_files.clone(),
            dirs: out.created_dirs.clone(),
        }
    } else {
        return None;
    };

    // Anything trashed to make room is restored first when this is undone.
    let action = if out.trashed.is_empty() {
        inner
    } else {
        UndoAction::Replace {
            victims: out.trashed.iter().map(|p| TrashRef::new(p, stamp)).collect(),
            inner: Box::new(inner),
        }
    };

    let label = match kind {
        JobKind::Move => "Undo Move",
        JobKind::Duplicate => "Undo Duplicate",
        _ => "Undo Copy",
    }
    .to_owned();

    st.undo_stack().push(label.clone(), action, out.touched_dirs.clone());
    Some(label)
}

#[tauri::command]
pub async fn duplicate_entries(
    paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, FsError> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let items = validated_paths(&paths)?;
        let mut created_files = Vec::new();
        let mut created_dirs = Vec::new();
        let mut touched = Vec::new();
        let mut out_paths = Vec::new();

        for src in &items {
            let Some(dir) = src.parent() else { continue };
            let Some(name) = src.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            let dup = names::duplicate_name(dir, &name)?;
            let target = dir.join(&dup);

            let md = std::fs::symlink_metadata(src).map_err(|e| FsError::from_io(&e, src))?;
            if md.is_dir() {
                copy_tree(src, &target, &mut created_files, &mut created_dirs)?;
            } else {
                std::fs::copy(src, &target).map_err(|e| FsError::from_io(&e, src))?;
                created_files.push(target.clone());
            }
            out_paths.push(crate::paths::to_display(&target));
            let d = dir.to_path_buf();
            if !touched.contains(&d) {
                touched.push(d);
            }
        }

        if !created_files.is_empty() || !created_dirs.is_empty() {
            st.undo_stack().push(
                "Undo Duplicate",
                UndoAction::Copy { files: created_files, dirs: created_dirs },
                touched,
            );
        }
        Ok(out_paths)
    })
    .await
    .map_err(|_| FsError::internal("The duplicate worker stopped unexpectedly."))?
}

fn copy_tree(
    src: &std::path::Path,
    target: &std::path::Path,
    files: &mut Vec<PathBuf>,
    dirs: &mut Vec<PathBuf>,
) -> Result<(), FsError> {
    std::fs::create_dir_all(target).map_err(|e| FsError::from_io(&e, target))?;
    dirs.push(target.to_path_buf());

    let entries = std::fs::read_dir(src).map_err(|e| FsError::from_io(&e, src))?;
    for entry in entries.flatten() {
        let child = entry.path();
        let Ok(md) = entry.metadata() else { continue };
        // Never follow a reparse point while recursing.
        use std::os::windows::fs::MetadataExt;
        if crate::fs::attrs::decode(md.file_attributes()) & crate::ipc::attr::REPARSE != 0 {
            continue;
        }
        let dest = target.join(entry.file_name());
        if md.is_dir() {
            copy_tree(&child, &dest, files, dirs)?;
        } else {
            std::fs::copy(&child, &dest).map_err(|e| FsError::from_io(&e, &child))?;
            files.push(dest);
        }
    }
    Ok(())
}

/* -- jobs and undo -------------------------------------------------------- */

#[tauri::command]
pub async fn cancel_job(job_id: u64, state: tauri::State<'_, AppState>) -> Result<(), FsError> {
    state.jobs.cancel(job_id);
    Ok(())
}

#[tauri::command]
pub async fn active_jobs(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::jobs::JobProgress>, FsError> {
    Ok(state.jobs.active())
}

#[tauri::command]
pub async fn undo_peek(state: tauri::State<'_, AppState>) -> Result<Option<UndoLabel>, FsError> {
    Ok(state.undo_stack().peek())
}

#[tauri::command]
pub async fn undo(state: tauri::State<'_, AppState>) -> Result<UndoOutcome, FsError> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || st.undo_stack().undo())
        .await
        .map_err(|_| FsError::internal("The undo worker stopped unexpectedly."))?
}

use crate::error::FsError;
use crate::ipc::{DirPage, FileMeta, ReadDirRequest};

#[tauri::command]
pub async fn read_dir(req: ReadDirRequest) -> Result<DirPage, FsError> {
    tauri::async_runtime::spawn_blocking(move || crate::fs::read_dir::run(req))
        .await
        .map_err(|_| FsError::internal("The directory read worker stopped unexpectedly."))?
}

/// Lazy disclosure-triangle resolution for tree mode. Never called in bulk --
/// see the "optimistic triangles" decision in `fs::read_dir`.
#[tauri::command]
pub async fn has_children(dir: String) -> Result<bool, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = crate::paths::validate_dir(&dir)?;
        Ok(crate::fs::read_dir::has_children(&p))
    })
    .await
    .map_err(|_| FsError::internal("The directory probe worker stopped unexpectedly."))?
}

#[tauri::command]
pub async fn stat(path: String) -> Result<FileMeta, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = crate::paths::validate_existing(&path)?;
        crate::fs::read_dir::stat(&p)
    })
    .await
    .map_err(|_| FsError::internal("The metadata worker stopped unexpectedly."))?
}

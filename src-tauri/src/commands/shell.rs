use crate::error::FsError;
use crate::ipc::ClipboardFiles;

#[tauri::command]
pub async fn open_path(path: String) -> Result<(), FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = crate::paths::validate_existing(&path)?;
        crate::win::shellexec::open(&p)
    })
    .await
    .map_err(|_| FsError::internal("The shell worker stopped unexpectedly."))?
}

/// The file list currently on the Windows clipboard, if any -- what lets
/// Ctrl+V paste files copied or cut in Explorer.
#[tauri::command]
pub async fn clipboard_files() -> Result<Option<ClipboardFiles>, FsError> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::win::clipboard::read_files().map(|opt| {
            opt.map(|f| ClipboardFiles { paths: f.paths, is_move: f.is_move })
        })
    })
    .await
    .map_err(|_| FsError::internal("The shell worker stopped unexpectedly."))?
}

#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> Result<(), FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = crate::paths::validate_existing(&path)?;
        crate::win::shellexec::reveal(&p)
    })
    .await
    .map_err(|_| FsError::internal("The shell worker stopped unexpectedly."))?
}

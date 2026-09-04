use crate::error::FsError;
use crate::ipc::{DriveInfo, KnownFolders};

#[tauri::command]
pub async fn list_drives() -> Result<Vec<DriveInfo>, FsError> {
    tauri::async_runtime::spawn_blocking(crate::win::drives::enumerate)
        .await
        .map_err(|_| FsError::internal("The drive enumeration worker stopped unexpectedly."))
}

#[tauri::command]
pub async fn known_folders() -> Result<KnownFolders, FsError> {
    tauri::async_runtime::spawn_blocking(crate::win::known_folders::all)
        .await
        .map_err(|_| FsError::internal("The known-folder worker stopped unexpectedly."))
}

use crate::error::FsError;

#[tauri::command]
pub async fn open_path(path: String) -> Result<(), FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = crate::paths::validate_existing(&path)?;
        crate::win::shellexec::open(&p)
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

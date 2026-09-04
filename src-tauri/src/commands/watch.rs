use crate::error::FsError;
use crate::state::AppState;

#[tauri::command]
pub async fn watch_dir(
    dir: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), FsError> {
    let path = crate::paths::validate_dir(&dir)?;
    state.watchers().acquire(&path, &app)
}

#[tauri::command]
pub async fn unwatch_dir(dir: String, state: tauri::State<'_, AppState>) -> Result<(), FsError> {
    // Deliberately tolerant: a directory can vanish while a view still holds a
    // reference to it, and failing to release would leak the watch.
    let path = crate::paths::validate(&dir)?;
    state.watchers().release(&path);
    Ok(())
}

#[tauri::command]
pub async fn watch_count(state: tauri::State<'_, AppState>) -> Result<usize, FsError> {
    Ok(state.watchers().count())
}

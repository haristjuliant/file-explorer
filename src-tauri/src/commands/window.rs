use crate::error::FsError;

/// Report where the maximize button sits, so Windows can offer Snap Layouts.
///
/// Called by the UI whenever the toolbar lays out. Coordinates are physical
/// pixels relative to the client area; the UI multiplies by the device pixel
/// ratio, because the hit test works in physical pixels while CSS does not.
#[tauri::command]
pub async fn set_caption_button_rect(x: i32, y: i32, w: i32, h: i32) -> Result<(), FsError> {
    crate::win::caption::set_button_rect(x, y, w, h);
    Ok(())
}

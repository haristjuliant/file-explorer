use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

use crate::error::{ErrCode, FsError};

/// Report where the maximize button sits, so Windows can offer Snap Layouts.
///
/// Called by the UI whenever the toolbar lays out. Coordinates are physical
/// pixels relative to the client area; the UI multiplies by the device pixel
/// ratio, because the hit test works in physical pixels while CSS does not.
///
/// `window` is injected by Tauri from whichever window sent the request --
/// with more than one window open (see `new_window`), each reports its own
/// button separately.
#[tauri::command]
pub async fn set_caption_button_rect(
    window: tauri::WebviewWindow,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), FsError> {
    if let Ok(hwnd) = window.hwnd() {
        crate::win::caption::set_button_rect(hwnd.0 as isize, x, y, w, h);
    }
    Ok(())
}

/// One label per window opened after the first. `main`, declared in
/// `tauri.conf.json`, is reserved -- every window opened from inside the app
/// counts up from here instead.
static NEXT_WINDOW: AtomicU32 = AtomicU32::new(1);

/// Open another top-level window onto the same app, landing wherever a fresh
/// launch would (see `useInitialDirectory` on the frontend). It shares this
/// process's backend state -- the directory cache, watchers, undo stack -- the
/// same way two Explorer windows share one shell process.
#[tauri::command]
pub async fn new_window(app: AppHandle) -> Result<(), FsError> {
    let label = format!("window-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));

    // Mirrors the `main` window's own config in `tauri.conf.json`: same size,
    // same undecorated chrome, same everything, so a second window looks and
    // behaves exactly like the first. It starts hidden too -- `main.tsx`
    // shows it itself once the first paint lands, which is what stops a
    // flash of an empty white rectangle in either window.
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("Finder")
        .inner_size(1180.0, 760.0)
        .min_inner_size(720.0, 420.0)
        .center()
        .resizable(true)
        .decorations(false)
        .transparent(false)
        .shadow(true)
        .background_color(tauri::utils::config::Color(30, 30, 30, 255))
        .drag_and_drop(false)
        .zoom_hotkeys_enabled(false)
        .visible(false)
        .build()
        .map_err(|e| {
            FsError::new(ErrCode::Internal, format!("Could not open a new window: {e}"))
        })?;

    // Same Snap Layouts treatment the main window gets in `lib.rs::run`.
    if let Ok(hwnd) = window.hwnd() {
        crate::win::caption::install(hwnd.0 as isize);
    }

    Ok(())
}

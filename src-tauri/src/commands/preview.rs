use std::path::Path;

use crate::error::FsError;
use crate::preview::text::TextHead;
use crate::preview::{PlanRequest, PreviewPlan};
use crate::state::AppState;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbResult {
    /// Plain path to the cached thumbnail; the frontend converts it to an
    /// `asset:` URL with Tauri's own helper.
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// Grant asset-protocol access to the directory holding `path`.
fn grant_parent(app: &tauri::AppHandle, state: &AppState, path: &Path) -> Result<(), FsError> {
    if let Some(parent) = path.parent() {
        state.grant_preview_scope(app, parent)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn preview_plan(
    path: String,
    max_px: u32,
    allow_hydrate: Option<bool>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<PreviewPlan, FsError> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = crate::paths::validate_existing(&path)?;
        let meta = crate::fs::read_dir::stat(&p)?;

        // Scope is granted BEFORE the plan is returned. A blocked asset request
        // renders an empty box and logs nothing anywhere, so leaving this to
        // the frontend is how this feature silently breaks.
        grant_parent(&app, &st, &p)?;
        // The thumbnail cache lives under the app cache directory, which the
        // static scope already covers, but granting it explicitly keeps the
        // ImageThumb path working even if that config changes.
        st.grant_preview_scope(&app, st.thumbs.root()).ok();

        crate::preview::plan(
            PlanRequest {
                path: &p,
                max_px: max_px.clamp(32, 4096),
                flags: meta.flags,
                is_dir: meta.is_dir,
                allow_hydrate: allow_hydrate.unwrap_or(false),
            },
            &st.thumbs,
        )
    })
    .await
    .map_err(|_| FsError::internal("The preview worker stopped unexpectedly."))?
}

#[tauri::command]
pub async fn read_text_head(path: String, max_bytes: Option<u64>) -> Result<TextHead, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = crate::paths::validate_existing(&path)?;
        crate::preview::text::read_head(&p, max_bytes)
    })
    .await
    .map_err(|_| FsError::internal("The text preview worker stopped unexpectedly."))?
}

#[tauri::command]
pub async fn thumbnail(
    path: String,
    size: u32,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ThumbResult, FsError> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = crate::paths::validate_existing(&path)?;
        let (file, dims) = st.thumbs.get_or_create(&p, size.clamp(32, 4096))?;
        st.grant_preview_scope(&app, st.thumbs.root())?;
        Ok(ThumbResult {
            path: crate::paths::to_display(&file),
            width: dims.width,
            height: dims.height,
        })
    })
    .await
    .map_err(|_| FsError::internal("The thumbnail worker stopped unexpectedly."))?
}

/// Warm the cache for the items either side of the cursor.
///
/// Fire and forget: failures are per-file and irrelevant to the caller, which is
/// why this returns nothing. Quick Look calls it so that stepping with the arrow
/// keys feels instant.
#[tauri::command]
pub async fn prefetch_thumbnails(
    paths: Vec<String>,
    size: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), FsError> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Capped so a runaway caller cannot queue thousands of decodes.
        for raw in paths.into_iter().take(8) {
            if let Ok(p) = crate::paths::validate_existing(&raw) {
                let _ = st.thumbs.get_or_create(&p, size.clamp(32, 4096));
            }
        }
    })
    .await
    .map_err(|_| FsError::internal("The prefetch worker stopped unexpectedly."))
}

use crate::error::FsError;
use crate::search::{run, SearchRequest};
use crate::state::AppState;

#[tauri::command]
pub async fn start_search(
    req: SearchRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<u64, FsError> {
    let st = state.inner().clone();
    // Starting a new search cancels the previous one: two searches streaming
    // into one result list would interleave.
    st.cancel_all_searches();

    let (job_id, cancel) = st.start_search();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = run(&app, job_id, req, &cancel);
        st.finish_search(job_id);
    });
    Ok(job_id)
}

#[tauri::command]
pub async fn cancel_search(job_id: u64, state: tauri::State<'_, AppState>) -> Result<(), FsError> {
    state.cancel_search(job_id);
    Ok(())
}

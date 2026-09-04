mod commands;
mod error;
mod fs;
mod ipc;
mod jobs;
mod paths;
mod preview;
mod search;
mod state;
mod undo;
mod watch;
mod win;

#[cfg(test)]
mod bench;
#[cfg(test)]
mod tests;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let cache_dir = app.path().app_cache_dir()?.join("cache");
            std::fs::create_dir_all(&cache_dir)?;

            let state = state::AppState::new(cache_dir);
            state.init_watchers(app.handle().clone());
            state.spawn_cache_sweep();
            app.manage(state);

            // Snap Layouts only appear when the window reports HTMAXBUTTON, and
            // an undecorated window never does on its own.
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(hwnd) = window.hwnd() {
                    win::caption::install(hwnd.0 as isize);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Signal every running job and give it a moment to notice.
                // Without this a copy in flight leaves a torn partial file
                // behind, because nothing else will clean it up.
                if let Some(state) = window.try_state::<state::AppState>() {
                    state.jobs.cancel_all();
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::dir::read_dir,
            commands::dir::has_children,
            commands::dir::stat,
            commands::drives::list_drives,
            commands::drives::known_folders,
            commands::fileops::create_folder,
            commands::fileops::rename_entry,
            commands::fileops::trash_entries,
            commands::fileops::delete_permanently,
            commands::fileops::preflight_transfer,
            commands::fileops::start_transfer,
            commands::fileops::duplicate_entries,
            commands::fileops::cancel_job,
            commands::fileops::active_jobs,
            commands::fileops::undo_peek,
            commands::fileops::undo,
            commands::preview::preview_plan,
            commands::preview::read_text_head,
            commands::preview::thumbnail,
            commands::preview::prefetch_thumbnails,
            commands::search::start_search,
            commands::search::cancel_search,
            commands::shell::open_path,
            commands::shell::reveal_in_explorer,
            commands::watch::watch_dir,
            commands::watch::unwatch_dir,
            commands::watch::watch_count,
            commands::window::set_caption_button_rect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

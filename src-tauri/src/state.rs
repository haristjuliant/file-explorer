//! Shared application state.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Manager};

use crate::error::FsError;
use crate::jobs::JobRegistry;
use crate::preview::cache::ThumbCache;
use crate::undo::UndoStack;
use crate::watch::WatchRegistry;

/// How many directories may be granted to the asset protocol at once.
///
/// The static scope in `tauri.conf.json` covers only the thumbnail cache: a file
/// manager cannot enumerate in advance what it may read, and a wide-open scope
/// would hand any successful XSS a read primitive over the whole disk. So the
/// scope is widened one directory at a time as the user navigates, and the
/// oldest grant is revoked once this many are live -- otherwise a long session
/// slowly accumulates a grant over everything.
const SCOPE_LRU_CAP: usize = 32;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

pub struct Inner {
    pub thumbs: ThumbCache,
    pub jobs: JobRegistry,
    /// The undo stack lives here, not in the frontend: it holds Recycle Bin
    /// references only Rust can act on, and it must survive a webview reload.
    pub undo: Mutex<UndoStack>,
    watchers: OnceLock<WatchRegistry>,
    next_search: AtomicU64,
    searches: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    granted: Mutex<VecDeque<PathBuf>>,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(cache_dir: PathBuf) -> Self {
        Self(Arc::new(Inner {
            thumbs: ThumbCache::new(cache_dir.join("thumbs")),
            jobs: JobRegistry::default(),
            undo: Mutex::new(UndoStack::default()),
            watchers: OnceLock::new(),
            next_search: AtomicU64::new(0),
            searches: Mutex::new(HashMap::new()),
            granted: Mutex::new(VecDeque::new()),
        }))
    }

    /// Allow the asset protocol to read one directory, non-recursively.
    ///
    /// Non-recursive matters: previewing a file in Pictures must not expose
    /// every subtree beneath it.
    pub fn grant_preview_scope(&self, app: &AppHandle, dir: &Path) -> Result<(), FsError> {
        let mut granted = self.granted.lock().unwrap_or_else(|e| e.into_inner());
        if granted.iter().any(|p| p == dir) {
            return Ok(());
        }

        app.asset_protocol_scope()
            .allow_directory(dir, false)
            .map_err(|e| FsError::internal(format!("could not grant preview access: {e}")))?;
        granted.push_back(dir.to_path_buf());

        while granted.len() > SCOPE_LRU_CAP {
            if let Some(old) = granted.pop_front() {
                let _ = app.asset_protocol_scope().forbid_directory(&old, false);
            }
        }
        Ok(())
    }

    /// The watcher registry, created on first use.
    ///
    /// It needs an `AppHandle` to emit change events, which does not exist when
    /// the state is constructed, so it is initialised once at setup.
    pub fn init_watchers(&self, app: AppHandle) {
        let _ = self.watchers.set(WatchRegistry::new(app));
    }

    pub fn watchers(&self) -> &WatchRegistry {
        self.watchers
            .get()
            .expect("watch registry must be initialised during setup")
    }

    pub fn start_search(&self) -> (u64, Arc<AtomicBool>) {
        let id = self.next_search.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = Arc::new(AtomicBool::new(false));
        self.searches_lock().insert(id, cancel.clone());
        (id, cancel)
    }

    pub fn cancel_search(&self, id: u64) {
        if let Some(c) = self.searches_lock().get(&id) {
            c.store(true, Ordering::Relaxed);
        }
    }

    /// Starting a new search cancels every earlier one.
    pub fn cancel_all_searches(&self) {
        for c in self.searches_lock().values() {
            c.store(true, Ordering::Relaxed);
        }
    }

    pub fn finish_search(&self, id: u64) {
        self.searches_lock().remove(&id);
    }

    fn searches_lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Arc<AtomicBool>>> {
        self.searches.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A poisoned lock must degrade, not cascade.
    pub fn undo_stack(&self) -> std::sync::MutexGuard<'_, UndoStack> {
        self.undo.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Sweep the thumbnail cache on a background thread at startup. It walks
    /// potentially thousands of files, so it must never block the launch.
    pub fn spawn_cache_sweep(&self) {
        let state = self.clone();
        std::thread::Builder::new()
            .name("thumb-cache-sweep".into())
            .spawn(move || state.thumbs.sweep())
            .ok();
    }
}

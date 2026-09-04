//! Filesystem watching.
//!
//! Column mode watches one directory per column and tree mode watches every
//! expanded node, so the registry is reference counted: a directory is watched
//! exactly while at least one view holds it.
//!
//! A change triggers a full re-read of the affected directory rather than a
//! delta. Reading a typical directory costs 1-5 ms, so delta application saves
//! nothing perceptible -- while `notify` on Windows genuinely drops and reorders
//! events under load, and a delta-only frontend would desync and show rows that
//! are not there.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::Emitter as _;

use crate::error::{ErrCode, FsError};

pub const EVENT_CHANGE: &str = "fs:change";
pub const EVENT_DROPPED: &str = "fs:watch-dropped";

/// Hard cap on live watches.
///
/// Each watch is a directory handle plus a kernel buffer. Beyond this the
/// least-recently-touched is dropped and the frontend told, which is better
/// than an unbounded handle count.
const MAX_WATCHES: usize = 96;

/// One save from an editor produces three to eight events -- temp create,
/// write, rename, attribute change -- within a few milliseconds. This window
/// collapses them into one refresh while still feeling immediate.
const FLUSH_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    /// Directories to re-read.
    pub dirs: Vec<String>,
    /// Watched directories that have themselves disappeared.
    pub gone: Vec<String>,
    /// Set when events were lost and the frontend must re-read regardless.
    pub rescan: bool,
}

struct Inner {
    watcher: RecommendedWatcher,
    /// Canonical lowercase key -> reference count.
    refs: HashMap<String, u32>,
    /// The real path behind each key, for `unwatch`.
    paths: HashMap<String, PathBuf>,
    /// Least-recently-touched first.
    order: VecDeque<String>,
}

pub struct WatchRegistry {
    inner: Mutex<Option<Inner>>,
}

impl WatchRegistry {
    /// Create the watcher and start the coalescing thread.
    ///
    /// If `notify` cannot start at all the app still runs: watching degrades to
    /// nothing rather than blocking launch.
    pub fn new(app: tauri::AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();

        // The notify callback runs on notify's own thread and must never block,
        // so it does nothing but hand the event off.
        let watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        });

        let inner = match watcher {
            Ok(watcher) => {
                spawn_coalescer(app, rx);
                Some(Inner {
                    watcher,
                    refs: HashMap::new(),
                    paths: HashMap::new(),
                    order: VecDeque::new(),
                })
            }
            Err(_) => None,
        };

        Self { inner: Mutex::new(inner) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Inner>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Begin watching, or bump the reference count if already watched.
    pub fn acquire(&self, dir: &Path, app: &tauri::AppHandle) -> Result<(), FsError> {
        let key = crate::paths::watch_key(dir);
        let mut guard = self.lock();
        let Some(inner) = guard.as_mut() else { return Ok(()) };

        if let Some(count) = inner.refs.get_mut(&key) {
            *count += 1;
            touch(&mut inner.order, &key);
            return Ok(());
        }

        if inner.refs.len() >= MAX_WATCHES {
            evict_one(inner, app);
        }

        // Always non-recursive: a recursive watch on a drive root delivers
        // millions of events, where a hundred non-recursive watches are cheap.
        inner
            .watcher
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|e| {
                FsError::new(ErrCode::Internal, format!("Could not watch this folder: {e}"))
                    .with_path(dir)
            })?;

        inner.refs.insert(key.clone(), 1);
        inner.paths.insert(key.clone(), dir.to_path_buf());
        inner.order.push_back(key);
        Ok(())
    }

    /// Release one reference, unwatching when the last consumer goes.
    pub fn release(&self, dir: &Path) {
        let key = crate::paths::watch_key(dir);
        let mut guard = self.lock();
        let Some(inner) = guard.as_mut() else { return };

        let Some(count) = inner.refs.get_mut(&key) else { return };
        *count = count.saturating_sub(1);
        if *count > 0 {
            return;
        }
        remove(inner, &key);
    }

    pub fn count(&self) -> usize {
        self.lock().as_ref().map(|i| i.refs.len()).unwrap_or(0)
    }

    /// Drop every watch under a volume, so a USB stick can be safely ejected.
    ///
    /// A watched directory keeps a handle that marks the VOLUME busy, which is
    /// exactly what blocks eject.
    #[allow(dead_code)] // wired to drive removal in the polish phase
    pub fn release_volume(&self, volume: &str) {
        let v = volume.to_lowercase();
        let mut guard = self.lock();
        let Some(inner) = guard.as_mut() else { return };

        let keys: Vec<String> = inner
            .paths
            .iter()
            .filter(|(_, p)| crate::fs::conflicts::volume_of(p) == v)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            remove(inner, &key);
        }
    }
}

fn touch(order: &mut VecDeque<String>, key: &str) {
    if let Some(i) = order.iter().position(|k| k == key) {
        order.remove(i);
    }
    order.push_back(key.to_owned());
}

fn remove(inner: &mut Inner, key: &str) {
    if let Some(path) = inner.paths.remove(key) {
        let _ = inner.watcher.unwatch(&path);
    }
    inner.refs.remove(key);
    if let Some(i) = inner.order.iter().position(|k| k == key) {
        inner.order.remove(i);
    }
}

fn evict_one(inner: &mut Inner, app: &tauri::AppHandle) {
    let Some(key) = inner.order.front().cloned() else { return };
    let display = inner
        .paths
        .get(&key)
        .map(|p| crate::paths::to_display(p))
        .unwrap_or_else(|| key.clone());
    remove(inner, &key);
    // Tell the frontend so it can fall back to a periodic refresh for that
    // node rather than silently going stale.
    let _ = app.emit_to("main", EVENT_DROPPED, &vec![display]);
}

/// Own the accumulator on one dedicated thread and flush on a fixed tick.
fn spawn_coalescer(app: tauri::AppHandle, rx: mpsc::Receiver<notify::Result<notify::Event>>) {
    std::thread::Builder::new()
        .name("fs-coalescer".into())
        .spawn(move || {
            let mut dirty: HashSet<PathBuf> = HashSet::new();
            let mut gone: HashSet<PathBuf> = HashSet::new();
            let mut rescan = false;
            let mut last_flush = Instant::now();

            loop {
                match rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(Ok(event)) => absorb(&event, &mut dirty, &mut gone, &mut rescan),
                    // A watcher error means events were lost; the only correct
                    // response is a full re-read, never a guess at the delta.
                    Ok(Err(_)) => rescan = true,
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }

                let big = dirty.len() > 64;
                if (last_flush.elapsed() >= FLUSH_INTERVAL || big)
                    && (!dirty.is_empty() || !gone.is_empty() || rescan)
                {
                    let payload = FsChange {
                        dirs: dirty.iter().map(|p| crate::paths::to_display(p)).collect(),
                        gone: gone.iter().map(|p| crate::paths::to_display(p)).collect(),
                        rescan,
                    };
                    let _ = app.emit_to("main", EVENT_CHANGE, &payload);
                    dirty.clear();
                    gone.clear();
                    rescan = false;
                    last_flush = Instant::now();
                }
            }
        })
        .ok();
}

fn absorb(
    event: &notify::Event,
    dirty: &mut HashSet<PathBuf>,
    gone: &mut HashSet<PathBuf>,
    rescan: &mut bool,
) {
    // Under a storm -- unzipping fifty thousand files into a watched folder --
    // the kernel buffer overflows and events are lost. Reconstructing the
    // missing deltas is impossible; a re-read is the only honest answer.
    if event.need_rescan() {
        *rescan = true;
        return;
    }

    for path in &event.paths {
        // Events name the changed item, so the directory to refresh is its
        // parent. A watched directory that is itself deleted reports on the
        // parent too, which is why disappearance is checked separately.
        if let Some(parent) = path.parent() {
            dirty.insert(parent.to_path_buf());
        }
        if matches!(event.kind, notify::EventKind::Remove(_)) && !path.exists() {
            gone.insert(path.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absorbs_events_into_their_parent_directory() {
        let mut dirty = HashSet::new();
        let mut gone = HashSet::new();
        let mut rescan = false;

        let event = notify::Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            paths: vec![PathBuf::from(r"C:\Users\User\a.txt")],
            attrs: Default::default(),
        };
        absorb(&event, &mut dirty, &mut gone, &mut rescan);

        assert!(dirty.contains(Path::new(r"C:\Users\User")));
        assert!(!rescan);
        assert!(gone.is_empty());
    }

    #[test]
    fn collapses_many_events_in_one_directory_into_a_single_entry() {
        let mut dirty = HashSet::new();
        let mut gone = HashSet::new();
        let mut rescan = false;

        for i in 0..50 {
            let event = notify::Event {
                kind: notify::EventKind::Create(notify::event::CreateKind::File),
                paths: vec![PathBuf::from(format!(r"C:\Users\User\f{i}.txt"))],
                attrs: Default::default(),
            };
            absorb(&event, &mut dirty, &mut gone, &mut rescan);
        }
        // One save, or a git clone, must produce one refresh -- not fifty.
        assert_eq!(dirty.len(), 1);
    }

    #[test]
    fn a_lost_event_batch_demands_a_full_rescan() {
        let mut dirty = HashSet::new();
        let mut gone = HashSet::new();
        let mut rescan = false;

        let mut attrs = notify::event::EventAttributes::new();
        attrs.set_flag(notify::event::Flag::Rescan);
        let event = notify::Event {
            kind: notify::EventKind::Any,
            paths: vec![PathBuf::from(r"C:\Users\User\a.txt")],
            attrs,
        };
        absorb(&event, &mut dirty, &mut gone, &mut rescan);

        assert!(rescan, "lost deltas can only be answered with a re-read");
    }
}

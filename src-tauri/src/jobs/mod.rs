//! Long-running job registry, cancellation, and throttled progress reporting.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::Emitter as _;

use crate::error::FsError;

pub const EVENT_PROGRESS: &str = "job:progress";
pub const EVENT_FINISHED: &str = "job:finished";

/// Hard floor between progress emits.
///
/// Copying 200,000 small files at 5,000 files/s would otherwise be 5,000 events
/// per second; at 10 Hz it is ten. `current` is a SAMPLE of what is being
/// copied, not a log of every file.
const EMIT_INTERVAL: Duration = Duration::from_millis(100);
/// Instantaneous rates jitter wildly and read as broken, so the rate is
/// smoothed and withheld until there is enough signal.
const EWMA_ALPHA: f64 = 0.3;
const ETA_WARMUP: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Delete and Duplicate become jobs when they get progress UI
pub enum JobKind {
    Copy,
    Move,
    Delete,
    Duplicate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub job_id: u64,
    pub kind: JobKind,
    pub items_done: u64,
    pub items_total: Option<u64>,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    /// A sample of the current item, truncated for display.
    pub current: Option<String>,
    pub bytes_per_sec: u64,
    pub eta_secs: Option<u64>,
    pub errors_so_far: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobFinished {
    pub job_id: u64,
    pub kind: JobKind,
    pub status: JobStatus,
    pub items_done: u64,
    pub bytes_done: u64,
    pub elapsed_ms: u64,
    pub replaced: u64,
    pub skipped: u64,
    pub renamed: u64,
    pub errors: Vec<FsError>,
    pub errors_truncated: bool,
    pub error_count: u64,
    /// Directories the frontend should re-read, even unwatched ones.
    pub touched_dirs: Vec<String>,
    pub undo_label: Option<String>,
}

pub struct JobHandle {
    pub cancel: Arc<AtomicBool>,
    pub snapshot: Arc<Mutex<JobProgress>>,
}

#[derive(Default)]
pub struct JobRegistry {
    next_id: AtomicU64,
    jobs: Mutex<HashMap<u64, JobHandle>>,
}

impl JobRegistry {
    pub fn start(&self, kind: JobKind, totals: (Option<u64>, Option<u64>)) -> (u64, Arc<AtomicBool>, Arc<Mutex<JobProgress>>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = Arc::new(AtomicBool::new(false));
        let snapshot = Arc::new(Mutex::new(JobProgress {
            job_id: id,
            kind,
            items_done: 0,
            items_total: totals.0,
            bytes_done: 0,
            bytes_total: totals.1,
            current: None,
            bytes_per_sec: 0,
            eta_secs: None,
            errors_so_far: 0,
        }));
        self.lock().insert(
            id,
            JobHandle { cancel: cancel.clone(), snapshot: snapshot.clone() },
        );
        (id, cancel, snapshot)
    }

    /// Signal cancellation and return immediately.
    ///
    /// It never waits for the worker: the worker notices at its next file or
    /// chunk boundary and performs its own cleanup contract.
    pub fn cancel(&self, id: u64) {
        if let Some(h) = self.lock().get(&id) {
            h.cancel.store(true, Ordering::Relaxed);
        }
    }

    /// Cancel everything, for window close.
    pub fn cancel_all(&self) {
        for h in self.lock().values() {
            h.cancel.store(true, Ordering::Relaxed);
        }
    }

    pub fn finish(&self, id: u64) {
        self.lock().remove(&id);
    }

    #[allow(dead_code)] // used by the UI reconnect path after a reload
    pub fn snapshot(&self, id: u64) -> Option<JobProgress> {
        self.lock()
            .get(&id)
            .and_then(|h| h.snapshot.lock().ok().map(|s| s.clone()))
    }

    pub fn active(&self) -> Vec<JobProgress> {
        self.lock()
            .values()
            .filter_map(|h| h.snapshot.lock().ok().map(|s| s.clone()))
            .collect()
    }

    /// A poisoned lock must degrade, not cascade.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, JobHandle>> {
        self.jobs.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Throttled progress emitter.
///
/// `tick` is called extremely often -- per file, and per megabyte inside a large
/// one -- so the non-emitting path does no allocation and takes one short lock.
pub struct Emitter {
    app: tauri::AppHandle,
    snapshot: Arc<Mutex<JobProgress>>,
    started: Instant,
    last_emit: Instant,
    last_sample: Instant,
    last_bytes: u64,
    rate: f64,
    last_pct: u8,
    dirty: bool,
}

impl Emitter {
    pub fn new(app: tauri::AppHandle, snapshot: Arc<Mutex<JobProgress>>) -> Self {
        let now = Instant::now();
        Self {
            app,
            snapshot,
            started: now,
            last_emit: now,
            last_sample: now,
            last_bytes: 0,
            rate: 0.0,
            last_pct: 255,
            dirty: true,
        }
    }

    pub fn tick(&mut self, items_done: u64, bytes_done: u64, current: Option<&Path>) {
        {
            let mut s = self.lock();
            s.items_done = items_done;
            s.bytes_done = bytes_done;
            if let Some(p) = current {
                let display = crate::paths::to_display(p);
                // Only reallocate when the sampled item actually changed.
                if s.current.as_deref() != Some(display.as_str()) {
                    s.current = Some(display);
                }
            }
        }
        self.dirty = true;

        let pct = self.percent();
        // A whole-percent change forces an emit so a slow job's bar still moves.
        if self.last_emit.elapsed() >= EMIT_INTERVAL || pct != self.last_pct {
            self.flush();
        }
    }

    pub fn flush(&mut self) {
        if !self.dirty {
            return;
        }

        let mut payload = {
            let s = self.lock();
            s.clone()
        };

        let since = self.last_sample.elapsed().as_secs_f64();
        if since > 0.05 {
            let delta = payload.bytes_done.saturating_sub(self.last_bytes) as f64;
            let instant = delta / since;
            self.rate = if self.rate == 0.0 {
                instant
            } else {
                EWMA_ALPHA * instant + (1.0 - EWMA_ALPHA) * self.rate
            };
            self.last_sample = Instant::now();
            self.last_bytes = payload.bytes_done;
        }

        payload.bytes_per_sec = self.rate as u64;
        payload.eta_secs = match payload.bytes_total {
            Some(total) if self.rate > 1.0 && self.started.elapsed() >= ETA_WARMUP => {
                Some(((total.saturating_sub(payload.bytes_done)) as f64 / self.rate) as u64)
            }
            _ => None,
        };

        {
            let mut s = self.lock();
            s.bytes_per_sec = payload.bytes_per_sec;
            s.eta_secs = payload.eta_secs;
        }

        // Errors are ignored: the window may already be gone.
        let _ = self.app.emit_to("main", EVENT_PROGRESS, &payload);
        self.last_emit = Instant::now();
        self.last_pct = self.percent();
        self.dirty = false;
    }

    fn percent(&self) -> u8 {
        let s = self.lock();
        match s.bytes_total {
            Some(total) if total > 0 => ((s.bytes_done * 100) / total).min(100) as u8,
            _ => 255,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, JobProgress> {
        self.snapshot.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hands_out_distinct_ids_and_tracks_active_jobs() {
        let reg = JobRegistry::default();
        let (a, _, _) = reg.start(JobKind::Copy, (Some(2), Some(10)));
        let (b, _, _) = reg.start(JobKind::Move, (None, None));
        assert_ne!(a, b);
        assert_eq!(reg.active().len(), 2);

        reg.finish(a);
        assert_eq!(reg.active().len(), 1);
        assert!(reg.snapshot(a).is_none());
    }

    #[test]
    fn cancel_sets_the_flag_without_waiting_for_the_worker() {
        let reg = JobRegistry::default();
        let (id, cancel, _) = reg.start(JobKind::Copy, (None, None));
        assert!(!cancel.load(Ordering::Relaxed));

        reg.cancel(id);
        assert!(cancel.load(Ordering::Relaxed));
    }

    #[test]
    fn cancel_all_stops_every_job_for_window_close() {
        let reg = JobRegistry::default();
        let (_, c1, _) = reg.start(JobKind::Copy, (None, None));
        let (_, c2, _) = reg.start(JobKind::Delete, (None, None));

        reg.cancel_all();
        assert!(c1.load(Ordering::Relaxed));
        assert!(c2.load(Ordering::Relaxed));
    }

    #[test]
    fn cancelling_an_unknown_job_is_harmless() {
        let reg = JobRegistry::default();
        reg.cancel(9999);
        reg.finish(9999);
    }

    #[test]
    fn the_snapshot_survives_for_a_ui_that_reconnects_mid_job() {
        let reg = JobRegistry::default();
        let (id, _, snapshot) = reg.start(JobKind::Copy, (Some(3), Some(300)));
        snapshot.lock().expect("lock").bytes_done = 150;

        let seen = reg.snapshot(id).expect("snapshot");
        assert_eq!(seen.bytes_done, 150);
        assert_eq!(seen.bytes_total, Some(300));
    }
}

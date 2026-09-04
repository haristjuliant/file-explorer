//! Recursive search.
//!
//! Results stream to the frontend in batches. Batching happens HERE rather than
//! only in the UI: emitting one event per hit is the classic source of jank, and
//! a search of a large tree can produce thousands of hits per second.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::Emitter as _;

use crate::error::FsError;
use crate::ipc::{attr, DirEntry};

pub const EVENT_BATCH: &str = "search:batch";

/// Emit whenever either threshold is reached.
const BATCH_SIZE: usize = 128;
const BATCH_INTERVAL: Duration = Duration::from_millis(125);

/// Above this the UI stops appending but keeps counting.
///
/// The virtualizer copes with far more; sorting and re-rendering half a million
/// rows on every flush does not.
const DEFAULT_MAX_HITS: usize = 20_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchMode {
    #[default]
    Substring,
    /// `*` and `?` only; a full glob engine is not worth a dependency here.
    Glob,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub root: String,
    pub query: String,
    #[serde(default)]
    pub match_mode: MatchMode,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub max_depth: Option<usize>,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default)]
    pub max_hits: Option<usize>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// The directory holding the item, so the UI can show a relative path.
    pub dir: String,
    pub entry: DirEntry,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchBatch {
    pub job_id: u64,
    pub hits: Vec<SearchHit>,
    pub scanned_dirs: u64,
    pub scanned_entries: u64,
    pub hit_total: u64,
    pub hit_cap_reached: bool,
    pub done: bool,
    pub cancelled: bool,
}

/// Case-insensitive substring, or a `*`/`?` glob.
pub fn matches(name: &str, query: &str, mode: MatchMode, case_sensitive: bool) -> bool {
    if query.is_empty() {
        return false;
    }
    let (name, query) = if case_sensitive {
        (name.to_owned(), query.to_owned())
    } else {
        (name.to_lowercase(), query.to_lowercase())
    };

    match mode {
        MatchMode::Substring => name.contains(&query),
        MatchMode::Glob => glob_match(name.as_bytes(), query.as_bytes()),
    }
}

/// Iterative `*`/`?` matcher with backtracking; no recursion, no dependency.
fn glob_match(name: &[u8], pattern: &[u8]) -> bool {
    let (mut n, mut p) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);

    while n < name.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == name[n]) {
            n += 1;
            p += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = p;
            mark = n;
            p += 1;
        } else if star != usize::MAX {
            // Backtrack: let the last `*` swallow one more character.
            p = star + 1;
            mark += 1;
            n = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

/// Directories never worth walking, and guaranteed to waste time or fail.
fn is_skippable(name: &str) -> bool {
    matches!(
        name,
        "$Recycle.Bin" | "System Volume Information" | "$RECYCLE.BIN" | "Config.Msi"
    )
}

pub fn run(
    app: &tauri::AppHandle,
    job_id: u64,
    req: SearchRequest,
    cancel: &AtomicBool,
) -> Result<(), FsError> {
    let root = crate::paths::validate_dir(&req.root)?;
    let max_hits = req.max_hits.unwrap_or(DEFAULT_MAX_HITS);

    let mut walker = walkdir::WalkDir::new(&root)
        // The one thing between "search my home folder" and an endless walk
        // through the legacy AppData junctions.
        .follow_links(false);
    if let Some(depth) = req.max_depth {
        walker = walker.max_depth(depth);
    }

    let mut pending: Vec<SearchHit> = Vec::with_capacity(BATCH_SIZE);
    let mut scanned_dirs = 0u64;
    let mut scanned_entries = 0u64;
    let mut hit_total = 0u64;
    let mut last_emit = Instant::now();
    let mut cap_reached = false;

    let mut it = walker.into_iter();
    loop {
        if cancel.load(Ordering::Relaxed) {
            emit(app, job_id, &mut pending, scanned_dirs, scanned_entries, hit_total, cap_reached, true, true);
            return Ok(());
        }

        let Some(next) = it.next() else { break };
        let entry = match next {
            Ok(e) => e,
            // An unreadable subtree is normal on a real machine; skip it rather
            // than abandoning the whole search.
            Err(_) => continue,
        };

        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().is_dir();

        if is_dir {
            scanned_dirs += 1;
            if is_skippable(&name) {
                it.skip_current_dir();
                continue;
            }
        } else {
            scanned_entries += 1;
        }

        let Ok(md) = entry.metadata() else { continue };
        use std::os::windows::fs::MetadataExt;
        let raw = md.file_attributes();
        let mut flags = crate::fs::attrs::decode(raw);
        if crate::fs::attrs::is_dotfile(&name) {
            flags |= attr::HIDDEN;
        }

        // Never descend through a reparse point, and never surface system items
        // unless asked.
        if is_dir && flags & attr::REPARSE != 0 {
            it.skip_current_dir();
            continue;
        }
        if !req.include_hidden && flags & (attr::HIDDEN | attr::SYSTEM) != 0 {
            if is_dir {
                it.skip_current_dir();
            }
            continue;
        }

        // The root itself is not a result.
        if entry.depth() == 0 {
            continue;
        }

        if matches(&name, &req.query, req.match_mode, req.case_sensitive) {
            hit_total += 1;
            // `hit_total` alone is the count: `pending` is drained on every
            // flush, so adding its length would double-count within a batch.
            if hit_total as usize <= max_hits && !cap_reached {
                let ext = crate::fs::category::ext_of(&name, is_dir);
                let category = crate::fs::category::of(is_dir, &ext, flags);
                pending.push(SearchHit {
                    dir: entry
                        .path()
                        .parent()
                        .map(crate::paths::to_display)
                        .unwrap_or_default(),
                    entry: DirEntry {
                        size: if is_dir { 0 } else { md.file_size() },
                        modified_ms: crate::fs::attrs::filetime_to_ms(md.last_write_time()),
                        name,
                        is_dir,
                        flags,
                        ext,
                        category,
                    },
                });
            } else {
                cap_reached = true;
            }
        }

        if pending.len() >= BATCH_SIZE || last_emit.elapsed() >= BATCH_INTERVAL {
            emit(app, job_id, &mut pending, scanned_dirs, scanned_entries, hit_total, cap_reached, false, false);
            last_emit = Instant::now();
        }
    }

    emit(app, job_id, &mut pending, scanned_dirs, scanned_entries, hit_total, cap_reached, true, false);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit(
    app: &tauri::AppHandle,
    job_id: u64,
    pending: &mut Vec<SearchHit>,
    scanned_dirs: u64,
    scanned_entries: u64,
    hit_total: u64,
    cap_reached: bool,
    done: bool,
    cancelled: bool,
) {
    // A silent tick with nothing to say is not worth an IPC round trip, but the
    // final one always goes so the UI can stop its spinner.
    if pending.is_empty() && !done {
        return;
    }
    let batch = SearchBatch {
        job_id,
        hits: std::mem::take(pending),
        scanned_dirs,
        scanned_entries,
        hit_total,
        hit_cap_reached: cap_reached,
        done,
        cancelled,
    };
    let _ = app.emit_to("main", EVENT_BATCH, &batch);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substring_matching_ignores_case_by_default() {
        assert!(matches("Report.PDF", "report", MatchMode::Substring, false));
        assert!(matches("Report.PDF", "PDF", MatchMode::Substring, false));
        assert!(!matches("Report.PDF", "xyz", MatchMode::Substring, false));
    }

    #[test]
    fn case_sensitivity_can_be_demanded() {
        assert!(!matches("Report.pdf", "report", MatchMode::Substring, true));
        assert!(matches("Report.pdf", "Report", MatchMode::Substring, true));
    }

    #[test]
    fn an_empty_query_matches_nothing() {
        // Otherwise "search" with an empty box would return the whole disk.
        assert!(!matches("anything", "", MatchMode::Substring, false));
    }

    #[test]
    fn glob_handles_stars_and_question_marks() {
        assert!(matches("report.pdf", "*.pdf", MatchMode::Glob, false));
        assert!(matches("report.pdf", "report.*", MatchMode::Glob, false));
        assert!(matches("report.pdf", "r*t.p?f", MatchMode::Glob, false));
        assert!(matches("report.pdf", "*", MatchMode::Glob, false));
        assert!(!matches("report.pdf", "*.txt", MatchMode::Glob, false));
        assert!(!matches("report.pdf", "report", MatchMode::Glob, false));
    }

    #[test]
    fn glob_backtracks_rather_than_giving_up_on_the_first_star() {
        // The naive matcher fails this: the first `*` must be allowed to give
        // characters back.
        assert!(matches("aaa.tar.gz", "*.tar.gz", MatchMode::Glob, false));
        assert!(matches("a.b.c.d", "*.d", MatchMode::Glob, false));
        assert!(matches("xxbyy", "*b*", MatchMode::Glob, false));
    }

    #[test]
    fn glob_matches_multiple_trailing_stars() {
        assert!(matches("abc", "a**", MatchMode::Glob, false));
        assert!(matches("abc", "abc*", MatchMode::Glob, false));
    }

    /// The cap counts hits, not the current batch: `pending` is drained on
    /// every flush, so mixing the two silently truncates results early.
    #[test]
    fn the_hit_cap_counts_total_hits_not_the_pending_batch() {
        let max_hits = 3usize;
        let mut hit_total = 0u64;
        let mut collected = 0usize;
        let mut cap_reached = false;

        for _ in 0..10 {
            hit_total += 1;
            if hit_total as usize <= max_hits && !cap_reached {
                collected += 1;
            } else {
                cap_reached = true;
            }
            // A flush between every hit, which is the case that used to break.
            // Nothing here depends on how many are pending.
        }

        assert_eq!(collected, 3);
        assert_eq!(hit_total, 10, "counting continues past the cap");
        assert!(cap_reached);
    }

    #[test]
    fn skips_directories_that_only_waste_time() {
        assert!(is_skippable("$Recycle.Bin"));
        assert!(is_skippable("System Volume Information"));
        assert!(!is_skippable("Documents"));
    }
}

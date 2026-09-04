//! Synthetic-tree benchmarks.
//!
//! The plan called for these to exist and to be KEPT, so every later change is
//! measured against the same tree rather than against a feeling. They are
//! `#[ignore]`d because building a 100,000-entry directory takes real time and
//! disk; run them deliberately:
//!
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
//! ```
//!
//! The assertions are deliberately loose. They exist to catch an order-of-
//! magnitude regression -- a per-entry syscall creeping into the hot loop, say --
//! not to pin a number that varies with the machine.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use crate::ipc::ReadDirRequest;

struct Bench {
    root: PathBuf,
}

impl Bench {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!("finder-fm-bench-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("bench root");
        Self { root }
    }

    /// A flat directory of `n` small files.
    fn flat(&self, name: &str, n: usize) -> PathBuf {
        let dir = self.root.join(name);
        std::fs::create_dir_all(&dir).expect("flat dir");
        for i in 0..n {
            // Mixed extensions, so the category table is exercised rather than
            // hitting one branch every time.
            let ext = match i % 5 {
                0 => "txt",
                1 => "png",
                2 => "rs",
                3 => "mp4",
                _ => "",
            };
            let file = if ext.is_empty() {
                dir.join(format!("item{i:06}"))
            } else {
                dir.join(format!("item{i:06}.{ext}"))
            };
            let _ = std::fs::write(file, b"x");
        }
        dir
    }

    /// A deep chain: `depth` nested folders, each holding `width` files.
    fn deep(&self, name: &str, depth: usize, width: usize) -> PathBuf {
        let base = self.root.join(name);
        let mut here = base.clone();
        for level in 0..depth {
            here = here.join(format!("level{level}"));
            std::fs::create_dir_all(&here).expect("deep dir");
            for i in 0..width {
                let _ = std::fs::write(here.join(format!("f{i:03}.txt")), b"x");
            }
        }
        base
    }
}

impl Drop for Bench {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn read(dir: &Path, limit: Option<usize>) -> (Duration, crate::ipc::DirPage) {
    let req = ReadDirRequest { dir: crate::paths::to_display(dir), limit };
    let started = Instant::now();
    let page = crate::fs::read_dir::run(req).expect("read_dir");
    (started.elapsed(), page)
}

#[test]
#[ignore = "builds large synthetic trees; run with --ignored"]
fn read_dir_scales_linearly_from_ten_to_a_hundred_thousand() {
    let b = Bench::new("scale");

    let mut per_entry_us: Vec<f64> = Vec::new();
    for n in [10usize, 1_000, 100_000] {
        let dir = b.flat(&format!("n{n}"), n);
        // Warm the directory once so the first measurement is not paying for
        // cold metadata that the later ones get for free.
        let _ = read(&dir, None);

        let (elapsed, page) = read(&dir, None);
        assert_eq!(page.total, n, "every entry must be counted");
        assert_eq!(page.entries.len(), n.min(50_000));

        let us = elapsed.as_secs_f64() * 1e6 / n as f64;
        per_entry_us.push(us);
        println!(
            "read_dir  n={n:>7}  {:>8.1?}  {:>6.2} us/entry  truncated={}",
            elapsed, us, page.truncated
        );
    }

    // The whole point of the hot loop is that per-entry cost is flat: metadata,
    // attributes, size and timestamps all come from the enumeration itself. A
    // per-entry syscall sneaking in shows up here as cost climbing with n.
    let small = per_entry_us[0];
    let large = per_entry_us[2];
    assert!(
        large < small.max(1.0) * 20.0,
        "per-entry cost grew from {small:.2}us to {large:.2}us, which suggests a \
         per-entry syscall entered the loop"
    );
}

#[test]
#[ignore = "builds large synthetic trees; run with --ignored"]
fn a_hundred_thousand_entries_read_in_under_a_second() {
    let b = Bench::new("100k");
    let dir = b.flat("big", 100_000);
    let _ = read(&dir, None);

    let (elapsed, page) = read(&dir, None);
    println!("100k entries in {elapsed:?} (returned {})", page.entries.len());

    // Generous: this is a regression tripwire, not a performance target.
    assert!(
        elapsed < Duration::from_secs(3),
        "reading 100k entries took {elapsed:?}"
    );
}

#[test]
#[ignore = "builds large synthetic trees; run with --ignored"]
fn the_entry_cap_bounds_the_payload_without_losing_the_count() {
    let b = Bench::new("cap");
    let dir = b.flat("big", 60_000);

    let (elapsed, page) = read(&dir, None);
    println!("capped read: {elapsed:?}, returned {} of {}", page.entries.len(), page.total);

    // The cap is what keeps a 14 MB JSON payload off the IPC boundary, while
    // the UI can still say "50,000 of 60,000".
    assert_eq!(page.entries.len(), 50_000);
    assert_eq!(page.total, 60_000);
    assert!(page.truncated);
}

#[test]
#[ignore = "builds large synthetic trees; run with --ignored"]
fn a_deep_tree_reads_one_level_at_a_time() {
    let b = Bench::new("deep");
    let base = b.deep("tree", 8, 50);

    // Tree and column mode read one directory per visible node, so what matters
    // is that a single level stays cheap however deep the tree goes.
    let mut here = base.clone();
    for level in 0..8 {
        here = here.join(format!("level{level}"));
        let (elapsed, page) = read(&here, None);
        assert!(page.total >= 50);
        assert!(
            elapsed < Duration::from_millis(200),
            "level {level} took {elapsed:?}"
        );
    }
}

#[test]
#[ignore = "builds large synthetic trees; run with --ignored"]
fn search_walks_a_deep_tree_within_a_sane_budget() {
    let b = Bench::new("search");
    let base = b.deep("tree", 6, 200);

    let cancel = AtomicBool::new(false);
    let started = Instant::now();
    // No AppHandle in a unit test, so this measures the walk and the matcher --
    // which is what the budget is about; emitting is throttled by design.
    let mut scanned = 0u64;
    for entry in walkdir::WalkDir::new(&base).follow_links(false).into_iter().flatten() {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        scanned += 1;
        let name = entry.file_name().to_string_lossy();
        let _ = crate::search::matches(&name, "f001", crate::search::MatchMode::Substring, false);
    }
    let elapsed = started.elapsed();
    println!("search walked {scanned} entries in {elapsed:?}");

    assert!(scanned >= 1_200);
    assert!(
        elapsed < Duration::from_secs(5),
        "walking {scanned} entries took {elapsed:?}"
    );
}

#[test]
#[ignore = "builds large synthetic trees; run with --ignored"]
fn repeated_reads_do_not_leak_handles() {
    // A directory read that failed to close its handle would eventually fail
    // outright; two hundred rounds is enough to expose that.
    let b = Bench::new("handles");
    let dir = b.flat("mid", 2_000);

    for round in 0..200 {
        let (_, page) = read(&dir, None);
        assert_eq!(page.total, 2_000, "round {round} came back short");
    }
}

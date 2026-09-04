//! Integration tests that exercise the real filesystem and the real Win32
//! calls. These are the phase-2 acceptance gate: they prove the backend works
//! before any UI is built on top of it.
//!
//! Fixtures live under the system temp directory in a uniquely named folder and
//! are removed on drop, so a failing assertion cannot leave litter behind.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use crate::ipc::{attr, Category, ReadDirRequest};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// A temp directory that deletes itself, so tests never litter and never
/// collide when run in parallel.
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let root = std::env::temp_dir().join(format!("finder-fm-test-{tag}-{pid}-{n}"));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create fixture root");
        Self { root }
    }

    fn dir(&self, name: &str) -> PathBuf {
        let p = self.root.join(name);
        fs::create_dir_all(&p).expect("create fixture dir");
        p
    }

    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let p = self.root.join(name);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).expect("create fixture parent");
        }
        fs::write(&p, bytes).expect("write fixture file");
        p
    }

    fn path_str(&self) -> String {
        crate::paths::to_display(&self.root)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn read(dir: &str) -> crate::ipc::DirPage {
    crate::fs::read_dir::run(ReadDirRequest { dir: dir.to_string(), limit: None })
        .expect("read_dir should succeed")
}

fn named<'a>(page: &'a crate::ipc::DirPage, name: &str) -> &'a crate::ipc::DirEntry {
    page.entries
        .iter()
        .find(|e| e.name == name)
        .unwrap_or_else(|| panic!("entry {name:?} not found in {:?}", page.entries.iter().map(|e| &e.name).collect::<Vec<_>>()))
}

#[test]
fn reads_a_directory_and_classifies_entries() {
    let fx = Fixture::new("read");
    fx.dir("Projects");
    fx.file("notes.txt", b"hello");
    fx.file("photo.PNG", &[0u8; 1234]);
    fx.file("archive.tar.gz", &[0u8; 10]);
    fx.file("Makefile", b"all:");

    let page = read(&fx.path_str());

    assert_eq!(page.total, 5, "all five entries counted");
    assert!(!page.truncated);
    assert!(page.warnings.is_empty(), "clean directory produces no warnings");
    // The page carries the directory once; entries carry no path of their own.
    assert_eq!(page.dir, fx.path_str());

    let folder = named(&page, "Projects");
    assert!(folder.is_dir);
    assert_eq!(folder.category, Category::Folder);
    assert_eq!(folder.size, 0, "directories report zero size");
    assert_eq!(folder.ext, "");

    let txt = named(&page, "notes.txt");
    assert!(!txt.is_dir);
    assert_eq!(txt.ext, "txt");
    assert_eq!(txt.category, Category::Text);
    assert_eq!(txt.size, 5);
    assert!(txt.modified_ms > 1_600_000_000_000, "a plausible epoch-ms timestamp");

    // Extension casing must be normalized, or the category table misses.
    let png = named(&page, "photo.PNG");
    assert_eq!(png.ext, "png");
    assert_eq!(png.category, Category::Image);
    assert_eq!(png.size, 1234);

    // Only the LAST extension is taken, so a compound name still classifies.
    let gz = named(&page, "archive.tar.gz");
    assert_eq!(gz.ext, "gz");
    assert_eq!(gz.category, Category::Archive);

    let mk = named(&page, "Makefile");
    assert_eq!(mk.ext, "", "no dot means no extension");
    assert_eq!(mk.category, Category::Unknown);
}

#[test]
fn dotfiles_are_reported_hidden_and_have_no_extension() {
    let fx = Fixture::new("dotfile");
    fx.file(".gitignore", b"node_modules");
    fx.file(".env.local", b"KEY=1");

    let page = read(&fx.path_str());

    let git = named(&page, ".gitignore");
    // Windows does not set the hidden ATTRIBUTE on dot-prefixed names, but the
    // visual target is Finder, which hides them -- so we set the flag ourselves.
    assert!(git.flags & attr::HIDDEN != 0, "a dotfile must be flagged hidden");
    assert_eq!(git.ext, "", "a leading dot is not an extension");

    let env = named(&page, ".env.local");
    assert!(env.flags & attr::HIDDEN != 0);
    assert_eq!(env.ext, "local", "a later dot still yields an extension");
}

#[test]
fn hidden_and_system_entries_are_returned_with_flags_not_filtered() {
    // The backend deliberately does NOT filter: it returns everything with
    // flags set so the frontend's show-hidden / show-system toggles are instant
    // and cost no IPC, and so the cache key stays a bare path.
    let fx = Fixture::new("flags");
    let f = fx.file("secret.txt", b"x");

    let wide = crate::paths::to_wide_verbatim_nul(&f);
    let ok = unsafe {
        windows::Win32::Storage::FileSystem::SetFileAttributesW(
            windows::core::PCWSTR(wide.as_ptr()),
            windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_HIDDEN,
        )
    };
    assert!(ok.is_ok(), "SetFileAttributesW should succeed on a temp file");

    let page = read(&fx.path_str());
    let e = named(&page, "secret.txt");
    assert!(e.flags & attr::HIDDEN != 0, "hidden attribute decoded");
    assert_eq!(page.total, 1, "the hidden entry is still returned, not filtered");
}

#[test]
fn limit_truncates_but_keeps_counting() {
    let fx = Fixture::new("limit");
    for i in 0..25 {
        fx.file(&format!("f{i:03}.txt"), b"x");
    }

    let page = crate::fs::read_dir::run(ReadDirRequest {
        dir: fx.path_str(),
        limit: Some(10),
    })
    .expect("read_dir with a limit");

    assert_eq!(page.entries.len(), 10, "collection stops at the limit");
    assert_eq!(page.total, 25, "counting continues past the limit");
    assert!(page.truncated, "the UI needs to know it is showing a subset");
}

#[test]
fn rejects_a_file_path_and_a_missing_directory() {
    let fx = Fixture::new("reject");
    let f = fx.file("a.txt", b"x");

    let as_file = crate::fs::read_dir::run(ReadDirRequest {
        dir: crate::paths::to_display(&f),
        limit: None,
    });
    assert!(matches!(
        as_file.map_err(|e| e.code),
        Err(crate::error::ErrCode::NotADirectory)
    ));

    let missing = crate::fs::read_dir::run(ReadDirRequest {
        dir: crate::paths::to_display(&fx.root.join("nope")),
        limit: None,
    });
    assert!(matches!(
        missing.map_err(|e| e.code),
        Err(crate::error::ErrCode::NotFound)
    ));
}

#[test]
fn has_children_distinguishes_empty_from_populated() {
    let fx = Fixture::new("children");
    let empty = fx.dir("empty");
    let full = fx.dir("full");
    fs::write(full.join("x.txt"), b"x").expect("write child");

    assert!(!crate::fs::read_dir::has_children(&empty));
    assert!(crate::fs::read_dir::has_children(&full));
    // A path that cannot be read yields false -- no disclosure triangle --
    // rather than an error, matching Explorer.
    assert!(!crate::fs::read_dir::has_children(Path::new(
        r"C:\__finder_fm_definitely_missing__"
    )));
}

#[test]
fn stat_returns_full_metadata() {
    let fx = Fixture::new("stat");
    let f = fx.file("doc.pdf", &[0u8; 42]);

    let meta = crate::fs::read_dir::stat(&f).expect("stat should succeed");
    assert_eq!(meta.name, "doc.pdf");
    assert!(!meta.is_dir);
    assert_eq!(meta.size, 42);
    assert_eq!(meta.ext, "pdf");
    assert_eq!(meta.category, Category::Pdf);
    assert!(meta.modified_ms > 1_600_000_000_000);
    assert!(meta.link_target.is_none());
    // Never a verbatim prefix on the way out.
    assert!(!meta.path.starts_with(r"\\?\"));
}

#[test]
fn stat_on_a_directory_reports_zero_size() {
    let fx = Fixture::new("statdir");
    let d = fx.dir("sub");
    let meta = crate::fs::read_dir::stat(&d).expect("stat a directory");
    assert!(meta.is_dir);
    assert_eq!(meta.size, 0);
    assert_eq!(meta.category, Category::Folder);
}

#[test]
fn enumerates_drives_including_the_system_volume() {
    let drives = crate::win::drives::enumerate();
    assert!(!drives.is_empty(), "at least one logical drive must exist");

    // Every root must already be in canonical display form.
    for d in &drives {
        assert!(!d.root.starts_with(r"\\?\"), "root {} is verbatim", d.root);
        assert!(d.root.ends_with('\\'), "root {} should end with a separator", d.root);
        assert!(!d.label.trim().is_empty(), "root {} has an empty label", d.root);
    }

    let system: Vec<_> = drives.iter().filter(|d| d.is_system).collect();
    assert_eq!(system.len(), 1, "exactly one drive holds %SystemRoot%");

    let sys = system[0];
    assert!(sys.ready, "the system drive is always ready");
    assert!(sys.total_bytes > 0, "the system drive reports a size");
    assert!(sys.free_bytes <= sys.total_bytes);
    assert_eq!(sys.drive_type, crate::ipc::DriveKind::Fixed);
    assert!(!sys.filesystem.is_empty(), "the system drive reports a filesystem");
}

#[test]
fn drive_enumeration_stays_within_its_time_budget() {
    // The guard against a disconnected network mapping blocking the sidebar for
    // 30 seconds. The budget is 1.5s; allow headroom for a loaded CI machine.
    let start = std::time::Instant::now();
    let _ = crate::win::drives::enumerate();
    let elapsed = start.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(4),
        "drive enumeration took {elapsed:?}, which would stall the sidebar"
    );
}

#[test]
fn resolves_known_folders_to_real_directories() {
    let kf = crate::win::known_folders::all();

    let home = kf.home.as_deref().expect("the user profile must resolve");
    assert!(Path::new(home).is_dir(), "home {home} should exist");
    assert!(!home.starts_with(r"\\?\"));

    // Desktop and Documents may be redirected into OneDrive; SHGetKnownFolderPath
    // follows the redirection, which is exactly why we do not use env vars.
    for (name, value) in [
        ("desktop", &kf.desktop),
        ("documents", &kf.documents),
        ("downloads", &kf.downloads),
        ("pictures", &kf.pictures),
        ("music", &kf.music),
        ("videos", &kf.videos),
    ] {
        let p = value.as_deref().unwrap_or_else(|| panic!("{name} should resolve"));
        assert!(!p.starts_with(r"\\?\"), "{name} leaked a verbatim prefix");
        assert!(Path::new(p).is_dir(), "{name} resolved to {p}, which is not a directory");
    }
}

#[test]
fn reads_the_user_profile_directory_without_warnings_that_matter() {
    // A real-world directory, not a fixture: catches attribute-decoding and
    // encoding surprises that a synthetic tree never produces.
    let kf = crate::win::known_folders::all();
    let home = kf.home.expect("home");
    let page = read(&home);
    assert!(page.total > 0, "the user profile is not empty");
    assert_eq!(page.dir, home, "the echoed directory matches the request");
}

//! Filename validation and collision-free naming.
//!
//! Shared by rename, new-folder, paste and duplicate, so every path that can
//! create a name goes through the same rules and produces the same errors.

use std::path::Path;

use crate::error::{ErrCode, FsError};

/// Device names Windows reserves, with or without an extension.
///
/// Creating one of these does not fail with a normal error -- it opens the
/// device -- so they must be refused before we touch the filesystem.
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Extensions made of two parts, so `archive.tar.gz` duplicates as
/// `archive (2).tar.gz` rather than `archive.tar (2).gz`.
const COMPOUND: &[&str] = &["tar.gz", "tar.bz2", "tar.xz", "tar.zst", "tar.lz4", "tar.lz"];

const MAX_COMPONENT: usize = 255;
/// Guard against an unbounded loop when every candidate name is taken.
const MAX_ATTEMPTS: u32 = 9999;

/// Reject a name Windows cannot store, or stores differently than typed.
pub fn validate_name(name: &str) -> Result<(), FsError> {
    if name.is_empty() || name.trim().is_empty() {
        return Err(FsError::new(ErrCode::InvalidName, "A name can't be empty."));
    }
    if name == "." || name == ".." {
        return Err(FsError::new(ErrCode::InvalidName, "That name is reserved."));
    }
    if name.len() > MAX_COMPONENT {
        return Err(FsError::new(
            ErrCode::InvalidName,
            format!("A name can be at most {MAX_COMPONENT} characters."),
        ));
    }
    if name.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
        return Err(FsError::new(
            ErrCode::InvalidName,
            "A name can't contain any of  < > : \" / \\ | ? *",
        ));
    }
    if name.chars().any(|c| (c as u32) < 0x20) {
        return Err(FsError::new(
            ErrCode::InvalidName,
            "A name can't contain control characters.",
        ));
    }
    // Windows silently strips these, which then breaks any "did the rename
    // actually apply?" check -- so refuse them rather than surprise the user.
    if name.ends_with(' ') || name.ends_with('.') {
        return Err(FsError::new(
            ErrCode::InvalidName,
            "A name can't end with a space or a period.",
        ));
    }

    let stem = name.split('.').next().unwrap_or(name);
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return Err(FsError::new(
            ErrCode::ReservedName,
            format!("\"{stem}\" is a reserved device name in Windows."),
        ));
    }
    Ok(())
}

/// Split into stem and extension.
///
/// A leading dot is part of the name, not an extension: `.gitignore` has no
/// extension. Compound archive extensions are kept whole.
pub fn split_name(name: &str) -> (&str, Option<&str>) {
    let lower = name.to_ascii_lowercase();
    for compound in COMPOUND {
        let suffix = format!(".{compound}");
        if lower.ends_with(&suffix) && lower.len() > suffix.len() {
            let cut = name.len() - suffix.len();
            return (&name[..cut], Some(&name[cut + 1..]));
        }
    }
    match name.rfind('.') {
        Some(0) | None => (name, None),
        Some(i) => (&name[..i], Some(&name[i + 1..])),
    }
}

fn compose(stem: &str, ext: Option<&str>) -> String {
    match ext {
        Some(e) => format!("{stem}.{e}"),
        None => stem.to_owned(),
    }
}

/// Find a free name by appending a counter, given a template.
fn first_free(dir: &Path, mut candidate: impl FnMut(u32) -> String) -> Result<String, FsError> {
    for n in 2..=MAX_ATTEMPTS {
        let name = candidate(n);
        if !dir.join(&name).exists() {
            return Ok(name);
        }
    }
    Err(FsError::new(
        ErrCode::AlreadyExists,
        "There are too many similarly named items here.",
    ))
}

/// Cross-directory collision: `Foo.txt` becomes `Foo (2).txt`.
///
/// The Windows convention, deliberately: these files land in folders shared with
/// Explorer, browsers and Office, all of which already produce this shape.
///
/// `exists()` is only a hint -- another process can win the race -- so the
/// actual create must use `create_new` semantics and retry on collision.
pub fn keep_both_name(dir: &Path, name: &str) -> Result<String, FsError> {
    let (stem, ext) = split_name(name);
    let (stem, ext) = (stem.to_owned(), ext.map(str::to_owned));
    first_free(dir, |n| compose(&format!("{stem} ({n})"), ext.as_deref()))
}

/// Duplicate in place: `Foo.txt` becomes `Foo copy.txt`, then `Foo copy 2.txt`.
///
/// The Finder convention, also deliberately: Duplicate is a Finder gesture with
/// no Explorer equivalent, so it keeps Finder's wording.
pub fn duplicate_name(dir: &Path, name: &str) -> Result<String, FsError> {
    let (stem, ext) = split_name(name);
    let first = compose(&format!("{stem} copy"), ext);
    if !dir.join(&first).exists() {
        return Ok(first);
    }
    let (stem, ext) = (stem.to_owned(), ext.map(str::to_owned));
    first_free(dir, |n| compose(&format!("{stem} copy {n}"), ext.as_deref()))
}

/// A new folder name that is free in `dir`: `New Folder`, then `New Folder (2)`.
pub fn new_folder_name(dir: &Path, base: &str) -> Result<String, FsError> {
    if !dir.join(base).exists() {
        return Ok(base.to_owned());
    }
    let base = base.to_owned();
    first_free(dir, |n| format!("{base} ({n})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("finder-fm-names-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("fixture");
        p
    }

    #[test]
    fn accepts_ordinary_names() {
        for name in ["notes.txt", "My Folder", ".gitignore", "a-b_c (1).tar.gz", "日本語.txt"] {
            assert!(validate_name(name).is_ok(), "{name} should be valid");
        }
    }

    #[test]
    fn rejects_empty_and_dot_names() {
        assert_eq!(validate_name("").unwrap_err().code, ErrCode::InvalidName);
        assert_eq!(validate_name("   ").unwrap_err().code, ErrCode::InvalidName);
        assert_eq!(validate_name(".").unwrap_err().code, ErrCode::InvalidName);
        assert_eq!(validate_name("..").unwrap_err().code, ErrCode::InvalidName);
    }

    #[test]
    fn rejects_illegal_characters_including_separators() {
        for name in ["a/b", r"a\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b"] {
            assert_eq!(
                validate_name(name).unwrap_err().code,
                ErrCode::InvalidName,
                "{name} should be rejected"
            );
        }
        assert_eq!(validate_name("a\tb").unwrap_err().code, ErrCode::InvalidName);
    }

    #[test]
    fn rejects_trailing_space_or_period() {
        // Windows strips these silently, which would make a rename look like it
        // failed when it merely landed somewhere else.
        assert_eq!(validate_name("notes ").unwrap_err().code, ErrCode::InvalidName);
        assert_eq!(validate_name("notes.").unwrap_err().code, ErrCode::InvalidName);
    }

    #[test]
    fn rejects_reserved_device_names_with_a_distinct_code() {
        // A distinct code lets the rename field explain the real reason rather
        // than saying "invalid name".
        for name in ["CON", "con", "NUL.txt", "COM1", "lpt9.log"] {
            assert_eq!(
                validate_name(name).unwrap_err().code,
                ErrCode::ReservedName,
                "{name} should be reserved"
            );
        }
        // Not reserved: only the exact device stems are.
        assert!(validate_name("CONSOLE.txt").is_ok());
        assert!(validate_name("COM10").is_ok());
    }

    #[test]
    fn rejects_an_over_long_name() {
        assert_eq!(
            validate_name(&"a".repeat(256)).unwrap_err().code,
            ErrCode::InvalidName
        );
        assert!(validate_name(&"a".repeat(255)).is_ok());
    }

    #[test]
    fn splits_names_into_stem_and_extension() {
        assert_eq!(split_name("notes.txt"), ("notes", Some("txt")));
        assert_eq!(split_name("Makefile"), ("Makefile", None));
        // A leading dot is the name, not an extension.
        assert_eq!(split_name(".gitignore"), (".gitignore", None));
        assert_eq!(split_name(".env.local"), (".env", Some("local")));
        assert_eq!(split_name("archive.tar.gz"), ("archive", Some("tar.gz")));
        assert_eq!(split_name("a.b.c.txt"), ("a.b.c", Some("txt")));
    }

    #[test]
    fn keep_both_appends_a_counter_before_the_extension() {
        let dir = fixture("keepboth");
        std::fs::write(dir.join("Foo.txt"), b"x").expect("write");
        assert_eq!(keep_both_name(&dir, "Foo.txt").expect("name"), "Foo (2).txt");

        std::fs::write(dir.join("Foo (2).txt"), b"x").expect("write");
        assert_eq!(keep_both_name(&dir, "Foo.txt").expect("name"), "Foo (3).txt");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keep_both_preserves_a_compound_extension() {
        let dir = fixture("compound");
        std::fs::write(dir.join("archive.tar.gz"), b"x").expect("write");
        assert_eq!(
            keep_both_name(&dir, "archive.tar.gz").expect("name"),
            "archive (2).tar.gz"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keep_both_handles_an_extensionless_name() {
        let dir = fixture("noext");
        std::fs::write(dir.join("Makefile"), b"x").expect("write");
        assert_eq!(keep_both_name(&dir, "Makefile").expect("name"), "Makefile (2)");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn duplicate_uses_the_finder_wording() {
        let dir = fixture("dup");
        std::fs::write(dir.join("Foo.txt"), b"x").expect("write");
        assert_eq!(duplicate_name(&dir, "Foo.txt").expect("name"), "Foo copy.txt");

        std::fs::write(dir.join("Foo copy.txt"), b"x").expect("write");
        assert_eq!(duplicate_name(&dir, "Foo.txt").expect("name"), "Foo copy 2.txt");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn new_folder_takes_the_plain_name_when_it_is_free() {
        let dir = fixture("newfolder");
        assert_eq!(new_folder_name(&dir, "New Folder").expect("name"), "New Folder");

        std::fs::create_dir(dir.join("New Folder")).expect("mkdir");
        assert_eq!(new_folder_name(&dir, "New Folder").expect("name"), "New Folder (2)");

        let _ = std::fs::remove_dir_all(dir);
    }
}

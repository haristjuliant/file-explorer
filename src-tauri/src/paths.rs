//! Windows path discipline.
//!
//! Two representations exist and must NEVER be mixed:
//!
//!   * **display** form (`to_display`, via `dunce::simplified`) is the only shape
//!     that crosses the IPC boundary. It never carries a verbatim prefix, because
//!     shipping verbatim paths to the UI means ugly breadcrumbs and paths that
//!     some external tools reject.
//!   * **verbatim** form (`to_wide_verbatim_nul`) is what OUR OWN Win32 calls get.
//!     `std::fs` converts internally and needs no help; `ShellExecuteW` and
//!     friends do not.
//!
//! Canonicalization happens ONCE, at the command boundary. Canonicalizing inside
//! a loop is the classic accidental-O(n)-syscalls bug.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

use crate::error::{ErrCode, FsError};

/// The verbatim prefix that lifts MAX_PATH for Win32 calls.
const VERBATIM: &str = r"\\?\";
/// The verbatim prefix for UNC paths.
const VERBATIM_UNC: &str = r"\\?\UNC\";
/// A UNC path prefix (two separators).
const UNC: &str = r"\\";
/// The Win32 device namespace, e.g. the physical-drive devices.
const DEVICE: &str = r"\\.\";

/// The only path shape the frontend ever sees.
pub fn to_display(p: &Path) -> String {
    dunce::simplified(p).to_string_lossy().into_owned()
}

/// Like `fs::canonicalize`, but `dunce` strips the verbatim prefix whenever the
/// result is expressible as a plain path.
pub fn canonical(p: &Path) -> Result<PathBuf, FsError> {
    dunce::canonicalize(p).map_err(|e| FsError::from_io(&e, p))
}

/// Key for the watcher registry and every cache: canonical plus lowercased,
/// because NTFS is case-insensitive and two casings of one path must not
/// produce two watchers or two cache entries.
#[allow(dead_code)] // used by the watcher registry in the file-operations phase
pub fn watch_key(p: &Path) -> String {
    to_display(p).to_lowercase()
}

/// Reject hostile or malformed input before touching the filesystem.
pub fn validate(input: &str) -> Result<PathBuf, FsError> {
    if input.trim().is_empty() {
        return Err(FsError::new(ErrCode::InvalidName, "Empty path."));
    }
    if input.contains('\0') {
        return Err(FsError::new(
            ErrCode::InvalidName,
            "Path contains a NUL character.",
        ));
    }
    // Device namespaces and verbatim prefixes are ours to construct, never the
    // frontend's to send.
    if input.starts_with(DEVICE) || input.starts_with(VERBATIM) {
        return Err(FsError::new(
            ErrCode::Unsupported,
            "Device and verbatim paths are not accepted from the UI.",
        ));
    }

    let p = PathBuf::from(input);
    match p.components().next() {
        // A drive prefix (C:) or a UNC share prefix.
        Some(Component::Prefix(_)) => {}
        _ => {
            return Err(FsError::new(
                ErrCode::InvalidName,
                r"Path must be absolute: a drive letter, or \\server\share.",
            ))
        }
    }
    // After canonicalization there is nothing left to traverse, so a parent-dir
    // component arriving from the frontend is a bug (or an attack). Reject it
    // rather than resolving it.
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(FsError::new(
            ErrCode::InvalidName,
            "Path must not contain a parent-directory component.",
        ));
    }
    Ok(p)
}

/// `validate` plus canonicalize, requiring an existing directory.
pub fn validate_dir(input: &str) -> Result<PathBuf, FsError> {
    let raw = validate(input)?;
    let p = canonical(&raw)?;
    let md = std::fs::metadata(&p).map_err(|e| FsError::from_io(&e, &p))?;
    if !md.is_dir() {
        return Err(
            FsError::new(ErrCode::NotADirectory, "That path is not a folder.").with_path(&p)
        );
    }
    Ok(p)
}

/// `validate` plus canonicalize. The item may be a file or a directory.
pub fn validate_existing(input: &str) -> Result<PathBuf, FsError> {
    let raw = validate(input)?;
    canonical(&raw)
}

/// NUL-terminated UTF-16, for Win32 calls taking a plain path.
pub fn to_wide_nul(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// NUL-terminated UTF-16 carrying a verbatim prefix, lifting the MAX_PATH limit
/// for our own Win32 calls.
///
/// `std::fs` already does this internally, which is exactly why the result must
/// never be handed back to `std`.
#[allow(dead_code)] // used by tests now, and by the shell-icon / preview phases
pub fn to_wide_verbatim_nul(p: &Path) -> Vec<u16> {
    let s = p.to_string_lossy();
    let prefixed = if s.starts_with(VERBATIM) {
        s.into_owned()
    } else if let Some(rest) = s.strip_prefix(UNC) {
        format!("{VERBATIM_UNC}{rest}")
    } else {
        format!("{VERBATIM}{s}")
    };
    to_wide_nul(&prefixed)
}

/// Parent directory, or `None` at a drive or share root.
#[allow(dead_code)] // used by the transfer engine in the file-operations phase
pub fn parent_of(p: &Path) -> Option<PathBuf> {
    p.parent()
        .map(Path::to_path_buf)
        .filter(|q| !q.as_os_str().is_empty())
}

/// True when the path lives on a UNC share. Network paths get different policy:
/// no eager child probing, no automatic thumbnailing, longer timeouts.
#[allow(dead_code)] // used by the search and thumbnail policy checks
pub fn is_unc(p: &Path) -> bool {
    p.to_string_lossy().starts_with(UNC)
}

/// Decode a NUL-terminated or fixed-length UTF-16 buffer into a `String`.
pub fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_and_traversal() {
        assert!(validate("Users").is_err());
        assert!(validate(r"C:\Users\..\Windows").is_err());
        assert!(validate("").is_err());
    }

    #[test]
    fn rejects_device_and_verbatim_from_the_ui() {
        assert!(validate(r"\\.\PhysicalDrive0").is_err());
        assert!(validate(r"\\?\C:\Users").is_err());
    }

    #[test]
    fn accepts_drive_and_unc_roots() {
        assert!(validate(r"C:\").is_ok());
        assert!(validate(r"C:\Users\User").is_ok());
        assert!(validate(r"\\server\share\dir").is_ok());
    }

    #[test]
    fn verbatim_prefixing_handles_unc_and_plain_paths() {
        let plain = to_wide_verbatim_nul(Path::new(r"C:\Users"));
        assert_eq!(wide_to_string(&plain), r"\\?\C:\Users");

        let unc = to_wide_verbatim_nul(Path::new(r"\\server\share\dir"));
        assert_eq!(wide_to_string(&unc), r"\\?\UNC\server\share\dir");

        // Already verbatim: must not be double-prefixed.
        let already = to_wide_verbatim_nul(Path::new(r"\\?\C:\Users"));
        assert_eq!(wide_to_string(&already), r"\\?\C:\Users");
    }

    #[test]
    fn wide_to_string_stops_at_the_nul() {
        let buf = [0x43u16, 0x3A, 0x5C, 0x00, 0x58, 0x58];
        assert_eq!(wide_to_string(&buf), r"C:\");
    }
}

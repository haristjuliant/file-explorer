//! Opening items in their default application, and revealing them in Explorer.

use std::path::Path;

use windows::core::PCWSTR;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::error::{ErrCode, FsError};

/// `ShellExecuteW` does NOT accept verbatim-prefixed paths, so a path past
/// MAX_PATH cannot be opened this way and is reported honestly instead of
/// failing silently.
pub fn open(path: &Path) -> Result<(), FsError> {
    let s = path.to_string_lossy();
    if s.len() >= 260 {
        return Err(FsError::new(
            ErrCode::PathTooLong,
            "This path is too long for Windows to open in its default app.",
        )
        .with_path(path));
    }

    let file = crate::paths::to_wide_nul(&s);
    let op = crate::paths::to_wide_nul("open");
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(op.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };

    // ShellExecuteW returns a pseudo-HINSTANCE: values <= 32 are error codes.
    let code = result.0 as isize;
    if code > 32 {
        return Ok(());
    }
    Err(match code {
        2 | 3 => FsError::new(ErrCode::NotFound, "This item no longer exists.").with_path(path),
        5 => FsError::new(ErrCode::AccessDenied, "Windows refused to open this item.")
            .with_path(path),
        31 => FsError::new(
            ErrCode::Unsupported,
            "No app is associated with this file type.",
        )
        .with_path(path),
        _ => FsError::new(ErrCode::Internal, format!("Windows could not open this item (code {code}).")).with_path(path),
    })
}

/// Reveal in Explorer with the item selected.
///
/// `explorer.exe /select,<path>` instead of COM `SHOpenFolderAndSelectItems`:
/// same visible result, no ITEMIDLIST allocation, no apartment requirement, and
/// no third-party shell extension loaded into our process.
///
/// Explorer exits with a non-zero code on success in some Windows builds, so
/// the exit status is deliberately not checked -- only the spawn is.
pub fn reveal(path: &Path) -> Result<(), FsError> {
    let arg = format!("/select,{}", crate::paths::to_display(path));
    std::process::Command::new("explorer.exe")
        .arg(arg)
        .spawn()
        .map(|_| ())
        .map_err(|e| FsError::from_io(&e, path))
}

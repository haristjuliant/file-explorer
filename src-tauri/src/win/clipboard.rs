//! Reading the file list Explorer puts on the clipboard for Ctrl+C / Ctrl+X,
//! so `paste` inside this app works the same way it does between two Explorer
//! windows.
//!
//! Deliberately raw `windows` calls rather than a clipboard crate: every other
//! OS integration in this codebase (`known_folders`, `drives`, `shellexec`)
//! is written the same way, and CF_HDROP plus the "Preferred DropEffect"
//! format are a handful of calls, not enough to earn a dependency.

use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
use windows::Win32::UI::Shell::DragQueryFileW;

use crate::error::{ErrCode, FsError};

/// The standard predefined clipboard format for a dropped/copied file list.
/// `windows-rs` does not re-export the predefined `CF_*` constants under a
/// stable path across versions, so it is spelled out here.
const CF_HDROP: u32 = 15;

/// `DROPEFFECT_MOVE`, read back from Explorer's "Preferred DropEffect" format
/// to tell a Cut from a Copy.
const DROPEFFECT_MOVE: u32 = 2;

pub struct ClipboardFiles {
    pub paths: Vec<String>,
    pub is_move: bool,
}

struct OpenedClipboard;

impl OpenedClipboard {
    fn new() -> Result<Self, FsError> {
        unsafe { OpenClipboard(None) }
            .map_err(|_| FsError::new(ErrCode::Internal, "Could not open the clipboard."))?;
        Ok(Self)
    }
}

impl Drop for OpenedClipboard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

/// Read one `u32` out of a global-memory clipboard format, e.g. the
/// "Preferred DropEffect" flags. Returns `None` for any failure -- a missing
/// or malformed format is not an error, just information Explorer chose not
/// to provide.
fn read_global_u32(format: u32) -> Option<u32> {
    unsafe {
        if IsClipboardFormatAvailable(format).is_err() {
            return None;
        }
        let handle = GetClipboardData(format).ok()?;
        let hglobal = HGLOBAL(handle.0);
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            return None;
        }
        let value = (ptr as *const u32).read_unaligned();
        let _ = GlobalUnlock(hglobal);
        Some(value)
    }
}

/// The list of files Explorer (or anything else) last copied or cut, if any.
///
/// `None` when the clipboard holds no file list at all -- distinct from an
/// empty `Vec`, though in practice CF_HDROP is never present with zero files.
pub fn read_files() -> Result<Option<ClipboardFiles>, FsError> {
    let _clip = OpenedClipboard::new()?;

    if unsafe { IsClipboardFormatAvailable(CF_HDROP) }.is_err() {
        return Ok(None);
    }

    let handle = unsafe { GetClipboardData(CF_HDROP) }
        .map_err(|_| FsError::new(ErrCode::Internal, "Could not read the clipboard."))?;
    let hdrop = windows::Win32::UI::Shell::HDROP(handle.0);

    let count = unsafe { DragQueryFileW(hdrop, u32::MAX, None) };
    let mut paths = Vec::with_capacity(count as usize);
    for i in 0..count {
        let len = unsafe { DragQueryFileW(hdrop, i, None) };
        if len == 0 {
            continue;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let written = unsafe { DragQueryFileW(hdrop, i, Some(&mut buf)) };
        if written == 0 {
            continue;
        }
        buf.truncate(written as usize);
        paths.push(crate::paths::to_display(std::path::Path::new(
            &String::from_utf16_lossy(&buf),
        )));
    }

    let drop_effect_format = unsafe {
        RegisterClipboardFormatW(windows::core::w!("Preferred DropEffect"))
    };
    let is_move = drop_effect_format != 0
        && read_global_u32(drop_effect_format)
            .is_some_and(|flags| flags & DROPEFFECT_MOVE != 0);

    Ok(Some(ClipboardFiles { paths, is_move }))
}

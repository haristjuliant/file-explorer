//! Known-folder resolution via `SHGetKnownFolderPath`.
//!
//! Deliberately NOT `dirs`/`directories` or Tauri's `app.path().document_dir()`:
//! those resolve through environment variables and get the answer wrong when
//! Documents/Pictures are redirected into OneDrive, which is the common case on
//! consumer Windows 11. The shell API follows the redirection.

use windows::core::GUID;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{
    SHGetKnownFolderPath, FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads,
    FOLDERID_Music, FOLDERID_Pictures, FOLDERID_Profile, FOLDERID_Videos, KF_FLAG_DEFAULT,
};

use crate::ipc::KnownFolders;

fn resolve(id: &GUID) -> Option<String> {
    unsafe {
        let pwstr = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        if pwstr.is_null() {
            return None;
        }
        let s = pwstr.to_string().ok();
        // The shell allocated this with CoTaskMemAlloc; we must free it.
        CoTaskMemFree(Some(pwstr.0 as *const _));
        // Normalize through our own display form so every path in the app has
        // one shape.
        s.map(|s| crate::paths::to_display(std::path::Path::new(&s)))
    }
}

pub fn all() -> KnownFolders {
    KnownFolders {
        home: resolve(&FOLDERID_Profile),
        desktop: resolve(&FOLDERID_Desktop),
        documents: resolve(&FOLDERID_Documents),
        downloads: resolve(&FOLDERID_Downloads),
        pictures: resolve(&FOLDERID_Pictures),
        music: resolve(&FOLDERID_Music),
        videos: resolve(&FOLDERID_Videos),
        // No FOLDERID for a personal OneDrive root; the env var is the
        // documented way to find it and is absent when OneDrive is not set up.
        one_drive: std::env::var("OneDrive")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .filter(|s| std::path::Path::new(s).is_dir()),
    }
}

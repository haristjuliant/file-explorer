//! Logical drive enumeration.
//!
//! Two Windows-specific hazards are handled here and nowhere else:
//!
//!   1. `SetThreadErrorMode(SEM_FAILCRITICALERRORS)` must be set BEFORE querying
//!      a volume. Without it, `GetVolumeInformationW` on an empty optical drive
//!      pops a MODAL SYSTEM DIALOG ("There is no disk in the drive") that the
//!      user cannot dismiss from our UI.
//!   2. A disconnected mapped network drive blocks `GetDiskFreeSpaceExW` for up
//!      to ~30 seconds. Each drive is therefore queried on its own thread under
//!      a wall-clock budget; on timeout it is reported `ready: false` and shown
//!      greyed rather than omitted.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem as wfs;
use windows::Win32::System::Diagnostics::Debug::{SetThreadErrorMode, SEM_FAILCRITICALERRORS};
// The DRIVE_* constants live in WindowsProgramming, not FileSystem, even though
// GetDriveTypeW itself is in FileSystem.
use windows::Win32::System::WindowsProgramming::{
    DRIVE_CDROM, DRIVE_FIXED, DRIVE_RAMDISK, DRIVE_REMOTE, DRIVE_REMOVABLE,
};

use crate::ipc::{DriveInfo, DriveKind};

/// Total wall-clock budget for the whole enumeration.
const BUDGET: Duration = Duration::from_millis(1500);

pub fn enumerate() -> Vec<DriveInfo> {
    let roots = logical_drive_roots();
    if roots.is_empty() {
        return Vec::new();
    }

    let system_root = std::env::var("SystemRoot").unwrap_or_default().to_uppercase();

    // Fan out: one thread per drive so a single wedged network mapping cannot
    // delay the others.
    let mut pending = Vec::with_capacity(roots.len());
    for root in roots {
        let (tx, rx) = mpsc::channel::<DriveInfo>();
        let r = root.clone();
        let sys = system_root.clone();
        std::thread::spawn(move || {
            let _ = tx.send(probe(&r, &sys));
        });
        pending.push((root, rx));
    }

    let deadline = Instant::now() + BUDGET;
    let mut out = Vec::with_capacity(pending.len());
    for (root, rx) in pending {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(info) => out.push(info),
            // Timed out or the worker died: report the drive as present but not
            // ready. The probe thread stays parked in the kernel and exits on
            // its own; that is preferable to blocking the sidebar.
            Err(_) => out.push(not_ready(&root, &system_root)),
        }
    }
    out.sort_by(|a, b| a.root.cmp(&b.root));
    out
}

fn logical_drive_roots() -> Vec<String> {
    let mut buf = [0u16; 512];
    // Returns the number of UTF-16 units written, excluding the final double NUL.
    let n = unsafe { wfs::GetLogicalDriveStringsW(Some(&mut buf)) } as usize;
    if n == 0 || n > buf.len() {
        return Vec::new();
    }
    buf[..n]
        .split(|&c| c == 0)
        .filter(|s| !s.is_empty())
        .map(String::from_utf16_lossy)
        .collect()
}

fn drive_kind(wide: &[u16]) -> DriveKind {
    match unsafe { wfs::GetDriveTypeW(PCWSTR(wide.as_ptr())) } {
        DRIVE_FIXED => DriveKind::Fixed,
        DRIVE_REMOVABLE => DriveKind::Removable,
        DRIVE_REMOTE => DriveKind::Network,
        DRIVE_CDROM => DriveKind::CdRom,
        DRIVE_RAMDISK => DriveKind::RamDisk,
        _ => DriveKind::Unknown,
    }
}

/// Fallback label matching what Explorer shows for an unlabelled volume.
fn default_label(kind: DriveKind) -> &'static str {
    match kind {
        DriveKind::Fixed => "Local Disk",
        DriveKind::Removable => "Removable Disk",
        DriveKind::Network => "Network Drive",
        DriveKind::CdRom => "DVD Drive",
        DriveKind::RamDisk => "RAM Disk",
        DriveKind::Unknown => "Disk",
    }
}

fn not_ready(root: &str, system_root: &str) -> DriveInfo {
    let wide = crate::paths::to_wide_nul(root);
    let kind = drive_kind(&wide);
    DriveInfo {
        root: root.to_string(),
        label: default_label(kind).to_string(),
        filesystem: String::new(),
        drive_type: kind,
        total_bytes: 0,
        free_bytes: 0,
        ready: false,
        is_system: system_root.starts_with(&root.to_uppercase()),
    }
}

fn probe(root: &str, system_root: &str) -> DriveInfo {
    // MUST come first, and it is per-thread -- hence inside the worker.
    unsafe {
        let _ = SetThreadErrorMode(SEM_FAILCRITICALERRORS, None);
    }

    let wide = crate::paths::to_wide_nul(root);
    let kind = drive_kind(&wide);

    let mut label_buf = [0u16; 261];
    let mut fs_buf = [0u16; 32];
    let vol_ok = unsafe {
        wfs::GetVolumeInformationW(
            PCWSTR(wide.as_ptr()),
            Some(&mut label_buf),
            None,
            None,
            None,
            Some(&mut fs_buf),
        )
    }
    .is_ok();

    let mut total: u64 = 0;
    let mut free: u64 = 0;
    let space_ok = unsafe {
        wfs::GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            None,
            Some(&mut total as *mut u64),
            Some(&mut free as *mut u64),
        )
    }
    .is_ok();

    let raw_label = crate::paths::wide_to_string(&label_buf);
    let label = if vol_ok && !raw_label.trim().is_empty() {
        raw_label
    } else {
        default_label(kind).to_string()
    };

    DriveInfo {
        root: root.to_string(),
        label,
        filesystem: if vol_ok { crate::paths::wide_to_string(&fs_buf) } else { String::new() },
        drive_type: kind,
        total_bytes: if space_ok { total } else { 0 },
        free_bytes: if space_ok { free } else { 0 },
        ready: vol_ok || space_ok,
        is_system: system_root.starts_with(&root.to_uppercase()),
    }
}

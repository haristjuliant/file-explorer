//! Attribute and timestamp decoding. Everything here is derived from data that
//! `FindFirstFileW`/`FindNextFileW` already returned, so it costs no syscalls.

use windows::Win32::Storage::FileSystem as wfs;

use crate::ipc::attr;

/// 100-nanosecond intervals between 1601-01-01 (Windows epoch) and
/// 1970-01-01 (Unix epoch).
const WIN_EPOCH_TO_UNIX_100NS: i64 = 116_444_736_000_000_000;

/// Convert a raw Windows FILETIME (as returned by `MetadataExt`) to Unix
/// epoch milliseconds. A zero FILETIME means "not recorded" -- some filesystems
/// omit creation time -- and maps to 0 rather than to the year 1601.
#[inline]
pub fn filetime_to_ms(ft_100ns: u64) -> i64 {
    if ft_100ns == 0 {
        return 0;
    }
    (ft_100ns as i64 - WIN_EPOCH_TO_UNIX_100NS) / 10_000
}

#[inline]
pub fn is_dir(raw: u32) -> bool {
    raw & wfs::FILE_ATTRIBUTE_DIRECTORY.0 != 0
}

/// Decode `FILE_ATTRIBUTE_*` into our compact flag word.
///
/// `FILE_ATTRIBUTE_REPARSE_POINT` says *something* is a reparse point but not
/// which kind -- the tag lives in `WIN32_FIND_DATAW.dwReserved0`, which `std`
/// does not expose. We record the generic REPARSE bit here and resolve the
/// specific kind lazily in `stat`, where one extra syscall is acceptable.
pub fn decode(raw: u32) -> u16 {
    let mut f = 0u16;
    if raw & wfs::FILE_ATTRIBUTE_HIDDEN.0 != 0 {
        f |= attr::HIDDEN;
    }
    if raw & wfs::FILE_ATTRIBUTE_SYSTEM.0 != 0 {
        f |= attr::SYSTEM;
    }
    if raw & wfs::FILE_ATTRIBUTE_READONLY.0 != 0 {
        f |= attr::READONLY;
    }
    if raw & wfs::FILE_ATTRIBUTE_COMPRESSED.0 != 0 {
        f |= attr::COMPRESSED;
    }
    if raw & wfs::FILE_ATTRIBUTE_ENCRYPTED.0 != 0 {
        f |= attr::ENCRYPTED;
    }
    if raw & wfs::FILE_ATTRIBUTE_SPARSE_FILE.0 != 0 {
        f |= attr::SPARSE;
    }
    if raw & wfs::FILE_ATTRIBUTE_OFFLINE.0 != 0 {
        f |= attr::OFFLINE;
    }
    // A OneDrive / cloud placeholder. Opening one triggers a synchronous
    // download of a possibly-gigabyte file, so preview and thumbnailing must
    // refuse these unless the user explicitly opts in.
    if raw & (wfs::FILE_ATTRIBUTE_RECALL_ON_OPEN.0 | wfs::FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS.0) != 0 {
        f |= attr::CLOUD_STUB;
    }
    if raw & wfs::FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        f |= attr::REPARSE;
    }
    f
}

/// True when this entry should never be opened for preview or thumbnailing,
/// and never probed for children.
#[inline]
#[allow(dead_code)] // used by the preview/thumbnail phase
pub fn is_stalling(flags: u16) -> bool {
    flags & (attr::CLOUD_STUB | attr::OFFLINE | attr::REPARSE | attr::JUNCTION) != 0
}

/// Finder hides dot-prefixed names; Windows does not mark them hidden by
/// attribute. Since the visual target is Finder, a leading dot participates in
/// the same "hidden" filter -- and is reported through the same HIDDEN flag so
/// the frontend renders it at reduced opacity when hidden files are shown.
#[inline]
pub fn is_dotfile(name: &str) -> bool {
    name.starts_with('.') && name != "." && name != ".."
}

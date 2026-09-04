//! Every serde payload in one place, so the TypeScript mirror in
//! `src/ipc/types.ts` has a single file to be checked against.

/// Attribute bit flags. One number instead of eleven booleans: at 50k entries
/// the JSON difference is megabytes.
pub mod attr {
    pub const HIDDEN: u16 = 1 << 0;
    pub const SYSTEM: u16 = 1 << 1;
    pub const READONLY: u16 = 1 << 2;
    pub const SYMLINK: u16 = 1 << 3;
    pub const JUNCTION: u16 = 1 << 4;
    pub const CLOUD_STUB: u16 = 1 << 5;
    pub const OFFLINE: u16 = 1 << 6;
    pub const COMPRESSED: u16 = 1 << 7;
    pub const ENCRYPTED: u16 = 1 << 8;
    pub const SPARSE: u16 = 1 << 9;
    pub const REPARSE: u16 = 1 << 10;
}

/// Drives the icon choice. The frontend owns the human-readable "Kind" label
/// table, so no per-entry label string is ever serialized.
/// `Volume` is produced by the sidebar drive list, not by directory reads.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Folder,
    Volume,
    Image,
    Video,
    Audio,
    Pdf,
    Text,
    Code,
    Archive,
    Document,
    Spreadsheet,
    Presentation,
    Font,
    Executable,
    Shortcut,
    Disk,
    Package,
    Unknown,
}

/// One directory entry.
///
/// Note what is absent: no `path` (the page carries `dir` once and the frontend
/// joins) and no `kind` label. Both are pure duplication per row.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub flags: u16,
    /// 0 for directories.
    pub size: u64,
    /// Unix epoch milliseconds, UTC.
    pub modified_ms: i64,
    /// Lowercase, no leading dot. Empty for directories and extensionless files.
    pub ext: String,
    pub category: Category,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDirRequest {
    pub dir: String,
    /// Hard cap on returned entries. Defaults to `DEFAULT_LIMIT`.
    ///
    /// There is no `showHidden` / `showSystem` here on purpose: the backend
    /// returns every entry with its flags set and the frontend filters. That
    /// makes both toggles instant and zero-IPC, and keeps the cache key a
    /// bare path instead of `path|hidden|system`.
    #[serde(default)]
    pub limit: Option<usize>,
}

pub const DEFAULT_LIMIT: usize = 50_000;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirPage {
    /// Canonical display form -- never carries a verbatim prefix.
    pub dir: String,
    pub entries: Vec<DirEntry>,
    /// Full count even when `entries` was truncated.
    pub total: usize,
    pub truncated: bool,
    pub elapsed_ms: u32,
    /// Per-entry failures. Never fatal: a directory where 3 of 40,000 entries
    /// vanished mid-enumeration still returns 39,997 rows.
    pub warnings: Vec<crate::error::FsError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DriveKind {
    Fixed,
    Removable,
    Network,
    CdRom,
    RamDisk,
    Unknown,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    /// `"C:\\"`
    pub root: String,
    /// Volume label, or a synthesized fallback such as "Local Disk".
    pub label: String,
    /// `"NTFS"`, `"exFAT"`, or empty when the drive is not ready.
    pub filesystem: String,
    pub drive_type: DriveKind,
    pub total_bytes: u64,
    pub free_bytes: u64,
    /// False for an empty optical drive or a disconnected network mapping.
    /// Such drives are shown greyed rather than omitted.
    pub ready: bool,
    /// Holds `%SystemRoot%`.
    pub is_system: bool,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownFolders {
    pub home: Option<String>,
    pub desktop: Option<String>,
    pub documents: Option<String>,
    pub downloads: Option<String>,
    pub pictures: Option<String>,
    pub music: Option<String>,
    pub videos: Option<String>,
    pub one_drive: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub flags: u16,
    pub size: u64,
    pub created_ms: i64,
    pub modified_ms: i64,
    pub accessed_ms: i64,
    pub ext: String,
    pub category: Category,
    /// Resolved symlink / junction target, when the item is a reparse point.
    pub link_target: Option<String>,
}

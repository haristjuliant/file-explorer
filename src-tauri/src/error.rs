//! Every command returns `Result<T, FsError>`. There is no `unwrap()` in the
//! command / fs / preview layers -- see the clippy deny attributes in `lib.rs`.

use std::fmt;
use std::path::Path;

/// The full code set is declared up front so the TypeScript mirror is written
/// once; codes for later phases (trash, decode, job cancellation) are not yet
/// constructed.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrCode {
    NotFound,
    AccessDenied,
    AlreadyExists,
    InvalidName,
    ReservedName,
    NotADirectory,
    IsADirectory,
    NotEmpty,
    DiskFull,
    DeviceNotReady,
    NetworkUnavailable,
    PathTooLong,
    Cancelled,
    Unsupported,
    RestoreCollision,
    TrashUnavailable,
    DecodeFailed,
    Timeout,
    Internal,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsError {
    pub code: ErrCode,
    pub message: String,
    pub path: Option<String>,
    pub os_error: Option<i32>,
}

impl FsError {
    pub fn new(code: ErrCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), path: None, os_error: None }
    }

    pub fn with_path(mut self, path: &Path) -> Self {
        self.path = Some(crate::paths::to_display(path));
        self
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrCode::Internal, message)
    }

    #[allow(dead_code)] // used by the job engine in the file-operations phase
    pub fn cancelled() -> Self {
        Self::new(ErrCode::Cancelled, "Operation was cancelled.")
    }

    /// Map a raw Windows error code to a typed, human-readable failure.
    ///
    /// The specific codes matter: 32 (sharing violation) and 5 (access denied)
    /// both look like "permission" to a user but need different wording, and
    /// 21 (device not ready) is what an empty card reader returns.
    pub fn from_io(e: &std::io::Error, path: &Path) -> Self {
        let raw = e.raw_os_error();
        let (code, message): (ErrCode, String) = match raw {
            Some(2) | Some(3) => (ErrCode::NotFound, "This item no longer exists.".into()),
            Some(5) => (
                ErrCode::AccessDenied,
                "You don't have permission to access this item.".into(),
            ),
            Some(15) | Some(21) => (
                ErrCode::DeviceNotReady,
                "The drive is not ready. It may be empty or disconnected.".into(),
            ),
            Some(19) => (ErrCode::AccessDenied, "The media is write-protected.".into()),
            Some(32) => (
                ErrCode::AccessDenied,
                "This file is in use by another program.".into(),
            ),
            Some(53) | Some(64) | Some(67) | Some(1231) => (
                ErrCode::NetworkUnavailable,
                "The network location is unavailable.".into(),
            ),
            Some(80) | Some(183) => (ErrCode::AlreadyExists, "An item with that name already exists.".into()),
            Some(112) => (ErrCode::DiskFull, "There is not enough space on the disk.".into()),
            Some(123) => (ErrCode::InvalidName, "That name contains invalid characters.".into()),
            Some(145) => (ErrCode::NotEmpty, "The folder is not empty.".into()),
            Some(206) => (ErrCode::PathTooLong, "The path is too long.".into()),
            Some(267) => (ErrCode::NotADirectory, "That path is not a folder.".into()),
            Some(1223) => (ErrCode::Cancelled, "Operation was cancelled.".into()),
            _ => match e.kind() {
                std::io::ErrorKind::NotFound => (ErrCode::NotFound, "This item no longer exists.".into()),
                std::io::ErrorKind::PermissionDenied => (
                    ErrCode::AccessDenied,
                    "You don't have permission to access this item.".into(),
                ),
                std::io::ErrorKind::AlreadyExists => {
                    (ErrCode::AlreadyExists, "An item with that name already exists.".into())
                }
                _ => (ErrCode::Internal, e.to_string()),
            },
        };
        Self { code, message, path: Some(crate::paths::to_display(path)), os_error: raw }
    }
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.path {
            Some(p) => write!(f, "{:?}: {} ({})", self.code, self.message, p),
            None => write!(f, "{:?}: {}", self.code, self.message),
        }
    }
}

impl std::error::Error for FsError {}

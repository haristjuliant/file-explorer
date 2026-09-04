//! Command layer. Every command is `async` and immediately hands off to
//! `spawn_blocking`, for two reasons:
//!
//!   1. A **sync** `#[tauri::command]` runs on the main/event-loop thread, so a
//!      200 ms directory read there is a 200 ms UI freeze.
//!   2. `spawn_blocking`'s `JoinError` turns a panic in the worker into a typed
//!      `Internal` error the UI can show, instead of aborting the process.

#![deny(clippy::unwrap_used, clippy::expect_used)]

pub mod dir;
pub mod drives;
pub mod fileops;
pub mod preview;
pub mod search;
pub mod shell;
pub mod watch;
pub mod window;

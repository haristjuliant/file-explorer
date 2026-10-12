//! Snap Layouts support for an undecorated window.
//!
//! Removing the native frame is what gives the unified Finder-style toolbar,
//! but it also silently removes Windows 11's Snap Layouts -- the flyout that
//! appears when you hover the maximize button. Windows only offers it when the
//! window reports `HTMAXBUTTON` from `WM_NCHITTEST`, which a custom button
//! drawn in HTML never does.
//!
//! So the window is subclassed. The subclass is deliberately minimal: it asks
//! the existing handler first and only overrides a hit that came back as plain
//! client area, which leaves tao's resize borders exactly as they were.
//!
//! State is keyed by HWND rather than held in a handful of global statics,
//! because more than one of these windows can be open at once (see
//! `commands::window::new_window`): each has its own maximize button at its
//! own screen position, and a single shared rectangle would make Snap Layouts
//! work in only whichever window last reported its layout.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, IsZoomed, ShowWindow, HTCLIENT, HTMAXBUTTON, SW_MAXIMIZE, SW_RESTORE,
    WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP,
};

#[derive(Clone, Copy, Default)]
struct ButtonState {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    /// Set while the pointer is pressed on this window's maximize button, so
    /// the release can be recognised as a click on it.
    pressed: bool,
}

fn table() -> &'static Mutex<HashMap<isize, ButtonState>> {
    static TABLE: OnceLock<Mutex<HashMap<isize, ButtonState>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

const SUBCLASS_ID: usize = 0x464D_0001;

/// Record where the maximize button sits in one window. Called by that
/// window's UI on every layout change.
pub fn set_button_rect(hwnd: isize, x: i32, y: i32, w: i32, h: i32) {
    let mut t = table().lock().unwrap_or_else(|e| e.into_inner());
    let entry = t.entry(hwnd).or_default();
    entry.x = x;
    entry.y = y;
    entry.w = w.max(0);
    entry.h = h.max(0);
}

fn hit_is_on_button(hwnd: HWND, lparam: LPARAM) -> bool {
    let t = table().lock().unwrap_or_else(|e| e.into_inner());
    let Some(state) = t.get(&(hwnd.0 as isize)).copied() else {
        return false;
    };
    if state.w <= 0 || state.h <= 0 {
        return false;
    }

    // WM_NCHITTEST carries SCREEN coordinates, packed as two signed 16-bit
    // values, so a window at a negative coordinate must not be read as huge.
    let raw = lparam.0 as u32;
    let screen_x = (raw & 0xFFFF) as i16 as i32;
    let screen_y = ((raw >> 16) & 0xFFFF) as i16 as i32;

    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
        return false;
    }
    // With no decorations the client origin is the window origin, so no
    // ScreenToClient round trip is needed.
    let x = screen_x - rect.left;
    let y = screen_y - rect.top;

    x >= state.x && x < state.x + state.w && y >= state.y && y < state.y + state.h
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        WM_NCHITTEST => {
            // Ask the existing handler first. Anything it claims -- every
            // resize border and corner -- is left alone; only a plain client
            // hit is a candidate for the maximize button.
            let default = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            if default.0 == HTCLIENT as isize && hit_is_on_button(hwnd, lparam) {
                return LRESULT(HTMAXBUTTON as isize);
            }
            default
        }

        // Windows sends these for our synthetic HTMAXBUTTON. Swallowing the
        // press stops the default frame behaviour; the release is the click.
        WM_NCLBUTTONDOWN if wparam.0 == HTMAXBUTTON as usize => {
            if let Some(s) = table()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_mut(&(hwnd.0 as isize))
            {
                s.pressed = true;
            }
            LRESULT(0)
        }
        WM_NCLBUTTONUP if wparam.0 == HTMAXBUTTON as usize => {
            let was_pressed = table()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_mut(&(hwnd.0 as isize))
                .map(|s| std::mem::take(&mut s.pressed))
                .unwrap_or(false);
            if was_pressed {
                unsafe {
                    let zoomed = IsZoomed(hwnd).as_bool();
                    let _ = ShowWindow(hwnd, if zoomed { SW_RESTORE } else { SW_MAXIMIZE });
                }
            }
            LRESULT(0)
        }

        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}

/// Install the subclass. Safe to call once per window.
pub fn install(hwnd: isize) -> bool {
    let win = HWND(hwnd as *mut std::ffi::c_void);
    unsafe { SetWindowSubclass(win, Some(subclass_proc), SUBCLASS_ID, 0) }.as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect_of(hwnd: isize) -> (i32, i32, i32, i32) {
        let t = table().lock().unwrap_or_else(|e| e.into_inner());
        let s = t.get(&hwnd).copied().unwrap_or_default();
        (s.x, s.y, s.w, s.h)
    }

    #[test]
    fn an_unreported_button_is_never_hit() {
        // A window with no entry at all behaves exactly like a zero-size one.
        assert_eq!(rect_of(0xDEAD), (0, 0, 0, 0));
    }

    #[test]
    fn a_negative_size_is_clamped_rather_than_stored() {
        set_button_rect(0x1001, 10, 4, -50, -2);
        assert_eq!(rect_of(0x1001), (10, 4, 0, 0));
    }

    #[test]
    fn the_rect_round_trips() {
        set_button_rect(0x1002, 1180 - 46, 0, 46, 32);
        assert_eq!(rect_of(0x1002), (1134, 0, 46, 32));
    }

    /// Two windows never see each other's rectangle.
    #[test]
    fn each_window_keeps_its_own_rect() {
        set_button_rect(0x2001, 100, 0, 46, 32);
        set_button_rect(0x2002, 900, 0, 46, 32);
        assert_eq!(rect_of(0x2001), (100, 0, 46, 32));
        assert_eq!(rect_of(0x2002), (900, 0, 46, 32));
    }

    /// The packed coordinates are signed: a window dragged to a negative screen
    /// coordinate, which a second monitor to the left produces, must not be
    /// read as a huge positive number.
    #[test]
    fn packed_coordinates_are_read_as_signed() {
        let lparam = LPARAM(((-5i16 as u16 as u32) | ((-9i16 as u16 as u32) << 16)) as isize);
        let raw = lparam.0 as u32;
        let x = (raw & 0xFFFF) as i16 as i32;
        let y = ((raw >> 16) & 0xFFFF) as i16 as i32;
        assert_eq!((x, y), (-5, -9));
    }
}

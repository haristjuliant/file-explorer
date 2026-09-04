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

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, IsZoomed, ShowWindow, HTCLIENT, HTMAXBUTTON, SW_MAXIMIZE, SW_RESTORE,
    WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP,
};

/// The maximize button's rectangle, in physical pixels relative to the client
/// area, as last reported by the UI. Zero width means "not known yet", and the
/// subclass then does nothing at all.
static BTN_X: AtomicI32 = AtomicI32::new(0);
static BTN_Y: AtomicI32 = AtomicI32::new(0);
static BTN_W: AtomicI32 = AtomicI32::new(0);
static BTN_H: AtomicI32 = AtomicI32::new(0);

/// Set while the pointer is pressed on our maximize button, so the release can
/// be recognised as a click on it.
static PRESSED: AtomicBool = AtomicBool::new(false);

const SUBCLASS_ID: usize = 0x464D_0001;

/// Record where the maximize button is. Called by the UI on layout changes.
pub fn set_button_rect(x: i32, y: i32, w: i32, h: i32) {
    BTN_X.store(x, Ordering::Relaxed);
    BTN_Y.store(y, Ordering::Relaxed);
    BTN_W.store(w.max(0), Ordering::Relaxed);
    BTN_H.store(h.max(0), Ordering::Relaxed);
}

fn hit_is_on_button(hwnd: HWND, lparam: LPARAM) -> bool {
    let w = BTN_W.load(Ordering::Relaxed);
    let h = BTN_H.load(Ordering::Relaxed);
    if w <= 0 || h <= 0 {
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

    let bx = BTN_X.load(Ordering::Relaxed);
    let by = BTN_Y.load(Ordering::Relaxed);
    x >= bx && x < bx + w && y >= by && y < by + h
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
            PRESSED.store(true, Ordering::Relaxed);
            LRESULT(0)
        }
        WM_NCLBUTTONUP if wparam.0 == HTMAXBUTTON as usize => {
            if PRESSED.swap(false, Ordering::Relaxed) {
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
    let hwnd = HWND(hwnd as *mut std::ffi::c_void);
    unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0) }.as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreported_button_is_never_hit() {
        set_button_rect(0, 0, 0, 0);
        // Before the UI has measured itself the subclass must do nothing, or a
        // stale rectangle would steal clicks from the content.
        assert_eq!(BTN_W.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn a_negative_size_is_clamped_rather_than_stored() {
        set_button_rect(10, 4, -50, -2);
        assert_eq!(BTN_W.load(Ordering::Relaxed), 0);
        assert_eq!(BTN_H.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn the_rect_round_trips() {
        set_button_rect(1180 - 46, 0, 46, 32);
        assert_eq!(BTN_X.load(Ordering::Relaxed), 1134);
        assert_eq!(BTN_Y.load(Ordering::Relaxed), 0);
        assert_eq!(BTN_W.load(Ordering::Relaxed), 46);
        assert_eq!(BTN_H.load(Ordering::Relaxed), 32);
        set_button_rect(0, 0, 0, 0);
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

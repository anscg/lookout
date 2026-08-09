//! Thin FFI wrapper around the Swift-implemented menu-bar item
//! (swift/lookout-tray). The Swift side owns the NSStatusItem and renders the
//! recorded time with SwiftUI's `contentTransition(.numericText())`, so digit
//! changes roll like the system timer instead of snapping. Clicks come back
//! through a C callback carrying the item's screen rect (logical points,
//! top-left origin), which feeds the same tray-window toggle used by the
//! tauri tray on other platforms.

use std::ffi::CString;
use std::os::raw::c_char;
use std::sync::OnceLock;

use tauri::AppHandle;

extern "C" {
    fn lookout_tray_set_callback(cb: extern "C" fn(f64, f64, f64, f64));
    fn lookout_tray_show(text: *const c_char, icon: *const u8, icon_len: i32);
    fn lookout_tray_update(text: *const c_char, paused: i32);
    fn lookout_tray_hide();
}

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Click callback from Swift; runs on the main thread.
extern "C" fn on_tray_click(x: f64, y: f64, w: f64, h: f64) {
    if let Some(app) = APP.get() {
        let rect = tauri::Rect {
            position: tauri::LogicalPosition::new(x, y).into(),
            size: tauri::LogicalSize::new(w, h).into(),
        };
        crate::tray::toggle_tray_window(app, rect);
    }
}

pub fn show(app: &AppHandle, time_text: &str) -> Result<(), String> {
    let _ = APP.set(app.clone());
    let text = CString::new(time_text).map_err(|e| e.to_string())?;
    let icon: &[u8] = include_bytes!("../icons/timelapse_template.png");
    unsafe {
        lookout_tray_set_callback(on_tray_click);
        lookout_tray_show(text.as_ptr(), icon.as_ptr(), icon.len() as i32);
    }
    Ok(())
}

/// `paused: None` keeps the current pause state (used by the 1s ticker).
pub fn update(time_text: &str, paused: Option<bool>) -> Result<(), String> {
    let text = CString::new(time_text).map_err(|e| e.to_string())?;
    let p = match paused {
        None => -1,
        Some(false) => 0,
        Some(true) => 1,
    };
    unsafe { lookout_tray_update(text.as_ptr(), p) };
    Ok(())
}

pub fn hide() {
    unsafe { lookout_tray_hide() };
}

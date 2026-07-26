//! Raycast-style popup menu for the gallery's "+" button, rendered by Swift
//! (swift/lookout-tray/Sources/AddMenu.swift) as a borderless NSPanel with
//! SwiftUI content. The frontend invokes `show_add_menu` with the items and
//! the button's rect (CSS px, viewport-relative — the webview spans the whole
//! window on macOS, so those are window coordinates); the command resolves to
//! the chosen item's id, or None when the menu is dismissed.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddMenuEntry {
    pub id: Option<String>,
    pub label: Option<String>,
    pub symbol: Option<String>,
    /// Remote image shown instead of `symbol`, which stays the fallback.
    #[serde(rename = "iconUrl")]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub separator: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct AddMenuAnchor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{AddMenuAnchor, AddMenuEntry};
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::sync::Mutex;
    use tokio::sync::oneshot;

    extern "C" {
        fn lookout_add_menu_show(
            items_json: *const c_char,
            ns_window: *mut c_void,
            x: f64,
            y: f64,
            w: f64,
            h: f64,
            cb: extern "C" fn(*const c_char),
        );
    }

    /// Only one menu can be open; replacing the sender cancels the previous
    /// command's await (its receiver resolves to None).
    static PENDING: Mutex<Option<oneshot::Sender<Option<String>>>> = Mutex::new(None);

    /// Selection callback from Swift; runs on the main thread. Null = dismissed.
    extern "C" fn on_select(id: *const c_char) {
        let value = if id.is_null() {
            None
        } else {
            Some(unsafe { CStr::from_ptr(id) }.to_string_lossy().into_owned())
        };
        if let Some(tx) = PENDING.lock().unwrap().take() {
            let _ = tx.send(value);
        }
    }

    pub async fn show(
        window: tauri::WebviewWindow,
        entries: Vec<AddMenuEntry>,
        anchor: AddMenuAnchor,
    ) -> Result<Option<String>, String> {
        let json = serde_json::to_string(&entries).map_err(|e| e.to_string())?;
        let json = CString::new(json).map_err(|e| e.to_string())?;
        let (tx, rx) = oneshot::channel();
        *PENDING.lock().unwrap() = Some(tx);
        // Scoped so the (!Send) NSWindow pointer isn't held across the await.
        {
            let ns_window = window.ns_window().map_err(|e| e.to_string())?;
            unsafe {
                lookout_add_menu_show(
                    json.as_ptr(),
                    ns_window,
                    anchor.x,
                    anchor.y,
                    anchor.width,
                    anchor.height,
                    on_select,
                );
            }
        }
        Ok(rx.await.unwrap_or(None))
    }
}

#[tauri::command]
pub async fn show_add_menu(
    window: tauri::WebviewWindow,
    entries: Vec<AddMenuEntry>,
    anchor: AddMenuAnchor,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        imp::show(window, entries, anchor).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, entries, anchor);
        Err("native add menu is only implemented on macOS".into())
    }
}

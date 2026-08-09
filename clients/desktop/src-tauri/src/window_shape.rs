//! Letting clicks fall through the window's shadow.
//!
//! The Linux window reserves a transparent frame around itself so it has
//! somewhere to draw its outer border and shadow (see `WINDOW_MARGIN` in
//! linuxChrome.ts). That frame is invisible but it is still part of the
//! window, so without further help a click anywhere in it — on what looks
//! like empty desktop beside the app — lands on Lookout and focuses it.
//!
//! GTK's answer is an input shape: a region telling the compositor which
//! part of the window actually accepts pointer input. Everything outside it
//! is passed through to whatever is behind.
//!
//! The region deliberately does NOT stop at the visible window. A band of
//! the frame nearest the content stays interactive, because that band is
//! the invisible border you grab to resize (WindowResizeHandles.tsx draws
//! its strips there). Excluding the whole frame would make the window
//! click-through-able *and* impossible to resize.
//!
//!     ┌─────────────────────────────┐
//!     │  passes through             │  ← outer frame: shadow only
//!     │  ┌───────────────────────┐  │
//!     │  │ resize band           │  │  ← still accepts input
//!     │  │  ┌─────────────────┐  │  │
//!     │  │  │ visible window  │  │  │
//!
//! Driven from the frontend rather than tracked here: it already knows when
//! the frame collapses (a snapped or maximized window is flush with the
//! screen and has no frame at all) and it already listens for resizes, so
//! this stays a pure "apply what I'm told" command with no state of its own
//! to fall out of sync.

/// Applies the window's input shape, inset by `inset` logical pixels on
/// every side. An inset of 0 clears the shape, making the whole window
/// interactive again — which is what a snapped window wants.
///
/// Failures are reported but never fatal: the cost of getting this wrong is
/// a window that catches clicks on its own shadow, which is exactly where we
/// started and is not worth taking the app down over.
#[tauri::command]
pub fn set_window_shadow_inset(
    window: tauri::WebviewWindow,
    inset: i32,
) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, inset);
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let inset = inset.max(0);
        let target = window.clone();
        // GTK is main-thread only, and commands run on a worker thread.
        window
            .run_on_main_thread(move || {
                if let Err(e) = apply_input_shape(&target, inset) {
                    eprintln!("[window-shape] could not set input shape: {e}");
                }
            })
            .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "linux")]
fn apply_input_shape(window: &tauri::WebviewWindow, inset: i32) -> Result<(), String> {
    use gtk::cairo::{RectangleInt, Region};
    use gtk::prelude::WidgetExt;

    let gtk_window = window.gtk_window().map_err(|e| e.to_string())?;

    if inset == 0 {
        // Passing None unsets the shape entirely, so the window takes input
        // across its whole area again.
        gtk_window.input_shape_combine_region(None);
        return Ok(());
    }

    // Widget coordinates, which is the space this region is interpreted in,
    // and the same logical pixels the CSS margin is expressed in.
    let width = gtk_window.allocated_width();
    let height = gtk_window.allocated_height();

    // Too small to inset — a zero or negative region would make the window
    // entirely click-through, which is unrecoverable without a keyboard.
    if width <= inset * 2 || height <= inset * 2 {
        gtk_window.input_shape_combine_region(None);
        return Ok(());
    }

    let interactive = RectangleInt::new(inset, inset, width - inset * 2, height - inset * 2);
    gtk_window.input_shape_combine_region(Some(&Region::create_rectangle(&interactive)));
    Ok(())
}

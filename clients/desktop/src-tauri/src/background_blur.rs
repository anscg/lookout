//! Asking the compositor to blur what is behind the window.
//!
//! Lookout's window is translucent on macOS (NSVisualEffectView) and on
//! Windows (Mica). On Linux there was nothing to ask: X11 had no answer, and
//! on Wayland a client could not say "blur behind me" at all — blur was
//! something the user configured per-app in the compositor, if their
//! compositor had it.
//!
//! `ext-background-effect-v1` is that missing request. The client hands the
//! compositor a region of its surface, and the compositor blurs whatever is
//! behind it. KDE (Plasma 6.7+) and niri (26.04+) implement it; COSMIC and
//! Mutter are working on it.
//!
//! THE RULE THIS MODULE EXISTS TO KEEP: a desktop without the protocol must
//! stay exactly as opaque as it is today. A translucent window over a
//! compositor that is not blurring anything is not a softer window, it is a
//! window you can see the desktop through — which is what a plain GNOME
//! session would get if we assumed support and were wrong. So the frontend
//! paints its opaque background until this module has actually bound the
//! global, actually been told blur is supported, and actually attached a
//! region to this window's surface. Anything short of all three answers
//! `false`, and nothing changes. There is no detection here, no list of
//! compositors to keep current: the answer is the result of doing it.
//!
//! OFF BY DEFAULT while this is new. `LOOKOUT_WINDOW_BLUR=1` switches it on;
//! unset, and none of the code below runs at all. Two reasons for the switch
//! rather than shipping it on: this is the one path in the app that shares a
//! Wayland connection with GTK, so a mistake here is not a cosmetic bug but a
//! protocol error on the toolkit's own connection — and a translucent window
//! is a taste question that deserves to be tried on real desktops before it
//! becomes what everyone gets. `=0` and `=off` are accepted too, so the
//! variable reads the same way whichever value someone reaches for.
//!
//! The mechanics are a little unusual, because the surface belongs to GTK.
//! We borrow GDK's own Wayland connection rather than opening a second one —
//! a protocol object has to be created against the same connection the
//! surface lives on — and drive it through our own event queue, which is the
//! standard way for a library to share a display with the toolkit. The
//! region is left as pending surface state for GTK's next frame to commit,
//! so we never commit the toolkit's surface behind its back.

/// The rectangles covering the part of the surface to blur: the visible
/// window, inset from the surface by `inset` on every side, with its corners
/// rounded to `radius`.
///
/// The inset is the transparent frame the window reserves for its shadow
/// (`WINDOW_MARGIN` in linuxChrome.ts). Blurring that band would put a hard
/// blurred rectangle out where the shadow fades, so the region stops at the
/// visible edge — and it is zero anyway on the sessions where Lookout draws
/// no frame at all.
///
/// The corners are why this returns a list rather than one rectangle.
/// `wl_region` is rectangles only and the protocol has no notion of a corner
/// radius, so a single rect would blur four square corners inside a rounded
/// window: a visible nub at each one. One row per pixel of the corner bands,
/// inset to the circle, is exact and costs at most 65 rectangles at the
/// radius ceiling.
#[cfg(any(target_os = "linux", test))]
fn blur_rects(width: i32, height: i32, inset: i32, radius: i32) -> Vec<(i32, i32, i32, i32)> {
    let inset = inset.max(0);
    let w = width - inset * 2;
    let h = height - inset * 2;
    // Mid-resize the allocation can be smaller than the frame it is supposed
    // to contain. An empty region blurs nothing, which is the right answer
    // for a window with no visible area yet.
    if w <= 0 || h <= 0 {
        return Vec::new();
    }

    let r = radius.clamp(0, w.min(h) / 2);
    if r == 0 {
        return vec![(inset, inset, w, h)];
    }

    let mut rects = Vec::with_capacity(2 * r as usize + 1);
    // Everything between the two corner bands, full width — unless the
    // radius has taken the whole height, which a radius clamped to exactly
    // half of it does.
    if h > 2 * r {
        rects.push((inset, inset + r, w, h - 2 * r));
    }
    for i in 0..r {
        // Distance from the corner circle's centre row, in rows.
        let dy = f64::from(r - i);
        let radius_f = f64::from(r);
        let dx = (radius_f - (radius_f * radius_f - dy * dy).sqrt()).round() as i32;
        let row_w = w - 2 * dx;
        if row_w <= 0 {
            continue;
        }
        rects.push((inset + dx, inset + i, row_w, 1));
        rects.push((inset + dx, inset + h - 1 - i, row_w, 1));
    }
    rects
}

/// Attach (or update) this window's blur region, and report whether the
/// compositor is actually blurring behind it.
///
/// `inset` and `radius` describe the visible window in surface-local pixels,
/// and come from the frontend because that is where they are decided: the
/// frame collapses when the window manager sizes the window, and the radius
/// is the GTK theme's. Both are the same numbers the CSS is using, read off
/// the same DOM state, so the blurred area and the painted one cannot drift.
///
/// Called again on every resize, since the region is in surface-local
/// coordinates and a resized surface would otherwise keep the old one.
///
/// `false` is not an error. It is the answer while the feature is switched
/// off, for X11, for a compositor without the protocol, and for a window that
/// is not on screen yet.
#[tauri::command]
pub fn sync_background_blur(
    window: tauri::WebviewWindow,
    inset: i32,
    radius: i32,
) -> Result<bool, String> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, inset, radius);
        Ok(false)
    }

    #[cfg(target_os = "linux")]
    {
        use std::sync::mpsc;
        use std::time::Duration;

        if !enabled() {
            return Ok(false);
        }

        let (tx, rx) = mpsc::channel();
        let target = window.clone();
        // GTK and the Wayland connection it owns are both main-thread only.
        window
            .run_on_main_thread(move || {
                let blurred = linux::apply(&target, inset, radius).unwrap_or_else(|e| {
                    eprintln!("[blur] could not attach a blur region: {e}");
                    false
                });
                let _ = tx.send(blurred);
            })
            .map_err(|e| e.to_string())?;

        // Bounded like every other main-thread hop here: a wedged main thread
        // must not hang the webview, and the window simply stays opaque.
        rx.recv_timeout(Duration::from_millis(500))
            .map_err(|e| format!("timed out attaching the blur region: {e}"))
    }
}

/// Whether the user has asked for this at all.
///
/// Read once and remembered: it gates every call, and an environment variable
/// cannot change under a running process anyway. Off is the answer for unset,
/// for empty, and for a typo — see `env_flag`, which is the same vocabulary
/// `LOOKOUT_WINDOW_FRAME` uses.
///
/// Checked before the hop to the main thread, so a session without the flag
/// costs one `OnceLock` read per resize and touches neither GTK nor Wayland.
#[cfg(target_os = "linux")]
fn enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

    *ON.get_or_init(|| {
        let on = crate::desktop_appearance::env_flag(
            std::env::var("LOOKOUT_WINDOW_BLUR").ok().as_deref(),
        )
        .unwrap_or(false);
        if on {
            eprintln!("[blur] LOOKOUT_WINDOW_BLUR is set; asking the compositor for blur");
        }
        on
    })
}

#[cfg(target_os = "linux")]
mod linux {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ffi::c_void;

    use wayland_client::backend::{Backend, ObjectId};
    use wayland_client::globals::{registry_queue_init, GlobalListContents};
    use wayland_client::protocol::{wl_compositor, wl_region, wl_registry, wl_surface};
    use wayland_client::{Connection, Dispatch, EventQueue, Proxy, QueueHandle, WEnum};
    use wayland_protocols::ext::background_effect::v1::client::{
        ext_background_effect_manager_v1::{self, Capability, ExtBackgroundEffectManagerV1},
        ext_background_effect_surface_v1::ExtBackgroundEffectSurfaceV1,
    };

    // GDK's Wayland accessors. Declared rather than bound through a crate:
    // gtk-rs publishes no gdkwayland for GTK3, and these two are the whole
    // of what we need. They live in the libgdk-3 the app already links.
    //
    // Both take a GObject we hold a live reference to. Calling either on an
    // X11 display is not merely useless but unsound — GDK casts without
    // checking — which is what the display type check in `apply` is for.
    extern "C" {
        fn gdk_wayland_display_get_wl_display(display: *mut c_void) -> *mut c_void;
        fn gdk_wayland_window_get_wl_surface(window: *mut c_void) -> *mut c_void;
    }

    /// What the compositor has told us. One field, because one event is all
    /// this protocol has: the manager reports its capabilities when bound and
    /// again whenever they change.
    #[derive(Default)]
    struct State {
        blur: bool,
    }

    /// The connection, kept for the process's life.
    ///
    /// Every proxy here belongs to `queue`, so the queue has to outlive them;
    /// keeping the lot in one struct is what guarantees that.
    ///
    /// `surfaces` is keyed by window label — the app has two windows, and
    /// each needs its own effect object — and remembers the `wl_surface` it
    /// was made for, so a window that gets re-realized is noticed rather than
    /// silently updated through an object belonging to a surface that no
    /// longer exists.
    ///
    /// It is not an optimisation. Asking for a second effect object for a
    /// surface that already has one is `background_effect_exists`, a protocol
    /// error — and a protocol error on this connection is fatal to GTK's
    /// connection, because it is the same one. Everything here is written to
    /// send exactly one `get_background_effect` per surface, ever. (An object
    /// whose surface has gone is defined to become inert, so the reverse
    /// mistake merely stops blurring.)
    struct Wayland {
        conn: Connection,
        queue: EventQueue<State>,
        state: State,
        compositor: wl_compositor::WlCompositor,
        manager: ExtBackgroundEffectManagerV1,
        surfaces: HashMap<String, (ExtBackgroundEffectSurfaceV1, *mut c_void)>,
    }

    /// Tried once. A compositor cannot grow the protocol without restarting
    /// the session, so a failure is remembered rather than re-attempted on
    /// every resize — that would be a registry round trip per hundred
    /// milliseconds of dragging a window edge, on a desktop that has already
    /// said no.
    enum Init {
        Untried,
        Unsupported,
        Ready(Box<Wayland>),
    }

    thread_local! {
        static WAYLAND: RefCell<Init> = const { RefCell::new(Init::Untried) };
    }

    impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
        fn event(
            _: &mut Self,
            _: &wl_registry::WlRegistry,
            _: wl_registry::Event,
            _: &GlobalListContents,
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }

    impl Dispatch<ExtBackgroundEffectManagerV1, ()> for State {
        fn event(
            state: &mut Self,
            _: &ExtBackgroundEffectManagerV1,
            event: ext_background_effect_manager_v1::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let ext_background_effect_manager_v1::Event::Capabilities { flags } = event {
                // A compositor may advertise the manager and support none of
                // the effects, and blur is the only one this protocol has so
                // far. Treat an unknown value as "no": the cost of being
                // wrong is a see-through window.
                state.blur = matches!(flags, WEnum::Value(caps) if caps.contains(Capability::Blur));
            }
        }
    }

    impl Dispatch<ExtBackgroundEffectSurfaceV1, ()> for State {
        fn event(
            _: &mut Self,
            _: &ExtBackgroundEffectSurfaceV1,
            _: <ExtBackgroundEffectSurfaceV1 as Proxy>::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }

    impl Dispatch<wl_compositor::WlCompositor, ()> for State {
        fn event(
            _: &mut Self,
            _: &wl_compositor::WlCompositor,
            _: wl_compositor::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }

    impl Dispatch<wl_region::WlRegion, ()> for State {
        fn event(
            _: &mut Self,
            _: &wl_region::WlRegion,
            _: wl_region::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }

    /// Borrow GDK's connection and bind what we need on it.
    ///
    /// The connection is GTK's, not ours: `from_foreign_display` enters
    /// "guest" mode, which means dropping this never closes it. The event
    /// queue *is* ours, so the events we ask for cannot be swallowed by GDK's
    /// dispatcher or vice versa.
    ///
    /// The round trip is the price of a real answer instead of a guess: it is
    /// what delivers the capabilities event, and therefore what makes
    /// "supported" mean the compositor said so.
    fn connect(wl_display: *mut c_void) -> Result<Wayland, String> {
        // SAFETY: the pointer comes from GDK's live display, which the app
        // holds for its whole run — GTK is shut down only at exit, after
        // which nothing calls in here.
        let backend = unsafe { Backend::from_foreign_display(wl_display.cast()) };
        let conn = Connection::from_backend(backend);

        let (globals, mut queue) =
            registry_queue_init::<State>(&conn).map_err(|e| format!("no registry: {e}"))?;
        let qh = queue.handle();

        let manager: ExtBackgroundEffectManagerV1 = globals
            .bind(&qh, 1..=1, ())
            .map_err(|e| format!("this compositor has no ext-background-effect: {e}"))?;
        // A second bind of wl_compositor, purely to make regions with. Globals
        // may be bound any number of times, and this keeps us off whatever
        // GDK's own compositor object is doing.
        let compositor: wl_compositor::WlCompositor = globals
            .bind(&qh, 1..=4, ())
            .map_err(|e| format!("no wl_compositor: {e}"))?;

        let mut state = State::default();
        queue
            .roundtrip(&mut state)
            .map_err(|e| format!("the compositor never reported its capabilities: {e}"))?;
        if !state.blur {
            return Err("the compositor offers the protocol but not blur".to_string());
        }

        Ok(Wayland {
            conn,
            queue,
            state,
            compositor,
            manager,
            surfaces: HashMap::new(),
        })
    }

    pub(super) fn apply(
        window: &tauri::WebviewWindow,
        inset: i32,
        radius: i32,
    ) -> Result<bool, String> {
        use gtk::glib::prelude::{ObjectExt, ObjectType};
        use gtk::prelude::WidgetExt;

        let gtk_window = window.gtk_window().map_err(|e| e.to_string())?;

        // The type check, not `WAYLAND_DISPLAY`, and not "did GDK pick
        // Wayland" inferred from anything else. `gdk_wayland_display_*` casts
        // its argument unchecked, so handing it an X11 display reads a
        // GdkX11Display as though it were a GdkWaylandDisplay.
        let display = WidgetExt::display(&gtk_window);
        if display.type_().name() != "GdkWaylandDisplay" {
            return Ok(false);
        }

        // No GdkWindow until the window is realized, and no wl_surface until
        // it is mapped. Both are ordinary states at startup, not failures.
        let Some(gdk_window) = gtk_window.window() else {
            return Ok(false);
        };
        // SAFETY: both arguments are the live GObjects above, borrowed for
        // the duration of these two calls. The surface pointer that comes
        // back is kept, but only ever as an identity token to compare
        // against — the one dereference of it is `ObjectId::from_ptr`, here
        // and now, while the window that owns it is realized.
        let (wl_display, wl_surface_ptr) = unsafe {
            (
                gdk_wayland_display_get_wl_display(display.as_ptr().cast()),
                gdk_wayland_window_get_wl_surface(gdk_window.as_ptr().cast()),
            )
        };
        if wl_display.is_null() || wl_surface_ptr.is_null() {
            return Ok(false);
        }

        let width = gtk_window.allocated_width();
        let height = gtk_window.allocated_height();
        let label = window.label().to_string();

        let applied = WAYLAND.with(|cell| -> Result<bool, String> {
            let mut slot = cell.borrow_mut();
            if matches!(*slot, Init::Untried) {
                // Caught, not because a panic is expected, but because this
                // is the one path in the app that hands a foreign pointer to
                // a protocol library on the main thread. A blurred window is
                // not worth a crash on some compositor we have never seen.
                let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    connect(wl_display)
                }))
                .unwrap_or_else(|_| Err("panicked while binding the protocol".to_string()));
                *slot = match attempt {
                    Ok(wl) => Init::Ready(Box::new(wl)),
                    Err(e) => {
                        // Once per session, and the only line most desktops
                        // will ever print: this is the ordinary answer on
                        // GNOME, on X11, and on anything older.
                        eprintln!("[blur] leaving the window opaque: {e}");
                        Init::Unsupported
                    }
                };
            }
            let Init::Ready(wl) = &mut *slot else {
                return Ok(false);
            };
            let wl: &mut Wayland = wl;

            // Anything the compositor has said since the last sync. Capabilities
            // are allowed to change; draining also keeps our queue from growing
            // for the life of the process.
            wl.queue
                .dispatch_pending(&mut wl.state)
                .map_err(|e| format!("could not read the compositor's events: {e}"))?;
            if !wl.state.blur {
                return Ok(false);
            }

            // A window that was unrealized and realized again has a new
            // surface, and the old effect object belongs to the dead one.
            if wl
                .surfaces
                .get(&label)
                .is_some_and(|(_, made_for)| *made_for != wl_surface_ptr)
            {
                if let Some((stale, _)) = wl.surfaces.remove(&label) {
                    stale.destroy();
                }
            }

            let qh = wl.queue.handle();
            // Cloned out rather than matched on in place: the map is inserted
            // into on the miss, and a borrow held across the match would be
            // the immutable one that forbids it.
            let known = wl.surfaces.get(&label).map(|(effect, _)| effect.clone());
            let effect = match known {
                Some(effect) => effect,
                None => {
                    // SAFETY: GTK's own surface, alive as long as the window
                    // is — and the entry is dropped above if it is replaced.
                    let id = unsafe {
                        ObjectId::from_ptr(wl_surface::WlSurface::interface(), wl_surface_ptr.cast())
                    }
                    .map_err(|e| format!("could not adopt GTK's surface: {e}"))?;
                    let surface = wl_surface::WlSurface::from_id(&wl.conn, id)
                        .map_err(|e| format!("could not adopt GTK's surface: {e}"))?;
                    let effect = wl.manager.get_background_effect(&surface, &qh, ());
                    wl.surfaces
                        .insert(label.clone(), (effect.clone(), wl_surface_ptr));
                    effect
                }
            };

            let region = wl.compositor.create_region(&qh, ());
            for (x, y, w, h) in super::blur_rects(width, height, inset, radius) {
                region.add(x, y, w, h);
            }
            effect.set_blur_region(Some(&region));
            // The region is copied into the surface's pending state, so the
            // object itself is ours to throw away immediately.
            region.destroy();

            // Deliberately no wl_surface.commit: the surface is GTK's, and
            // committing it here would publish whatever half-built frame the
            // toolkit has pending. The region is double-buffered state, so
            // GTK's own next commit applies it — which the redraw below is
            // there to make happen now rather than at the next repaint.
            wl.conn
                .flush()
                .map_err(|e| format!("could not flush the region: {e}"))?;
            Ok(true)
        })?;

        if applied {
            gtk_window.queue_draw();
        }
        Ok(applied)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Total area of a region, which for these rectangles is also the pixel
    /// count: they are disjoint by construction (one row each in the corner
    /// bands, one block in between).
    fn area(rects: &[(i32, i32, i32, i32)]) -> i32 {
        rects.iter().map(|(_, _, w, h)| w * h).sum()
    }

    fn covers(rects: &[(i32, i32, i32, i32)], x: i32, y: i32) -> bool {
        rects
            .iter()
            .any(|(rx, ry, w, h)| x >= *rx && x < rx + w && y >= *ry && y < ry + h)
    }

    #[test]
    fn a_square_window_is_one_rectangle() {
        assert_eq!(blur_rects(800, 600, 0, 0), vec![(0, 0, 800, 600)]);
        // The frame is subtracted from every side, not just added up.
        assert_eq!(blur_rects(880, 680, 40, 0), vec![(40, 40, 800, 600)]);
    }

    #[test]
    fn the_rounded_region_covers_every_row_and_no_corner() {
        let (w, h, inset, radius) = (880, 680, 40, 12);
        let rects = blur_rects(w, h, inset, radius);

        // Every row of the visible window is represented exactly once, so the
        // region is the window minus the four corner bites and nothing else.
        assert_eq!(rects.len(), 2 * radius as usize + 1);
        assert!(area(&rects) < 800 * 600, "a rounded region is smaller than its box");
        assert!(area(&rects) > 800 * 600 - 4 * radius * radius);

        // The corner pixel itself is outside the circle...
        assert!(!covers(&rects, inset, inset));
        assert!(!covers(&rects, w - inset - 1, inset));
        assert!(!covers(&rects, inset, h - inset - 1));
        assert!(!covers(&rects, w - inset - 1, h - inset - 1));
        // ...while the middle of each edge, and the centre, are inside it.
        assert!(covers(&rects, w / 2, inset));
        assert!(covers(&rects, w / 2, h - inset - 1));
        assert!(covers(&rects, inset, h / 2));
        assert!(covers(&rects, w / 2, h / 2));
    }

    #[test]
    fn a_window_smaller_than_its_frame_blurs_nothing() {
        // Mid-resize, and at the first sync of a window that has been
        // allocated nothing yet. An empty region is a legitimate answer; a
        // negative-width rectangle is a protocol error.
        assert!(blur_rects(60, 60, 40, 12).is_empty());
        assert!(blur_rects(0, 0, 0, 0).is_empty());
        for (x, y, w, h) in blur_rects(200, 100, 40, 12) {
            assert!(w > 0 && h > 0, "({x},{y},{w},{h}) is not a rectangle");
        }
    }

    #[test]
    fn the_radius_cannot_swallow_the_window() {
        // A theme radius larger than the window is clamped to half the
        // smaller side, which is a circle-ended shape rather than an
        // inside-out one.
        let rects = blur_rects(200, 100, 0, 400);
        assert!(!rects.is_empty());
        assert!(covers(&rects, 100, 50));
        assert!(!covers(&rects, 0, 0));
    }
}

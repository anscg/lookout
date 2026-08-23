//! What the Linux desktop says it should look like.
//!
//! A GTK app gets the user's accent colour, window-button layout and UI font
//! for free, because GTK reads them. Lookout's UI is a webview, so nothing
//! reaches it unless we go and fetch it — which is most of why the app looks
//! like a visitor on Linux rather than a resident.
//!
//! Everything here is read through `gsettings`, which is present wherever
//! GSettings is (GNOME, Cinnamon, Budgie, and any session that ships the
//! schemas). Every read is allowed to fail: a missing binary, a missing
//! schema, or a desktop that simply has no opinion all land on the same
//! answer — `None`, meaning "keep Lookout's own default".

use serde::Serialize;

/// One of the window controls a `button-layout` can name.
///
/// Parsed but not all drawn: the header bar carries close and nothing else,
/// the way GNOME's own apps do. The rest of the layout is read so that the
/// *edge* close belongs on can be worked out correctly — a layout like
/// `close,minimize:appmenu` puts close on the left, which a check for
/// "does the trailing edge mention close" gets right only by accident.
#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum WindowControl {
    Minimize,
    Maximize,
    Close,
}

/// A parsed `button-layout`, split by edge and in the user's own order.
#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Debug, Default)]
struct WindowControls {
    leading: Vec<WindowControl>,
    trailing: Vec<WindowControl>,
}

/// Which edge the close button belongs on, from a `button-layout`.
///
/// Close is drawn wherever the user put it, and drawn even by a layout that
/// names no close at all — a window whose only chrome is this header bar and
/// which offers no way to shut itself is a support ticket, not a preference
/// faithfully honoured.
#[cfg(any(target_os = "linux", test))]
fn close_on_trailing_edge(layout: &str) -> bool {
    !parse_button_layout(layout)
        .leading
        .contains(&WindowControl::Close)
}

/// The colours of the session's actual GTK theme, as CSS hex strings.
///
/// Read from the theme rather than assumed, because plenty of people are not
/// on Adwaita: Yaru, Breeze, Nord, Dracula, Catppuccin and a long tail of
/// hand-rolled themes all redefine these. Hardcoding Adwaita's greys makes
/// Lookout the one window on such a desktop that ignores the theme.
///
/// Every field is optional and independent: a theme that defines only some
/// of these leaves the rest on the app's own palette rather than producing a
/// half-applied mixture.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors {
    /// The window's own background — what a GTK window paints behind content.
    pub window_bg: Option<String>,
    /// Text on that background.
    pub window_fg: Option<String>,
    /// Content-area background: lists, text views, the recessed surfaces a
    /// GTK app puts inside a window.
    pub view_bg: Option<String>,
    /// The theme's border colour, used for the window outline and popovers.
    pub border: Option<String>,
    /// Popover/menu background, an *elevated* surface — normally lighter
    /// than the window on a dark theme, not darker.
    pub popover_bg: Option<String>,
    /// The theme's accent. Takes precedence over the GSettings accent name,
    /// since a theme that hardcodes its own accent means it.
    pub accent: Option<String>,
}

#[derive(Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAppearance {
    /// The session accent as a hex string, e.g. `#3584e4`. `None` leaves the
    /// app on its own accent.
    pub accent: Option<String>,
    /// UI font family, e.g. `Adwaita Sans`. Size and style are stripped —
    /// the app sizes its own text.
    pub font_family: Option<String>,
    /// Close sits on the trailing edge of the header bar. False means the
    /// user moved their window controls to the leading edge.
    pub controls_on_right: bool,
    /// The GTK theme's own colours, where it defines them.
    pub colors: ThemeColors,
    /// The radius GTK rounds this theme's windows to, in logical px. `None`
    /// leaves Lookout on Adwaita's 12.
    pub window_radius: Option<i32>,
}

impl DesktopAppearance {
    /// What to assume when the desktop won't say: GNOME's own default —
    /// close on the trailing edge — and no theme colours, which leaves the
    /// app's own palette in place.
    fn fallback() -> Self {
        Self {
            accent: None,
            font_family: None,
            controls_on_right: true,
            colors: ThemeColors::default(),
            window_radius: None,
        }
    }
}

/// GNOME 47+ ships a fixed palette of named accents rather than free colour
/// choice, so the name maps straight onto Adwaita's own hex values.
#[cfg(any(target_os = "linux", test))]
fn accent_hex(name: &str) -> Option<&'static str> {
    Some(match name {
        "blue" => "#3584e4",
        "teal" => "#2190a4",
        "green" => "#3a944a",
        "yellow" => "#c88800",
        "orange" => "#ed5b00",
        "red" => "#e62d42",
        "pink" => "#d56199",
        "purple" => "#9141ac",
        "slate" => "#6f8396",
        _ => return None,
    })
}

/// Read one GSettings key, or `None` if the key, schema, or `gsettings`
/// itself isn't there.
#[cfg(target_os = "linux")]
fn gsetting(schema: &str, key: &str) -> Option<String> {
    let out = std::process::Command::new("gsettings")
        .args(["get", schema, key])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8(out.stdout).ok()?;
    // GSettings quotes string values: `'blue'`, `'Adwaita Sans 11'`.
    let trimmed = raw.trim().trim_matches('\'').trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Split a Pango font description (`"Adwaita Sans Bold 11"`) down to the
/// family alone. Pango puts the size last and style keywords just before it,
/// so peeling those off the end leaves the family.
#[cfg(any(target_os = "linux", test))]
fn font_family_from_pango(desc: &str) -> Option<String> {
    const STYLES: [&str; 12] = [
        "thin", "ultralight", "light", "semilight", "book", "regular", "medium", "semibold",
        "bold", "ultrabold", "heavy", "italic",
    ];
    let mut parts: Vec<&str> = desc.split_whitespace().collect();
    while let Some(last) = parts.last() {
        let lower = last.to_ascii_lowercase();
        if last.parse::<f32>().is_ok() || STYLES.contains(&lower.as_str()) {
            parts.pop();
        } else {
            break;
        }
    }
    let family = parts.join(" ");
    if family.is_empty() {
        None
    } else {
        Some(family)
    }
}

/// The window controls a GNOME `button-layout` asks for, split by edge.
///
/// The format is `"appmenu:minimize,maximize,close"`: the colon separates
/// the leading edge from the trailing one, commas separate the items. A
/// layout with no colon is all trailing, which is how GTK reads it too.
///
/// Order is preserved — someone who put close first meant close first — and
/// items we don't draw (`appmenu`, `icon`, `spacer`, anything unrecognised)
/// are dropped rather than guessed at. A layout that names no control we can
/// draw yields empty edges, which is a legitimate answer: it means the user
/// asked for a bar with no buttons.
#[cfg(any(target_os = "linux", test))]
fn parse_button_layout(layout: &str) -> WindowControls {
    fn edge(spec: &str) -> Vec<WindowControl> {
        spec.split(',')
            .filter_map(|item| match item.trim().to_ascii_lowercase().as_str() {
                "minimize" => Some(WindowControl::Minimize),
                "maximize" => Some(WindowControl::Maximize),
                "close" => Some(WindowControl::Close),
                _ => None,
            })
            .collect()
    }

    match layout.split_once(':') {
        Some((leading, trailing)) => WindowControls {
            leading: edge(leading),
            trailing: edge(trailing),
        },
        None => WindowControls {
            leading: Vec::new(),
            trailing: edge(layout),
        },
    }
}

/// A GTK colour as a CSS hex string.
///
/// Alpha is dropped rather than carried into `rgba()`: these are the theme's
/// *base* surfaces, the app composes its own translucent overlays on top of
/// them, and a base colour that is itself see-through would let the desktop
/// show through the window.
#[cfg(any(target_os = "linux", test))]
fn rgba_to_hex(red: f64, green: f64, blue: f64) -> String {
    let channel = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!(
        "#{:02x}{:02x}{:02x}",
        channel(red),
        channel(green),
        channel(blue)
    )
}

/// The GTK named colours to try for each role, best first.
///
/// Two generations of naming are in play. libadwaita introduced the
/// `window_bg_color` family and modern Adwaita-derived GTK3 themes define
/// them; older and more independent themes only have the classic
/// `theme_bg_color` set. Trying both is what makes this work across the
/// whole spread of themes people actually run, and a theme that defines
/// neither simply leaves that role unset.
#[cfg(target_os = "linux")]
const COLOR_ROLES: [(&str, &[&str]); 6] = [
    ("window_bg", &["window_bg_color", "theme_bg_color"]),
    ("window_fg", &["window_fg_color", "theme_fg_color"]),
    ("view_bg", &["view_bg_color", "theme_base_color"]),
    ("border", &["borders", "unfocused_borders"]),
    // Only the explicit name, with no fallback. `theme_base_color` looks like
    // the obvious second choice and is actively wrong: it is a *recessed*
    // content surface, and on Yaru-dark it is #272727 against a #2c2c2c
    // window — darker, so every menu would read as a hole punched in the
    // window rather than a card floating above it. Where a theme doesn't say,
    // the frontend derives an elevated surface from the window colour.
    ("popover_bg", &["popover_bg_color"]),
    ("accent", &["accent_bg_color", "theme_selected_bg_color"]),
];

/// The radius GTK rounds this theme's windows to, in logical px.
///
/// Read from a style context pathed at the `decoration` node, which is the
/// one that actually carries it — a GtkWindow's own node reports 0, since the
/// corners belong to the decoration GTK draws around it.
///
/// Measured against GTK 3.24: Adwaita answers 8, Yaru 15, System-4-1.0 zero.
/// The `border-top-*-radius` longhands are "not gettable" and warn if asked,
/// so only the `border-radius` shorthand may be read.
///
/// A theme built for square windows therefore gets square corners, instead of
/// Lookout being the one rounded window on the desktop. Note that none of the
/// measured answers is the 12 this app used to hardcode.
///
/// MUST be called on the main thread.
#[cfg(target_os = "linux")]
fn read_window_radius() -> Option<i32> {
    use gtk::prelude::StyleContextExt;

    let screen = gtk::gdk::Screen::default()?;

    // An anonymous node named `decoration`: enough for the CSS engine to
    // match the theme's `decoration { border-radius: … }` rule, without
    // creating or realizing a widget to hang it off.
    let path = gtk::WidgetPath::new();
    let pos = path.append_type(gtk::glib::Type::UNIT);
    path.iter_set_object_name(pos, Some("decoration"));

    let ctx = gtk::StyleContext::new();
    ctx.set_screen(&screen);
    ctx.set_path(&path);

    let radius = ctx
        .style_property_for_state("border-radius", gtk::StateFlags::NORMAL)
        .get::<i32>()
        .ok()?;

    // A theme is allowed to be strange, but not to swallow the window: the
    // frame only reserves 40px, and a radius past half the window's smaller
    // side stops being a corner at all.
    Some(radius.clamp(0, 32))
}

/// Read the current GTK theme's colours off a realized widget.
///
/// `lookup_color` resolves the theme's `@define-color` entries, which are
/// global to the theme rather than per-widget, so the window we already have
/// is as good a place to ask from as any — and it avoids creating and
/// realizing a throwaway widget just to read a palette.
///
/// MUST be called on the main thread; GTK is not thread-safe.
#[cfg(target_os = "linux")]
fn read_theme_colors(window: &tauri::WebviewWindow) -> Result<ThemeColors, String> {
    use gtk::prelude::{StyleContextExt, WidgetExt};

    let gtk_window = window.gtk_window().map_err(|e| e.to_string())?;
    let ctx = gtk_window.style_context();

    let mut found: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
    for (role, names) in COLOR_ROLES {
        if let Some(rgba) = names.iter().find_map(|name| ctx.lookup_color(*name)) {
            found.insert(role, rgba_to_hex(rgba.red(), rgba.green(), rgba.blue()));
        }
    }

    Ok(ThemeColors {
        window_bg: found.remove("window_bg"),
        window_fg: found.remove("window_fg"),
        view_bg: found.remove("view_bg"),
        border: found.remove("border"),
        popover_bg: found.remove("popover_bg"),
        accent: found.remove("accent"),
    })
}

/// UUID prefixes of the GNOME Shell extensions that draw a frame — rounded
/// corners, a border, a shadow — around every window themselves.
///
/// Prefixes rather than whole UUIDs because these get forked constantly and
/// a fork keeps the name while changing the domain. Anchored at the start of
/// the UUID, which is what keeps the *opposite* extensions out: several
/// popular ones exist to strip GNOME's rounding
/// (`remove-rounded-corners@markbokil.com`, `rrc@ogarcia.me`,
/// `candythief@nils-werner.github.com`), they leave a square window that
/// needs our frame as much as a bare session does, and a substring match on
/// "rounded-corners" would have caught the first of them.
///
/// Deliberately not listed, having been checked:
/// * `Rounded_Corners@lennart-k`, `nowa-shell@nowaos` — screen and panel
///   corners, nothing per-window.
/// * `highlight-focus@pimsnel.com`, `always-on-top-outline@…` — a border
///   that is temporary, or only on always-on-top windows, which Lookout is
///   not. Giving up our frame permanently for either is the worse trade.
///
/// This list cannot be complete — see `LOOKOUT_WINDOW_FRAME` in
/// `shell_draws_window_frame` for the way out when it is wrong.
#[cfg(any(target_os = "linux", test))]
const SHELL_CORNER_EXTENSIONS: [&str; 4] = [
    // Upstream (`@yilozt`), "Rounded Window Corners Reborn" (`@fxgn`), and
    // the forks of that fork.
    "rounded-window-corners@",
    // An older name upstream shipped under.
    "rounded-corners-effect@",
    // "Rounded Window Corners Gnome 50" (`@marcosgt.github.io`) — a separate
    // implementation, and note the different stem: it rounds every window
    // and draws custom shadows, so it collides exactly as the others do.
    "rounded-windows@",
    // "P7 Borders" (`@prasannavl.com`) — adds a border to every window. No
    // corners involved, same double frame.
    "p7-borders@",
];

/// Sessions whose window manager frames every window itself.
///
/// The same collision as `SHELL_CORNER_EXTENSIONS`, reached from the other
/// direction: these compositors frame every window they manage themselves,
/// from the window's real edge. Ours is 40px larger than it looks, so their
/// border and shadow land 40px out from the app with a band of desktop
/// showing in between.
///
/// niri is worth spelling out, because it fails differently and worse. Its
/// focus ring — on by default, 4px of accent blue — is painted as a solid
/// rectangle *behind* the window rather than around it, on the stated
/// grounds that it should show through a semitransparent one. Our frame is
/// not semitransparent, it is transparent, so the ring is not a 4px outline
/// there: it is a 40px slab of accent colour with the app floating in the
/// middle of it.
///
/// The tilers among them collide twice over, because a tiler also chooses
/// the window's size. The margin cannot come out of the window then, so it
/// comes out of the app: it sits in the middle of its tile with 40px of
/// nothing on every side, which is the worse-looking half of the bug.
///
/// Matched whole and case-insensitively against each name the session
/// advertises. `XDG_CURRENT_DESKTOP` is a colon-separated list
/// (`Hyprland`, `sway`, but also `ubuntu:GNOME`), and a substring test on
/// it would find a window manager inside the name of anything that merely
/// shipped alongside one.
///
/// Deliberately not listed, having been checked:
/// * GNOME and KDE. Mutter and KWin draw nothing around a window that says
///   it decorates itself, which this one does (`set_decorations(false)`) —
///   there the frame is ours, and drawing it well is most of this module.
/// * `wayfire`, `labwc`. Both decorate server-side, i.e. only windows that
///   asked them to, and neither is a tiler sizing the window for us.
///   Rounding and shadows are available in both as configuration, so a
///   session that turns them on wants `LOOKOUT_WINDOW_FRAME=0`.
#[cfg(any(target_os = "linux", test))]
const SELF_DECORATING_SESSIONS: [&str; 14] = [
    // Wayland. Every one of them borders each window it manages, and every
    // one of them tiles by default, so it sizes the window too.
    "hyprland",
    "niri",
    "sway",
    "river",
    "dwl",
    // X11 tilers. No shadows to collide with, but every one of them sizes
    // the window, which the margin cannot survive.
    "i3",
    "bspwm",
    "awesome",
    "xmonad",
    "herbstluftwm",
    "spectrwm",
    "dwm",
    "leftwm",
    // Runs on both, under the one name.
    "qtile",
];

/// Environment variables that name the compositor when the session doesn't.
///
/// A window manager launched from a session file has `XDG_CURRENT_DESKTOP`
/// set for it. One started by hand — a line in `.xinitrc`, an `exec` at the
/// end of a shell profile, which is how a fair share of the list above gets
/// run — has nothing set at all, and the session reads as empty. Each of
/// these is a socket or instance id the compositor exports for its own
/// clients, so finding one is as good as being told the name.
#[cfg(target_os = "linux")]
const SESSION_MARKERS: [(&str, &str); 4] = [
    ("HYPRLAND_INSTANCE_SIGNATURE", "Hyprland"),
    ("SWAYSOCK", "sway"),
    ("NIRI_SOCKET", "niri"),
    ("I3SOCK", "i3"),
];

/// The name this session goes by, if it is one that frames its own windows.
///
/// Takes the raw value of one of the desktop variables: a colon-separated
/// list of names, each of which `DESKTOP_SESSION` is allowed to write as a
/// path to the session file rather than as a bare name.
#[cfg(any(target_os = "linux", test))]
fn self_decorating_desktop(raw: &str) -> Option<&str> {
    raw.split(':')
        .map(|name| {
            let name = name.trim();
            // `/usr/share/wayland-sessions/hyprland` names Hyprland.
            name.rsplit('/').next().unwrap_or(name)
        })
        .find(|name| {
            SELF_DECORATING_SESSIONS
                .iter()
                .any(|wm| name.eq_ignore_ascii_case(*wm))
        })
}

/// Ask the environment, every way it might answer, whether the thing
/// managing this window already frames it.
#[cfg(target_os = "linux")]
fn self_decorating_session() -> Option<String> {
    for var in ["XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION"] {
        if let Ok(raw) = std::env::var(var) {
            if let Some(name) = self_decorating_desktop(&raw) {
                return Some(name.to_string());
            }
        }
    }
    SESSION_MARKERS
        .iter()
        .find(|(var, _)| std::env::var_os(var).is_some_and(|value| !value.is_empty()))
        .map(|(_, name)| (*name).to_string())
}

/// The vocabulary every `LOOKOUT_*` switch on Linux answers to.
///
/// `None` means the variable said nothing useful — unset, empty, or a typo —
/// which each caller reads as "you decide": fall through to detection for
/// `LOOKOUT_WINDOW_FRAME`, stay off for `LOOKOUT_WINDOW_BLUR`.
///
/// Kept in one place so the switches are one thing to learn rather than
/// several. Someone who found out that `LOOKOUT_WINDOW_FRAME=0` fixes a
/// double frame should be able to write `LOOKOUT_WINDOW_BLUR=on` without
/// looking anything up, and should not discover that `off` works for one and
/// not the other.
///
/// Anything unrecognised is deliberately not `false`: a typo is not an
/// instruction, and silently reading `LOOKOUT_WINDOW_FRAME=ture` as "no
/// frame" would be worse than ignoring it.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn env_flag(raw: Option<&str>) -> Option<bool> {
    match raw?.trim().to_ascii_lowercase().as_str() {
        "0" | "false" | "off" | "no" => Some(false),
        "1" | "true" | "on" | "yes" => Some(true),
        _ => None,
    }
}

/// The strings in a GSettings string array: `['a@b', 'c@d']`, or `@as []`
/// when the key has never been written.
#[cfg(any(target_os = "linux", test))]
fn parse_gvariant_list(raw: &str) -> Vec<String> {
    let inner = match (raw.find('['), raw.rfind(']')) {
        (Some(open), Some(close)) if close > open => &raw[open + 1..close],
        // Not a list at all — a missing schema, or gsettings reporting an
        // error on stdout. Treat it as empty rather than guessing.
        _ => return Vec::new(),
    };
    inner
        .split(',')
        .map(|item| item.trim().trim_matches('\'').trim_matches('"').trim())
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

/// Whether any of the enabled extensions is one of the corner-drawing family.
///
/// `disable_user_extensions` short-circuits it: with that set GNOME runs no
/// user extension at all, so what the enabled list says is irrelevant.
#[cfg(any(target_os = "linux", test))]
fn corner_extension_enabled(disable_user_extensions: bool, enabled: &[String]) -> bool {
    if disable_user_extensions {
        return false;
    }
    enabled.iter().any(|uuid| {
        SHELL_CORNER_EXTENSIONS
            .iter()
            .any(|prefix| uuid.starts_with(prefix))
    })
}

/// Whether something else is already drawing this window's rounded corners
/// and shadow, in which case Lookout must draw none of its own.
///
/// Two things can be: a compositor that frames every window itself
/// (`SELF_DECORATING_SESSIONS` — Hyprland, niri, the tilers), or a GNOME
/// Shell extension doing the same to a session that otherwise wouldn't
/// (`SHELL_CORNER_EXTENSIONS`).
///
/// Lookout's frame is a transparent margin reserved *inside* an
/// over-sized window (see `WINDOW_MARGIN` in linuxChrome.ts). Whatever
/// rounds and shades every window knows nothing about that margin, so it
/// works from the window's real edge — and you get its rounded rectangle
/// and shadow floating 40px out from the app, with Lookout's own border and
/// shadow nested inside. One window, decorated twice.
///
/// There is no negotiating with either, so the frame is simply handed over:
/// no margin, no border, no radius, no shadow, and no input shape. The
/// header bar stays — the window is still undecorated, and neither a
/// compositor nor an extension does anything about titlebars.
///
/// Both lists are things we happen to know about and cannot keep complete,
/// so `LOOKOUT_WINDOW_FRAME` overrides the whole question.
///
/// Answered once and cached. The window's geometry is chosen from this at
/// startup and the webview's first-paint CSS is keyed on the same value, so
/// a re-read that disagreed mid-session would leave the two contradicting
/// each other; switching compositor or toggling the extension needs an app
/// restart either way.
pub fn shell_draws_window_frame() -> bool {
    static ANSWER: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

    *ANSWER.get_or_init(|| {
        #[cfg(not(target_os = "linux"))]
        {
            false
        }

        #[cfg(target_os = "linux")]
        {
            // An explicit answer wins outright, extension or no extension:
            // `LOOKOUT_WINDOW_FRAME=0` to stop Lookout drawing its own frame,
            // `=1` to make it draw one regardless.
            //
            // It exists because `SHELL_CORNER_EXTENSIONS` and
            // `SELF_DECORATING_SESSIONS` are lists of things we happen to
            // know about, and both are always going to be behind: the
            // extension family is forked constantly, new implementations
            // appear under new names, compositors get written, and a KWin
            // script or a Picom rule can round and shade every window with
            // nothing to detect at all. Someone hitting a double frame — or a
            // missing frame because we guessed wrong — should not have to
            // wait for a release.
            //
            // Note the inversion: the variable answers "should Lookout
            // draw the frame", and this function answers the opposite —
            // whether something else is drawing it, so we don't. Saying no to
            // the frame is saying yes here, and that one boolean is what
            // drops the 40px margin, the border, the shadow, the radius and
            // the input shape together.
            if let Some(draw_our_own) = env_flag(
                std::env::var("LOOKOUT_WINDOW_FRAME").ok().as_deref(),
            ) {
                eprintln!("[linux-chrome] LOOKOUT_WINDOW_FRAME says draw={draw_our_own}");
                return !draw_our_own;
            }

            // A compositor that frames its own windows — Hyprland, niri, a
            // wlroots tiler — is the same collision as the extensions
            // below, minus the extension. Asked before GSettings because it
            // is two environment reads against two subprocesses, and
            // because none of these sessions has a GNOME Shell to ask
            // about.
            if let Some(session) = self_decorating_session() {
                eprintln!(
                    "[linux-chrome] {session} frames its own windows; \
                     leaving the window frame to it"
                );
                return true;
            }

            let disabled = gsetting("org.gnome.shell", "disable-user-extensions")
                .map(|v| v == "true")
                .unwrap_or(false);
            let enabled = gsetting("org.gnome.shell", "enabled-extensions")
                .map(|raw| parse_gvariant_list(&raw))
                .unwrap_or_default();
            let found = corner_extension_enabled(disabled, &enabled);
            if found {
                eprintln!(
                    "[linux-chrome] a rounded-corners shell extension is enabled; \
                     leaving the window frame to it"
                );
            }
            found
        }
    })
}

/// Everything the desktop will tell us about how it wants to look.
///
/// Takes the calling window because the GTK theme's colours are read off its
/// style context — Tauri injects it, so the frontend still calls this with no
/// arguments.
#[tauri::command]
pub fn desktop_appearance(window: tauri::WebviewWindow) -> DesktopAppearance {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        DesktopAppearance::fallback()
    }

    #[cfg(target_os = "linux")]
    {
        let mut appearance = DesktopAppearance::fallback();

        if let Some(name) = gsetting("org.gnome.desktop.interface", "accent-color") {
            appearance.accent = accent_hex(&name).map(str::to_string);
        }
        if let Some(desc) = gsetting("org.gnome.desktop.interface", "font-name") {
            appearance.font_family = font_family_from_pango(&desc);
        }
        if let Some(layout) = gsetting("org.gnome.desktop.wm.preferences", "button-layout") {
            appearance.controls_on_right = close_on_trailing_edge(&layout);
        }
        let (colors, radius) = gtk_style_on_main_thread(&window);
        appearance.colors = colors;
        appearance.window_radius = radius;

        appearance
    }
}

/// Hop to the main thread for everything GTK has to answer, and bring it back.
///
/// One hop for both reads, since they need the same thread and the same
/// moment. Bounded, and every failure lands on "nothing": the app keeps its
/// own palette and Adwaita's radius, which looks like Adwaita rather than
/// looking broken. Losing the theme's colours is worth far less than hanging
/// the window on a wedged main thread would cost.
#[cfg(target_os = "linux")]
fn gtk_style_on_main_thread(window: &tauri::WebviewWindow) -> (ThemeColors, Option<i32>) {
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel();
    let target = window.clone();
    if window
        .run_on_main_thread(move || {
            let colors = read_theme_colors(&target).unwrap_or_else(|e| {
                eprintln!("[linux-chrome] could not read the GTK palette: {e}");
                ThemeColors::default()
            });
            let _ = tx.send((colors, read_window_radius()));
        })
        .is_err()
    {
        return (ThemeColors::default(), None);
    }

    rx.recv_timeout(Duration::from_millis(500)).unwrap_or_else(|e| {
        eprintln!("[linux-chrome] timed out reading the GTK style: {e}");
        (ThemeColors::default(), None)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_size_and_style_off_a_pango_description() {
        assert_eq!(font_family_from_pango("Adwaita Sans 11").as_deref(), Some("Adwaita Sans"));
        assert_eq!(font_family_from_pango("Cantarell Bold 11").as_deref(), Some("Cantarell"));
        assert_eq!(font_family_from_pango("Inter Display 10.5").as_deref(), Some("Inter Display"));
        assert_eq!(font_family_from_pango("Cantarell").as_deref(), Some("Cantarell"));
    }

    #[test]
    fn a_description_that_is_only_size_and_style_has_no_family() {
        assert_eq!(font_family_from_pango("Bold 11"), None);
        assert_eq!(font_family_from_pango(""), None);
    }

    #[test]
    fn reads_the_window_controls_the_user_asked_for() {
        use WindowControl::*;

        // GNOME's default: close alone, trailing.
        let gnome = parse_button_layout("appmenu:close");
        assert!(gnome.leading.is_empty());
        assert_eq!(gnome.trailing, vec![Close]);

        // Ubuntu's default: the full set, trailing.
        let ubuntu = parse_button_layout("appmenu:minimize,maximize,close");
        assert!(ubuntu.leading.is_empty());
        assert_eq!(ubuntu.trailing, vec![Minimize, Maximize, Close]);

        // Moved to the leading edge, and in the user's own order.
        let left = parse_button_layout("close,minimize:appmenu");
        assert_eq!(left.leading, vec![Close, Minimize]);
        assert!(left.trailing.is_empty());
    }

    #[test]
    fn puts_close_on_the_edge_the_user_chose() {
        // GNOME's default, and Ubuntu's: trailing either way.
        assert!(close_on_trailing_edge("appmenu:close"));
        assert!(close_on_trailing_edge("appmenu:minimize,maximize,close"));
        // Moved to the leading edge. The second is the case a "does the
        // trailing edge mention close" check gets right only by accident:
        // close is leading, but `minimize` is what trails.
        assert!(!close_on_trailing_edge("close:appmenu"));
        assert!(!close_on_trailing_edge("close,minimize:appmenu"));
        // A layout that names no close still gets one, on the default edge.
        assert!(close_on_trailing_edge("appmenu:"));
        assert!(close_on_trailing_edge("icon:spacer"));
    }

    #[test]
    fn drops_the_items_a_header_bar_cannot_draw() {
        use WindowControl::*;
        // appmenu, icon and spacer are all real button-layout items.
        let layout = parse_button_layout("icon,appmenu:spacer,maximize,close");
        assert!(layout.leading.is_empty());
        assert_eq!(layout.trailing, vec![Maximize, Close]);
        // A layout naming nothing we draw is a bar with no buttons, not a
        // reason to invent one.
        let none = parse_button_layout("appmenu:");
        assert!(none.leading.is_empty() && none.trailing.is_empty());
    }

    #[test]
    fn a_layout_without_a_separator_is_all_trailing() {
        use WindowControl::*;
        let layout = parse_button_layout("minimize,close");
        assert!(layout.leading.is_empty());
        assert_eq!(layout.trailing, vec![Minimize, Close]);
    }

    #[test]
    fn converts_gtk_colours_to_css_hex() {
        assert_eq!(rgba_to_hex(0.0, 0.0, 0.0), "#000000");
        assert_eq!(rgba_to_hex(1.0, 1.0, 1.0), "#ffffff");
        // Adwaita's #242424 window background.
        assert_eq!(rgba_to_hex(36.0 / 255.0, 36.0 / 255.0, 36.0 / 255.0), "#242424");
        // Out-of-gamut values from a theme doing something odd are clamped,
        // not wrapped round into a different colour.
        assert_eq!(rgba_to_hex(-0.5, 1.4, 0.5), "#00ff80");
    }

    #[test]
    fn reads_the_uuids_out_of_an_enabled_extensions_list() {
        assert_eq!(
            parse_gvariant_list("['ding@rastersoft.com', 'ubuntu-dock@ubuntu.com']"),
            vec!["ding@rastersoft.com", "ubuntu-dock@ubuntu.com"],
        );
        // GNOME writes an empty list with its type annotation.
        assert!(parse_gvariant_list("@as []").is_empty());
        assert!(parse_gvariant_list("[]").is_empty());
        // Anything that isn't a list at all.
        assert!(parse_gvariant_list("No such schema").is_empty());
    }

    #[test]
    fn spots_every_extension_that_frames_windows_for_us() {
        for uuid in [
            // "Rounded Window Corners Reborn", and upstream before it.
            "rounded-window-corners@fxgn",
            "rounded-window-corners@yilozt",
            // A fork that kept the name and changed the domain.
            "rounded-window-corners@fxliang.pp.ua",
            // An older name upstream shipped under.
            "rounded-corners-effect@yilozt",
            // A separate implementation, on a different stem.
            "rounded-windows@marcosgt.github.io",
            // Borders rather than corners, same collision.
            "p7-borders@prasannavl.com",
        ] {
            assert!(
                corner_extension_enabled(false, &[uuid.to_string()]),
                "{uuid} should have been recognised"
            );
        }
    }

    #[test]
    fn leaves_the_frame_alone_when_no_such_extension_is_running() {
        let unrelated = vec![
            "ding@rastersoft.com".to_string(),
            "tiling-assistant@ubuntu.com".to_string(),
        ];
        assert!(!corner_extension_enabled(false, &unrelated));
        assert!(!corner_extension_enabled(false, &[]));
        // A name that merely mentions corners is not the same extension.
        assert!(!corner_extension_enabled(
            false,
            &["rounded-corners-everywhere@example.com".to_string()]
        ));
    }

    #[test]
    fn the_extensions_that_strip_rounding_are_not_the_ones_that_add_it() {
        // These leave a square window, which needs our frame as much as a
        // bare session does. `remove-rounded-corners` is the trap: it
        // contains the name of what we are looking for.
        for uuid in [
            "remove-rounded-corners@markbokil.com",
            "rrc@ogarcia.me",
            "candythief@nils-werner.github.com",
            // Screen and panel corners, nothing per-window.
            "Rounded_Corners@lennart-k",
            "panel-corners@aunetx",
            "nowa-shell@nowaos",
        ] {
            assert!(
                !corner_extension_enabled(false, &[uuid.to_string()]),
                "{uuid} should have been ignored"
            );
        }
    }

    #[test]
    fn every_switch_reads_the_same_yeses_and_noes() {
        for raw in ["0", "false", "off", "no", "OFF", " 0 "] {
            assert_eq!(env_flag(Some(raw)), Some(false), "{raw}");
        }
        for raw in ["1", "true", "on", "yes", "True"] {
            assert_eq!(env_flag(Some(raw)), Some(true), "{raw}");
        }
    }

    #[test]
    fn a_switch_we_cannot_read_says_nothing_either_way() {
        // Which each caller resolves for itself: detection for
        // LOOKOUT_WINDOW_FRAME, off for LOOKOUT_WINDOW_BLUR.
        assert_eq!(env_flag(None), None);
        assert_eq!(env_flag(Some("")), None);
        assert_eq!(env_flag(Some("maybe")), None);
    }

    #[test]
    fn extensions_switched_off_wholesale_cannot_be_drawing_anything() {
        let reborn = vec!["rounded-window-corners@fxgn".to_string()];
        assert!(!corner_extension_enabled(true, &reborn));
    }

    #[test]
    fn spots_the_compositors_that_frame_their_own_windows() {
        for desktop in ["Hyprland", "sway", "niri", "river", "dwm", "i3", "qtile"] {
            assert!(
                self_decorating_desktop(desktop).is_some(),
                "{desktop} should have been recognised"
            );
        }
        // The variable is a list, so a name anywhere in it counts...
        assert_eq!(self_decorating_desktop("Hyprland:wlroots"), Some("Hyprland"));
        // ...and DESKTOP_SESSION may name the session file rather than the
        // session.
        assert_eq!(
            self_decorating_desktop("/usr/share/wayland-sessions/hyprland"),
            Some("hyprland")
        );
    }

    #[test]
    fn leaves_the_frame_to_the_desktops_that_expect_us_to_draw_it() {
        for desktop in [
            "GNOME",
            "ubuntu:GNOME",
            "GNOME-Flashback:GNOME",
            "KDE",
            "X-Cinnamon",
            "XFCE",
            "",
        ] {
            assert!(
                self_decorating_desktop(desktop).is_none(),
                "{desktop} should have been left alone"
            );
        }
        // Whole names only. A tool that ships with a window manager carries
        // its name around, and is not the window manager.
        assert!(self_decorating_desktop("i3status").is_none());
        assert!(self_decorating_desktop("swaybg").is_none());
    }

    #[test]
    fn unknown_accent_names_fall_back_to_the_app_accent() {
        assert_eq!(accent_hex("blue"), Some("#3584e4"));
        assert_eq!(accent_hex("mauve"), None);
    }
}

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

#[derive(Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAppearance {
    /// The session accent as a hex string, e.g. `#3584e4`. `None` leaves the
    /// app on its own accent.
    pub accent: Option<String>,
    /// UI font family, e.g. `Adwaita Sans`. Size and style are stripped —
    /// the app sizes its own text.
    pub font_family: Option<String>,
    /// Window controls on the trailing edge of the header bar. False means
    /// the user moved them to the leading edge.
    pub controls_on_right: bool,
}

impl DesktopAppearance {
    /// What to assume when the desktop won't say: GNOME's own default —
    /// close on the right.
    fn fallback() -> Self {
        Self {
            accent: None,
            font_family: None,
            controls_on_right: true,
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

/// Which edge the window controls sit on, from a GNOME `button-layout`
/// string (`"appmenu:minimize,maximize,close"`) — the colon separates the
/// leading edge from the trailing one.
///
/// Only the close button's side matters to us: the header bar draws close
/// and nothing else, the way GNOME's own apps do now.
#[cfg(any(target_os = "linux", test))]
fn close_on_trailing_edge(layout: &str) -> bool {
    let (_, trailing) = layout.split_once(':').unwrap_or(("", layout));
    trailing.contains("close")
}

#[tauri::command]
pub fn desktop_appearance() -> DesktopAppearance {
    #[cfg(not(target_os = "linux"))]
    {
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

        appearance
    }
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
    fn reads_which_edge_the_close_button_sits_on() {
        // GNOME's default: close alone, trailing edge.
        assert!(close_on_trailing_edge("appmenu:close"));
        // Ubuntu's default adds minimize and maximize; close is still trailing.
        assert!(close_on_trailing_edge("appmenu:minimize,maximize,close"));
        // Controls moved to the leading edge.
        assert!(!close_on_trailing_edge("close,minimize:appmenu"));
        assert!(!close_on_trailing_edge("close:"));
    }

    #[test]
    fn a_layout_without_a_separator_is_all_trailing() {
        assert!(close_on_trailing_edge("minimize,close"));
    }

    #[test]
    fn unknown_accent_names_fall_back_to_the_app_accent() {
        assert_eq!(accent_hex("blue"), Some("#3584e4"));
        assert_eq!(accent_hex("mauve"), None);
    }
}

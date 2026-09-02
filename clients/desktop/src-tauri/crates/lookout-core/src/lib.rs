//! Lookout's capture engine, independent of any UI toolkit.
//!
//! Everything a Lookout desktop client has to do that is *not* drawing a
//! window lives here: enumerating monitors and windows, grabbing and
//! redacting frames, encoding per-minute H.264 clips, the self-scheduling
//! capture loop with its sleep/pause recovery and final flush, the
//! presigned-URL upload pipeline with its retry policy and clock-offset
//! estimate, the menu-bar recording clock, and every call to the server
//! API. The Tauri app in `src-tauri/src` is one shell over this crate; a GTK
//! or Qt shell would link the same crate and implement [`Frontend`].
//!
//! The contract is deliberately small:
//!
//! - Construct a [`Core`] with a [`Frontend`] implementation and a client
//!   name/version (the telemetry string sent to the server).
//! - Call [`Core::configure`] with the session token + API base URL, then
//!   [`Core::start_capture_loop`] / [`Core::stop_capture_loop`].
//! - Receive progress, previews, credited seconds and failures as
//!   [`CoreEvent`]s, and the clock text through
//!   [`Frontend::set_tray_title`].
//! - Drive the session itself (status, pause, resume, stop, rename, video,
//!   cut editing) and read the program registry / announcement through the
//!   [`api`] methods, so no shell speaks HTTP to the server on its own.
//!   Session *creation* happens on the program's website and reaches a
//!   shell as a `lookout://` deep link with the token.
//!
//! Anything that spawns (`start_capture_loop`, `start_tray_timer`,
//! `start_tray_ticker`, the screencast portal) uses `tokio::spawn` and so
//! must be called from inside a tokio runtime.

pub mod api;
pub mod apps;
pub mod capture;
pub mod capture_diagnostics;
pub mod capture_loop;
pub mod clips;
pub mod clock_offset;
mod crop;
mod pipewire;
#[cfg(target_os = "macos")]
pub mod power;
pub mod screencast;
pub mod sources;
pub mod timer;
pub mod upload;

/// Test-only helpers shared by the per-module leak tests.
#[cfg(test)]
pub(crate) mod test_support {
    /// Resident-set size of this process, in KB. Crude on purpose — good
    /// enough to tell a leak from steady state, and needs no dependency.
    ///
    /// The Unix arm shells out to `ps`; Windows (where the worst leaks have
    /// actually shipped — the GDI bitmap and MF sink-writer ones) asks
    /// PowerShell for the working set, so the leak tests finally RUN there
    /// instead of panicking on a missing `ps`.
    pub fn rss_kb() -> u64 {
        #[cfg(windows)]
        {
            let out = std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command"])
                .arg(format!(
                    "(Get-Process -Id {}).WorkingSet64",
                    std::process::id()
                ))
                .output()
                .expect("powershell");
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse::<u64>()
                .unwrap_or(0)
                / 1024
        }
        #[cfg(not(windows))]
        {
            let out = std::process::Command::new("ps")
                .args(["-o", "rss=", "-p"])
                .arg(std::process::id().to_string())
                .output()
                .expect("ps");
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse()
                .unwrap_or(0)
        }
    }

    /// Live GDI object count for this process — the precise leak signal on
    /// Windows: orphaning a bitmap costs exactly one GDI handle, and the
    /// per-process cap is 10k, after which every capture fails.
    #[cfg(windows)]
    pub fn gdi_object_count() -> u32 {
        use windows::Win32::System::Threading::{
            GetCurrentProcess, GetGuiResources, GR_GDIOBJECTS,
        };
        unsafe { GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS) }
    }
}

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, OnceLock};

pub use api::{ApiError, ApiResult};
pub use capture_loop::{
    CaptureLoopHandle, CapturePreviewFrame, CaptureSessionTerminated, CaptureSourceLost,
    CaptureTickError, CaptureTickResult,
};
pub use screencast::ScreencastRevoked;
pub use upload::CaptureUploadResult;

#[derive(Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    pub token: String,
    pub api_base_url: String,
}

#[derive(Serialize)]
pub struct CaptureResult {
    /// Base64-encoded JPEG bytes
    pub base64: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CaptureSource {
    #[serde(rename = "monitor")]
    Monitor { id: u32 },
    #[serde(rename = "window")]
    Window { id: u32 },
    #[serde(rename = "pipewire")]
    PipeWire { id: u32 },
}

/// What the core needs from whatever is drawing the UI.
///
/// Implementations must be cheap and non-blocking: these are called from
/// the capture loop and the once-a-second clock task.
pub trait Frontend: Send + Sync + 'static {
    /// Deliver a capture-loop / upload / screencast event to the UI.
    fn emit(&self, event: CoreEvent);

    /// Whether anyone is looking at the live preview right now. When false
    /// the loop skips the per-frame preview JPEG (and, outside clips mode,
    /// the in-between frame grab entirely). The Tauri shell answers with
    /// "is the main window focused".
    fn wants_preview_frames(&self) -> bool;

    /// Show the recording clock text (`mm:ss` or `h:mm:ss`) in the menu bar
    /// / tray, and whether the recording is paused. Called once a second
    /// while a session is recording, but only when the text changed (or
    /// right after a pause).
    fn set_tray_title(&self, time_text: &str, paused: bool);
}

/// Everything the core reports to the shell. [`CoreEvent::name`] is the
/// stable wire name each event has always had on the Tauri event bus, for
/// shells that forward these over some other bus as JSON.
#[derive(Clone)]
pub enum CoreEvent {
    /// Human-readable upload pipeline progress (`"uploading 84KB to R2..."`).
    Progress(String),
    /// Authoritative credited seconds learned during sleep recovery.
    TrackedSeconds(i64),
    /// The server reports the session in a terminal state; the loop stopped.
    SessionTerminated(CaptureSessionTerminated),
    /// An upload tick confirmed.
    TickResult(CaptureTickResult),
    /// An upload tick failed (after retries); the loop carries on.
    TickError(CaptureTickError),
    /// The capture source is gone for good and the loop gave up.
    SourceLost(CaptureSourceLost),
    /// A live-preview frame, between upload ticks, while previews are wanted.
    PreviewFrame(CapturePreviewFrame),
    /// The compositor tore a screencast session down (Linux portal).
    ScreencastRevoked(ScreencastRevoked),
}

impl CoreEvent {
    /// The event's wire name (the Tauri event channel it is emitted on).
    pub fn name(&self) -> &'static str {
        match self {
            CoreEvent::Progress(_) => "capture-progress",
            CoreEvent::TrackedSeconds(_) => "capture-tracked-seconds",
            CoreEvent::SessionTerminated(_) => "capture-session-terminated",
            CoreEvent::TickResult(_) => "capture-tick-result",
            CoreEvent::TickError(_) => "capture-tick-error",
            CoreEvent::SourceLost(_) => "capture-source-lost",
            CoreEvent::PreviewFrame(_) => "capture-preview-frame",
            CoreEvent::ScreencastRevoked(_) => "screencast-revoked",
        }
    }
}

/// The engine. One per process, shared behind an [`Arc`]: the capture loop,
/// the clock task and the screencast portal tasks hold clones while they run.
pub struct Core {
    /// Where uploads go: session token + API base URL. `None` until
    /// [`Core::configure`] is called.
    pub config: Mutex<Option<SessionConfig>>,
    /// Maps PipeWire node_id -> the RawFd of the screencast session that owns it.
    /// This allows streams from different portal sessions to coexist (e.g. when
    /// the user incrementally adds sources via the "+" button).
    #[cfg(target_os = "linux")]
    pub pipewire_fds: Mutex<std::collections::HashMap<u32, std::os::fd::RawFd>>,
    /// Live XDG screencast sessions, one per trip through the portal picker.
    /// Holding them is what lets us CLOSE them: the portal keeps casting until
    /// `Close()` is called, so a session we forget about streams (and shows in
    /// the system's screen-sharing indicator) until the process exits.
    /// `pipewire_fds` above is a derived view of this list — see
    /// `screencast::rebuild_fd_map`.
    #[cfg(target_os = "linux")]
    pub screencast_sessions: Mutex<Vec<screencast::ScreencastSession>>,
    /// App names whose windows should be blacked out in monitor captures.
    pub blacklisted_apps: Mutex<Vec<String>>,
    /// Active Rust-side capture loop (if running). Holds the cancel channel
    /// and JoinHandle so we can stop it from `stop_capture_loop`.
    pub(crate) capture_loop: Mutex<Option<CaptureLoopHandle>>,
    /// Rust-side 1s tray title ticker — keeps the menu bar time accurate
    /// even when the WebView's JS timers are throttled.
    pub(crate) tray_timer: Mutex<Option<timer::TrayTimerHandle>>,
    /// Running estimate of `serverNow - clientNow`. Fed by the `serverTime`
    /// on every upload response; read wherever we stamp a capture or turn a
    /// server wall-clock target into a local delay. This is what makes a
    /// wrong system clock cost nothing: without it, any skew past ±30s
    /// zeroed the credit and past 60s halved the capture rate (the skew
    /// leaked into every `nextExpectedAt - now` delay and hit the
    /// 2x-interval clamp).
    pub clock_offset: Mutex<clock_offset::ClockOffset>,
    pub(crate) frontend: Arc<dyn Frontend>,
    client_name: String,
    client_version: String,
    client_info: OnceLock<String>,
}

impl Core {
    /// `client_name`/`client_version` make up the telemetry string sent with
    /// every upload-url request (`"Lookout Desktop/0.4.0 (macOS 14.3)"`) —
    /// pass the shipping app's name and version, not this crate's.
    pub fn new(
        frontend: Arc<dyn Frontend>,
        client_name: impl Into<String>,
        client_version: impl Into<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            config: Mutex::new(None),
            #[cfg(target_os = "linux")]
            pipewire_fds: Mutex::new(std::collections::HashMap::new()),
            #[cfg(target_os = "linux")]
            screencast_sessions: Mutex::new(Vec::new()),
            blacklisted_apps: Mutex::new(Vec::new()),
            capture_loop: Mutex::new(None),
            tray_timer: Mutex::new(None),
            clock_offset: Mutex::new(clock_offset::ClockOffset::new()),
            frontend,
            client_name: client_name.into(),
            client_version: client_version.into(),
            client_info: OnceLock::new(),
        })
    }

    /// The shell this core reports to.
    pub fn frontend(&self) -> &dyn Frontend {
        &*self.frontend
    }

    pub(crate) fn emit(&self, event: CoreEvent) {
        self.frontend.emit(event);
    }

    /// Initialize the session config so the core knows where the server is.
    pub fn configure(&self, token: String, api_base_url: String) -> Result<(), String> {
        let mut config = self.config.lock().map_err(|e| e.to_string())?;
        *config = Some(SessionConfig {
            token,
            api_base_url,
        });
        Ok(())
    }

    /// Set the list of blacklisted app names (replaces current list).
    pub fn set_blacklisted_apps(&self, apps: Vec<String>) -> Result<(), String> {
        let mut blacklist = self.blacklisted_apps.lock().map_err(|e| e.to_string())?;
        *blacklist = apps;
        Ok(())
    }

    /// Get the current list of blacklisted app names.
    pub fn get_blacklisted_apps(&self) -> Result<Vec<String>, String> {
        let blacklist = self.blacklisted_apps.lock().map_err(|e| e.to_string())?;
        Ok(blacklist.clone())
    }

    /// Take a native screenshot, encode as JPEG, return base64.
    pub fn take_screenshot(
        &self,
        source: CaptureSource,
        max_width: u32,
        max_height: u32,
        jpeg_quality: u8,
    ) -> Result<CaptureResult, String> {
        #[allow(unused_mut, unused_assignments)]
        let mut pipewire_fds = std::collections::HashMap::new();
        #[cfg(target_os = "linux")]
        if let Ok(guard) = self.pipewire_fds.lock() {
            pipewire_fds = guard.clone();
        }
        capture::take_screenshot(source, max_width, max_height, jpeg_quality, &pipewire_fds)
    }
}

pub fn base64_decode(b64: &str) -> Result<Vec<u8>, String> {
    use base64_engine::*;
    ENGINE
        .decode(b64)
        .map_err(|e| format!("Base64 decode failed: {e}"))
}

pub fn base64_encode(data: &[u8]) -> String {
    use base64_engine::*;
    ENGINE.encode(data)
}

mod base64_engine {
    pub use base64::engine::general_purpose::STANDARD as ENGINE;
    pub use base64::Engine;
}

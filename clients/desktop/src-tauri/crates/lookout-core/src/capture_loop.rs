//! The Rust-side capture loop: frame cadence, clip cutting, sleep/pause
//! recovery, the pause/stop flush and the self-scheduling upload tick. Runs
//! entirely on tokio so WebView timer throttling can't touch it; the shell
//! only receives [`CoreEvent`]s.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant as StdInstant;
use tokio::sync::watch;

use crate::upload::{
    captured_at_now, http_client, upload_and_confirm, CaptureUploadResult, UploadPayload,
    ENABLE_CREDIT_MODE,
};
use crate::{base64_encode, capture, clips, CaptureSource, Core, CoreEvent, SessionConfig};

/// Handle for cancelling the Rust-side capture loop.
pub struct CaptureLoopHandle {
    cancel_tx: watch::Sender<bool>,
    join_handle: tokio::task::JoinHandle<()>,
}

impl CaptureLoopHandle {
    /// Cancel the loop and abort its task without waiting for the flush.
    /// [`Core::stop_capture_loop`] is the orderly path (it awaits the
    /// pause/stop flush); this is for a shell tearing the loop down from a
    /// path of its own (e.g. the main window closing).
    pub fn cancel(self) {
        let _ = self.cancel_tx.send(true);
        self.join_handle.abort();
    }
}

// ── Capture-loop interval (seconds) ─────────────────────────────
pub const CAPTURE_INTERVAL_SECS: u64 = 60;
/// If the wall-clock gap between ticks exceeds this, the machine
/// probably slept (or the WebView was throttled hard).
const SLEEP_THRESHOLD_SECS: u64 = CAPTURE_INTERVAL_SECS * 2 + 30; // 150s
/// Fallback frame cadence when the server doesn't advertise one (pre-clips
/// servers): every 10s = 6 frames/min. Mirrors CLIP_FRAME_INTERVAL_MS in
/// @lookout/shared. When the server sends `frameIntervalMs` on the session
/// GET, that value wins — the cadence is server-authoritative. Frames go
/// through the identical redaction-aware capture path as uploads; in clips
/// mode they're recorded into the clip, and the JPEG preview side is only
/// produced while the window is focused.
const DEFAULT_FRAME_INTERVAL_MS: u64 = 10_000;

/// Consecutive clip-encoder failures tolerated before this capture run gives
/// up on clips and records plain JPEGs for the rest of the session.
///
/// A broken encoder is already survivable one interval at a time (each
/// failure falls back to a JPEG), but "survivable" was not the same as
/// "quiet": on a machine where the encoder can never initialize, the loop
/// retried it on every single frame — for hours — each attempt paying the
/// full cost of constructing and tearing down an OS encoder, and writing a
/// line to stderr. Latching off after a few consecutive failures keeps the
/// recording intact and stops the thrash.
const MAX_CLIP_ENCODER_FAILURES: u32 = 3;

/// Consecutive failed capture ticks that mean a PipeWire source is gone for
/// good rather than briefly unhappy.
///
/// A revoked screencast is normally caught by the portal's `Closed` signal
/// (see `screencast::portal_session_task`), which is instant. This is the
/// backstop for the case where the stream dies without the session closing:
/// `pipewiresrc` then just times out on every frame, and the loop used to
/// retry that forever — tray ticking, UI claiming to record, not one frame
/// reaching the server. Only armed for PipeWire sources; a monitor capture
/// failing a few times in a row is ordinary (locked screen, sleeping display)
/// and must not end the recording.
const MAX_CONSECUTIVE_PIPEWIRE_FAILURES: u32 = 3;

/// Event payload delivered to the shell after each successful capture.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTickResult {
    pub confirmed: bool,
    pub tracked_seconds: i64,
    pub next_expected_at: String,
    pub preview_base64: String,
    pub preview_width: u32,
    pub preview_height: u32,
}

impl From<CaptureUploadResult> for CaptureTickResult {
    fn from(r: CaptureUploadResult) -> Self {
        Self {
            confirmed: r.confirmed,
            tracked_seconds: r.tracked_seconds,
            next_expected_at: r.next_expected_at,
            preview_base64: r.preview_base64,
            preview_width: r.preview_width,
            preview_height: r.preview_height,
        }
    }
}

/// Event payload emitted when a capture tick fails.
#[derive(Clone, Serialize)]
pub struct CaptureTickError {
    pub message: String,
}

/// Event payload emitted when the capture source is gone for good and the
/// loop has given up — as opposed to `CaptureTickError`, which is a bad
/// minute the loop expects to recover from.
#[derive(Clone, Serialize)]
pub struct CaptureSourceLost {
    pub message: String,
}

/// Event payload for an in-between live-preview frame from the capture
/// loop (one per frame interval while the window is focused).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePreviewFrame {
    pub preview_base64: String,
    pub preview_width: u32,
    pub preview_height: u32,
}

/// Event payload emitted when the capture loop detects a terminal session state.
#[derive(Clone, Serialize)]
pub struct CaptureSessionTerminated {
    pub status: String,
}

/// Session status response from the server.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatusResponse {
    status: String,
    #[serde(default)]
    tracked_seconds: Option<i64>,
}

/// What JPEG (if any) a frame grab should produce alongside the raw image.
#[derive(Clone, Copy, PartialEq)]
enum GrabJpeg {
    /// No JPEG — clip frame while the window is unfocused.
    None,
    /// Preview-sized (≤854x480, q65) — matches the resolution the live
    /// preview always used, and keeps the per-frame IPC payload ~5x
    /// smaller than a full-res frame would be.
    Preview,
    /// Full capture resolution at upload quality — the tick frame, which
    /// doubles as the JPEG upload/fallback payload.
    Full,
}

/// Downscale bounds + quality for preview JPEGs (mirrors the values the
/// dedicated preview protocol always served).
const PREVIEW_MAX_W: u32 = 854;
const PREVIEW_MAX_H: u32 = 480;
const PREVIEW_JPEG_QUALITY: u8 = 65;

/// One frame off the capture pipeline: the raw (redacted, scaled) image
/// plus, when requested, its JPEG encoding.
struct FrameGrab {
    image: image::DynamicImage,
    jpeg: Option<capture::RawCaptureResult>,
}

/// Read the current blacklist (+ Linux PipeWire fds) and capture one
/// redaction-aware stitched frame on the blocking pool. Shared by the
/// upload tick, the clip frames, and the live preview, so everything goes
/// through the exact same capture path — Filtered Apps redaction included.
async fn grab_frame(
    core: &Core,
    sources: &[CaptureSource],
    max_width: u32,
    max_height: u32,
    jpeg_quality: u8,
    jpeg: GrabJpeg,
) -> Result<FrameGrab, String> {
    let blacklisted = {
        core
            .blacklisted_apps
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    };

    #[allow(unused_mut, unused_assignments)]
    let mut pipewire_fds = std::collections::HashMap::new();
    #[cfg(target_os = "linux")]
    {
        if let Ok(guard) = core.pipewire_fds.lock() {
            pipewire_fds = guard.clone();
        };
    }

    let sources_clone = sources.to_vec();
    tokio::task::spawn_blocking(move || {
        let image = capture::take_stitched_screenshots_image_with_blacklist(
            &sources_clone,
            max_width,
            max_height,
            &pipewire_fds,
            &blacklisted,
            // This frame is what gets encoded and uploaded — the one image
            // a viewer ever sees of this minute.
            capture::ResizeQuality::Recorded,
        )?;
        let encoded = match jpeg {
            GrabJpeg::None => None,
            GrabJpeg::Full => Some(capture::encode_frame_jpeg(&image, jpeg_quality)?),
            GrabJpeg::Preview => {
                let (w, h) = (image.width(), image.height());
                if w > PREVIEW_MAX_W || h > PREVIEW_MAX_H {
                    let scale =
                        f64::min(PREVIEW_MAX_W as f64 / w as f64, PREVIEW_MAX_H as f64 / h as f64);
                    let pw = ((w as f64 * scale).round() as u32).max(2);
                    let ph = ((h as f64 * scale).round() as u32).max(2);
                    // Borrowing resize: the full-res frame stays untouched
                    // for the clip encoder.
                    image
                        .as_rgba8()
                        .and_then(|rgba| {
                            capture::fast_resize_buffer(
                                rgba,
                                pw,
                                ph,
                                capture::ResizeQuality::Preview,
                            )
                        })
                        .map(|small| {
                            capture::encode_frame_jpeg(
                                &image::DynamicImage::ImageRgba8(small),
                                PREVIEW_JPEG_QUALITY,
                            )
                        })
                        .transpose()?
                } else {
                    Some(capture::encode_frame_jpeg(&image, PREVIEW_JPEG_QUALITY)?)
                }
            }
        };
        Ok(FrameGrab {
            image,
            jpeg: encoded,
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking panicked: {e}"))
    .and_then(|r| r)
}

/// Record one clip-encoder failure, and latch clips off for the rest of the
/// run once they stop looking transient.
///
/// The recording itself is never at risk either way — every clip failure
/// already falls back to a JPEG for that interval. This is about not
/// re-attempting a hopeless encoder several times a minute for hours. Any
/// clip that finalizes successfully resets the counter, so a one-off
/// hiccup (a display mode change, a busy GPU) never disables clips.
fn note_clip_failure(failures: &mut u32, clips_mode: &mut bool) {
    *failures += 1;
    if *failures >= MAX_CLIP_ENCODER_FAILURES && *clips_mode {
        *clips_mode = false;
        eprintln!(
            "[capture-loop] {} consecutive clip-encoder failures — disabling clips \
             for this session, continuing with one JPEG per minute",
            *failures
        );
    }
}

/// Clip capability the server advertises for a session (on the session
/// GET). Fetched once at capture-loop start; any failure means clips off,
/// i.e. legacy one-JPEG-per-minute behavior.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SessionClipCapabilities {
    #[serde(default)]
    clips_enabled: bool,
    #[serde(default)]
    frame_interval_ms: Option<u64>,
}

async fn fetch_clip_capabilities(config: &SessionConfig) -> SessionClipCapabilities {
    let url = format!("{}/api/sessions/{}", config.api_base_url, config.token);
    match http_client()
        .get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => res.json().await.unwrap_or_default(),
        Ok(res) => {
            eprintln!(
                "[capture-loop] capability fetch returned HTTP {} — clips off",
                res.status()
            );
            SessionClipCapabilities::default()
        }
        Err(e) => {
            eprintln!("[capture-loop] capability fetch failed ({e}) — clips off");
            SessionClipCapabilities::default()
        }
    }
}

/// The core capture loop, runs on a tokio task. Captures screenshots at
/// a fixed interval, uploads them, and emits events back to the shell.
///
/// This is immune to WebView timer throttling because it runs entirely
/// in the Rust/tokio runtime — no JS setTimeout involved.
async fn capture_loop_task(
    core: Arc<Core>,
    sources: Vec<CaptureSource>,
    max_width: u32,
    max_height: u32,
    jpeg_quality: u8,
    mut cancel_rx: watch::Receiver<bool>,
) {
    use tokio::time::{sleep_until, Duration, Instant as TokioInstant};

    // Self-scheduling chain. The fixed-interval ticker is replaced with a
    // `sleep_until(next_target)` that's recomputed from each confirm's
    // `nextExpectedAt`. When the server returns an ISO timestamp we parse
    // it via system clock delta; otherwise we fall back to the legacy 60s
    // cadence. Catch-up-on-miss: clamp negative delays to 0 so we fire
    // immediately rather than waiting another full interval after sleep.
    let interval_dur = Duration::from_secs(CAPTURE_INTERVAL_SECS);
    // First iteration overwrites this before reading; the value is just a
    // placeholder so the variable is bound for the loop body.
    #[allow(unused_assignments)]
    let mut next_fire = TokioInstant::now();
    let mut last_tick = StdInstant::now();

    // Helper: check session status with the server and handle sleep/pause recovery
    async fn handle_sleep_recovery(
        core: &Core,
        config: &SessionConfig,
    ) -> Result<bool /* should_continue */, ()> {
        let client = http_client();
        let status_timeout = std::time::Duration::from_secs(15);
        let url = format!("{}/api/sessions/{}/status", config.api_base_url, config.token);
        match client.get(&url).timeout(status_timeout).send().await {
            Ok(res) if res.status().is_success() => {
                if let Ok(data) = res.json::<SessionStatusResponse>().await {
                    eprintln!("[capture-loop] session status after sleep: {}", data.status);
                    if let Some(ts) = data.tracked_seconds {
                        core.emit(CoreEvent::TrackedSeconds(ts));
                    }
                    if data.status == "paused" {
                        let resume_url = format!(
                            "{}/api/sessions/{}/resume",
                            config.api_base_url, config.token
                        );
                        let _ = client.post(&resume_url).timeout(status_timeout).send().await;
                        eprintln!("[capture-loop] session resumed after sleep");
                    } else if data.status != "active" && data.status != "pending" {
                        eprintln!(
                            "[capture-loop] session is {}, stopping capture loop",
                            data.status
                        );
                        core.emit(CoreEvent::SessionTerminated(CaptureSessionTerminated {
                            status: data.status,
                        }));
                        return Ok(false);
                    }
                }
            }
            Ok(res) => {
                eprintln!("[capture-loop] status check failed: HTTP {}", res.status());
            }
            Err(e) => {
                eprintln!("[capture-loop] status check failed: {e}");
            }
        }
        Ok(true)
    }

    /// Apply a finished upload's outcome: sync the tray timer, refine the
    /// next tick target from the server's `nextExpectedAt`, emit the UI
    /// events, and run pause/termination recovery on failure. Returns false
    /// when the capture loop should stop (terminal session state).
    async fn apply_upload_result(
        core: &Core,
        config: &SessionConfig,
        result: Result<CaptureUploadResult, String>,
        next_fire: &mut tokio::time::Instant,
        interval_dur: tokio::time::Duration,
    ) -> bool {
        match result {
            Ok(result) => {
                // Sync tray timer to authoritative server time
                core.sync_tray_timer(result.tracked_seconds);
                // Compute next fire from the server-provided nextExpectedAt.
                // If parsing fails or the target is in the past, default to
                // "fire now" (catch-up). Upper-bounded at 2x interval as a
                // guard against malformed responses.
                //
                // The target is SERVER wall-clock, so subtract our estimate
                // of the server's now — not the raw local clock. Raw local
                // time baked the machine's clock skew into every delay:
                // >30s of skew pushed every capture out of the credit
                // window (trackedSeconds stuck at 0), and >60s pinned the
                // delay at the clamp below, halving the capture rate and
                // with it the compiled video's length.
                let parsed_target_ms = parse_iso_to_unix_ms(&result.next_expected_at);
                let now_ms = {
                    let offset = core.clock_offset.lock().unwrap();
                    offset.correct(current_unix_ms())
                };
                let delay_ms = match parsed_target_ms {
                    Some(target) => (target - now_ms).max(0) as u64,
                    None => CAPTURE_INTERVAL_SECS * 1000,
                };
                let clamp_ms = CAPTURE_INTERVAL_SECS * 2 * 1000;
                if delay_ms > clamp_ms {
                    // With the offset applied this should never bind for
                    // clock skew — if it fires, something else is feeding us
                    // bad targets, and silence here is how the skew bug ran
                    // unnoticed for three months.
                    eprintln!(
                        "[capture-loop] next-capture delay {delay_ms}ms exceeds \
                         the 2x-interval clamp — capping to {clamp_ms}ms"
                    );
                }
                let delay_ms = delay_ms.min(clamp_ms);
                *next_fire =
                    tokio::time::Instant::now() + tokio::time::Duration::from_millis(delay_ms);
                core.emit(CoreEvent::TickResult(CaptureTickResult::from(result)));
                true
            }
            Err(e) => {
                eprintln!("[capture-loop] upload failed: {e}");
                core.emit(CoreEvent::TickError(CaptureTickError { message: e.clone() }));
                // No server target available — fall back to a full interval.
                *next_fire = tokio::time::Instant::now() + interval_dur;
                // Check if the server paused/stopped the session
                match handle_sleep_recovery(core, config).await {
                    Ok(true) => true,
                    Ok(false) => false,
                    Err(_) => true,
                }
            }
        }
    }

    // Clip capability comes from the server, once per loop run. Any fetch
    // failure (or clips off) means legacy JPEG mode, bit-for-bit.
    let initial_config = {
        let guard = core.config.lock().unwrap();
        guard.clone()
    };
    let caps = match &initial_config {
        Some(c) => fetch_clip_capabilities(c).await,
        None => SessionClipCapabilities::default(),
    };
    // Mutable: latches off after MAX_CLIP_ENCODER_FAILURES consecutive
    // encoder failures, so a machine with a broken encoder settles into
    // plain JPEG mode instead of retrying forever.
    let mut clips_mode = caps.clips_enabled;
    let mut clip_encoder_failures: u32 = 0;
    // Server-authoritative cadence, clamped defensively against a
    // misbehaving server so the loop can't spin or stall.
    let frame_interval_ms = caps
        .frame_interval_ms
        .unwrap_or(DEFAULT_FRAME_INTERVAL_MS)
        .clamp(500, 30_000);
    let frame_dur = Duration::from_millis(frame_interval_ms);
    let mut recorder: Option<clips::ClipRecorder> = None;
    if clips_mode {
        eprintln!("[capture-loop] clips enabled (frame every {frame_interval_ms}ms)");
    }

    // Watchdog for a screencast that died without the portal telling us.
    // Only armed when a PipeWire source is in play — see
    // MAX_CONSECUTIVE_PIPEWIRE_FAILURES.
    let watch_for_lost_source = sources
        .iter()
        .any(|s| matches!(s, CaptureSource::PipeWire { .. }));
    let mut consecutive_capture_failures: u32 = 0;

    // The first tick fires immediately in BOTH modes. The first capture is
    // the streak seed: it credits 0 seconds, and its capturedAt becomes the
    // session's startedAt and the anchor every later 60s credit mark is
    // measured from. Clips mode used to hold it back by
    // CLIP_FIRST_CUT_DELAY_MS so the opening clip carried a few frames —
    // but the compiler drops the seed unit from the video outright, so
    // those frames bought nothing, while the delay shifted the entire
    // credit schedule ~8s past record-press: seconds permanently lost from
    // tracked time, and a display timer frozen at 1:00 until the first
    // real credit landed at ~68s. The seed now uploads as a plain JPEG at
    // t=0 (fast activation — smaller than any clip) and the recorder rolls
    // through it, so the first FINISHED clip covers the full first minute.
    next_fire = TokioInstant::now();
    let mut first_upload_done = false;

    // The in-flight upload, if any. Uploads run CONCURRENTLY with frame
    // capture: a multi-second clip finalize+upload must not punch a hole in
    // the recording every minute — serially that compounds to minutes of
    // missing screen time per hour. Strictly one upload at a time: the next
    // tick settles the previous one before cutting, which preserves
    // capturedAt monotonicity and the per-session rate-limit assumptions.
    let mut upload_handle: Option<tokio::task::JoinHandle<Result<CaptureUploadResult, String>>> =
        None;
    let mut upload_cfg: Option<SessionConfig> = None;

    // Set only by the deliberate cancel path (pause/stop). Gates the final
    // partial-capture flush below — other exits (source lost, terminated
    // server-side, not configured) must not attempt it.
    let mut cancelled = false;

    // Newest successfully captured frame, retained so the pause/stop flush
    // never has to grab a fresh one — at most one cadence interval stale,
    // and already redacted/scaled by the capture path.
    let mut last_frame: Option<image::DynamicImage> = None;

    'outer: loop {
        // ── Wait until next_fire, collecting frames along the way ──
        // Frames run at the clip cadence (server-set, 6/min) through the
        // SAME redaction-aware capture path as uploads. In clips mode every
        // frame is recorded into the current clip; the JPEG preview side
        // is focus-gated either way (nobody can see it unfocused).
        // sleep_until returns immediately when next_fire is already past
        // (catch-up), which also skips frame collection.
        loop {
            let now = TokioInstant::now();
            if now >= next_fire {
                break;
            }
            let wake = std::cmp::min(now + frame_dur, next_fire);
            // Third arm: the in-flight upload finishing mid-wait. Its body
            // only records the outcome — applying it (which needs mutable
            // access to upload_handle/next_fire) happens after the select.
            let mut upload_outcome: Option<Result<CaptureUploadResult, String>> = None;
            tokio::select! {
                _ = sleep_until(wake) => {}
                _ = cancel_rx.changed() => {
                    eprintln!("[capture-loop] cancelled");
                    cancelled = true;
                    break 'outer;
                }
                res = async {
                    match upload_handle.as_mut() {
                        Some(h) => match h.await {
                            Ok(r) => r,
                            Err(e) => Err(format!("upload task panicked: {e}")),
                        },
                        None => unreachable!("guarded by select condition"),
                    }
                }, if upload_handle.is_some() => {
                    upload_outcome = Some(res);
                }
            }
            if let Some(res) = upload_outcome {
                upload_handle = None;
                let cfg = upload_cfg.take().expect("cfg tracks upload_handle");
                if !apply_upload_result(&core, &cfg, res, &mut next_fire, interval_dur).await {
                    break 'outer;
                }
                // next_fire was just refined by the confirm — recompute the
                // wake target instead of falling through with a stale one.
                continue;
            }
            // Woke for the upload tick, not a frame.
            if TokioInstant::now() >= next_fire {
                break;
            }

            let focused = core.frontend.wants_preview_frames();
            if !clips_mode && !focused {
                continue;
            }

            let jpeg_mode = if focused {
                GrabJpeg::Preview
            } else {
                GrabJpeg::None
            };
            match grab_frame(&core, &sources, max_width, max_height, jpeg_quality, jpeg_mode).await
            {
                Ok(grab) => {
                    last_frame = Some(grab.image.clone());
                    if clips_mode {
                        if recorder.is_none() {
                            match clips::ClipRecorder::new(
                                grab.image.width(),
                                grab.image.height(),
                                frame_interval_ms,
                            ) {
                                Ok(r) => recorder = Some(r),
                                Err(e) => {
                                    eprintln!(
                                        "[capture-loop] clip encoder init failed: {e} — JPEG fallback this interval"
                                    );
                                    note_clip_failure(
                                        &mut clip_encoder_failures,
                                        &mut clips_mode,
                                    );
                                }
                            }
                        }
                        if let Some(r) = recorder.as_mut() {
                            if let Err(e) = r.push_frame(&grab.image) {
                                eprintln!(
                                    "[capture-loop] clip frame append failed: {e} — dropping clip, JPEG fallback"
                                );
                                if let Some(r) = recorder.take() {
                                    r.discard();
                                }
                                note_clip_failure(&mut clip_encoder_failures, &mut clips_mode);
                            }
                        }
                    }
                    if focused {
                        if let Some(jpeg) = grab.jpeg {
                            core.emit(CoreEvent::PreviewFrame(CapturePreviewFrame {
                                preview_base64: base64_encode(&jpeg.data),
                                preview_width: jpeg.width,
                                preview_height: jpeg.height,
                            }));
                        }
                    }
                }
                Err(e) => {
                    // Frame-level failure: log and keep going — the upload
                    // tick has its own error handling and retry cadence.
                    eprintln!("[capture-loop] frame capture failed: {e}");
                }
            }
        }

        // ── Upload tick ──
        let now = StdInstant::now();
        let elapsed_secs = now.duration_since(last_tick).as_secs();
        last_tick = now;

        // Read config for this tick
        let config = {
            let guard = core.config.lock().unwrap();
            match guard.clone() {
                Some(c) => c,
                None => {
                    core.emit(CoreEvent::TickError(CaptureTickError {
                        message: "Not configured".into(),
                    }));
                    break;
                }
            }
        };

        // Sleep detection
        if elapsed_secs > SLEEP_THRESHOLD_SECS {
            eprintln!(
                "[capture-loop] detected sleep (gap: {}s), checking session status...",
                elapsed_secs
            );
            // A clip spanning a sleep gap would carry an hours-long hole —
            // drop it and start fresh after recovery.
            if let Some(r) = recorder.take() {
                r.discard();
            }
            match handle_sleep_recovery(&core, &config).await {
                Ok(true) => { /* continue capturing */ }
                Ok(false) => break,
                Err(_) => { /* best effort, continue */ }
            }
        }

        // A previous upload still in flight (very slow network): settle it
        // before cutting the next clip so uploads stay strictly ordered —
        // capturedAt monotonicity and the per-session rate limits both
        // assume order.
        if let Some(handle) = upload_handle.take() {
            let cfg = upload_cfg.take().expect("cfg tracks upload_handle");
            let res = match handle.await {
                Ok(r) => r,
                Err(e) => Err(format!("upload task panicked: {e}")),
            };
            if !apply_upload_result(&core, &cfg, res, &mut next_fire, interval_dur).await {
                break;
            }
        }

        // Grab the tick frame — the clip's final frame, the UI preview,
        // and the JPEG fallback, all from one capture. Full-size JPEG:
        // this one may be uploaded.
        let grab_result =
            grab_frame(&core, &sources, max_width, max_height, jpeg_quality, GrabJpeg::Full).await;

        // Capture the wall-clock moment NOW — that's the value we'll send
        // as `capturedAt`, not when the upload eventually reaches the server.
        let captured_at = if ENABLE_CREDIT_MODE {
            Some(captured_at_now(&core))
        } else {
            None
        };

        match grab_result {
            Ok(grab) => {
                consecutive_capture_failures = 0;
                last_frame = Some(grab.image.clone());
                let capture::RawCaptureResult {
                    data: jpeg_data,
                    width: jpeg_w,
                    height: jpeg_h,
                } = grab.jpeg.expect("tick grab always requests jpeg");
                let jpeg_base64 = base64_encode(&jpeg_data);
                let jpeg_bytes = bytes::Bytes::from(jpeg_data);

                // Clips: append the final frame and cut this interval's clip.
                // On the SEED tick (the immediate first upload) the frame is
                // appended but the clip is NOT cut: the seed uploads as a
                // plain JPEG — its content is dropped by the compiler anyway,
                // and what matters is planting the streak anchor at
                // record-press — while the recorder keeps rolling so the
                // first finished clip covers the whole first minute.
                let clip = if clips_mode {
                    if recorder.is_none() {
                        recorder = clips::ClipRecorder::new(
                            grab.image.width(),
                            grab.image.height(),
                            frame_interval_ms,
                        )
                        .map_err(|e| {
                            eprintln!("[capture-loop] clip encoder init failed: {e}");
                            note_clip_failure(&mut clip_encoder_failures, &mut clips_mode);
                        })
                        .ok();
                    }
                    if let Some(r) = recorder.as_mut() {
                        if let Err(e) = r.push_frame(&grab.image) {
                            eprintln!("[capture-loop] clip frame append failed: {e}");
                            if let Some(r) = recorder.take() {
                                r.discard();
                            }
                            note_clip_failure(&mut clip_encoder_failures, &mut clips_mode);
                        }
                    }
                    if !first_upload_done {
                        None
                    } else {
                        match recorder.take().map(|r| r.finish()) {
                            Some(Ok(c)) => {
                                // A clip made it out whole — the encoder works,
                                // so earlier failures were transient.
                                clip_encoder_failures = 0;
                                Some(c)
                            }
                            Some(Err(e)) => {
                                eprintln!(
                                    "[capture-loop] clip finalize failed: {e} — uploading JPEG instead"
                                );
                                note_clip_failure(&mut clip_encoder_failures, &mut clips_mode);
                                None
                            }
                            None => None,
                        }
                    }
                } else {
                    None
                };

                // Spawn the upload as a background task — frame capture for
                // the NEXT clip resumes immediately instead of stalling for
                // the finalize+upload round trip (which would put a hole in
                // the recording every minute). Clip first; ANY clip-upload
                // failure (size cap, server downgrade, transient) retries
                // the tick as a JPEG so the credit streak never skips a
                // beat.
                let task_core = Arc::clone(&core);
                let task_config = config.clone();
                let task_captured_at = captured_at.clone();
                upload_handle = Some(tokio::spawn(async move {
                    let jpeg_fallback =
                        UploadPayload::jpeg(jpeg_bytes, jpeg_base64.clone(), jpeg_w, jpeg_h);
                    match clip {
                        Some(c) => {
                            match upload_and_confirm(
                                UploadPayload::clip(c, jpeg_base64),
                                task_captured_at.as_deref(),
                                &task_config,
                                &task_core,
                            )
                            .await
                            {
                                Ok(r) => Ok(r),
                                Err(e) => {
                                    eprintln!(
                                        "[capture-loop] clip upload failed ({e}) — retrying tick as JPEG"
                                    );
                                    upload_and_confirm(
                                        jpeg_fallback,
                                        task_captured_at.as_deref(),
                                        &task_config,
                                        &task_core,
                                    )
                                    .await
                                }
                            }
                        }
                        None => {
                            upload_and_confirm(
                                jpeg_fallback,
                                task_captured_at.as_deref(),
                                &task_config,
                                &task_core,
                            )
                            .await
                        }
                    }
                }));
                upload_cfg = Some(config.clone());
                // Provisional next tick one interval out; refined to the
                // server's nextExpectedAt when the confirm lands mid-wait
                // (see the wait-loop's third select arm).
                next_fire = TokioInstant::now() + interval_dur;
            }
            Err(e) => {
                eprintln!("[capture-loop] screenshot failed: {e}");
                consecutive_capture_failures += 1;
                if watch_for_lost_source
                    && consecutive_capture_failures >= MAX_CONSECUTIVE_PIPEWIRE_FAILURES
                {
                    eprintln!(
                        "[capture-loop] {consecutive_capture_failures} capture ticks in a row \
                         failed on a PipeWire source — the screencast is gone, stopping"
                    );
                    core.emit(CoreEvent::SourceLost(CaptureSourceLost { message: e }));
                    break;
                }
                core.emit(CoreEvent::TickError(CaptureTickError {
                    message: e.clone(),
                }));
                // Local capture failure — retry on the legacy cadence.
                next_fire = TokioInstant::now() + interval_dur;
            }
        }

        // Whatever happened, the seed tick is spent — every later tick cuts
        // its clip. (Set even on failure: a failed seed retries on the normal
        // cadence, and that retry should behave like any other tick.)
        first_upload_done = true;
    }

    // Pause/stop: flush one last capture flagged `final` so the partial
    // minute since the last credited mark still credits (the server's
    // creditFinalCapture) — pausing at 03:15 resumes at 03:15, not 03:00.
    // Only on deliberate cancellation: the session is still active and
    // `stop_capture_loop` awaits this task before the UI sends the pause
    // POST (a paused session rejects confirms).
    //
    // THE FLUSH IS A SINGLE JPEG, DELIBERATELY. Earlier versions cut and
    // uploaded the in-progress clip here, and every step of that was a
    // place for the pause button to die: `ClipRecorder::finish()` blocks on
    // the OS encoder draining (GStreamer's EOS wait is up to 15s on a slow
    // or wedged pipeline — and it ran BEFORE any upload budget, so the
    // stop_capture_loop backstop aborted the whole task mid-finalize and
    // the credit was lost), the multi-MB clip upload burned retry backoffs,
    // and the clip→JPEG fallback doubled the round trips. The partial
    // minute's CREDIT needs one verifiable capture, not a video: encode the
    // last frame already in memory (~50ms), one small upload, one confirm.
    // The in-progress clip is discarded below — its frames were only ever
    // worth one second of timelapse.
    if cancelled {
        // Settle the in-flight upload FIRST — the final capture resets the
        // streak anchor, and a still-unconfirmed full minute confirmed
        // after that reset would credit nothing. Bounded: if it can't
        // settle promptly, flush anyway rather than hang the pause (the
        // task keeps running detached; worst case ITS minute re-confirms
        // against the reset anchor and loses, which is rarer and smaller
        // than every pause hanging).
        if let Some(handle) = upload_handle.take() {
            let cfg = upload_cfg.take().expect("cfg tracks upload_handle");
            let settle_started = StdInstant::now();
            match tokio::time::timeout(std::time::Duration::from_secs(5), handle).await {
                Ok(joined) => {
                    let res = match joined {
                        Ok(r) => r,
                        Err(e) => Err(format!("upload task panicked: {e}")),
                    };
                    let _ =
                        apply_upload_result(&core, &cfg, res, &mut next_fire, interval_dur).await;
                    eprintln!(
                        "[capture-loop] flush: settled in-flight upload in {}ms",
                        settle_started.elapsed().as_millis()
                    );
                }
                Err(_) => eprintln!(
                    "[capture-loop] flush: in-flight upload still running after 5s — flushing anyway"
                ),
            }
        }
        let config = {
            let guard = core.config.lock().unwrap();
            guard.clone()
        };
        // No fresh grab, no clip: encode the last frame already in memory
        // and send that. Every stage is timed to stderr so a slow pause
        // names its own culprit.
        if let (Some(config), Some(frame)) = (config, last_frame.take()) {
            let captured_at = if ENABLE_CREDIT_MODE {
                Some(captured_at_now(&core))
            } else {
                None
            };
            let flush_started = StdInstant::now();
            let upload = async {
                let jpeg = capture::encode_frame_jpeg(&frame, jpeg_quality)?;
                eprintln!(
                    "[capture-loop] flush: encoded {}KB JPEG in {}ms",
                    jpeg.data.len() / 1024,
                    flush_started.elapsed().as_millis()
                );
                let jpeg_base64 = base64_encode(&jpeg.data);
                let jpeg_bytes = bytes::Bytes::from(jpeg.data);
                upload_and_confirm(
                    UploadPayload::jpeg(jpeg_bytes, jpeg_base64, jpeg.width, jpeg.height)
                        .final_capture(),
                    captured_at.as_deref(),
                    &config,
                    &core,
                )
                .await
            };
            // Hard budget on the whole flush: the pause button must never
            // hang on upload retries. Past it, the partial minute is lost —
            // exactly what happened before the flush existed.
            let result =
                match tokio::time::timeout(std::time::Duration::from_secs(8), upload).await {
                    Ok(r) => r,
                    Err(_) => Err("flush timed out after 8s".into()),
                };
            match result {
                Ok(r) => {
                    eprintln!(
                        "[capture-loop] flush: final partial capture confirmed in {}ms (tracked {}s)",
                        flush_started.elapsed().as_millis(),
                        r.tracked_seconds
                    );
                    core.emit(CoreEvent::TickResult(CaptureTickResult::from(r)));
                }
                // Best effort: a failed flush loses only the partial
                // minute, which is exactly what happened before the
                // flush existed.
                Err(e) => eprintln!(
                    "[capture-loop] flush: FAILED after {}ms: {e}",
                    flush_started.elapsed().as_millis()
                ),
            }
        }
    }

    // Never leave a half-recorded clip (or its temp file) behind on
    // pause/stop/cancel. AFTER the flush on purpose: on Linux, discard()
    // still waits on the encoder pipeline (a wedged one can block for
    // seconds), and that wait must never sit between the user and their
    // credit — if it drags past stop_capture_loop's backstop, the abort
    // reaps a task whose only remaining work was cleanup.
    if let Some(r) = recorder.take() {
        r.discard();
    }

    eprintln!("[capture-loop] stopped");
}

/// Parse an ISO-8601 timestamp like `2024-09-12T18:34:21.123Z` to milliseconds
/// since the Unix epoch. Returns None on any parse failure. Implementation
/// uses civil-date math (Howard Hinnant) so we don't pull in chrono just
/// for this one call site.
pub(crate) fn parse_iso_to_unix_ms(s: &str) -> Option<i64> {
    // Expected layout: YYYY-MM-DDTHH:MM:SS[.fff][Z|+HH:MM|-HH:MM]
    let bytes = s.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T'
        || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let hour: u32 = s.get(11..13)?.parse().ok()?;
    let minute: u32 = s.get(14..16)?.parse().ok()?;
    let second: u32 = s.get(17..19)?.parse().ok()?;
    // Fractional seconds + timezone offset.
    let mut ms: i64 = 0;
    let mut idx = 19;
    if bytes.get(idx).copied() == Some(b'.') {
        idx += 1;
        let frac_start = idx;
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        let frac = &s[frac_start..idx];
        // Take the first 3 digits as milliseconds, ignore the rest.
        let trimmed: String = frac.chars().take(3).collect();
        let padded = format!("{:0<3}", trimmed); // pad right to 3 chars
        ms = padded.parse().ok()?;
    }
    let mut tz_offset_min: i64 = 0;
    if let Some(&c) = bytes.get(idx) {
        if c == b'Z' {
            // UTC, no offset
        } else if c == b'+' || c == b'-' {
            let sign: i64 = if c == b'+' { 1 } else { -1 };
            let h: i64 = s.get(idx + 1..idx + 3)?.parse().ok()?;
            let m: i64 = if bytes.get(idx + 3) == Some(&b':') {
                s.get(idx + 4..idx + 6)?.parse().ok()?
            } else {
                s.get(idx + 3..idx + 5)?.parse().ok()?
            };
            tz_offset_min = sign * (h * 60 + m);
        }
    }

    // Civil date → days-since-epoch (Howard Hinnant).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m_adj = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * m_adj as u64 + 2) / 5 + day as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe as i64 - 719_468;
    let total_secs =
        days * 86_400 + (hour as i64) * 3600 + (minute as i64) * 60 + second as i64;
    Some((total_secs - tz_offset_min * 60) * 1000 + ms)
}

pub(crate) fn current_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Core {
    /// Start the Rust-side capture loop. Replaces any existing loop.
    /// For screen/window/pipewire sources only — camera sources stay shell-driven.
    ///
    /// Spawns onto the ambient tokio runtime — call it from inside one.
    pub fn start_capture_loop(
        self: &Arc<Self>,
        sources: Vec<CaptureSource>,
        max_width: u32,
        max_height: u32,
        jpeg_quality: u8,
    ) -> Result<(), String> {
        // Stop any existing loop first
        {
            let mut guard = self.capture_loop.lock().map_err(|e| e.to_string())?;
            if let Some(handle) = guard.take() {
                let _ = handle.cancel_tx.send(true);
                handle.join_handle.abort();
            }
        }

        // Start the tray timer (if not already running)
        self.start_tray_timer();

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let core = Arc::clone(self);

        eprintln!(
            "[capture-loop] starting with {} sources, {}x{} q{}",
            sources.len(),
            max_width,
            max_height,
            jpeg_quality
        );

        let join_handle = tokio::spawn(async move {
            capture_loop_task(core, sources, max_width, max_height, jpeg_quality, cancel_rx).await;
        });

        {
            let mut guard = self.capture_loop.lock().map_err(|e| e.to_string())?;
            *guard = Some(CaptureLoopHandle {
                cancel_tx,
                join_handle,
            });
        }

        Ok(())
    }

    /// Stop the Rust-side capture loop (if running).
    ///
    /// Async, and AWAITED by the shell before it sends the pause/stop POST: on
    /// cancellation the loop flushes the in-progress partial minute as a
    /// `final` capture (see the end of `capture_loop_task`), and that confirm
    /// must land while the session is still active — a paused session rejects
    /// it. Bounded so a dead network can't wedge the pause button; on timeout
    /// the flush is abandoned (the partial minute is lost, exactly as it was
    /// before the flush existed).
    pub async fn stop_capture_loop(&self) -> Result<(), String> {
        let handle = {
            let mut guard = self.capture_loop.lock().map_err(|e| e.to_string())?;
            guard.take()
        };
        if let Some(handle) = handle {
            eprintln!("[capture-loop] stopping");
            let _ = handle.cancel_tx.send(true);
            // The flush itself is budgeted at 12s (see capture_loop_task); this
            // only backstops a loop wedged outside the flush.
            let mut join = handle.join_handle;
            if tokio::time::timeout(std::time::Duration::from_secs(15), &mut join)
                .await
                .is_err()
            {
                eprintln!("[capture-loop] final flush timed out — aborting the loop");
                join.abort();
            }
        }
        // Stop the tray timer too
        self.stop_tray_timer();
        Ok(())
    }

    /// Whether a capture loop is currently registered (running or not yet
    /// observed as finished). `false` if the lock is poisoned.
    pub fn has_capture_loop(&self) -> bool {
        self.capture_loop
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }

    /// Detach the running capture loop's handle without cancelling it, leaving
    /// the tray timer alone. `None` when nothing is running or the lock is
    /// poisoned. The caller decides what to do with it — see
    /// [`CaptureLoopHandle::cancel`].
    pub fn take_capture_loop(&self) -> Option<CaptureLoopHandle> {
        self.capture_loop.lock().ok().and_then(|mut guard| guard.take())
    }
}

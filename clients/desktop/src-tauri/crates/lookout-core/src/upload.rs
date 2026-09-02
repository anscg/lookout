//! The upload pipeline: presigned URL → PUT to R2 → confirm, with the retry
//! policy and error shaping shared by the capture loop, the one-shot
//! `capture_and_upload`, and the camera path's `upload_frame`. Also the
//! clock-offset bookkeeping those round trips feed.

use serde::{Deserialize, Serialize};

use crate::capture_loop::{current_unix_ms, parse_iso_to_unix_ms};
use crate::{base64_decode, base64_encode, capture, clips, CaptureSource, Core, CoreEvent, SessionConfig};

// Response structs use `#[serde(default)]` on new fields so older servers
// that don't include them still deserialize cleanly (no `deny_unknown_fields`
// either — keeps forward-compat for any future additions).
#[derive(Serialize, Deserialize)]
pub struct UploadUrlResponse {
    #[serde(rename = "uploadUrl")]
    pub upload_url: String,
    #[serde(rename = "r2Key")]
    pub r2_key: String,
    #[serde(rename = "screenshotId")]
    pub screenshot_id: String,
    #[serde(rename = "minuteBucket")]
    pub minute_bucket: i32,
    #[serde(rename = "nextExpectedAt")]
    pub next_expected_at: String,
    /// Server wall-clock at response time. Absent on pre-credit-mode servers.
    #[serde(rename = "serverTime", default)]
    pub server_time: Option<String>,
    /// True when the server replaced this capture's timestamp with its own
    /// because ours was outside the ±5min trust envelope. The upload still
    /// succeeded; seeing this means the clock-offset estimate is about to
    /// matter, so it's worth telling the user their clock is wrong.
    #[serde(rename = "capturedAtAdopted", default)]
    pub captured_at_adopted: bool,
    /// Sticky tracking mode for the session. Absent on pre-credit-mode servers.
    #[serde(rename = "trackingMode", default)]
    pub tracking_mode: Option<String>,
    /// GRANTED payload format — may differ from the requested one (the
    /// server downgrades clip formats to "jpeg" on sessions without clips).
    /// Absent on pre-clips servers.
    #[serde(rename = "format", default)]
    pub format: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct ConfirmResponse {
    pub confirmed: bool,
    #[serde(rename = "trackedSeconds")]
    pub tracked_seconds: i64,
    #[serde(rename = "nextExpectedAt")]
    pub next_expected_at: String,
    #[serde(rename = "serverTime", default)]
    pub server_time: Option<String>,
}

/// Result returned to the frontend from capture_and_upload.
/// Includes the server confirm data AND the screenshot preview.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureUploadResult {
    pub confirmed: bool,
    pub tracked_seconds: i64,
    pub next_expected_at: String,
    /// Base64-encoded JPEG of the captured frame (same image that was uploaded)
    pub preview_base64: String,
    pub preview_width: u32,
    pub preview_height: u32,
}

/// Shared HTTP client for all server/R2 traffic. Building a `reqwest::Client`
/// allocates a fresh connection pool + TLS config, so constructing one per
/// request (as each capture tick used to) both wastes CPU and forces a new
/// TCP/TLS handshake every 60 seconds. One shared client keeps connections
/// alive between ticks. Timeouts differ per call site, so they're applied
/// per-request via `RequestBuilder::timeout` instead of on the client.
pub fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default()
    })
}

impl Core {
    /// Free-form client telemetry string sent on every upload-url request, e.g.
    /// "Lookout Desktop/0.2.6 (macOS 14.3)". Computed once, on first use. NOT
    /// the HTTP User-Agent — explicit info for server-side telemetry/debugging.
    /// The product name and version are whatever the shell passed to
    /// [`Core::new`].
    pub fn client_info(&self) -> &str {
        self.client_info.get_or_init(|| {
            let info = os_info::get();
            let os_type = match info.os_type() {
                os_info::Type::Macos => "macOS".to_string(),
                other => other.to_string(),
            };
            let version = info.version().to_string();
            let os = if version.is_empty() || version == "Unknown" {
                os_type
            } else {
                format!("{os_type} {version}")
            };
            format!("{}/{} ({os})", self.client_name, self.client_version)
        })
    }
}

/// reqwest's `Display` is generic boilerplate ("error sending request for
/// url (...)") that gives zero debugging signal. The real reason — DNS
/// failure, connection refused, TLS handshake error, timeout, or an HTTP
/// status — is either in the `source()` chain or in `.status()`. Skip the
/// boilerplate and return just the signal: an HTTP code, or a short
/// category plus the innermost cause (e.g. "connection failed: Connection
/// refused (os error 61)").
///
/// This runs on the error path, so it must never make things worse: the
/// extraction is best-effort, and we always fall back to the raw error
/// string (never an empty or missing message) if it yields nothing useful.
pub(crate) fn describe_reqwest_error(err: &reqwest::Error) -> String {
    let signal = extract_reqwest_signal(err);
    if !signal.trim().is_empty() {
        return signal;
    }
    // Fallback: report the raw error, never nothing.
    let raw = err.to_string();
    if raw.trim().is_empty() {
        "unknown request error".to_string()
    } else {
        raw
    }
}

/// Compact, consistent message for an HTTP error response: the status code
/// (+ reason phrase, which `StatusCode` Displays) and the response body when
/// there is one. No filler. The failing step is supplied by the retry
/// wrapper's label, so it isn't repeated here.
fn http_error(status: reqwest::StatusCode, body: &str) -> String {
    let body = body.trim();
    if body.is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {body}")
    }
}

/// Best-effort signal extraction for [`describe_reqwest_error`]. Returns an
/// empty string when nothing better than the raw boilerplate is available,
/// signalling the caller to fall back. Pure string work — never panics.
fn extract_reqwest_signal(err: &reqwest::Error) -> String {
    use std::error::Error;
    // Walk to the innermost cause — the most specific reason (OS error,
    // TLS detail, etc.).
    let mut deepest: Option<String> = None;
    let mut source = err.source();
    while let Some(cause) = source {
        let s = cause.to_string();
        if !s.trim().is_empty() {
            deepest = Some(s);
        }
        source = cause.source();
    }
    // Status-class error (from `error_for_status`): the code is the signal.
    if let Some(status) = err.status() {
        return match deepest {
            Some(d) => format!("HTTP {}: {d}", status.as_u16()),
            None => format!("HTTP {}", status.as_u16()),
        };
    }
    let (kind, known) = if err.is_timeout() {
        ("timed out", true)
    } else if err.is_connect() {
        ("connection failed", true)
    } else if err.is_decode() {
        ("malformed response", true)
    } else if err.is_body() {
        ("request body error", true)
    } else {
        ("request failed", false)
    };
    match deepest {
        Some(detail) => format!("{kind}: {detail}"),
        // A known category with no cause chain (e.g. a bare timeout) stands
        // on its own. Otherwise return empty so the caller falls back to the
        // raw error rather than the vague "request failed".
        None if known => kind.to_string(),
        None => String::new(),
    }
}

/// Outcome of a single upload-pipeline attempt, used by [`retry_upload_step`]
/// to decide whether a failure is worth retrying.
enum StepError {
    /// Transient failure (timeout, connection error, 5xx, …) — retry with
    /// backoff.
    Retryable(String),
    /// Permanent failure — fail fast, no retry. Currently only HTTP 409
    /// (session paused/stopped server-side): retrying would just burn the
    /// backoff window before the capture loop runs sleep-recovery.
    Terminal(String),
}

/// Classify an HTTP error response into a [`StepError`]. Mirrors the react
/// client's special-case (clients/react/src/hooks/useUploader.ts): 409 is
/// terminal, everything else is retryable.
fn classify_http(status: reqwest::StatusCode, msg: String) -> StepError {
    if status == reqwest::StatusCode::CONFLICT {
        StepError::Terminal(msg)
    } else {
        StepError::Retryable(msg)
    }
}

/// Collapse the per-attempt failure history into one diagnostic string, led by
/// the step `label` (e.g. `r2-upload 84KB → acct.r2.cloudflarestorage.com`).
/// The goal: make an intermittent failure legible at a glance.
///
/// - If every attempt failed the same way, report the cause once with all the
///   elapsed times (a steady outage): `… failed after 3 attempts: timed out
///   (30.0s, 30.0s, 30.0s)`.
/// - If the causes differ, list each attempt (flapping connectivity): `…
///   failed after 3 attempts: #1 timed out (30.0s); #2 connection refused
///   (1.2s); #3 timed out (30.0s)`.
///
/// Each entry is `(attempt_number, cause, elapsed_seconds)`. Per-attempt
/// timing is the one thing the breadcrumb log can't reconstruct — it tells a
/// read-timeout (R2 stalled mid-transfer) apart from a connect-timeout
/// (couldn't reach it at all).
fn summarize_attempts(label: &str, history: &[(usize, String, f64)]) -> String {
    match history {
        [] => format!("{label}: unknown error"),
        [(_, cause, secs)] => format!("{label}: {cause} ({secs:.1}s)"),
        [(_, first_cause, _), rest @ ..] => {
            let n = history.len();
            if rest.iter().all(|(_, c, _)| c == first_cause) {
                let times = history
                    .iter()
                    .map(|(_, _, s)| format!("{s:.1}s"))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{label} failed after {n} attempts: {first_cause} ({times})")
            } else {
                let parts = history
                    .iter()
                    .map(|(i, c, s)| format!("#{i} {c} ({s:.1}s)"))
                    .collect::<Vec<_>>()
                    .join("; ");
                format!("{label} failed after {n} attempts: {parts}")
            }
        }
    }
}

/// Retry an upload step with exponential backoff, mirroring the web client's
/// `retry()` (clients/web/src/hooks/useUploader.ts): up to `MAX_RETRIES`
/// attempts, sleeping `RETRY_DELAYS_MS[i]` between them. The body must
/// evaluate to `Result<T, StepError>`; a `StepError::Terminal` short-circuits
/// without retrying, and the macro yields `Result<T, String>`.
///
/// Takes a `label` describing the step (carried into the final error) and the
/// attempt `block`. On exhaustion the error is the full per-attempt history
/// with timing (via [`summarize_attempts`]) rather than just the last failure
/// — that's what tells a steady outage apart from flapping connectivity. A
/// `Terminal` error is labelled (`{label}: {msg}`) and returned immediately.
///
/// Expanded inline (rather than a generic async helper) so the body can
/// freely borrow locals — an `FnMut` returning a borrowing future runs into
/// lifetime gymnastics that aren't worth it here.
macro_rules! retry_upload_step {
    ($label:expr, $attempt:block) => {{
        const MAX_RETRIES: usize = 3;
        const RETRY_DELAYS_MS: [u64; 3] = [2_000, 4_000, 8_000];
        let __label: String = ($label).to_string();
        let mut __attempt: usize = 0;
        let mut __history: Vec<(usize, String, f64)> = Vec::new();
        loop {
            let __start = tokio::time::Instant::now();
            match (async $attempt).await {
                Ok(__v) => break Ok::<_, String>(__v),
                Err(StepError::Terminal(__msg)) => break Err(format!("{__label}: {__msg}")),
                Err(StepError::Retryable(__msg)) => {
                    __history.push((__attempt + 1, __msg, __start.elapsed().as_secs_f64()));
                    if __attempt + 1 >= MAX_RETRIES {
                        break Err(summarize_attempts(&__label, &__history));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(
                        RETRY_DELAYS_MS[__attempt],
                    ))
                    .await;
                    __attempt += 1;
                }
            }
        }
    }};
}

/// Shared upload-and-confirm pipeline: get presigned URL, PUT to R2, POST
/// confirmation. Used by both `capture_and_upload` (screen/window) and
/// `upload_frame` (camera). Each network step is retried with exponential
/// backoff (see [`retry_upload_step`]).
///
/// `captured_at` is the ISO-8601 timestamp (in client clock) of when the
/// screenshot was actually taken. Optional — when `None`, the request
/// matches the legacy bucket-mode payload byte-for-byte. When `Some`, it
/// opts the session into credit-mode tracking on the first request.
///
/// Takes the JPEG as `bytes::Bytes` (cheap refcounted clones for retries —
/// no full-buffer copy per attempt) plus its base64 form, which is only
/// carried through for the JS preview. Callers that capture natively encode
/// base64 exactly once; nothing here decodes it back.
/// One capture unit ready for upload: the legacy single JPEG or an H.264
/// MP4 clip. The content type must match the granted format — the
/// presigned URL is signed with it.
pub(crate) struct UploadPayload {
    bytes: bytes::Bytes,
    content_type: &'static str,
    /// `format` query value for upload-url. None = legacy JPEG request.
    format: Option<&'static str>,
    /// Frames inside a clip (confirm-body telemetry). None for JPEG.
    frame_count: Option<u32>,
    width: u32,
    height: u32,
    /// JPEG preview (base64) of the unit's last frame, for the UI event.
    preview_base64: String,
    /// Pause/stop flush: the confirm carries `final: true`, and the server
    /// credits the partial minute since the last credited mark (its
    /// creditFinalCapture) instead of the all-or-nothing streak rule.
    is_final: bool,
}

impl UploadPayload {
    pub(crate) fn jpeg(bytes: bytes::Bytes, base64: String, width: u32, height: u32) -> Self {
        Self {
            bytes,
            content_type: "image/jpeg",
            format: None,
            frame_count: None,
            width,
            height,
            preview_base64: base64,
            is_final: false,
        }
    }

    /// Mark this payload as the pause/stop flush capture.
    pub(crate) fn final_capture(mut self) -> Self {
        self.is_final = true;
        self
    }

    /// A per-minute clip. The container is whatever the platform encoder
    /// produced — MP4 everywhere except the Linux VP9 fallback's WebM — and
    /// the granted format has to match the content type the presigned PUT
    /// was signed with, so both come off the clip rather than being
    /// hardcoded here.
    pub(crate) fn clip(clip: clips::FinishedClip, preview_base64: String) -> Self {
        Self {
            bytes: bytes::Bytes::from(clip.bytes),
            content_type: clip.format.content_type(),
            format: Some(clip.format.upload_format()),
            frame_count: Some(clip.frame_count),
            width: clip.width,
            height: clip.height,
            preview_base64,
            is_final: false,
        }
    }
}

pub(crate) async fn upload_and_confirm(
    payload: UploadPayload,
    captured_at: Option<&str>,
    config: &SessionConfig,
    core: &Core,
) -> Result<CaptureUploadResult, String> {
    let size_bytes = payload.bytes.len();
    const STEP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

    // Step 1: Get presigned URL from server
    core.emit(CoreEvent::Progress("getting upload url from server...".to_string()));
    let client = http_client();
    let upload_url_url = format!(
        "{}/api/sessions/{}/upload-url",
        config.api_base_url, config.token
    );
    // Build query params; reqwest percent-encodes them correctly (replacing
    // the old hand-rolled capturedAt encoding). clientInfo is always sent.
    let mut query: Vec<(&str, &str)> = vec![("clientInfo", core.client_info())];
    if let Some(c) = captured_at {
        query.push(("capturedAt", c));
    }
    if let Some(f) = payload.format {
        query.push(("format", f));
    }
    // Each attempt re-requests a FRESH presigned URL (it has a 120s expiry).
    // Bracket the request on the local clock for the offset estimate below.
    // The bracket spans the whole retry block (matching the web SDK) — a
    // retried attempt inflates the window and the midpoint with it, but the
    // estimator smooths samples and only ever needs ±30s accuracy.
    let url_sent_at_ms = current_unix_ms();
    let upload_url_resp: UploadUrlResponse = retry_upload_step!("upload-url", {
        let url_response = client
            .get(upload_url_url.as_str())
            .query(&query)
            .timeout(STEP_TIMEOUT)
            .send()
            .await
            .map_err(|e| StepError::Retryable(describe_reqwest_error(&e)))?;
        let url_status = url_response.status();
        if !url_status.is_success() {
            let body = url_response.text().await.unwrap_or_default();
            Err(classify_http(url_status, http_error(url_status, &body)))
        } else {
            url_response
                .json::<UploadUrlResponse>()
                .await
                .map_err(|e| StepError::Retryable(describe_reqwest_error(&e)))
        }
    })?;
    core.emit(CoreEvent::Progress(format!(
        "got upload url, screenshot id: {}",
        upload_url_resp.screenshot_id
    )));

    // Fold the server's clock into the offset estimate. One sample per
    // upload, for free — this is what keeps stamps and the tick schedule
    // honest on a machine whose system clock is wrong.
    if let Some(server_ms) = upload_url_resp
        .server_time
        .as_deref()
        .and_then(parse_iso_to_unix_ms)
    {
        let mut offset = core.clock_offset.lock().unwrap();
        offset.observe(server_ms, url_sent_at_ms, current_unix_ms());
        if upload_url_resp.captured_at_adopted {
            // The server stamped that capture on arrival because our clock
            // was outside the trust envelope. Recording is intact; from the
            // next capture on, the estimate above corrects our stamps.
            let skew_s = offset.offset_ms() / 1000;
            eprintln!(
                "[clock] this machine's clock is ~{skew_s}s off the server's — \
                 the capture was saved with server time, and later captures \
                 are corrected automatically"
            );
            core.emit(CoreEvent::Progress(format!("system clock is ~{skew_s}s off — corrected automatically")));
        }
    }

    // The presigned URL is signed for the GRANTED format's content type —
    // uploading a clip against a jpeg grant would fail the signature. A
    // downgrade here (clips disabled server-side, pre-clips server) is a
    // terminal error for this payload; the capture loop retries the tick
    // with its JPEG fallback.
    if let Some(requested) = payload.format {
        let granted = upload_url_resp.format.as_deref().unwrap_or("jpeg");
        if granted != requested {
            return Err(format!(
                "server granted \"{granted}\" for a \"{requested}\" clip upload"
            ));
        }
    }

    // Step 2: Upload JPEG to R2
    core.emit(CoreEvent::Progress(format!("uploading {}KB to R2...", size_bytes / 1024)));
    // Retried against the same presigned URL (still valid within its expiry).
    // Label carries the payload size and target host so an "r2 timed out"
    // report isolates the bucket/account and flags oversized frames.
    let r2_host = reqwest::Url::parse(&upload_url_resp.upload_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "r2".to_string());
    let r2_label = format!("r2-upload {}KB → {}", size_bytes / 1024, r2_host);
    retry_upload_step!(r2_label, {
        client
            .put(upload_url_resp.upload_url.as_str())
            .header("Content-Type", payload.content_type)
            // Bytes::clone is a refcount bump, not a buffer copy.
            .body(payload.bytes.clone())
            .timeout(STEP_TIMEOUT)
            .send()
            .await
            .map_err(|e| StepError::Retryable(describe_reqwest_error(&e)))?
            .error_for_status()
            .map_err(|e| StepError::Retryable(describe_reqwest_error(&e)))?;
        Ok(())
    })?;
    core.emit(CoreEvent::Progress("uploaded to R2 successfully".to_string()));

    // Step 3: Confirm upload with server
    core.emit(CoreEvent::Progress("confirming upload with server...".to_string()));
    let mut confirm_body = serde_json::json!({
        "screenshotId": upload_url_resp.screenshot_id,
        "width": payload.width,
        "height": payload.height,
        "fileSize": size_bytes,
    });
    if let Some(fc) = payload.frame_count {
        confirm_body["frameCount"] = fc.into();
    }
    // Only sent when true: pre-final servers reject unknown confirm fields.
    if payload.is_final {
        confirm_body["final"] = true.into();
    }
    let confirm_sent_at_ms = current_unix_ms();
    let confirm_resp: ConfirmResponse = retry_upload_step!("confirm", {
        let confirm_response = client
            .post(format!(
                "{}/api/sessions/{}/screenshots",
                config.api_base_url, config.token
            ))
            .json(&confirm_body)
            .timeout(STEP_TIMEOUT)
            .send()
            .await
            .map_err(|e| StepError::Retryable(describe_reqwest_error(&e)))?;
        let confirm_status = confirm_response.status();
        if !confirm_status.is_success() {
            let body = confirm_response.text().await.unwrap_or_default();
            Err(classify_http(confirm_status, http_error(confirm_status, &body)))
        } else {
            confirm_response
                .json::<ConfirmResponse>()
                .await
                .map_err(|e| StepError::Retryable(describe_reqwest_error(&e)))
        }
    })?;
    // Second free offset sample per upload, same bracketing as upload-url.
    if let Some(server_ms) = confirm_resp
        .server_time
        .as_deref()
        .and_then(parse_iso_to_unix_ms)
    {
        core.clock_offset
            .lock()
            .unwrap()
            .observe(server_ms, confirm_sent_at_ms, current_unix_ms());
    }

    core.emit(CoreEvent::Progress(format!(
        "confirmed! tracked {}s, next expected at {}",
        confirm_resp.tracked_seconds, confirm_resp.next_expected_at
    )));

    Ok(CaptureUploadResult {
        confirmed: confirm_resp.confirmed,
        tracked_seconds: confirm_resp.tracked_seconds,
        next_expected_at: confirm_resp.next_expected_at,
        preview_base64: payload.preview_base64,
        preview_width: payload.width,
        preview_height: payload.height,
    })
}

#[cfg(test)]
mod retry_tests {
    use super::{classify_http, summarize_attempts, StepError};
    use std::cell::Cell;

    #[test]
    fn summarize_handles_edge_cases() {
        assert_eq!(summarize_attempts("upload-url", &[]), "upload-url: unknown error");
        // A lone failure is labelled and timed, no "failed after N" wrapper.
        assert_eq!(
            summarize_attempts("r2-upload", &[(1, "timed out".into(), 30.0)]),
            "r2-upload: timed out (30.0s)"
        );
    }

    #[test]
    fn summarize_collapses_identical_causes_with_all_times() {
        // Steady outage: one cause, every attempt's elapsed time listed.
        let history = [
            (1, "timed out".to_string(), 30.0),
            (2, "timed out".to_string(), 30.0),
            (3, "timed out".to_string(), 30.0),
        ];
        assert_eq!(
            summarize_attempts("r2-upload 84KB → acct.r2.dev", &history),
            "r2-upload 84KB → acct.r2.dev failed after 3 attempts: timed out (30.0s, 30.0s, 30.0s)"
        );
    }

    #[test]
    fn summarize_lists_distinct_causes_with_times() {
        // Flapping: each attempt's cause and elapsed time preserved.
        let history = [
            (1, "timed out".to_string(), 30.0),
            (2, "connection refused".to_string(), 1.2),
        ];
        assert_eq!(
            summarize_attempts("r2-upload", &history),
            "r2-upload failed after 2 attempts: #1 timed out (30.0s); #2 connection refused (1.2s)"
        );
    }

    #[test]
    fn classify_409_conflict_is_terminal() {
        // 409 = session paused/stopped server-side → must not retry.
        let e = classify_http(reqwest::StatusCode::CONFLICT, "paused".into());
        assert!(matches!(e, StepError::Terminal(_)));
    }

    #[test]
    fn classify_5xx_is_retryable() {
        let e = classify_http(reqwest::StatusCode::INTERNAL_SERVER_ERROR, "boom".into());
        assert!(matches!(e, StepError::Retryable(_)));
    }

    #[test]
    fn classify_other_4xx_is_retryable() {
        // Only 409 is special; everything else (incl. 404) retries, matching
        // the web client.
        let e = classify_http(reqwest::StatusCode::NOT_FOUND, "missing".into());
        assert!(matches!(e, StepError::Retryable(_)));
    }

    // `start_paused` makes tokio auto-advance virtual time, so the backoff
    // sleeps complete instantly and we still exercise the real sleep path.

    // Under the paused clock no real time elapses between an attempt's start
    // and its failure, so per-attempt timing renders as "0.0s".

    #[tokio::test(start_paused = true)]
    async fn first_attempt_success_does_not_retry() {
        let attempts = Cell::new(0usize);
        let result: Result<&str, String> = retry_upload_step!("test", {
            attempts.set(attempts.get() + 1);
            Ok("ok")
        });
        assert_eq!(attempts.get(), 1);
        assert_eq!(result.unwrap(), "ok");
    }

    #[tokio::test(start_paused = true)]
    async fn retryable_failure_recovers_within_max_attempts() {
        let attempts = Cell::new(0usize);
        let result: Result<u32, String> = retry_upload_step!("test", {
            let n = attempts.get() + 1;
            attempts.set(n);
            if n < 3 {
                Err(StepError::Retryable(format!("transient {n}")))
            } else {
                Ok(42u32)
            }
        });
        assert_eq!(attempts.get(), 3);
        assert_eq!(result.unwrap(), 42);
    }

    #[tokio::test(start_paused = true)]
    async fn retryable_failure_exhausts_after_three_attempts() {
        let attempts = Cell::new(0usize);
        let result: Result<(), String> = retry_upload_step!("upload-url", {
            attempts.set(attempts.get() + 1);
            Err::<(), StepError>(StepError::Retryable("timed out".into()))
        });
        // MAX_RETRIES = 3 → three attempts; identical causes collapse to one
        // line, led by the label, with every elapsed time listed.
        assert_eq!(attempts.get(), 3);
        assert_eq!(
            result.unwrap_err(),
            "upload-url failed after 3 attempts: timed out (0.0s, 0.0s, 0.0s)"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn distinct_failures_are_all_listed() {
        // A flapping failure must stay distinguishable from a steady outage:
        // each attempt's cause is preserved in the summary.
        let attempts = Cell::new(0usize);
        let result: Result<(), String> = retry_upload_step!("r2-upload", {
            let n = attempts.get() + 1;
            attempts.set(n);
            Err::<(), StepError>(StepError::Retryable(format!("cause {n}")))
        });
        assert_eq!(attempts.get(), 3);
        assert_eq!(
            result.unwrap_err(),
            "r2-upload failed after 3 attempts: #1 cause 1 (0.0s); #2 cause 2 (0.0s); #3 cause 3 (0.0s)"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn terminal_failure_short_circuits_without_retry() {
        let attempts = Cell::new(0usize);
        let result: Result<(), String> = retry_upload_step!("confirm", {
            attempts.set(attempts.get() + 1);
            Err::<(), StepError>(StepError::Terminal("paused".into()))
        });
        assert_eq!(attempts.get(), 1);
        // Terminal errors are labelled too, so the step is never lost.
        assert_eq!(result.unwrap_err(), "confirm: paused");
    }
}

/// Build an ISO-8601 timestamp in UTC for the current instant, corrected
/// into server time by the running clock-offset estimate. Used as the
/// client-attested `capturedAt` on upload requests when credit mode is on.
/// A no-op for a healthy clock; for a skewed one it's the difference between
/// every capture landing in the ±30s credit window and none of them doing so.
pub(crate) fn captured_at_now(core: &Core) -> String {
    let corrected_ms = {
        let offset = core.clock_offset.lock().unwrap();
        offset.correct(current_unix_ms())
    };
    unix_ms_to_iso(corrected_ms)
}

/// Format milliseconds-since-epoch as `YYYY-MM-DDTHH:MM:SS.sssZ` — what
/// `Date.parse()` and Go's `time.Parse(time.RFC3339)` both accept without
/// surprises.
pub(crate) fn unix_ms_to_iso(unix_ms: i64) -> String {
    let total_secs = unix_ms.div_euclid(1_000);
    let millis = unix_ms.rem_euclid(1_000) as u32;

    // Civil date math via days-since-epoch — Howard Hinnant's algorithm.
    let days = total_secs.div_euclid(86_400);
    let time_of_day = total_secs.rem_euclid(86_400) as u32;
    let hour = time_of_day / 3600;
    let minute = (time_of_day % 3600) / 60;
    let second = time_of_day % 60;

    // Convert days-since-1970-01-01 to civil (year, month, day).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, millis
    )
}

/// Credit-mode opt-in toggle. New desktop builds always send `capturedAt`;
/// pinning to one flag keeps the wire-format change reviewable in one spot.
/// Old builds (without this constant) never sent it and the server stays in
/// bucket mode for those sessions.
pub(crate) const ENABLE_CREDIT_MODE: bool = true;

impl Core {
    /// Full capture-upload-confirm pipeline in Rust (no browser CORS issues).
    /// Returns the confirm data AND the screenshot preview (base64) so the
    /// frontend can display the captured frame without a separate IPC call.
    pub async fn capture_and_upload(
        &self,
        sources: Vec<CaptureSource>,
        max_width: u32,
        max_height: u32,
        jpeg_quality: u8,
    ) -> Result<CaptureUploadResult, String> {
        let config = {
            let guard = self.config.lock().map_err(|e| e.to_string())?;
            guard
                .clone()
                .ok_or("Not configured — call configure() first")?
        };

        // Read blacklisted apps
        let blacklisted = {
            let guard = self.blacklisted_apps.lock().map_err(|e| e.to_string())?;
            guard.clone()
        };

        // Native screenshot
        self.emit(CoreEvent::Progress("capturing screen...".to_string()));
        #[allow(unused_mut, unused_assignments)]
        let mut pipewire_fds = std::collections::HashMap::new();
        #[cfg(target_os = "linux")]
        if let Ok(guard) = self.pipewire_fds.lock() {
            pipewire_fds = guard.clone();
        }

        // Screen capture + JPEG encode is heavy blocking work — keep it off the
        // async runtime's worker threads (same as the Rust capture loop does).
        let screenshot = tokio::task::spawn_blocking(move || {
            capture::take_stitched_screenshots_raw_with_blacklist(
                &sources,
                max_width,
                max_height,
                jpeg_quality,
                &pipewire_fds,
                &blacklisted,
                // Uploaded, so it is a recorded frame even though JS drove it.
                capture::ResizeQuality::Recorded,
            )
        })
        .await
        .map_err(|e| format!("spawn_blocking panicked: {e}"))??;
        self.emit(CoreEvent::Progress(format!(
            "captured {}x{} ({}KB jpeg)",
            screenshot.width,
            screenshot.height,
            screenshot.data.len() / 1024
        )));

        let captured_at = if ENABLE_CREDIT_MODE {
            Some(captured_at_now(self))
        } else {
            None
        };
        let jpeg_base64 = base64_encode(&screenshot.data);
        upload_and_confirm(
            UploadPayload::jpeg(
                bytes::Bytes::from(screenshot.data),
                jpeg_base64,
                screenshot.width,
                screenshot.height,
            ),
            captured_at.as_deref(),
            &config,
            self,
        )
        .await
    }

    /// Upload a pre-captured frame (e.g. from browser camera capture).
    /// Accepts base64-encoded JPEG from the frontend, runs the upload pipeline.
    pub async fn upload_frame(
        &self,
        base64: String,
        width: u32,
        height: u32,
    ) -> Result<CaptureUploadResult, String> {
        let config = {
            let guard = self.config.lock().map_err(|e| e.to_string())?;
            guard
                .clone()
                .ok_or("Not configured — call configure() first")?
        };

        self.emit(CoreEvent::Progress(format!("uploading camera frame {}x{}", width, height)));

        let captured_at = if ENABLE_CREDIT_MODE {
            Some(captured_at_now(self))
        } else {
            None
        };
        let jpeg_bytes = bytes::Bytes::from(base64_decode(&base64)?);
        upload_and_confirm(
            UploadPayload::jpeg(jpeg_bytes, base64, width, height),
            captured_at.as_deref(),
            &config,
            self,
        )
        .await
    }
}

/// Best-effort "pause the session" for a shell that is about to exit with a
/// capture loop still running, so the session doesn't sit "active" until
/// the server auto-pauses it (5 min timeout). Short timeout, errors only
/// logged: the process is leaving either way.
pub async fn pause_session_before_exit(config: &SessionConfig) {
    let client = http_client();
    let url = format!(
        "{}/api/sessions/{}/pause",
        config.api_base_url, config.token
    );
    match client
        .post(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(res) => eprintln!("[exit] pause response: {}", res.status()),
        Err(e) => eprintln!("[exit] pause failed (best-effort): {e}"),
    }
}

// ──────────────────────────────────────────────────────────────────
// Compat tests for the wire format.
//
// Cross-checks that:
//   1. The CURRENT response structs accept both legacy and new JSON.
//   2. The LEGACY response structs (copied verbatim from the pre-credit-mode
//      `lib.rs`) still accept the new server's JSON. This is the load-bearing
//      compat guarantee: an unupgraded user's binary in the wild keeps working.
// ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod compat_tests {
    use super::{unix_ms_to_iso, ConfirmResponse, UploadUrlResponse};
    use crate::capture_loop::{current_unix_ms, parse_iso_to_unix_ms};

    // Snapshot of the pre-credit-mode struct definitions, byte-for-byte from
    // git history. If a future change accidentally breaks shape compat with
    // shipped binaries, the relevant test below will fail.
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct LegacyUploadUrlResponse {
        #[serde(rename = "uploadUrl")]
        upload_url: String,
        #[serde(rename = "r2Key")]
        r2_key: String,
        #[serde(rename = "screenshotId")]
        screenshot_id: String,
        #[serde(rename = "minuteBucket")]
        minute_bucket: i32,
        #[serde(rename = "nextExpectedAt")]
        next_expected_at: String,
    }

    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct LegacyConfirmResponse {
        confirmed: bool,
        #[serde(rename = "trackedSeconds")]
        tracked_seconds: i64,
        #[serde(rename = "nextExpectedAt")]
        next_expected_at: String,
    }

    const LEGACY_UPLOAD_JSON: &str = r#"{
        "uploadUrl": "https://r2.example.com/upload",
        "r2Key": "screenshots/abc/def.jpg",
        "screenshotId": "11111111-2222-3333-4444-555555555555",
        "minuteBucket": 7,
        "nextExpectedAt": "2025-06-01T12:01:00.000Z"
    }"#;

    const NEW_UPLOAD_JSON: &str = r#"{
        "uploadUrl": "https://r2.example.com/upload",
        "r2Key": "screenshots/abc/def.jpg",
        "screenshotId": "11111111-2222-3333-4444-555555555555",
        "minuteBucket": 7,
        "nextExpectedAt": "2025-06-01T12:01:00.000Z",
        "serverTime": "2025-06-01T12:00:00.000Z",
        "capturedAtAdopted": true,
        "trackingMode": "credit"
    }"#;

    const LEGACY_CONFIRM_JSON: &str = r#"{
        "confirmed": true,
        "trackedSeconds": 60,
        "nextExpectedAt": "2025-06-01T12:01:00.000Z"
    }"#;

    const NEW_CONFIRM_JSON: &str = r#"{
        "confirmed": true,
        "trackedSeconds": 60,
        "nextExpectedAt": "2025-06-01T12:01:00.000Z",
        "serverTime": "2025-06-01T12:00:00.500Z"
    }"#;

    // ── 4-way matrix: {legacy, new} struct × {legacy, new} JSON ───────

    #[test]
    fn new_struct_parses_legacy_json_upload_url() {
        // New binary hitting an OLD server (rollout window): the new struct
        // must accept the legacy JSON (missing serverTime / trackingMode).
        let r: UploadUrlResponse = serde_json::from_str(LEGACY_UPLOAD_JSON).unwrap();
        assert_eq!(r.screenshot_id, "11111111-2222-3333-4444-555555555555");
        assert_eq!(r.minute_bucket, 7);
        assert!(r.server_time.is_none());
        assert!(!r.captured_at_adopted);
        assert!(r.tracking_mode.is_none());
    }

    #[test]
    fn new_struct_parses_new_json_upload_url() {
        let r: UploadUrlResponse = serde_json::from_str(NEW_UPLOAD_JSON).unwrap();
        assert_eq!(r.server_time.as_deref(), Some("2025-06-01T12:00:00.000Z"));
        assert!(r.captured_at_adopted);
        assert_eq!(r.tracking_mode.as_deref(), Some("credit"));
    }

    #[test]
    fn legacy_struct_parses_new_json_upload_url() {
        // *** Load-bearing compat guarantee ***
        // The struct shape as it exists in the currently-shipped binary
        // must continue to deserialize the new server's responses. If
        // serde's default behavior (ignore unknown fields) ever changes
        // — or if someone adds `deny_unknown_fields` later — this fails.
        let r: LegacyUploadUrlResponse = serde_json::from_str(NEW_UPLOAD_JSON).unwrap();
        assert_eq!(r.screenshot_id, "11111111-2222-3333-4444-555555555555");
        assert_eq!(r.minute_bucket, 7);
        assert_eq!(r.next_expected_at, "2025-06-01T12:01:00.000Z");
    }

    #[test]
    fn legacy_struct_parses_legacy_json_upload_url() {
        let r: LegacyUploadUrlResponse = serde_json::from_str(LEGACY_UPLOAD_JSON).unwrap();
        assert_eq!(r.minute_bucket, 7);
    }

    #[test]
    fn new_struct_parses_legacy_json_confirm() {
        let r: ConfirmResponse = serde_json::from_str(LEGACY_CONFIRM_JSON).unwrap();
        assert_eq!(r.tracked_seconds, 60);
        assert!(r.server_time.is_none());
    }

    #[test]
    fn new_struct_parses_new_json_confirm() {
        let r: ConfirmResponse = serde_json::from_str(NEW_CONFIRM_JSON).unwrap();
        assert_eq!(r.tracked_seconds, 60);
        assert!(r.server_time.is_some());
    }

    #[test]
    fn legacy_struct_parses_new_json_confirm() {
        // *** Load-bearing compat guarantee *** for /screenshots responses.
        let r: LegacyConfirmResponse = serde_json::from_str(NEW_CONFIRM_JSON).unwrap();
        assert!(r.confirmed);
        assert_eq!(r.tracked_seconds, 60);
        assert_eq!(r.next_expected_at, "2025-06-01T12:01:00.000Z");
    }

    #[test]
    fn legacy_struct_parses_legacy_json_confirm() {
        let r: LegacyConfirmResponse = serde_json::from_str(LEGACY_CONFIRM_JSON).unwrap();
        assert_eq!(r.tracked_seconds, 60);
    }

    // ── captured_at helpers ───────────────────────────────────────────

    #[test]
    fn captured_at_now_is_iso8601_utc() {
        let s = unix_ms_to_iso(current_unix_ms());
        // YYYY-MM-DDTHH:MM:SS.sssZ — 24 chars total
        assert_eq!(s.len(), 24);
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[7..8], "-");
        assert_eq!(&s[10..11], "T");
        assert_eq!(&s[13..14], ":");
        assert_eq!(&s[16..17], ":");
        assert_eq!(&s[19..20], ".");
        assert_eq!(&s[23..24], "Z");
    }

    #[test]
    fn parse_iso_to_unix_ms_round_trips_captured_at_now() {
        let s = unix_ms_to_iso(current_unix_ms());
        let parsed = parse_iso_to_unix_ms(&s).expect("parses");
        let actual = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        // Round-trip within 5s of wall clock.
        assert!((parsed - actual).abs() < 5_000, "parsed={parsed} actual={actual}");
    }

    #[test]
    fn parse_iso_to_unix_ms_handles_known_values() {
        // 2025-01-01T00:00:00.000Z = 1735689600000
        assert_eq!(
            parse_iso_to_unix_ms("2025-01-01T00:00:00.000Z"),
            Some(1735689600000)
        );
        // 2025-06-01T12:00:00.000Z = 1748779200000
        assert_eq!(
            parse_iso_to_unix_ms("2025-06-01T12:00:00.000Z"),
            Some(1748779200000)
        );
        // 1970-01-01T00:00:00.000Z = 0
        assert_eq!(parse_iso_to_unix_ms("1970-01-01T00:00:00.000Z"), Some(0));
    }

    #[test]
    fn parse_iso_to_unix_ms_handles_timezone_offset() {
        // 12:00 at +05:00 == 07:00 UTC
        let a = parse_iso_to_unix_ms("2025-06-01T12:00:00.000+05:00");
        let b = parse_iso_to_unix_ms("2025-06-01T07:00:00.000Z");
        assert_eq!(a, b);
    }

    #[test]
    fn parse_iso_to_unix_ms_rejects_garbage() {
        assert_eq!(parse_iso_to_unix_ms(""), None);
        assert_eq!(parse_iso_to_unix_ms("not-a-date"), None);
        assert_eq!(parse_iso_to_unix_ms("2025/06/01"), None);
    }

    // ──────────────────────────────────────────────────────────────────
    // Regression test for the camera-session crash (SIGABRT) in 0.2.0/0.2.1.
    //
    // `start_tray_ticker` was a sync `#[tauri::command]` that called
    // `tokio::spawn` via `start_tray_timer` (today: `Core::start_tray_timer`,
    // called from the shell's async command). Sync Tauri commands run on a
    // thread with no tokio runtime in context, so `tokio::spawn` panicked
    // and the app aborted. The fix is making the command `async` so Tauri
    // hosts it on its async runtime.
    //
    // We can't easily instantiate Tauri's AppHandle in a unit test, so we
    // reproduce the underlying invariant: `tokio::spawn` must run inside a
    // runtime. If this assertion ever weakens (e.g. tokio adds an
    // ambient-runtime fallback), revisit whether the `async fn` is still
    // load-bearing on the command.
    // ──────────────────────────────────────────────────────────────────

    #[test]
    fn tokio_spawn_panics_without_runtime() {
        // The exact failure mode that crashed 0.2.0/0.2.1 camera sessions.
        let result = std::panic::catch_unwind(|| {
            let _ = tokio::spawn(async {});
        });
        assert!(
            result.is_err(),
            "tokio::spawn outside a runtime should panic — if this now succeeds, \
             tokio's behavior changed and the async-fn fix may no longer be required."
        );
    }

    #[test]
    fn tokio_spawn_succeeds_inside_runtime() {
        // Mirrors what Tauri's async runtime does for `async` commands.
        let rt = tokio::runtime::Runtime::new().expect("build runtime");
        rt.block_on(async {
            let h = tokio::spawn(async { 42i32 });
            assert_eq!(h.await.unwrap(), 42);
        });
    }
}

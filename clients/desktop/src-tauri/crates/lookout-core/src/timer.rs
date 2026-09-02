//! The recording clock shown in the menu bar / tray. Ticks in Rust, once a
//! second, so a throttled WebView can't stall it; the shell only gets told
//! what text to display (see [`crate::Frontend::set_tray_title`]).

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant as StdInstant;
use tokio::sync::watch;

use crate::capture_loop::{current_unix_ms, CAPTURE_INTERVAL_SECS};
#[cfg(target_os = "macos")]
use crate::power;
use crate::{Core, Frontend};

/// Shared state for the Rust-side tray title timer.
/// Uses atomics so the capture loop can update tracked_seconds
/// without acquiring a mutex on every tick.
///
/// This mirrors `useSessionTimerState` in @lookout/react. The menu bar,
/// the tray popup and the main window each tick their own clock (so a
/// throttled WebView can't stall the menu bar), which only works if all
/// three apply the *same* rules to the same anchor: ratchet the base
/// forward, cap interpolation at one capture interval, and drop the
/// interpolated remainder while paused. Diverge on any of those and the
/// menu bar visibly disagrees with the main window.
pub struct TrayTimerState {
    /// Authoritative tracked seconds from the last server response.
    /// Ratchets forward only — see `sync_tray_timer`.
    tracked_seconds: AtomicI64,
    /// Wall-clock instant `tracked_seconds` last advanced (the
    /// interpolation anchor).
    started_at: Mutex<StdInstant>,
    /// Whether the timer is actively ticking (false = paused).
    is_running: AtomicBool,
}

/// Handle for the tray title ticker task.
pub(crate) struct TrayTimerHandle {
    state: Arc<TrayTimerState>,
    cancel_tx: watch::Sender<bool>,
    join_handle: tokio::task::JoinHandle<()>,
}

/// Extra interpolation headroom past one capture interval, absorbing the
/// confirm round-trip a credit takes to reach the UI. Mirrors
/// TIMER_INTERPOLATION_SLACK_S in @lookout/shared — keep the two in step.
/// Without it, any two confirms arriving more than one interval apart
/// (multi-MB clip uploads jitter by seconds) froze every timer surface
/// exactly at a xx:00 boundary until the next confirm landed.
pub const TIMER_INTERPOLATION_SLACK_SECS: i64 = 15;

/// Max seconds the menu-bar time may run ahead of the last server-credited
/// `tracked_seconds`. Must equal `MAX_INTERPOLATION_S` in
/// @lookout/react's useSessionTimer — one capture interval plus latency
/// slack. Without the cap the menu bar kept counting through a capture
/// stall while the main window froze at the same cap, and the two never
/// reconverged.
pub const MAX_TRAY_INTERPOLATION_SECS: i64 =
    CAPTURE_INTERVAL_SECS as i64 + TIMER_INTERPOLATION_SLACK_SECS;

/// The Rust mirror of `deriveDisplaySeconds` in @lookout/react. Keep the two
/// in step: the menu bar and the main window each tick their own clock, so any
/// difference here is directly visible as the two showing different times.
pub fn tray_display_seconds(base_seconds: i64, elapsed_secs: i64, running: bool) -> i64 {
    if !running {
        // Paused drops the interpolated remainder rather than freezing it,
        // matching the main window's snap-down.
        return base_seconds;
    }
    base_seconds + elapsed_secs.clamp(0, MAX_TRAY_INTERPOLATION_SECS)
}

/// Format seconds into a clock-style tray title:
/// >0h: "{h}:{mm:02}:{ss:02}", else: "{mm:02}:{ss:02}"
pub fn format_tray_time(total_seconds: i64) -> String {
    let total = total_seconds.max(0) as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

/// The tray title ticker task — updates the menu bar text every second.
/// Runs independently of JS so it works even when the WebView is throttled.
async fn tray_timer_task(
    frontend: Arc<dyn Frontend>,
    timer_state: Arc<TrayTimerState>,
    mut cancel_rx: watch::Receiver<bool>,
) {
    use tokio::time::{interval, Duration, MissedTickBehavior};

    let mut ticker = interval(Duration::from_secs(1));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // The title only changes at minute granularity, so most 1s ticks would
    // rewrite the exact same string. Cache the last text and skip redundant
    // native tray updates. After a paused stretch the JS side may have
    // overwritten the title (paused indicator), so force one refresh on the
    // first running tick after a pause even if the text matches.
    let mut last_title: Option<String> = None;
    let mut was_paused = false;

    loop {
        tokio::select! {
            _ = ticker.tick() => {}
            _ = cancel_rx.changed() => {
                eprintln!("[tray-timer] cancelled");
                break;
            }
        }

        let base_seconds = timer_state.tracked_seconds.load(Ordering::Relaxed);
        let running = timer_state.is_running.load(Ordering::Relaxed);

        let elapsed = {
            let started = timer_state.started_at.lock().unwrap();
            started.elapsed().as_secs() as i64
        };
        let display_seconds = tray_display_seconds(base_seconds, elapsed, running);

        let time_text = format_tray_time(display_seconds);

        if !running {
            // Write the frozen value once (a pause snaps the title down by
            // the dropped remainder), then idle until resume.
            if last_title.as_deref() != Some(time_text.as_str()) {
                frontend.set_tray_title(&time_text, true);
                last_title = Some(time_text);
            }
            was_paused = true;
            continue;
        }

        if was_paused || last_title.as_deref() != Some(time_text.as_str()) {
            frontend.set_tray_title(&time_text, false);
            last_title = Some(time_text);
        }
        was_paused = false;
    }
}

impl Core {
    /// Start the tray timer (if not already running). Returns the shared state
    /// so the capture loop can sync `tracked_seconds` into it.
    ///
    /// Spawns onto the ambient tokio runtime — call it from inside one.
    pub fn start_tray_timer(&self) -> Arc<TrayTimerState> {
        let mut guard = self.tray_timer.lock().unwrap();

        // If already running, just return the existing state handle
        if let Some(ref handle) = *guard {
            return Arc::clone(&handle.state);
        }

        // The tray timer lives exactly as long as a session is being recorded
        // (screen sessions via start_capture_loop, camera via start_tray_ticker),
        // so it's the right scope for the keep-awake assertion.
        #[cfg(target_os = "macos")]
        power::begin_recording_assertion();

        let timer_state = Arc::new(TrayTimerState {
            tracked_seconds: AtomicI64::new(0),
            started_at: Mutex::new(StdInstant::now()),
            is_running: AtomicBool::new(true),
        });

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let frontend = Arc::clone(&self.frontend);
        let state_clone = Arc::clone(&timer_state);

        let join_handle = tokio::spawn(async move {
            tray_timer_task(frontend, state_clone, cancel_rx).await;
        });

        eprintln!("[tray-timer] started");

        let handle = TrayTimerHandle {
            state: Arc::clone(&timer_state),
            cancel_tx,
            join_handle,
        };
        *guard = Some(handle);

        timer_state
    }

    /// Stop the tray timer.
    pub fn stop_tray_timer(&self) {
        let mut guard = self.tray_timer.lock().unwrap();
        if let Some(handle) = guard.take() {
            eprintln!("[tray-timer] stopping");
            let _ = handle.cancel_tx.send(true);
            handle.join_handle.abort();

            // Recording is over — let macOS nap/idle-sleep normally again.
            #[cfg(target_os = "macos")]
            power::end_recording_assertion();
        }
    }

    /// Start the tray title ticker for a session whose capture loop runs
    /// elsewhere (camera sessions: the shell captures, but the menu bar clock
    /// should still tick in Rust).
    ///
    /// Spawns onto the ambient tokio runtime via [`Core::start_tray_timer`] —
    /// call it from inside one. (In the Tauri shell that means an `async`
    /// command: a sync command has no runtime in context, and calling
    /// `tokio::spawn` there aborted camera sessions in 0.2.0 + 0.2.1.)
    pub fn start_tray_ticker(&self, tracked_seconds: i64) -> Result<(), String> {
        let timer_state = self.start_tray_timer();
        // Ratchet, don't store: `start_tray_timer` returns the *existing* state
        // if a session is already being tracked, and a re-entrant call with a
        // stale (or zero) baseline would knock the menu bar backwards.
        ratchet_tray_tracked_seconds(&timer_state, tracked_seconds);
        {
            let mut started = timer_state.started_at.lock().unwrap();
            *started = StdInstant::now();
        }
        timer_state.is_running.store(true, Ordering::Relaxed);
        Ok(())
    }
}

/// Ratchet `tracked_seconds` to a new authoritative value, re-anchoring the
/// elapsed counter **only if the value actually advanced**.
///
/// Both halves matter for staying in step with the main window:
///   - Ratchet: an idempotent retry can confirm against a stale read and
///     return a *lower* `trackedSeconds`. JS keeps the higher value, so
///     storing the lower one here made the menu bar jump backwards and sit
///     a minute behind until the next credit.
///   - Anchor only on advance: a repeated reading must not restart the
///     interpolation window, or the menu bar loses time the main window keeps.
pub(crate) fn ratchet_tray_tracked_seconds(timer_state: &TrayTimerState, tracked_seconds: i64) {
    let prev = timer_state
        .tracked_seconds
        .fetch_max(tracked_seconds, Ordering::Relaxed);
    if tracked_seconds > prev {
        let mut started = timer_state.started_at.lock().unwrap();
        *started = StdInstant::now();
    }
}

impl Core {
    /// Sync the tray timer to a new authoritative tracked_seconds value
    /// (typically from a capture result).
    pub fn sync_tray_timer(&self, tracked_seconds: i64) {
        let guard = self.tray_timer.lock().unwrap();
        if let Some(ref handle) = *guard {
            ratchet_tray_tracked_seconds(&handle.state, tracked_seconds);
        }
    }

    /// Sync the tray timer AND align its interpolation anchor with the main
    /// window's (epoch ms, from useSessionTimerState's `anchorAt`).
    ///
    /// The two surfaces tick independently, and they only show the same seconds
    /// if they interpolate from the same anchor. The main window's anchor sits
    /// up to the carry (confirm latency, ≤ the slack) in the PAST of the moment
    /// the credit arrived — see the carry logic in useSessionTimer — while this
    /// ticker used to re-anchor at its own `Instant::now()`, so the menu
    /// bar/waybar ran a few seconds behind the main window for the whole
    /// session. Accepts equal (not just greater) values so a carry-only anchor
    /// adjustment still propagates.
    pub fn sync_tray_timer_anchored(&self, tracked_seconds: i64, anchor_at_unix_ms: i64) {
        let guard = self.tray_timer.lock().unwrap();
        if let Some(ref handle) = *guard {
            let ts = &handle.state;
            let prev = ts.tracked_seconds.fetch_max(tracked_seconds, Ordering::Relaxed);
            if tracked_seconds >= prev {
                let behind_ms = (current_unix_ms() - anchor_at_unix_ms)
                    .clamp(0, MAX_TRAY_INTERPOLATION_SECS * 1000);
                let mut started = ts.started_at.lock().unwrap();
                *started = StdInstant::now() - std::time::Duration::from_millis(behind_ms as u64);
            }
        }
    }

    /// Pause the tray timer. The next tick drops the interpolated remainder and
    /// shows the bare `tracked_seconds`, matching the main window's snap-down.
    pub fn pause_tray_timer(&self) {
        let guard = self.tray_timer.lock().unwrap();
        if let Some(ref handle) = *guard {
            handle.state.is_running.store(false, Ordering::Relaxed);
        }
    }

    /// Resume the tray timer. Re-anchors the elapsed counter so it continues
    /// from the current tracked_seconds.
    pub fn resume_tray_timer(&self) {
        let guard = self.tray_timer.lock().unwrap();
        if let Some(ref handle) = *guard {
            let mut started = handle.state.started_at.lock().unwrap();
            *started = StdInstant::now();
            handle.state.is_running.store(true, Ordering::Relaxed);
        }
    }
}

/// The menu-bar clock must agree with the main window's clock. Both tick
/// independently, so they only stay together if these rules match
/// `deriveDisplaySeconds` / `useSessionTimerState` in @lookout/react.
#[cfg(test)]
mod tray_timer_tests {
    use super::{
        format_tray_time, ratchet_tray_tracked_seconds, tray_display_seconds, TrayTimerState,
        MAX_TRAY_INTERPOLATION_SECS,
    };
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
    use std::sync::Mutex;
    use std::time::Instant;

    fn state(tracked: i64) -> TrayTimerState {
        TrayTimerState {
            tracked_seconds: AtomicI64::new(tracked),
            started_at: Mutex::new(Instant::now()),
            is_running: AtomicBool::new(true),
        }
    }

    #[test]
    fn cap_matches_the_js_side() {
        // MAX_INTERPOLATION_S in useSessionTimer.ts is
        // SCREENSHOT_INTERVAL_MS / 1000 + TIMER_INTERPOLATION_SLACK_S
        // = 60 + 15.
        assert_eq!(MAX_TRAY_INTERPOLATION_SECS, 75);
    }

    #[test]
    fn interpolates_at_wall_clock_rate() {
        assert_eq!(tray_display_seconds(120, 0, true), 120);
        assert_eq!(tray_display_seconds(120, 30, true), 150);
    }

    #[test]
    fn interpolation_is_capped_at_one_interval_plus_slack() {
        // Without the cap the menu bar kept counting through a capture stall
        // while the main window froze at the shared cap, and the two never
        // reconverged — the reported "menu bar shows a different time".
        assert_eq!(
            tray_display_seconds(120, 90, true),
            120 + MAX_TRAY_INTERPOLATION_SECS
        );
        assert_eq!(
            tray_display_seconds(120, 600, true),
            120 + MAX_TRAY_INTERPOLATION_SECS
        );
    }

    #[test]
    fn pause_drops_the_interpolated_remainder() {
        // The main window snaps down to the base on pause. Freezing at the
        // interpolated value here left the menu bar up to a minute ahead for
        // the whole pause.
        assert_eq!(tray_display_seconds(120, 45, false), 120);
        // Clock-style title: the paused value is the base, formatted exactly —
        // 299s is 04:59, not the 4m the minute-granularity title used to show.
        assert_eq!(
            format_tray_time(tray_display_seconds(299, 59, false)),
            "04:59"
        );
    }

    #[test]
    fn ratchet_ignores_a_stale_lower_reading() {
        // An idempotent retry can confirm against a stale read and return a
        // lower trackedSeconds. JS keeps the higher value; storing the lower
        // one here made the menu bar jump backwards and sit behind.
        let s = state(120);
        ratchet_tray_tracked_seconds(&s, 60);
        assert_eq!(s.tracked_seconds.load(Ordering::Relaxed), 120);
        ratchet_tray_tracked_seconds(&s, 180);
        assert_eq!(s.tracked_seconds.load(Ordering::Relaxed), 180);
    }

    #[test]
    fn ratchet_re_anchors_only_on_advance() {
        let s = state(120);
        let before = *s.started_at.lock().unwrap();

        // A repeated reading must not restart the interpolation window, or
        // the menu bar loses time the main window is still counting.
        ratchet_tray_tracked_seconds(&s, 120);
        assert_eq!(*s.started_at.lock().unwrap(), before);
        ratchet_tray_tracked_seconds(&s, 60);
        assert_eq!(*s.started_at.lock().unwrap(), before);

        // A real advance re-anchors.
        ratchet_tray_tracked_seconds(&s, 180);
        assert!(*s.started_at.lock().unwrap() > before);
    }
}

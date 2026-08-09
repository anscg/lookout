/**
 * Tests for useSessionTimer — the user-facing recording clock.
 *
 * The invariants under test:
 *   1. Display never overshoots the server value by more than one
 *      capture interval (60s). Bounds the surprise at stop/compile.
 *   2. When the server credits, the display unfreezes smoothly — the
 *      new server value equals the previously-frozen display value (no
 *      visible jump on recovery).
 *   3. Snap to server when `isActive` flips false (pause/stop). No
 *      further interpolation past that point.
 *   4. Stale-read protection: a server value LOWER than the current
 *      ratchet does not move the display backward (defends against
 *      idempotent-retry races returning a cached older value).
 *   5. Resume after pause re-anchors to the (current) server value.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useSessionTimer,
  useSessionTimerState,
  deriveDisplaySeconds,
} from "./useSessionTimer.js";

// The hook uses `Date.now()` for elapsed-time math and
// `requestAnimationFrame` for the per-second tick. We control both via
// fake timers so the tests are deterministic.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advance fake time AND let the rAF tick callback fire. The hook
 *  drives ticks via requestAnimationFrame; with vitest fake timers,
 *  rAF is polyfilled to a setTimeout(16ms). `runAllTicks` advances
 *  enough time that the tick reads a new elapsed value and re-renders. */
function tickClock(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useSessionTimer — basics", () => {
  it("initializes to the server value", () => {
    const { result } = renderHook(() => useSessionTimer(0, false));
    expect(result.current).toBe(0);
  });

  it("returns server value immediately when active starts", () => {
    const { result } = renderHook(({ s, a }) => useSessionTimer(s, a), {
      initialProps: { s: 100, a: true },
    });
    expect(result.current).toBe(100);
  });
});

describe("useSessionTimer — normal interpolation", () => {
  it("ticks forward at wall-clock rate while active", () => {
    const { result } = renderHook(({ s, a }) => useSessionTimer(s, a), {
      initialProps: { s: 0, a: true },
    });
    tickClock(30_000);
    expect(result.current).toBeGreaterThanOrEqual(29);
    expect(result.current).toBeLessThanOrEqual(31);
  });

  it("re-anchors when server credits land", () => {
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimer(s, a),
      { initialProps: { s: 0, a: true } },
    );
    tickClock(30_000);
    rerender({ s: 60, a: true });
    // After server credit lands, display jumps to server value (= 60).
    expect(result.current).toBe(60);
  });
});

describe("useSessionTimer — freeze (the fix)", () => {
  it("caps interpolation at one capture interval (60s)", () => {
    const { result } = renderHook(({ s, a }) => useSessionTimer(s, a), {
      initialProps: { s: 0, a: true },
    });
    // Advance well past one interval without any server update
    tickClock(180_000);
    // Display must be capped at server + 60 even though 180s passed
    expect(result.current).toBe(60);
  });

  it("stays frozen indefinitely when captures stall", () => {
    const { result } = renderHook(({ s, a }) => useSessionTimer(s, a), {
      initialProps: { s: 120, a: true },
    });
    tickClock(600_000); // 10 minutes
    expect(result.current).toBe(180); // 120 + 60 cap
  });
});

describe("useSessionTimer — unfreeze after stall", () => {
  it("the credit that unfreezes equals the frozen display value (no jump)", () => {
    // This is the core unfreeze contract. After the cap kicks in,
    // display = server + 60. When the next credit lands, server jumps
    // by exactly 60 → display = new_server + 0 = previous display.
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimer(s, a),
      { initialProps: { s: 60, a: true } },
    );
    tickClock(120_000); // freeze
    const frozenValue = result.current;
    expect(frozenValue).toBe(120); // 60 + 60 cap

    // Server credit finally arrives — server advances by 60
    rerender({ s: 120, a: true });
    expect(result.current).toBe(frozenValue);
  });

  it("after unfreeze, interpolation resumes from the new server value", () => {
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimer(s, a),
      { initialProps: { s: 60, a: true } },
    );
    tickClock(120_000);
    rerender({ s: 120, a: true });
    tickClock(30_000);
    expect(result.current).toBeGreaterThanOrEqual(149);
    expect(result.current).toBeLessThanOrEqual(151);
  });

  it("multiple credits arriving back-to-back catch up correctly", () => {
    // E.g., the chain woke up after a stall and the uploader processed
    // its buffered captures in rapid succession.
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimer(s, a),
      { initialProps: { s: 0, a: true } },
    );
    tickClock(200_000);
    rerender({ s: 60, a: true });
    rerender({ s: 120, a: true });
    rerender({ s: 180, a: true });
    // Display follows the latest server value
    expect(result.current).toBe(180);
  });
});

describe("useSessionTimer — pause", () => {
  it("snaps display to the server value when isActive flips false", () => {
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimer(s, a),
      { initialProps: { s: 60, a: true } },
    );
    tickClock(45_000);
    // Mid-interpolation, display is roughly 60 + 45 = 105
    expect(result.current).toBeGreaterThan(100);
    rerender({ s: 60, a: false });
    // Snap back to server value (max drop = MAX_INTERPOLATION_S = 60)
    expect(result.current).toBe(60);
  });

  it("max drop on pause is bounded by one interval", () => {
    // Even after a long stall where display was frozen at +60, the
    // pause-time snap can only reveal that 60s — never more.
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimer(s, a),
      { initialProps: { s: 0, a: true } },
    );
    tickClock(600_000); // 10 min of stall
    const beforePause = result.current;
    rerender({ s: 0, a: false });
    expect(beforePause - result.current).toBeLessThanOrEqual(60);
  });

  it("display stays frozen at server value during pause", () => {
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimer(s, a),
      { initialProps: { s: 60, a: false } },
    );
    tickClock(120_000);
    // Paused, no interpolation should run
    expect(result.current).toBe(60);
  });
});

describe("useSessionTimer — resume", () => {
  it("resumes interpolation from the current server value", () => {
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimer(s, a),
      { initialProps: { s: 120, a: false } },
    );
    expect(result.current).toBe(120);
    rerender({ s: 120, a: true });
    tickClock(30_000);
    expect(result.current).toBeGreaterThanOrEqual(149);
    expect(result.current).toBeLessThanOrEqual(151);
  });

  it("does not double-count pause duration after resume", () => {
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimer(s, a),
      { initialProps: { s: 60, a: true } },
    );
    tickClock(30_000); // display = 90
    rerender({ s: 60, a: false }); // paused; snap to 60
    tickClock(300_000); // 5 minutes of pause
    rerender({ s: 60, a: true }); // resume
    tickClock(1_000);
    // After 1s of resumed active time, display should be ~61, NOT 60+5min
    expect(result.current).toBeLessThanOrEqual(62);
  });
});

describe("useSessionTimer — stale-read protection (ratchet)", () => {
  it("does not move display backward when server returns a lower value", () => {
    // Simulates the idempotent-retry path returning a stale-fetched
    // session.trackedSeconds that's behind reality. This is the bug
    // that the ratchet exists to prevent.
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimer(s, a),
      { initialProps: { s: 120, a: true } },
    );
    expect(result.current).toBe(120);
    rerender({ s: 60, a: true }); // lower value arrives
    // Display should NOT drop to 60. Ratchet holds it.
    expect(result.current).toBeGreaterThanOrEqual(120);
  });

  it("subsequent higher value moves the display forward as normal", () => {
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimer(s, a),
      { initialProps: { s: 120, a: true } },
    );
    rerender({ s: 60, a: true }); // stale, ignored
    rerender({ s: 180, a: true }); // real advance
    expect(result.current).toBe(180);
  });
});

describe("useSessionTimer — latency / delay scenarios", () => {
  it("late credit arrival (capture confirmed 30s after expected) unfreezes correctly", () => {
    // Captures should land at t=60, t=120, etc. Simulate the confirm
    // for t=120 arriving 30s late, at t=150.
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimer(s, a),
      { initialProps: { s: 60, a: true } },
    );
    tickClock(90_000); // we're 90s past last sync, but cap holds display at 120
    expect(result.current).toBe(120);
    rerender({ s: 120, a: true });
    // Display does not jump backward, does not over-advance
    expect(result.current).toBe(120);
  });

  it("simulated network loss: no credits for 5 minutes then catch-up", () => {
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimer(s, a),
      { initialProps: { s: 60, a: true } },
    );
    tickClock(300_000); // 5 min stall
    expect(result.current).toBe(120); // frozen at +60
    // Network comes back; one credit lands (chain caught up to one
    // interval). Subsequent credits will follow on schedule.
    rerender({ s: 120, a: true });
    // Display equals frozen value — no visible jump
    expect(result.current).toBe(120);
  });

  it("delayed first credit (slow first upload): display still caps", () => {
    // First capture's confirm is slow. Server doesn't credit for 90s.
    const { result } = renderHook(({ s, a }) => useSessionTimer(s, a), {
      initialProps: { s: 0, a: true },
    });
    tickClock(90_000);
    expect(result.current).toBe(60); // capped at one interval, not 90
  });
});

/**
 * The desktop app renders this clock on three surfaces that each tick
 * independently: the main window, the menu-bar title (Rust), and the tray
 * popup window. The two that don't run this hook are handed `baseSeconds` +
 * `anchorAt` and re-derive from them, so these tests pin the contract those
 * surfaces are written against. Break one of these and the menu bar starts
 * showing a different time from the main app.
 */
describe("deriveDisplaySeconds — shared cross-surface derivation", () => {
  const ANCHOR = 1_000_000;

  it("interpolates at wall-clock rate from the anchor", () => {
    expect(deriveDisplaySeconds(120, ANCHOR, true, ANCHOR)).toBe(120);
    expect(deriveDisplaySeconds(120, ANCHOR, true, ANCHOR + 30_000)).toBe(150);
  });

  it("caps interpolation at one capture interval", () => {
    // The menu bar used to keep counting here while the main window froze
    // at +60, and the two never reconverged.
    expect(deriveDisplaySeconds(120, ANCHOR, true, ANCHOR + 90_000)).toBe(180);
    expect(deriveDisplaySeconds(120, ANCHOR, true, ANCHOR + 600_000)).toBe(180);
  });

  it("drops the interpolated remainder when not active", () => {
    // Pausing mid-interval snaps DOWN to the base on every surface. The
    // menu bar used to freeze at the interpolated value instead, leaving it
    // up to a minute ahead for the whole pause.
    expect(deriveDisplaySeconds(120, ANCHOR, false, ANCHOR + 30_000)).toBe(120);
  });

  it("never goes backward if the anchor is in the future", () => {
    expect(deriveDisplaySeconds(120, ANCHOR, true, ANCHOR - 5_000)).toBe(120);
  });

  it("tracks the hook's own display value across a whole interval", () => {
    // The surfaces tick on independent 1s timers, so at any given instant
    // they may be up to one tick apart from the main window — invisible at
    // the menu bar's minute granularity. What must never happen is the
    // unbounded, non-converging drift this test would catch as `step` grows.
    const { result } = renderHook(({ s, a }) => useSessionTimerState(s, a), {
      initialProps: { s: 120, a: true },
    });
    for (const step of [0, 1_000, 30_000, 59_000, 90_000, 600_000]) {
      tickClock(step);
      const surface = deriveDisplaySeconds(
        result.current.baseSeconds,
        result.current.anchorAt,
        true,
        Date.now(),
      );
      expect(Math.abs(surface - result.current.displaySeconds)).toBeLessThanOrEqual(1);
    }
  });
});

describe("useSessionTimerState — anchor exposed to other surfaces", () => {
  it("exposes the ratcheted base, not the interpolated display", () => {
    const { result } = renderHook(({ s, a }) => useSessionTimerState(s, a), {
      initialProps: { s: 120, a: true },
    });
    tickClock(30_000);
    expect(result.current.displaySeconds).toBe(150);
    // Surfaces must interpolate from 120, never from 150 — extrapolating
    // from an already-interpolated value double-counts the remainder.
    expect(result.current.baseSeconds).toBe(120);
  });

  it("holds the base on a stale lower reading, so surfaces don't jump back", () => {
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimerState(s, a),
      { initialProps: { s: 120, a: true } },
    );
    rerender({ s: 60, a: true });
    expect(result.current.baseSeconds).toBe(120);
  });

  it("re-anchors only when the base actually advances", () => {
    const { result, rerender } = renderHook(
      ({ s, a }) => useSessionTimerState(s, a),
      { initialProps: { s: 120, a: true } },
    );
    const firstAnchor = result.current.anchorAt;

    // A repeated (or lower) reading must not restart the interpolation
    // window — that silently discarded up to a minute the other surfaces
    // were still counting.
    tickClock(20_000);
    rerender({ s: 120, a: true });
    expect(result.current.anchorAt).toBe(firstAnchor);
    expect(result.current.displaySeconds).toBe(140);

    // A real advance re-anchors and restarts interpolation from there.
    rerender({ s: 180, a: true });
    expect(result.current.anchorAt).toBeGreaterThan(firstAnchor);
    expect(result.current.baseSeconds).toBe(180);
    expect(result.current.displaySeconds).toBe(180);
  });
});

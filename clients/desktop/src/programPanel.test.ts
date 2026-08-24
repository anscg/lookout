// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  PANEL_HEIGHT_SLACK,
  PANEL_SANITY_MAX_HEIGHT,
  PANEL_MIN_HEIGHT,
  PANEL_SANDBOX,
  getPanelState,
  isPanelUrlAcceptable,
  panelOrigin,
  parsePanelMessage,
  setPanelState,
  shouldOfferPanel,
} from "./programPanel.js";

const ORIGIN = "https://lapse.hackclub.com";

beforeEach(() => {
  localStorage.clear();
});

describe("panel sandbox", () => {
  // The frame is a third party rendering inside the app window. These are the
  // load-bearing parts of that boundary, so they're pinned rather than left to
  // a future refactor.
  it("never grants top-level navigation", () => {
    expect(PANEL_SANDBOX).not.toContain("allow-top-navigation");
  });

  it("is a sandbox at all, and grants only what a form needs", () => {
    expect(PANEL_SANDBOX.split(" ").sort()).toEqual([
      "allow-forms",
      "allow-popups",
      "allow-same-origin",
      "allow-scripts",
    ]);
  });
});

describe("height slack", () => {
  it("is small but non-zero, so fractional content can't reserve a scrollbar", () => {
    // A body of 500.38px in a 500px frame overflows by a third of a pixel and
    // the engine reserves a full scrollbar gutter for it. The slack absorbs
    // that; it stays small because it is real added sheet height.
    expect(PANEL_HEIGHT_SLACK).toBeGreaterThan(0);
    expect(PANEL_HEIGHT_SLACK).toBeLessThanOrEqual(4);
  });
});

describe("isPanelUrlAcceptable", () => {
  it("requires https for remote hosts", () => {
    expect(isPanelUrlAcceptable("https://lapse.hackclub.com/publish/abc")).toBe(true);
    expect(isPanelUrlAcceptable("http://lapse.hackclub.com/publish")).toBe(false);
  });

  it("allows http on loopback, so a panel can be developed locally", () => {
    // happy-dom serves the test document from localhost:3000, so 127.0.0.1 is
    // the loopback host that is NOT our own origin.
    expect(isPanelUrlAcceptable("http://127.0.0.1:3000/publish")).toBe(true);
    // Not a look-alike host that merely starts with "localhost".
    expect(isPanelUrlAcceptable("http://localhost.evil.example/publish")).toBe(false);
  });

  it("never frames our own origin, which would defeat the sandbox entirely", () => {
    // A same-origin frame with allow-same-origin can reach the parent's Tauri
    // IPC, and therefore every stored device credential.
    expect(isPanelUrlAcceptable(location.origin + "/panel")).toBe(false);
    expect(isPanelUrlAcceptable(`http://${location.hostname}:9999/panel`)).toBe(false);
    expect(isPanelUrlAcceptable("https://tauri.localhost/panel")).toBe(false);
    expect(isPanelUrlAcceptable("https://anything.localhost/panel")).toBe(false);
  });

  it("rejects other schemes and junk", () => {
    expect(isPanelUrlAcceptable("javascript:alert(1)")).toBe(false);
    expect(isPanelUrlAcceptable("data:text/html,<h1>hi")).toBe(false);
    expect(isPanelUrlAcceptable("not a url")).toBe(false);
    expect(isPanelUrlAcceptable("")).toBe(false);
    expect(isPanelUrlAcceptable(null)).toBe(false);
    expect(isPanelUrlAcceptable(undefined)).toBe(false);
  });
});

describe("panelOrigin", () => {
  it("returns the origin, ignoring path and query", () => {
    expect(panelOrigin("https://lapse.hackclub.com/publish/abc?x=1")).toBe(ORIGIN);
  });
  it("returns null for an unparseable URL", () => {
    expect(panelOrigin("nope")).toBeNull();
  });
});

describe("parsePanelMessage", () => {
  it("accepts the three known messages from the panel's origin", () => {
    expect(parsePanelMessage({ origin: ORIGIN, data: { type: "lookout:done" } }, ORIGIN))
      .toEqual({ type: "lookout:done" });
    expect(parsePanelMessage({ origin: ORIGIN, data: { type: "lookout:cancel" } }, ORIGIN))
      .toEqual({ type: "lookout:cancel" });
    expect(parsePanelMessage({ origin: ORIGIN, data: { type: "lookout:resize", height: 420 } }, ORIGIN))
      .toEqual({ type: "lookout:resize", height: 420 });
  });

  it("ignores messages from any other origin", () => {
    // The whole point of the origin check: another frame, an extension, or a
    // look-alike host must not be able to drive the sheet.
    for (const origin of [
      "https://evil.example",
      "https://lapse.hackclub.com.evil.example",
      "http://lapse.hackclub.com",
      "null",
    ]) {
      expect(parsePanelMessage({ origin, data: { type: "lookout:done" } }, ORIGIN)).toBeNull();
    }
  });

  it("ignores unknown and malformed payloads", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "lookout:done",
      42,
      { type: "lookout:unknown" },
      { type: "something-else" },
      {},
      { type: "lookout:resize" },
      { type: "lookout:resize", height: "400" },
      { type: "lookout:resize", height: NaN },
      { type: "lookout:resize", height: Infinity },
      { type: "lookout:resize", height: 0 },
      { type: "lookout:resize", height: -50 },
    ];
    for (const data of bad) {
      expect(parsePanelMessage({ origin: ORIGIN, data }, ORIGIN)).toBeNull();
    }
  });

  it("clamps a resize to the minimum and the sanity ceiling", () => {
    expect(
      parsePanelMessage({ origin: ORIGIN, data: { type: "lookout:resize", height: 5 } }, ORIGIN),
    ).toEqual({ type: "lookout:resize", height: PANEL_MIN_HEIGHT });
    expect(
      parsePanelMessage({ origin: ORIGIN, data: { type: "lookout:resize", height: 99999 } }, ORIGIN),
    ).toEqual({ type: "lookout:resize", height: PANEL_SANITY_MAX_HEIGHT });
    expect(
      parsePanelMessage({ origin: ORIGIN, data: { type: "lookout:resize", height: 400.6 } }, ORIGIN),
    ).toEqual({ type: "lookout:resize", height: 401 });
  });

  it("passes through heights above the sheet cap, so the sheet can scroll them", () => {
    // The frame is sized to the full content height and the SHEET scrolls;
    // clamping here would instead make the frame scroll itself, showing a
    // scrollbar we have no way to style.
    expect(
      parsePanelMessage({ origin: ORIGIN, data: { type: "lookout:resize", height: 1400 } }, ORIGIN),
    ).toEqual({ type: "lookout:resize", height: 1400 });
  });
});

describe("parsePanelMessage source pinning", () => {
  const frame = { name: "panel frame" };
  const popup = { name: "a popup the panel opened" };

  it("accepts the panel frame and rejects anything else on the same origin", () => {
    const ev = (source: unknown) => ({ origin: ORIGIN, data: { type: "lookout:done" }, source });
    expect(parsePanelMessage(ev(frame), ORIGIN, frame)).toEqual({ type: "lookout:done" });
    expect(parsePanelMessage(ev(popup), ORIGIN, frame)).toBeNull();
    expect(parsePanelMessage(ev(undefined), ORIGIN, frame)).toBeNull();
  });

  it("skips the check before the frame exists, so the first resize isn't lost", () => {
    const ev = { origin: ORIGIN, data: { type: "lookout:resize", height: 400 }, source: frame };
    expect(parsePanelMessage(ev, ORIGIN, undefined)).toEqual({ type: "lookout:resize", height: 400 });
  });
});

describe("panel state", () => {
  const token = "a".repeat(64);

  it("starts pending and round-trips", () => {
    expect(getPanelState(token)).toBe("pending");
    setPanelState(token, "dismissed");
    expect(getPanelState(token)).toBe("dismissed");
    setPanelState(token, "done");
    expect(getPanelState(token)).toBe("done");
  });

  it("keeps sessions independent", () => {
    const other = "b".repeat(64);
    setPanelState(token, "done");
    expect(getPanelState(other)).toBe("pending");
  });

  it("stores nothing for pending, so the map doesn't grow forever", () => {
    setPanelState(token, "dismissed");
    setPanelState(token, "pending");
    expect(getPanelState(token)).toBe("pending");
    expect(localStorage.getItem("lookout-panel-state")).toBe("{}");
  });

  it("survives a corrupt store", () => {
    localStorage.setItem("lookout-panel-state", "{not json");
    expect(getPanelState(token)).toBe("pending");
  });
});

describe("shouldOfferPanel", () => {
  const token = "c".repeat(64);
  const url = `${ORIGIN}/publish/abc`;

  it("offers anything not yet finished, and stops once done", () => {
    // Pending counts: the sheet opens itself when the compile lands, but if
    // that moment was missed (app closed, crash, nobody watching) the ask
    // would otherwise disappear without a trace.
    expect(shouldOfferPanel(token, url)).toBe(true);
    setPanelState(token, "dismissed");
    expect(shouldOfferPanel(token, url)).toBe(true);
    setPanelState(token, "done");
    expect(shouldOfferPanel(token, url)).toBe(false);
  });

  it("stops offering once the program says it is resolved", () => {
    // The user may have filled the form in on the program's website, which
    // this device never sees. The program's word settles it, whatever the
    // local state says.
    setPanelState(token, "dismissed");
    expect(shouldOfferPanel(token, url, true)).toBe(false);
    setPanelState(token, "pending");
    expect(shouldOfferPanel(token, url, true)).toBe(false);
    // Absent/false (older servers, unresolved) leaves the local state in charge.
    expect(shouldOfferPanel(token, url, false)).toBe(true);
    expect(shouldOfferPanel(token, url, undefined)).toBe(true);
  });

  it("never offers a session without a usable panel URL", () => {
    setPanelState(token, "dismissed");
    expect(shouldOfferPanel(token, null)).toBe(false);
    expect(shouldOfferPanel(token, undefined)).toBe(false);
    expect(shouldOfferPanel(token, "http://lapse.hackclub.com/x")).toBe(false);
  });
});

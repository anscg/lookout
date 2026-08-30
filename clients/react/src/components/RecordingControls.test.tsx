import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MIN_STOPPABLE_TRACKED_SECONDS } from "@lookout/shared";

// @squircle-js/react ships a CJS bundle under a "type": "module" package,
// so importing it through Button blows up in vitest's ESM loader. It only
// rounds corners; `asChild` means it renders its child either way.
vi.mock("@squircle-js/react", () => ({
  Squircle: ({ children }: { children: React.ReactNode }) => children,
}));

const { RecordingControls } = await import("./RecordingControls.js");

/**
 * The Stop gate as the user meets it. `stopGuard` decides; this pins that
 * the decision actually reaches the button, and that a recorder driving
 * these controls WITHOUT the new props keeps the behaviour it had before
 * the gate existed — the component is public API.
 */

const noop = () => {};

/** No jest-dom in this package — read the DOM property directly. */
function stopButton(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function renderControls(props: Partial<React.ComponentProps<typeof RecordingControls>> = {}) {
  return render(
    <RecordingControls
      status="active"
      isSharing
      onStartSharing={noop}
      onPause={noop}
      onResume={noop}
      onStop={noop}
      {...props}
    />,
  );
}

afterEach(cleanup);

describe("<RecordingControls> stop gate", () => {
  it("disables Stop under a credited minute and says why", () => {
    renderControls({ trackedSeconds: 0, displaySeconds: 25 });
    expect(stopButton("Stop").disabled).toBe(true);
    expect(screen.getByText(/35s to go/)).toBeTruthy();
  });

  it("enables Stop once a minute is credited", () => {
    renderControls({
      trackedSeconds: MIN_STOPPABLE_TRACKED_SECONDS,
      displaySeconds: 61,
    });
    expect(stopButton("Stop").disabled).toBe(false);
    expect(screen.queryByText(/to go/)).toBeNull();
  });

  it("gates the paused-state Stop too — that is the one people reach for", () => {
    renderControls({
      status: "paused",
      isSharing: false,
      trackedSeconds: 0,
      displaySeconds: 12,
    });
    expect(stopButton("Stop Session").disabled).toBe(true);
  });

  it("leaves Stop alone when no tracked time is passed", () => {
    // A custom recorder built against the pre-gate props.
    renderControls();
    expect(stopButton("Stop").disabled).toBe(false);
    expect(screen.queryByText(/to go/)).toBeNull();
  });
});

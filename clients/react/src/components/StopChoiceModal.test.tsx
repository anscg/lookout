import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// @squircle-js/react ships a CJS bundle under a "type": "module" package,
// so importing it through Button blows up in vitest's ESM loader. It only
// rounds corners; `asChild` means it renders its child either way.
vi.mock("@squircle-js/react", () => ({
  Squircle: ({ children }: { children: React.ReactNode }) => children,
}));

const { StopChoiceModal } = await import("./StopChoiceModal.js");

/**
 * The short-session case. Stopping stays available on purpose — someone
 * who opened a session by mistake is entitled to leave — so what's pinned
 * here is that they're told once, in the confirmation, rather than being
 * argued with on the recording screen.
 */

const noop = () => {};

afterEach(cleanup);

describe("<StopChoiceModal> under a minute", () => {
  it("says there is nothing to save, and still lets them leave", () => {
    render(
      <StopChoiceModal
        tooShort
        onResume={noop}
        onStopAndSave={noop}
        onEditAndSave={noop}
        withName
      />,
    );
    expect(screen.getByRole("heading", { name: "Nothing to save yet" })).toBeTruthy();
    const stop = screen.getByRole("button", { name: "Stop anyway" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Keep recording" })).toBeTruthy();
  });

  it("drops the options that assume a timelapse exists", () => {
    render(
      <StopChoiceModal
        tooShort
        onResume={noop}
        onStopAndSave={noop}
        onEditAndSave={noop}
        withName
      />,
    );
    // Nothing to cut, and nothing to name.
    expect(screen.queryByRole("button", { name: /Edit & save/ })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("is the ordinary modal once a minute is banked", () => {
    render(
      <StopChoiceModal
        onResume={noop}
        onStopAndSave={noop}
        onEditAndSave={noop}
        withName
      />,
    );
    expect(screen.getByRole("heading", { name: "Finish this timelapse?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Edit & save/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stop & save/ })).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop anyway" })).toBeNull();
  });
});

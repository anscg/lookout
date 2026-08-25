// @vitest-environment happy-dom
/**
 * The colour maths behind following the desktop's accent.
 */
import { describe, expect, it } from "vitest";
import { accentForeground } from "./linuxChrome.js";

describe("accentForeground", () => {
  it("picks black on a genuinely bright accent", () => {
    expect(accentForeground("#f5c211")).toBe("#000000");
  });

  it("still picks white on GNOME's yellow, which was darkened for it", () => {
    // #c88800 looks like the case this guard exists for, and isn't: GNOME
    // chose that dark amber over a bright yellow precisely so white works,
    // and libadwaita pairs it with white. Strict WCAG would prefer black
    // here (6.98 vs 3.01), but matching the desktop beats out-contrasting
    // it. Don't "fix" this.
    expect(accentForeground("#c88800")).toBe("#ffffff");
  });

  it("picks white on the dark end", () => {
    expect(accentForeground("#9141ac")).toBe("#ffffff");
    expect(accentForeground("#3584e4")).toBe("#ffffff");
  });

  it("falls back to white on an unparseable accent", () => {
    expect(accentForeground("#abc")).toBe("#ffffff");
  });
});

import { describe, expect, it } from "vitest";
import {
  announcementMatchesVersion,
  compareVersions,
  parseVersion,
} from "./announcementTargeting.js";

describe("parseVersion", () => {
  it("parses dotted numerics, tolerating v-prefix and suffixes", () => {
    expect(parseVersion("0.3.1")).toEqual([0, 3, 1]);
    expect(parseVersion("v1.2")).toEqual([1, 2]);
    expect(parseVersion("0.3.0-beta.1")).toEqual([0, 3, 0]);
    expect(parseVersion("  2.0 ")).toEqual([2, 0]);
  });

  it("returns null for garbage or absence", () => {
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("compares segment-wise with missing segments as 0", () => {
    expect(compareVersions([1, 2], [1, 2, 0])).toBe(0);
    expect(compareVersions([0, 3], [0, 2, 9])).toBeGreaterThan(0);
    expect(compareVersions([0, 2, 9], [0, 10])).toBeLessThan(0); // numeric, not lexicographic
  });
});

describe("announcementMatchesVersion", () => {
  const bounds = (minVersion: string | null, maxVersion: string | null) => ({
    minVersion,
    maxVersion,
  });

  it("untargeted announcements match everyone, version reported or not", () => {
    expect(announcementMatchesVersion(bounds(null, null), "0.3.1")).toBe(true);
    expect(announcementMatchesVersion(bounds(null, null), undefined)).toBe(true);
  });

  it("maxVersion-only reaches old builds INCLUDING those reporting nothing", () => {
    // The deprecation banner: "everyone at or below 0.2.x, please update".
    const b = bounds(null, "0.2.9");
    expect(announcementMatchesVersion(b, "0.2.5")).toBe(true);
    expect(announcementMatchesVersion(b, "0.2.9")).toBe(true); // inclusive
    expect(announcementMatchesVersion(b, undefined)).toBe(true); // pre-reporting build = old
    expect(announcementMatchesVersion(b, "0.3.0")).toBe(false);
  });

  it("minVersion never matches builds that report nothing", () => {
    const b = bounds("0.3.0", null);
    expect(announcementMatchesVersion(b, "0.3.0")).toBe(true); // inclusive
    expect(announcementMatchesVersion(b, "0.4.1")).toBe(true);
    expect(announcementMatchesVersion(b, "0.2.9")).toBe(false);
    expect(announcementMatchesVersion(b, undefined)).toBe(false);
  });

  it("both bounds form an inclusive range", () => {
    const b = bounds("0.3.0", "0.3.5");
    expect(announcementMatchesVersion(b, "0.3.0")).toBe(true);
    expect(announcementMatchesVersion(b, "0.3.5")).toBe(true);
    expect(announcementMatchesVersion(b, "0.3.6")).toBe(false);
    expect(announcementMatchesVersion(b, "0.2.9")).toBe(false);
    expect(announcementMatchesVersion(b, undefined)).toBe(false);
  });

  it("an unparseable bound fails open on that bound", () => {
    // The admin API validates bounds, so this only guards hand-edited rows:
    // better to over-show an announcement than silently hide it.
    expect(announcementMatchesVersion(bounds("not-a-version", null), undefined)).toBe(true);
    expect(announcementMatchesVersion(bounds(null, "???"), "9.9.9")).toBe(true);
  });

  it("client version strings with suffixes still compare numerically", () => {
    expect(
      announcementMatchesVersion(bounds(null, "0.2.9"), "0.2.9-rc.2"),
    ).toBe(true);
    expect(
      announcementMatchesVersion(bounds("0.3.0", null), "v0.10.0"),
    ).toBe(true);
  });
});

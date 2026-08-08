import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { MAX_CLIP_UPLOAD_FAILURES } from "@lookout/shared";
import { LookoutProvider } from "../LookoutProvider.js";
import {
  useUploader,
  ClipFormatRejectedError,
  type UploadPayload,
} from "./useUploader.js";

/**
 * Clips are an enhancement; one JPEG a minute is the contract. These tests pin
 * the two ways that promise used to be broken on the web client, both of which
 * the desktop client already handled:
 *
 *  1. A clip that encodes but fails to UPLOAD cost the entire minute — no
 *     capture, no credit — where desktop retried the tick as a JPEG.
 *  2. A session whose clip support went away server-side re-attempted a clip
 *     every minute forever, each one failing identically.
 */

const TOKEN = "a".repeat(64);

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <LookoutProvider token={TOKEN} apiBaseUrl="https://api.test">
      {children}
    </LookoutProvider>
  );
}

interface TransportOptions {
  /** Format the server grants on upload-url (drives the downgrade case). */
  grant?: string;
  /** Fail the R2 PUT for payloads of this content type. */
  failPutContentType?: string;
}

function mockTransport(opts: TransportOptions = {}) {
  const puts: { contentType: string }[] = [];
  const capturedAts: (string | null)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/upload-url")) {
        capturedAts.push(new URL(url).searchParams.get("capturedAt"));
        const requested = new URL(url).searchParams.get("format");
        return new Response(
          JSON.stringify({
            uploadUrl: "https://r2.test/put",
            r2Key: "k",
            screenshotId: "00000000-0000-0000-0000-000000000000",
            minuteBucket: 0,
            nextExpectedAt: new Date(Date.now() + 60_000).toISOString(),
            // Absent `format` means jpeg was granted.
            ...(requested ? { format: opts.grant ?? requested } : {}),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (init?.method === "PUT") {
        const contentType = (init.headers as Record<string, string>)[
          "Content-Type"
        ];
        puts.push({ contentType });
        if (opts.failPutContentType === contentType) {
          return new Response("<Error><Code>InternalError</Code></Error>", {
            status: 500,
          });
        }
        return new Response("", { status: 200 });
      }
      if (url.includes("/screenshots")) {
        return new Response(
          JSON.stringify({
            confirmed: true,
            trackedSeconds: 60,
            nextExpectedAt: new Date(Date.now() + 60_000).toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }),
  );
  return { puts, capturedAts };
}

/** A clip payload carrying its cut-time JPEG snapshot, as ClipRecorder emits. */
function clipPayload(capturedAtMs: number): UploadPayload {
  return {
    blob: new Blob(["clip-bytes"], { type: "video/mp4" }),
    width: 1920,
    height: 1080,
    capturedAtMs,
    format: "mp4",
    previewBlob: new Blob(["jpeg-bytes"], { type: "image/jpeg" }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("a clip upload that fails", () => {
  it("is retried as a JPEG at the SAME capture moment, so the minute credits", async () => {
    // Clips fail, JPEGs succeed — a server rejecting the clip container, or a
    // link that dies on the larger payload.
    const { puts, capturedAts } = mockTransport({
      failPutContentType: "video/mp4",
    });
    const { result } = renderHook(() => useUploader(), { wrapper });
    const capturedAtMs = Date.now() - 5_000;

    // Mirrors useLookout's uploadWithFallback: clip first, JPEG snapshot after.
    let confirmed: { trackedSeconds: number } | null = null;
    await act(async () => {
      const payload = clipPayload(capturedAtMs);
      try {
        confirmed = await result.current.captureUploadConfirm(payload);
      } catch {
        confirmed = await result.current.captureUploadConfirm({
          blob: payload.previewBlob!,
          width: payload.width,
          height: payload.height,
          capturedAtMs: payload.capturedAtMs,
        });
      }
    });

    // The clip exhausts its normal retry budget first (a transient failure
    // shouldn't cost the clip), and only then does one JPEG go up.
    const types = puts.map((p) => p.contentType);
    expect(types.filter((t) => t === "video/mp4").length).toBeGreaterThan(1);
    expect(types.filter((t) => t === "image/jpeg")).toEqual(["image/jpeg"]);
    expect(types[types.length - 1]).toBe("image/jpeg");
    // The minute still credited.
    expect(confirmed!.trackedSeconds).toBe(60);
    // And crucially the retry did NOT re-stamp the time: a capturedAt of "now"
    // would drift the streak anchor and eventually stop crediting.
    expect(capturedAts).toHaveLength(2);
    expect(capturedAts[0]).toBe(new Date(capturedAtMs).toISOString());
    expect(capturedAts[1]).toBe(capturedAts[0]);
  });
});

describe("a session whose clip support went away", () => {
  it("reports a distinguishable error rather than a generic failure", async () => {
    // The server grants jpeg for an mp4 request — clips were turned off.
    mockTransport({ grant: "jpeg" });
    const { result } = renderHook(() => useUploader(), { wrapper });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.captureUploadConfirm(clipPayload(Date.now()));
      } catch (err) {
        caught = err;
      }
    });

    // Typed, so the capture loop can latch clips off immediately instead of
    // retrying something that will never succeed.
    expect(caught).toBeInstanceOf(ClipFormatRejectedError);
    expect((caught as ClipFormatRejectedError).granted).toBe("jpeg");
  });

  it("never uploads the clip against a mismatched grant", async () => {
    // The presigned URL is signed for the GRANTED content type, so uploading
    // the clip would fail the signature anyway — fail before spending the
    // bytes.
    const { puts } = mockTransport({ grant: "jpeg" });
    const { result } = renderHook(() => useUploader(), { wrapper });

    await act(async () => {
      await result.current
        .captureUploadConfirm(clipPayload(Date.now()))
        .catch(() => {});
    });

    expect(puts).toHaveLength(0);
  });
});

describe("the failure budget", () => {
  it("is small enough that a broken encoder can't waste a session", () => {
    // Three strikes: enough to ride out a patch of bad network (each attempt
    // already retries internally), few enough that a structurally broken
    // clip path costs minutes, not hours.
    expect(MAX_CLIP_UPLOAD_FAILURES).toBeGreaterThanOrEqual(2);
    expect(MAX_CLIP_UPLOAD_FAILURES).toBeLessThanOrEqual(5);
  });
});

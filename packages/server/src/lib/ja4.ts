import type { FastifyRequest } from "fastify";
import { JA4_MAX_BYTES } from "@lookout/shared";

/**
 * Which request header carries the JA4 TLS fingerprint. The Node origin can't
 * compute JA4 itself (it terminates plain HTTP behind a proxy), so the edge is
 * expected to observe the ClientHello and forward it here — e.g. a Cloudflare
 * Transform Rule that sets this header from `cf.bot_management.ja4`.
 *
 * Configurable so the header name can match whatever the deployment's edge
 * emits. Lower-cased once at load; Fastify/Node header keys are always lower.
 * Absent config → default `cf-ja4`, matching our Cloudflare Transform Rule
 * (`CF-JA4 = cf.bot_management.ja4`).
 */
const JA4_HEADER = (process.env.JA4_HEADER || "cf-ja4").toLowerCase();

// A canonical JA4 is printable ASCII with a small alphabet (hex + a/b/c/d/i/q/t
// markers and underscores), e.g. "t13d1516h2_8daaf6152771_b186095e22b6". We
// don't enforce the exact grammar — JA4 has siblings (JA4H/JA4S/…) and the
// spec evolves — but we do reject anything with characters no JA4 variant uses,
// so a garbage/injected header value degrades to null rather than being stored.
const JA4_SHAPE = /^[A-Za-z0-9._-]+$/;

/**
 * Best-effort sanitize of a raw header value into a stored JA4, mirroring how
 * `clientInfo` is handled: trim, bound the length, and drop anything malformed
 * instead of rejecting the request. Returns null for missing/empty/oversized/
 * malformed input so the upload still succeeds without a fingerprint.
 */
export function sanitizeJa4(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v || v.length > JA4_MAX_BYTES || !JA4_SHAPE.test(v)) return null;
  return v;
}

/**
 * Pull the JA4 fingerprint off an incoming request's edge-set header. A header
 * sent more than once arrives as an array; take the first. Returns null when
 * the header is absent (local dev, direct-to-origin) or malformed.
 */
export function extractJa4(request: FastifyRequest): string | null {
  const h = request.headers[JA4_HEADER];
  const raw = Array.isArray(h) ? h[0] : h;
  return sanitizeJa4(raw);
}

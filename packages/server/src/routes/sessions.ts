import type { FastifyInstance } from "fastify";
import { eq, sql, and } from "drizzle-orm";
import { PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";
import { r2Client, R2_BUCKET } from "../config/r2.js";
import { boss, COMPILE_JOB } from "../lib/queue.js";
import { computeMinuteBucket, checkRateLimit } from "../lib/timing.js";
import {
  SCREENSHOT_INTERVAL_MS,
  PRESIGNED_URL_EXPIRY_SECONDS,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOTS_PER_SESSION,
  MAX_UPLOAD_REQUESTS_PER_SESSION,
} from "@collapse/shared";

/** Helper to look up session by token */
async function findSession(token: string) {
  return db.query.sessions.findFirst({
    where: eq(schema.sessions.token, token),
  });
}

/** Count distinct confirmed minute buckets for a session */
async function getTrackedSeconds(sessionId: string): Promise<number> {
  const [{ count }] = await db
    .select({
      count: sql<number>`count(distinct ${schema.screenshots.minuteBucket})`,
    })
    .from(schema.screenshots)
    .where(
      and(
        eq(schema.screenshots.sessionId, sessionId),
        eq(schema.screenshots.confirmed, true),
      ),
    );
  return Number(count) * 60;
}

/** Count total confirmed screenshots */
async function getScreenshotCount(sessionId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.screenshots)
    .where(
      and(
        eq(schema.screenshots.sessionId, sessionId),
        eq(schema.screenshots.confirmed, true),
      ),
    );
  return Number(count);
}

/** Count total upload-url requests (confirmed + unconfirmed) */
async function getTotalUploadRequests(sessionId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.screenshots)
    .where(eq(schema.screenshots.sessionId, sessionId));
  return Number(count);
}

export async function sessionRoutes(app: FastifyInstance) {
  // Get session status (used for recovery after refresh)
  app.get<{ Params: { token: string } }>(
    "/api/sessions/:token",
    async (request, reply) => {
      const session = await findSession(request.params.token);
      if (!session) return reply.code(404).send({ error: "Session not found" });

      const trackedSeconds = await getTrackedSeconds(session.id);
      const screenshotCount = await getScreenshotCount(session.id);

      return {
        status: session.status,
        trackedSeconds,
        screenshotCount,
        startedAt: session.startedAt?.toISOString() ?? null,
        totalActiveSeconds: session.totalActiveSeconds,
      };
    },
  );

  // Get presigned upload URL — this is where server timestamps capture time
  app.get<{ Params: { token: string } }>(
    "/api/sessions/:token/upload-url",
    async (request, reply) => {
      const session = await findSession(request.params.token);
      if (!session) return reply.code(404).send({ error: "Session not found" });

      // Activate pending sessions on first upload-url request
      const isActivating = session.status === "pending";
      if (!isActivating && session.status !== "active") {
        return reply
          .code(409)
          .send({ error: `Session is ${session.status}, cannot upload` });
      }

      // Rate limiting
      const rl = checkRateLimit(session.id);
      if (!rl.allowed) {
        reply.header(
          "Retry-After",
          String(Math.ceil((rl.retryAfterMs ?? 60_000) / 1000)),
        );
        return reply.code(429).send({ error: "Rate limit exceeded" });
      }

      // Session-level hard cap
      const totalRequests = await getTotalUploadRequests(session.id);
      if (totalRequests >= MAX_UPLOAD_REQUESTS_PER_SESSION) {
        return reply
          .code(429)
          .send({ error: "Max upload requests per session exceeded" });
      }

      const now = new Date();

      // If activating, set started_at
      if (isActivating) {
        await db
          .update(schema.sessions)
          .set({
            status: "active",
            startedAt: now,
            lastScreenshotAt: now,
            updatedAt: now,
          })
          .where(eq(schema.sessions.id, session.id));
      } else {
        await db
          .update(schema.sessions)
          .set({ lastScreenshotAt: now, updatedAt: now })
          .where(eq(schema.sessions.id, session.id));
      }

      const startedAt = isActivating ? now : session.startedAt!;
      const minuteBucket = computeMinuteBucket(now, startedAt);
      const screenshotId = randomUUID();
      const r2Key = `screenshots/${session.id}/${screenshotId}.jpg`;

      // Create screenshot record (unconfirmed)
      await db.insert(schema.screenshots).values({
        id: screenshotId,
        sessionId: session.id,
        r2Key,
        requestedAt: now,
        minuteBucket,
        confirmed: false,
      });

      // Generate presigned PUT URL
      // Note: Don't set ContentLength — it signs an exact size and rejects
      // anything different. Size is validated at confirmation via HeadObject.
      const command = new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: r2Key,
        ContentType: "image/jpeg",
      });

      const uploadUrl = await getSignedUrl(r2Client, command, {
        expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
      });

      const nextExpectedAt = new Date(
        now.getTime() + SCREENSHOT_INTERVAL_MS,
      ).toISOString();

      return {
        uploadUrl,
        r2Key,
        screenshotId,
        minuteBucket,
        nextExpectedAt,
      };
    },
  );

  // Confirm screenshot upload
  app.post<{
    Params: { token: string };
    Body: {
      screenshotId: string;
      width: number;
      height: number;
      fileSize: number;
    };
  }>("/api/sessions/:token/screenshots", async (request, reply) => {
    const session = await findSession(request.params.token);
    if (!session) return reply.code(404).send({ error: "Session not found" });

    if (session.status !== "active" && session.status !== "pending") {
      return reply
        .code(409)
        .send({ error: `Session is ${session.status}, cannot confirm` });
    }

    const { screenshotId, width, height, fileSize } = request.body;

    // Validate screenshot belongs to this session and isn't already confirmed
    const screenshot = await db.query.screenshots.findFirst({
      where: and(
        eq(schema.screenshots.id, screenshotId),
        eq(schema.screenshots.sessionId, session.id),
      ),
    });

    if (!screenshot) {
      return reply.code(404).send({ error: "Screenshot not found" });
    }

    // Idempotent: already confirmed
    if (screenshot.confirmed) {
      const trackedSeconds = await getTrackedSeconds(session.id);
      const nextExpectedAt = new Date(
        Date.now() + SCREENSHOT_INTERVAL_MS,
      ).toISOString();
      return { confirmed: true, trackedSeconds, nextExpectedAt };
    }

    // Verify the object actually exists in R2 and is within size limits
    try {
      const head = await r2Client.send(
        new HeadObjectCommand({ Bucket: R2_BUCKET, Key: screenshot.r2Key }),
      );
      if (head.ContentLength && head.ContentLength > MAX_SCREENSHOT_BYTES) {
        return reply.code(400).send({ error: "Uploaded object is too large" });
      }
    } catch {
      return reply
        .code(400)
        .send({ error: "Screenshot not found in storage — upload may have failed" });
    }

    // Check confirmed screenshot cap
    const confirmedCount = await getScreenshotCount(session.id);
    if (confirmedCount >= MAX_SCREENSHOTS_PER_SESSION) {
      return reply
        .code(429)
        .send({ error: "Max screenshots per session exceeded" });
    }

    // Mark confirmed
    await db
      .update(schema.screenshots)
      .set({
        confirmed: true,
        width,
        height,
        fileSizeBytes: fileSize,
      })
      .where(eq(schema.screenshots.id, screenshotId));

    // Update session's last_screenshot_at
    await db
      .update(schema.sessions)
      .set({ lastScreenshotAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.sessions.id, session.id));

    const trackedSeconds = await getTrackedSeconds(session.id);
    const nextExpectedAt = new Date(
      Date.now() + SCREENSHOT_INTERVAL_MS,
    ).toISOString();

    return { confirmed: true, trackedSeconds, nextExpectedAt };
  });

  // Pause session
  app.post<{ Params: { token: string } }>(
    "/api/sessions/:token/pause",
    async (request, reply) => {
      const session = await findSession(request.params.token);
      if (!session) return reply.code(404).send({ error: "Session not found" });

      // Pending sessions: no active time to accumulate, return no-op
      if (session.status === "pending") {
        return { status: "paused" as const, totalActiveSeconds: 0 };
      }

      // Already paused: idempotent
      if (session.status === "paused") {
        return {
          status: "paused" as const,
          totalActiveSeconds: session.totalActiveSeconds,
        };
      }

      if (session.status !== "active") {
        return reply
          .code(409)
          .send({ error: `Session is ${session.status}, cannot pause` });
      }

      // Accumulate active time
      const activeFrom =
        session.resumedAt || session.startedAt!;
      const additionalSeconds = Math.floor(
        (Date.now() - activeFrom.getTime()) / 1000,
      );

      await db
        .update(schema.sessions)
        .set({
          status: "paused",
          pausedAt: new Date(),
          totalActiveSeconds: session.totalActiveSeconds + additionalSeconds,
          updatedAt: new Date(),
        })
        .where(eq(schema.sessions.id, session.id));

      return {
        status: "paused" as const,
        totalActiveSeconds: session.totalActiveSeconds + additionalSeconds,
      };
    },
  );

  // Resume session
  app.post<{ Params: { token: string } }>(
    "/api/sessions/:token/resume",
    async (request, reply) => {
      const session = await findSession(request.params.token);
      if (!session) return reply.code(404).send({ error: "Session not found" });

      if (session.status !== "paused") {
        return reply
          .code(409)
          .send({ error: `Session is ${session.status}, cannot resume` });
      }

      const now = new Date();

      await db
        .update(schema.sessions)
        .set({
          status: "active",
          pausedAt: null,
          resumedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.sessions.id, session.id));

      const nextExpectedAt = new Date(
        now.getTime() + SCREENSHOT_INTERVAL_MS,
      ).toISOString();

      return { status: "active" as const, nextExpectedAt };
    },
  );

  // Stop session
  app.post<{ Params: { token: string } }>(
    "/api/sessions/:token/stop",
    async (request, reply) => {
      const session = await findSession(request.params.token);
      if (!session) return reply.code(404).send({ error: "Session not found" });

      if (
        session.status !== "active" &&
        session.status !== "paused" &&
        session.status !== "pending"
      ) {
        return reply
          .code(409)
          .send({ error: `Session is ${session.status}, cannot stop` });
      }

      // Accumulate remaining active time
      let totalActiveSeconds = session.totalActiveSeconds;
      if (session.status === "active" && session.startedAt) {
        const activeFrom =
          session.resumedAt || session.startedAt;
        totalActiveSeconds += Math.floor(
          (Date.now() - activeFrom.getTime()) / 1000,
        );
      }

      const now = new Date();

      await db
        .update(schema.sessions)
        .set({
          status: "stopped",
          stoppedAt: now,
          totalActiveSeconds,
          updatedAt: now,
        })
        .where(eq(schema.sessions.id, session.id));

      // Enqueue compilation
      const screenshotCount = await getScreenshotCount(session.id);
      if (screenshotCount > 0) {
        await boss.send(COMPILE_JOB, { sessionId: session.id });
      } else {
        // No screenshots — mark complete immediately with no video
        await db
          .update(schema.sessions)
          .set({ status: "complete", updatedAt: now })
          .where(eq(schema.sessions.id, session.id));
      }

      const trackedSeconds = await getTrackedSeconds(session.id);

      return {
        status: "stopped" as const,
        trackedSeconds,
        totalActiveSeconds,
      };
    },
  );

  // Poll compilation status
  app.get<{ Params: { token: string } }>(
    "/api/sessions/:token/status",
    async (request, reply) => {
      const session = await findSession(request.params.token);
      if (!session) return reply.code(404).send({ error: "Session not found" });

      const trackedSeconds = await getTrackedSeconds(session.id);

      return {
        status: session.status,
        videoUrl: session.videoUrl ?? undefined,
        trackedSeconds,
      };
    },
  );

  // Get video presigned URL
  app.get<{ Params: { token: string } }>(
    "/api/sessions/:token/video",
    async (request, reply) => {
      const session = await findSession(request.params.token);
      if (!session) return reply.code(404).send({ error: "Session not found" });

      if (session.status !== "complete" || !session.videoR2Key) {
        return reply.code(404).send({ error: "Video not available" });
      }

      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const command = new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: session.videoR2Key,
      });
      const videoUrl = await getSignedUrl(r2Client, command, {
        expiresIn: 3600,
      });

      return { videoUrl };
    },
  );
}

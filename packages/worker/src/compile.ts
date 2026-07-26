import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, sql } from "drizzle-orm";
import {
  computeKeptRanges,
  computeCutSeconds,
  type CaptureRowForCuts,
  type CutInterval,
  type KeptRange,
  type VideoUnit,
} from "@lookout/shared";
import * as schema from "./schema.js";
import {
  buildSegment,
  cutVideoToKeptRanges,
  SEGMENT_CONCURRENCY,
  SEGMENT_FPS,
  SEGMENT_GOP_ARGS,
  ASSEMBLE_TIMEOUT_MS,
} from "./segments.js";

const execFileAsync = promisify(execFile);

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable must be set");
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const db = drizzle(pool, { schema });

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

const R2_BUCKET = process.env.R2_BUCKET_NAME || "lookout";
const R2_PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN || "";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verify a video file with ffprobe: check file size > 0 and frame count within tolerance. */
async function verifyVideo(
  filePath: string,
  expectedInputFrames: number,
  outputFps: number,
  label: string,
): Promise<number> {
  const stat = await fs.stat(filePath);
  if (stat.size === 0)
    throw new Error(`${label}: ffmpeg produced empty output`);

  const { stdout: frameCountStr } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-count_packets",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_packets",
      "-of",
      "csv=p=0",
      filePath,
    ],
    { timeout: 60_000 },
  );

  const frameCount = parseInt(frameCountStr.trim(), 10);
  const expectedFrames = expectedInputFrames * outputFps;
  const tolerance = Math.max(outputFps, Math.round(expectedFrames * 0.02));
  if (isNaN(frameCount) || Math.abs(frameCount - expectedFrames) > tolerance) {
    throw new Error(
      `${label}: frame count mismatch: expected ~${expectedFrames} (±${tolerance}), got ${frameCount}`,
    );
  }

  return stat.size;
}

/** Upload a file to R2 and verify the upload with HeadObject. */
async function uploadAndVerify(
  localPath: string,
  r2Key: string,
  contentType: string,
  expectedSize: number,
  label: string,
): Promise<void> {
  const bytes = await fs.readFile(localPath);
  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: r2Key,
      Body: bytes,
      ContentType: contentType,
    }),
  );

  const headResponse = await r2Client.send(
    new HeadObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }),
  );
  if (headResponse.ContentLength !== expectedSize) {
    throw new Error(
      `${label}: R2 upload size mismatch: expected ${expectedSize}, got ${headResponse.ContentLength}`,
    );
  }
}

/** Download an R2 object to a local file, with retries. */
async function downloadObject(r2Key: string, destPath: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await r2Client.send(
        new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }),
      );
      const body = await response.Body!.transformToByteArray();
      await fs.writeFile(destPath, body);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Failed to download ${r2Key} after 3 attempts`, {
    cause: lastErr,
  });
}

/** Extract the session thumbnail (first frame) from a compiled video. */
async function extractThumbnail(
  videoPath: string,
  thumbnailPath: string,
): Promise<void> {
  await execFileAsync(
    "ffmpeg",
    [
      "-i", videoPath,
      "-vframes", "1",
      "-vf", "scale=480:-1",
      "-q:v", "5",
      "-y",
      thumbnailPath,
    ],
    { timeout: 30_000 },
  );
}

/** Best-effort R2 delete (orphans are acceptable; jobs must not fail on it). */
async function deleteObjectQuiet(r2Key: string): Promise<void> {
  try {
    await r2Client.send(
      new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }),
    );
  } catch {
    // Non-fatal: orphaned R2 objects can be cleaned up later
  }
}

/** Confirmed capture rows in the shape the shared cut/tracked-time math
 *  expects. The coalesce mirrors the timings endpoint exactly. */
async function getCaptureRowsForCuts(
  sessionId: string,
): Promise<CaptureRowForCuts[]> {
  const rows = await db.execute<{
    ts: Date | string;
    credited_seconds: number | string | null;
    minute_bucket: number | string;
  }>(sql`
    SELECT coalesce(captured_at, requested_at) AS ts,
           credited_seconds,
           minute_bucket
    FROM screenshots
    WHERE session_id = ${sessionId} AND confirmed = true
  `);
  return rows.rows.map((r) => ({
    timeMs: (r.ts instanceof Date ? r.ts : new Date(r.ts)).getTime(),
    creditedSeconds:
      r.credited_seconds === null ? null : Number(r.credited_seconds),
    minuteBucket: Number(r.minute_bucket),
  }));
}

export async function compileTimelapse(sessionId: string): Promise<{
  videoUrl: string;
  videoR2Key: string;
  thumbnailUrl: string;
  thumbnailR2Key: string;
}> {
  // Validate sessionId is a proper UUID to prevent path traversal
  if (!UUID_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId format: ${sessionId}`);
  }

  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });

  if (!session) throw new Error(`Session ${sessionId} not found`);

  // Atomically claim the compilation (concurrency guard).
  // Allow re-entry from 'compiling' so pg-boss retries can re-claim after a crash.
  const [claimed] = await db
    .update(schema.sessions)
    .set({ status: "compiling", updatedAt: new Date() })
    .where(
      and(
        eq(schema.sessions.id, sessionId),
        sql`${schema.sessions.status} IN ('stopped', 'compiling')`,
      ),
    )
    .returning({ id: schema.sessions.id });

  if (!claimed) {
    throw new Error(
      `Session ${sessionId} cannot be compiled (status: ${session.status})`,
    );
  }

  const tmpDir = `/tmp/compile-${sessionId}`;
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const cuts: CutInterval[] = Array.isArray(session.cuts)
      ? (session.cuts as CutInterval[])
      : [];

    // ── Half B: cut apply ─────────────────────────────────────
    // The original video already exists with its unit map — this is a
    // user-initiated edit (or an un-cut). Never touches capture units, so
    // it works even after the screenshot retention purge.
    if (session.originalVideoR2Key && (session.videoUnits?.length ?? 0) > 0) {
      return await applyCutCompile(session, cuts, tmpDir);
    }

    // ── Half A: original build (the pre-existing pipeline) ───────

    // Step 1: Sample selection — pick best screenshot per minute bucket
    // Using raw SQL for DISTINCT ON which Drizzle doesn't support directly
    const sampledScreenshots = await db.execute<{
      id: string;
      r2_key: string;
      minute_bucket: number;
      requested_at: Date | string;
      captured_at: Date | string | null;
      format: string;
    }>(sql`
      SELECT DISTINCT ON (minute_bucket) id, r2_key, minute_bucket, requested_at, captured_at, format
      FROM screenshots
      WHERE session_id = ${sessionId} AND confirmed = true
      ORDER BY minute_bucket,
        ABS(EXTRACT(EPOCH FROM (requested_at - (
          ${session.startedAt!}::timestamptz
          + (minute_bucket * interval '1 minute')
          + interval '30 seconds'
        ))))
    `);

    if (sampledScreenshots.rows.length === 0) {
      // No screenshots — mark failed (no video possible)
      await db
        .update(schema.sessions)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(schema.sessions.id, sessionId));
      return {
        videoUrl: "",
        videoR2Key: "",
        thumbnailUrl: "",
        thumbnailR2Key: "",
      };
    }

    // Mark sampled screenshots
    const sampledIds = sampledScreenshots.rows.map((s) => s.id);
    for (const id of sampledIds) {
      await db
        .update(schema.screenshots)
        .set({ sampled: true })
        .where(eq(schema.screenshots.id, id));
    }

    // Steps 2+3, pipelined: one worker pool downloads each unit and
    // immediately builds its 1-second normalized segment — no barrier
    // between the stages, so early units encode while later units are
    // still downloading. Every unit — legacy JPEG or clip — becomes
    // exactly one second of 30fps output with identical pinned encoder
    // parameters, so the final timelapse is a stream-copy concatenation
    // instead of one giant whole-session encode. Wall clock scales with
    // units/SEGMENT_CONCURRENCY, and a corrupt unit is caught and skipped
    // per-minute rather than poisoning the full encode.
    const total = sampledScreenshots.rows.length;
    const unitExt = (format: string) => (format === "jpeg" ? "jpg" : format);
    const segmentPaths: (string | null)[] = new Array(total).fill(null);
    let downloadFailures = 0;
    let buildFailures = 0;
    {
      let next = 0;
      const worker = async () => {
        while (next < total) {
          const i = next++;
          const ss = sampledScreenshots.rows[i];
          const unitPath = path.join(tmpDir, `dl_${i}.${unitExt(ss.format)}`);

          let downloadedUnit = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const response = await r2Client.send(
                new GetObjectCommand({ Bucket: R2_BUCKET, Key: ss.r2_key }),
              );
              const body = await response.Body!.transformToByteArray();
              await fs.writeFile(unitPath, body);
              downloadedUnit = true;
              break;
            } catch {
              if (attempt === 2) {
                console.warn(
                  `Skipping unit ${i + 1}: download failed after 3 attempts (${ss.r2_key})`,
                );
              }
            }
          }
          if (!downloadedUnit) {
            downloadFailures++;
            continue;
          }

          try {
            segmentPaths[i] = await buildSegment(tmpDir, i, unitPath, ss.format);
          } catch (err) {
            buildFailures++;
            console.warn(
              `Skipping unit ${i + 1}: segment build failed (${ss.r2_key})`,
              err,
            );
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(SEGMENT_CONCURRENCY, total) }, worker),
      );
    }

    const segments = segmentPaths.filter((p): p is string => p !== null);
    const unitsIncluded = segments.length;
    if (downloadFailures > 5) {
      throw new Error(
        `Too many failed unit downloads: ${downloadFailures}/${total} failed`,
      );
    }
    if (unitsIncluded === 0) {
      throw new Error("No usable capture units after segment build");
    }
    if (buildFailures > 5) {
      throw new Error(
        `Too many failed segment builds: ${buildFailures}/${total - downloadFailures} failed`,
      );
    }
    if (downloadFailures + buildFailures > 0) {
      console.warn(
        `${downloadFailures} download / ${buildFailures} build failures out of ${total} units, continuing`,
      );
    }

    // The units that actually made it in, in output order. Array index =
    // video second = real-world minute — the exact video-time ↔ wall-clock
    // map the edit feature scrubs and cuts against. Built from the segment
    // list (not the sampled rows) so build-failure holes never desync it.
    const videoUnits: VideoUnit[] = [];
    for (let i = 0; i < total; i++) {
      if (segmentPaths[i] === null) continue;
      const ss = sampledScreenshots.rows[i];
      const ts = ss.captured_at ?? ss.requested_at;
      videoUnits.push({
        capturedAt: (ts instanceof Date ? ts : new Date(ts)).toISOString(),
        screenshotId: ss.id,
      });
    }

    // Step 4: Assemble — stream-copy concat of the segments, remuxed to MP4.
    // No re-encoding on the happy path: segments share pinned parameters and
    // each starts on an IDR frame, so this is I/O-bound (seconds, even for a
    // 12-hour session).
    const concatListPath = path.join(tmpDir, "segments.txt");
    await fs.writeFile(
      concatListPath,
      segments.map((p) => `file '${p}'`).join("\n") + "\n",
    );

    const originalPath = path.join(tmpDir, "original.mp4");
    let originalSize: number;
    try {
      await execFileAsync(
        "ffmpeg",
        [
          "-f", "concat",
          "-safe", "0",
          "-i", concatListPath,
          "-c", "copy",
          "-movflags", "+faststart",
          "-y",
          originalPath,
        ],
        { timeout: ASSEMBLE_TIMEOUT_MS },
      );
      originalSize = await verifyVideo(
        originalPath,
        unitsIncluded,
        SEGMENT_FPS,
        "MP4",
      );
    } catch (err) {
      // Safety net: if the copied stream doesn't verify (e.g. an encoder
      // parameter drifted between segments), re-encode the already-built
      // segments into one uniform stream. One extra ffmpeg pass over 1s
      // segments — not a second pipeline. The GOP args keep the fallback
      // output on the same 1s IDR grid as the copy path, so the video stays
      // losslessly cuttable by the edit feature.
      console.warn("Stream-copy assembly failed, re-encoding segments:", err);
      await execFileAsync(
        "ffmpeg",
        [
          "-f", "concat",
          "-safe", "0",
          "-i", concatListPath,
          "-c:v", "libx264",
          "-preset", "fast",
          // Match the segment encoder's visually-lossless setting — this
          // fallback must not be a quality downgrade either.
          "-crf", "18",
          "-pix_fmt", "yuv420p",
          "-r", String(SEGMENT_FPS),
          ...SEGMENT_GOP_ARGS,
          "-movflags", "+faststart",
          "-y",
          originalPath,
        ],
        { timeout: ASSEMBLE_TIMEOUT_MS },
      );
      originalSize = await verifyVideo(
        originalPath,
        unitsIncluded,
        SEGMENT_FPS,
        "MP4 (re-encoded)",
      );
    }
    // Both assembly paths land on the pinned 1s closed-GOP grid.
    const videoCopyAligned = true;

    // Step 4.25: apply cuts, if any. A first compile normally has none —
    // cuts are authored during the edit hold, after this build hands the
    // user a preview. This branch covers a re-run that lost its original
    // (e.g. an internal recompile of a failed edited compile).
    const unitTimesMs = videoUnits.map((u) => Date.parse(u.capturedAt));
    const keptRanges = computeKeptRanges(unitTimesMs, cuts);
    const hasEffectiveCuts =
      cuts.length > 0 &&
      keptRanges.reduce((n, r) => n + (r.end - r.start), 0) < videoUnits.length;
    if (cuts.length > 0 && keptRanges.length === 0) {
      throw new Error("Cut list removes every capture unit — refusing to compile an empty video");
    }

    let publishPath = originalPath;
    let publishSize = originalSize;
    let publishR2Key = `timelapses/${sessionId}/original.mp4`;
    const originalR2Key = `timelapses/${sessionId}/original.mp4`;

    if (hasEffectiveCuts) {
      publishPath = await cutVideoToKeptRanges(tmpDir, originalPath, keptRanges, videoCopyAligned);
      publishSize = (await fs.stat(publishPath)).size;
      publishR2Key = `timelapses/${sessionId}/edited.mp4`;
    }

    // Step 4.5: Extract thumbnail from the PUBLISHED video's first frame
    // (post-cut when edited, so a cut first minute never leaks a stale frame).
    const thumbnailPath = path.join(tmpDir, "thumbnail.jpg");
    await extractThumbnail(publishPath, thumbnailPath);

    // Step 5: Upload all artifacts to R2 and verify
    const thumbnailR2Key = `timelapses/${sessionId}/thumbnail.jpg`;
    const thumbnailBytes = await fs.readFile(thumbnailPath);
    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: thumbnailR2Key,
        Body: thumbnailBytes,
        ContentType: "image/jpeg",
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );

    await uploadAndVerify(
      originalPath,
      originalR2Key,
      "video/mp4",
      originalSize,
      "MP4 (original)",
    );
    if (hasEffectiveCuts) {
      await uploadAndVerify(
        publishPath,
        publishR2Key,
        "video/mp4",
        publishSize,
        "MP4 (edited)",
      );
    }

    // Authoritative cut-seconds for the tracked-time subtraction.
    const cutSeconds = hasEffectiveCuts
      ? computeCutSeconds(
          await getCaptureRowsForCuts(sessionId),
          session.trackingMode === "credit" ? "credit" : "bucket",
          session.trackedSeconds ?? 0,
          cuts,
        )
      : 0;

    // Step 6: Publish — or hold.
    //
    // A session stopped with `{edit: true}` must NOT reach `complete` yet:
    // that status is what programs act on (forwarding heartbeats, accepting
    // submissions, firing the redirect hook), so it may only appear once
    // the user's cuts are baked in. Such a session goes back to `stopped`
    // with everything built but `video_r2_key` still null — the editor
    // opens on the original, and either the user's publish call or the
    // hold-expiry job flips it to `complete`.
    const thumbnailUrl = R2_PUBLIC_DOMAIN
      ? `https://${R2_PUBLIC_DOMAIN}/${thumbnailR2Key}`
      : thumbnailR2Key;

    const videoUrl = R2_PUBLIC_DOMAIN
      ? `https://${R2_PUBLIC_DOMAIN}/${publishR2Key}`
      : publishR2Key;

    // Re-read the hold: the user may have let it lapse (or the expiry job
    // may have cleared it) during the minutes this build was running.
    const [current] = await db
      .select({ editHoldUntil: schema.sessions.editHoldUntil })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId));
    const holdActive =
      current?.editHoldUntil != null &&
      current.editHoldUntil.getTime() > Date.now();

    await db
      .update(schema.sessions)
      .set({
        status: holdActive ? "stopped" : "complete",
        videoUrl: holdActive ? null : videoUrl,
        videoR2Key: holdActive ? null : publishR2Key,
        originalVideoR2Key: originalR2Key,
        videoUnits,
        videoCopyAligned,
        cutSeconds,
        ...(hasEffectiveCuts ? { lastEditCompileAt: new Date() } : {}),
        thumbnailUrl,
        thumbnailR2Key,
        updatedAt: new Date(),
      })
      .where(eq(schema.sessions.id, sessionId));

    if (holdActive) {
      console.log(
        `Session ${sessionId} built and held for editing until ${current!.editHoldUntil!.toISOString()}`,
      );
    }

    // Step 7: Cleanup unsampled screenshots from R2
    const unsampled = await db
      .select({ r2Key: schema.screenshots.r2Key, id: schema.screenshots.id })
      .from(schema.screenshots)
      .where(
        and(
          eq(schema.screenshots.sessionId, sessionId),
          eq(schema.screenshots.confirmed, true),
          eq(schema.screenshots.sampled, false),
        ),
      );

    for (const ss of unsampled) {
      await deleteObjectQuiet(ss.r2Key);
    }

    // Delete unconfirmed screenshot records
    await db
      .delete(schema.screenshots)
      .where(
        and(
          eq(schema.screenshots.sessionId, sessionId),
          eq(schema.screenshots.confirmed, false),
        ),
      );

    return {
      videoUrl,
      videoR2Key: publishR2Key,
      thumbnailUrl,
      thumbnailR2Key,
    };
  } finally {
    // Always clean up temp directory
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Half B of the compile job: bake the user's cuts into the already-built
 * original and PUBLISH the session. Downloads a single MP4, cuts it
 * (usually a lossless stream copy), regenerates the thumbnail, and flips
 * the session `complete` — no capture units involved.
 *
 * This is the end of the edit hold, so the uncut original is deleted right
 * after: the cut minutes are gone the moment the timelapse goes out, not
 * seven days later. Recovering an edited session afterwards (admin
 * recompile) falls back to Half A, which rebuilds from capture units and
 * applies the same cut list.
 */
async function applyCutCompile(
  session: typeof schema.sessions.$inferSelect,
  cuts: CutInterval[],
  tmpDir: string,
): Promise<{
  videoUrl: string;
  videoR2Key: string;
  thumbnailUrl: string;
  thumbnailR2Key: string;
}> {
  const sessionId = session.id;
  const originalR2Key = session.originalVideoR2Key!;
  const editedR2Key = `timelapses/${sessionId}/edited.mp4`;
  const videoUnits = session.videoUnits as VideoUnit[];

  const originalPath = path.join(tmpDir, "original.mp4");
  await downloadObject(originalR2Key, originalPath);

  const unitTimesMs = videoUnits.map((u) => Date.parse(u.capturedAt));
  const keptRanges = computeKeptRanges(unitTimesMs, cuts);
  const keptUnits = keptRanges.reduce((n, r) => n + (r.end - r.start), 0);
  const hasEffectiveCuts = cuts.length > 0 && keptUnits < videoUnits.length;

  if (cuts.length > 0 && keptRanges.length === 0) {
    throw new Error(
      "Cut list removes every capture unit — refusing to compile an empty video",
    );
  }

  let publishPath = originalPath;
  let publishR2Key = originalR2Key;

  if (hasEffectiveCuts) {
    publishPath = await cutVideoToKeptRanges(
      tmpDir,
      originalPath,
      keptRanges,
      session.videoCopyAligned === true,
    );
    publishR2Key = editedR2Key;
  }

  // Thumbnail follows the published video: a cut first minute must not leak
  // a stale first frame, and un-cutting must restore the original's.
  const thumbnailPath = path.join(tmpDir, "thumbnail.jpg");
  await extractThumbnail(publishPath, thumbnailPath);

  const thumbnailR2Key = `timelapses/${sessionId}/thumbnail.jpg`;
  const thumbnailBytes = await fs.readFile(thumbnailPath);
  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: thumbnailR2Key,
      Body: thumbnailBytes,
      ContentType: "image/jpeg",
      CacheControl: "public, max-age=86400",
    }),
  );

  if (hasEffectiveCuts) {
    const publishSize = (await fs.stat(publishPath)).size;
    await uploadAndVerify(
      publishPath,
      publishR2Key,
      "video/mp4",
      publishSize,
      "MP4 (edited)",
    );
  } else if (session.videoR2Key && session.videoR2Key !== originalR2Key) {
    // Un-cut: the original becomes the published video again; drop the now
    // stale edited artifact.
    await deleteObjectQuiet(session.videoR2Key);
  }

  const cutSeconds = hasEffectiveCuts
    ? computeCutSeconds(
        await getCaptureRowsForCuts(sessionId),
        session.trackingMode === "credit" ? "credit" : "bucket",
        session.trackedSeconds ?? 0,
        cuts,
      )
    : 0;

  const thumbnailUrl = R2_PUBLIC_DOMAIN
    ? `https://${R2_PUBLIC_DOMAIN}/${thumbnailR2Key}`
    : thumbnailR2Key;
  const videoUrl = R2_PUBLIC_DOMAIN
    ? `https://${R2_PUBLIC_DOMAIN}/${publishR2Key}`
    : publishR2Key;

  await db
    .update(schema.sessions)
    .set({
      status: "complete",
      videoUrl,
      videoR2Key: publishR2Key,
      cutSeconds,
      // The hold ends here — the session is published and its numbers are
      // final for every program reading them.
      editHoldUntil: null,
      // Cut content must not outlive the publish: once the edited video is
      // out, the uncut original is deleted below and its key cleared.
      ...(hasEffectiveCuts ? { originalVideoR2Key: null } : {}),
      lastEditCompileAt: new Date(),
      thumbnailUrl,
      thumbnailR2Key,
      updatedAt: new Date(),
    })
    .where(eq(schema.sessions.id, sessionId));

  // Delete the uncut original only AFTER the edited video is published and
  // the row committed — if this ordering flipped, a crash in between would
  // leave a session pointing at bytes that no longer exist.
  if (hasEffectiveCuts) {
    await deleteObjectQuiet(originalR2Key);
  }

  return { videoUrl, videoR2Key: publishR2Key, thumbnailUrl, thumbnailR2Key };
}

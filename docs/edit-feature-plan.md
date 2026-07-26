# Edit feature (cuts) — implementation plan v2

Status: proposal. Covers server, worker, and all three clients.

## Model

```
record ── stop ──> compile (UNCHANGED — this is the "pre-compile")
                     └─> complete: original.mp4 published
                            │
                            │  editor previews the compiled video
                            │  PUT /cuts  { cuts: [{start, end}, …] }   (wall-clock intervals)
                            │  POST /compile
                            v
                   cut-compile (fast: lossless stream-copy of kept ranges)
                     └─> complete: edited.mp4 published, original kept for re-edits
```

- The **existing compile runs exactly as today** the moment the user stops.
  Nothing about stop, the compile pipeline, old clients, or program
  integrations changes. Its output doubles as the editor's preview.
- **Editing is optional and happens after `complete`.** The editor scrubs
  the compiled video; a second, much cheaper compile applies the cuts.
- An edit is a **cut list of absolute wall-clock intervals** stored on the
  session — `[{ "start": ISO-8601, "end": ISO-8601 }]` ("start a → end a,
  start b → end b"). Never "offset + duration": Lookout is heartbeat-based,
  so the cut must live in the same domain as the capture timestamps that
  drive `/timings` and `trackedSeconds`.

### The invariant that makes all of this cheap

One capture unit = one real-world minute = **exactly one second of output
video**, and every segment is encoded with a pinned closed GOP of exactly 30
frames starting on an IDR frame (`segments.ts`: `-g 30 -keyint_min 30
-sc_threshold 0 -x264-params open-gop=0`). Consequences:

1. **Video-time ↔ wall-clock mapping is exact**: second *i* of the compiled
   video is capture unit *i*, whose `capturedAt` is known. The editor
   converts selected video-second ranges to wall-clock intervals losslessly.
2. **The final video omits cut time via lossless stream copy.** Because
   every second boundary is an IDR frame in a closed GOP, each kept range is
   extracted with an input seek to its IDR (`-ss`) plus an exact copied
   packet count (`-frames:v`), then the ranges stream-copy concat. (NOT the
   concat demuxer's `inpoint`/`outpoint`: outpoint is dts-based, and B-frame
   dts offsets leak ~2 frames of the cut region past each boundary — caught
   by the worker's frame-exact test.) A cut-compile is I/O-bound — seconds,
   even for a 12-hour session — and adds no quality generation.
3. **Cut granularity is whole minutes**, which is also heartbeat granularity
   — a sub-minute cut couldn't be expressed in the time data anyway.
   Sub-minute/frame-level cutting inside clips is explicitly out of scope.

**Membership rule (single shared definition):** a capture unit is cut iff
`coalesce(captured_at, requested_at) ∈ [start, end)` for any interval in the
list. Used identically by the cut-compile, `/timings`, and tracked-time math.
Lives once in `@lookout/shared` (mirrored in the worker's schema-local copy),
tested once.

## Derived effects of the cut list

| Consumer | Effect |
|---|---|
| Published video | Kept ranges of `original.mp4` stream-copy concatenated into `edited.mp4` |
| `GET /timings` | Timestamps inside cuts excluded from the default array; intervals surfaced as `cuts` |
| `trackedSeconds` | Reported as `raw − cutSeconds` everywhere; raw preserved as `uncutTrackedSeconds` |

`trackedSeconds` shrinking with cuts is deliberate: `/timings` and
`trackedSeconds` must tell the same story ("verified time, minus what the
user removed"), and cutting can only *reduce* the number, so there's no fraud
vector. Programs forwarding `/timings` to Hackatime pick up cuts with zero
code changes. The DB keeps `sessions.tracked_seconds` raw (audit trail);
subtraction happens in the one read-side dispatcher
(`getTrackedSecondsForSession`).

## Data model (migration)

`sessions` gains:

| Column | Type | Meaning |
|---|---|---|
| `cuts` | `jsonb` | Normalized cut list. `null`/`[]` = no edits |
| `cut_seconds` | `integer` | Credited seconds removed; recomputed on every cuts write and at cut-compile |
| `video_units` | `jsonb` | Ordered array of the units actually included in `original.mp4` (`[{capturedAt, screenshotId}]`), written by compile. THE video-second ↔ wall-clock map — sampled rows alone can't provide it because compile skips undecodable units |
| `original_video_r2_key` | `text` | The uncut compiled video. On first compile this equals `video_r2_key`; after an edited compile, `video_r2_key` points at `edited.mp4` while this keeps pointing at the original |
| `video_copy_aligned` | `boolean` | True when assembly used the stream-copy path (GOP grid guaranteed). False → cut-compile must use its re-encode fallback |
| `recompile_count` | `integer not null default 0` | User-initiated cut-compiles, capped |

No `screenshots` changes — cut membership is computed from the interval
list, never denormalized onto rows.

### Cut-list validation (server, on every `PUT /cuts`)

- Valid ISO dates, `end > start`, per interval.
- Clamp to `[startedAt − 5 min, stoppedAt + 5 min]`.
- Sort by start; merge overlapping/adjacent intervals.
- Cap `MAX_CUT_INTERVALS = 120`.
- Reject a list that cuts **every** unit in `video_units` (a video must
  remain).
- Response echoes normalized list + server-authoritative preview:
  `{ cuts, unitsTotal, unitsCut, trackedSeconds, uncutTrackedSeconds }`.

## API changes (`packages/server/src/routes/sessions.ts`)

Token-authenticated, rate-limited like their neighbors. **No change to
`/stop`.**

1. **`GET /api/sessions/:token/units`** — editor metadata (no presigning, no
   R2 access): `{ units: <video_units>, cuts, editable, originalVideoUrl }`.
   `editable` is false when `original.mp4` has been purged or
   `recompile_count` is exhausted. `originalVideoUrl` is a token-free
   presigned GET (1 h) for `original_video_r2_key` — the editor's preview
   source. It must NOT be the public `/api/media/...` URL: after an edit,
   cut content exists only in the original, which stays reachable through
   the secret token only.
2. **`PUT /api/sessions/:token/cuts`** — replace the whole list (idempotent;
   no patch semantics). Allowed in `complete`; 409 while `compiling`.
   `[]` clears edits.
3. **`POST /api/sessions/:token/compile`** — apply the current cut list:
   - Guards: status `complete`, `original_video_r2_key` present,
     `recompile_count < MAX_USER_RECOMPILES (5)`, per-token rate limit.
   - Special case, no job needed: if `cuts` is empty and an `edited.mp4`
     exists, repoint `video_r2_key` back to the original, delete
     `edited.mp4`, regenerate nothing (thumbnail = original's, kept).
     "Undo all edits" is instant.
   - Otherwise flip status → `compiling` (worker's claim already accepts
     re-entry), increment `recompile_count`, enqueue `COMPILE_JOB`.
4. **`GET /api/sessions/:token/timings`** — returns
   `{ count, timestamps: [kept only], cuts, cutCount }`; cut captures are
   excluded **by default** so existing Hackatime forwarders respect edits
   automatically. `?includeCut=true` adds `cutTimestamps`.
5. **`GET /api/sessions/:token`**, **`/status`**, **`/batch`**, internal
   session endpoint — add `cuts`, `cutSeconds`, `uncutTrackedSeconds`,
   `editable`. `trackedSeconds` becomes post-cut everywhere via the
   dispatcher. `/status` keeps working unchanged for old clients during a
   cut-compile (`compiling` → `complete` — states they already handle).

## Worker changes

The compile job becomes two idempotent halves; `compileTimelapse` dispatches
on what exists:

**A. Original build (unchanged pipeline + bookkeeping).** Runs when
`original_video_r2_key` is absent — i.e., every first compile. Identical
sampling → segment build → stream-copy assembly, plus:
- Write output to `timelapses/{id}/original.mp4`; set both
  `original_video_r2_key` and `video_r2_key` to it.
- Record `video_units` (the units whose segments actually made it in, in
  order) and `video_copy_aligned` (true on the copy path).
- **Fix the assembly re-encode fallback to pin the GOP** (reuse
  `SEGMENT_ENCODE_ARGS`' `-g/-keyint_min/-sc_threshold/open-gop`): today the
  fallback emits default x264 keyframes (~every 250 frames, scene-cut on),
  which would break lossless cutting. Cheap and correct regardless of this
  feature.

**B. Cut apply.** Runs when `original_video_r2_key` exists and `cuts` is
non-empty:
- Compute kept video-second ranges: map each `video_units[i]` through the
  membership rule → contiguous kept index runs → `[inpoint, outpoint)` pairs.
- `video_copy_aligned = true`: concat-demuxer file listing `original.mp4`
  once per kept range with `inpoint`/`outpoint`, `-c copy`, remux with
  `+faststart` → `timelapses/{id}/edited.mp4`. Lossless, seconds.
- `video_copy_aligned = false` (legacy videos assembled via the old
  fallback): same ranges but re-encode with the pinned args (one CRF-18
  generation — acceptable, rare).
- Verify frame count = kept units × 30 (existing `verifyVideo`).
- Regenerate the thumbnail from `edited.mp4` (first frame may have been cut).
- Point `video_r2_key` at `edited.mp4`, persist authoritative
  `cut_seconds`, status `complete`.

Notes:
- The cut path **never downloads capture units** — it needs only
  `original.mp4`. Editing therefore works even after the 7-day screenshot
  purge, for as long as the original is retained.
- Keep compile step 7 (unsampled cleanup) untouched; sampled unit files
  still age out via the existing retention job. They're no longer needed for
  editing at all.

### Retention & privacy for cut content

Cut minutes vanish from the published video but live on in `original.mp4`
(token-gated). Extend the daily retention job: for sessions whose cuts are
non-empty and whose edit window has closed (`EDIT_WINDOW_DAYS = 7` after the
last cut-compile), delete `original.mp4` and null
`original_video_r2_key` — the cut content is then truly gone and `editable`
goes false. Uncut sessions keep their single video file forever, as today.
(Public media redirect caches `video.mp4` for 30 min — an edited video may
serve the stale original that long. Documented, acceptable.)

## Clients — one editor, three surfaces

`clients/desktop` and `clients/web` both already depend on
`@lookout/react`, so the editor is built **once** in the SDK.

### `@lookout/react`

- `api/client.ts`: `getUnits()`, `setCuts(cuts)`, `applyCuts()` (the compile
  call). `CutInterval` type from `@lookout/shared`.
- **`<TimelapseEditor token onDone />`**:
  - Preview = `<video src={originalVideoUrl}>`. Scrubbing is native video
    seeking; the filmstrip is generated client-side by seeking a second
    hidden video element and drawing frames to canvas (the proven Lapse
    `makeFilmstrip` approach) — no extra endpoints, works for jpeg and clip
    sessions identically.
  - Timeline is the video's own time axis (1 s per minute), with a
    wall-clock ruler derived from `video_units` and gap markers where
    consecutive units are > ~90 s apart (pauses).
  - **Region-based cutting** (the settled UX): drag on the timeline creates
    a cut region in one gesture; regions are first-class objects with edge
    handles, selection, delete-key removal; plain click seeks; ruler lane
    owns scrubbing; while dragging an edge the preview shows the boundary
    frame. Edges snap to whole seconds (= unit boundaries, inherent) and to
    pause gaps. Playback preview mode skips cut regions (jump
    `currentTime` past them on `timeupdate`); scrubbing moves through them
    (dimmed) so edges can be judged.
  - Region ↔ interval serialization: selected units `[i..j]` →
    `start = video_units[i].capturedAt`,
    `end = video_units[j].capturedAt + 60 s`; server normalizes.
  - Footer: "`<kept>` after cuts" (from the PUT response), Cancel, Save &
    apply (`PUT /cuts` → `POST /compile` → existing `ProcessingState` until
    `complete`).
- Wiring: `SessionDetail` and `ResultView` gain an "Edit" button when
  `complete && editable`. `LookoutRecorder` post-stop flow flows into the
  same button once compile finishes — no recording-path changes at all.
- Pure helpers with tests (style of `computeBestTracked.ts`): unit↔interval
  mapping, kept-range computation, gap detection.

### Desktop (`clients/desktop`)

- The main window is a fixed 480×640 — too small for precise timeline
  scrubbing — so the Edit button (via `SessionDetail`'s `onEdit` override)
  opens a **dedicated resizable 960×720 editor window** (`EditorWindow.tsx`,
  route `#/editor?token=…`, Tauri `WebviewWindow` labeled `editor-*`).
  Applying cuts emits a `lookout-edited` event; the main window remounts the
  open `SessionDetail` and refreshes the gallery.
- The post-stop RecordPage routes to `SessionDetail` on completion, which
  carries the Edit affordance; the `redirectUrl` hook keeps firing on first
  `complete` exactly as documented.
- No Rust changes — capture/tray/upload untouched (window creation +
  close permissions added to the default capability).

### Web (`clients/web`)

- `Result.tsx`: Edit button → `<TimelapseEditor>`. `?edit=false` recorder
  URL param lets an embedding program hide it.

## Docs

- `packages/server/API.md`: new endpoints/fields, membership rule, cut
  semantics, recompile limits, retention of originals.
- `docs/integration.md`: "Edits and cuts" section for program authors —
  `trackedSeconds` now reflects cuts, `/timings` filters by default, new
  fields (`cuts`, `cutSeconds`, `uncutTrackedSeconds`), stale-cache note,
  and that adopting requires nothing.
- `clients/react/API.md`: `<TimelapseEditor>`, new client methods.

## Tests

- **Shared**: membership + normalization/merge pure-function suite.
- **Server integration**: PUT cuts validation matrix (merge, clamp, all-cut
  rejection, cap, 409 while compiling); compile endpoint transitions,
  instant un-cut repoint, recompile cap; timings filtering (+`includeCut`);
  trackedSeconds subtraction in `GET`/`status`/`batch`; units endpoint auth
  + purged behavior; original purge job.
- **Worker** (extend the `clips.integration.test.ts` harness): original
  build writes `video_units`/aligned flag; cut-compile produces exact
  kept-units × 30 frames via stream copy; misaligned original takes the
  re-encode path; thumbnail regenerated; fallback assembly now pins GOP.
- **React**: mapping/gap/kept-range unit tests; editor interaction tests.
- **Desktop legacy** (`legacy_client.rs`): stop path byte-identical.

## Rollout order

1. `@lookout/shared`: `CutInterval`, membership/normalize helpers,
   constants (`MAX_CUT_INTERVALS`, `MAX_USER_RECOMPILES`, `EDIT_WINDOW_DAYS`).
2. Worker: GOP-pin the assembly fallback; write
   `video_units`/`original_video_r2_key`/`video_copy_aligned` on compile.
   (Deployable alone; migration ships here.)
3. Server: units/cuts/compile endpoints + timings & response fields +
   original-purge job. (Deployable alone — inert until a client writes cuts.)
4. Worker: cut-apply path.
5. `@lookout/react`: api client + `<TimelapseEditor>` + wiring.
6. Web + desktop surfaces; desktop release.
7. Docs; announce to program authors.

Videos compiled before step 2 lack `video_units`/alignment info —
`editable: false` for them (backfill is possible from sampled rows but not
worth it; sessions age out of relevance in days).

## Edge cases ledger

- **Bucket-mode / legacy sessions**: membership falls back to
  `requested_at`; `cut_seconds` = distinct cut minute-buckets × 60.
- **Mixed-format sessions**: irrelevant post-compile — cuts operate on the
  compiled video's second grid.
- **Build-failure holes**: `video_units` records what's actually in the
  video, so the mapping stays exact even when compile skipped undecodable
  units.
- **Concurrent PUT cuts vs compile**: PUT checks status in its transaction,
  409 while `compiling`; compile claim is already atomic.
- **Re-edit loops**: each cut-compile starts from `original.mp4`, so edits
  never compound quality loss and un-cutting any region always works within
  the window.
- **Failed cut-compile**: pg-boss retries; final failure marks `failed` as
  today — recovery via internal recompile re-enters half A/B dispatch
  idempotently.
- **`videoWebmUrl` legacy field**: unchanged (static please-update video).

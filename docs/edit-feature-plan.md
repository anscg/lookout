# Edit feature (cuts) — implementation plan v3

Status: implemented. Covers server, worker, and all three clients.

## Model

Editing lives **inside the stop flow**, before the session is ever
published. Stopping offers three choices:

```
recording ──Stop──> ┌ Keep recording ─────────────────────> (back to recording)
                    ├ Stop & save ───> compile ───────────> complete
                    └ Edit & save ──> stop {edit:true}
                                        │ compile runs, but the session is HELD
                                        │ (status stays "stopped", video unpublished)
                                        │
                                        ├ user cuts → publish ──> compiling ──> complete
                                        ├ "publish as recorded" ───────────────> complete
                                        └ hold expires (30 min) ───────────────> complete
```

**Why not edit after `complete`?** Because `complete` is the signal
programs act on — forwarding heartbeats to Hackatime, accepting a
submission, firing the redirect hook. Editing a published session would
mutate numbers someone already consumed. So a session reaches `complete`
exactly once, with its cuts already applied, and post-publication editing
does not exist (`editable: false`, `PUT /cuts` 409s).

Consequences that fall out of this:

- **Programs need no changes at all.** The observable lifecycle is still
  `stopped → compiling → complete`; an edit just means longer in `stopped`.
- **The hold can delay publication, never cancel it.** A background job
  publishes the timelapse as recorded when the hold expires, so an
  abandoned edit still yields a video.
- **Cut footage is deleted immediately** after an edited publish, instead
  of lingering for a 7-day re-edit window.
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

All three are settled before the session publishes, so no consumer ever
observes them changing.

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
| `original_video_r2_key` | `text` | The uncut compiled video — the editor's preview source. Nulled (and the object deleted) as soon as an edited publish lands |
| `video_copy_aligned` | `boolean` | True when assembly used the stream-copy path (GOP grid guaranteed). False → the cut must use its re-encode fallback |
| `recompile_count` | `integer not null default 0` | User-initiated publishes-with-cuts, capped |
| `edit_hold_until` | `timestamptz` | While set and in the future, the compiled video stays unpublished (`status` `stopped`, `video_r2_key` null) so the owner can cut it. Cleared by the publish call or the expiry job |

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

Token-authenticated, rate-limited like their neighbors.

1. **`POST /api/sessions/:token/stop`** — accepts an optional body
   `{ edit: true }`. Absent (or no body at all) → today's behavior
   byte-for-byte, so shipped clients are untouched. Present, and the
   session has captures → sets `edit_hold_until = now + 30 min` and
   returns it. The compile is enqueued either way.
2. **`GET /api/sessions/:token/units`** — editor metadata:
   `{ units: <video_units>, cuts, editable, editableReason, editHoldUntil,
   originalVideoUrl, recompilesRemaining }`. `originalVideoUrl` is a
   presigned GET (1 h) for the unpublished original. It must NOT be the
   public `/api/media/...` URL — that is null until the session publishes,
   and afterwards serves the cut version only.
3. **`PUT /api/sessions/:token/cuts`** — replace the whole list (idempotent;
   `[]` clears). **Only during an active hold**; the write is guarded on
   `status = 'stopped' AND edit_hold_until > now()` so a session that
   published mid-edit can never be mutated.
4. **`POST /api/sessions/:token/compile`** — publish, baking in the cuts:
   - No cuts → publish the built original directly, no worker round-trip
     (`instant: true`). This is "Save as recorded".
   - With cuts → claim `stopped → compiling`, clear the hold (so the expiry
     job can't race), increment `recompile_count`, enqueue `COMPILE_JOB`.
   - Already `complete` → `200 instant` (the expiry job won the race; the
     timelapse is out either way). Already `compiling` → `202`.
5. **`GET /api/sessions/:token/timings`** — returns
   `{ count, timestamps: [kept only], cuts, cutCount }`; cut captures are
   excluded **by default** so existing Hackatime forwarders respect edits
   automatically. `?includeCut=true` adds `cutTimestamps`.
6. **`GET /api/sessions/:token`**, **`/status`**, **`/batch`**, internal
   session endpoint — add `cuts`, `cutSeconds`, `uncutTrackedSeconds`,
   `editable`, `editHoldUntil`. `trackedSeconds` becomes post-cut
   everywhere via the dispatcher.
7. **Hold expiry** (`lib/timeouts.ts`, on the existing every-minute cron):
   publish any `stopped` session whose `edit_hold_until` has passed, via
   the shared `publishHeldSession` helper. This is what makes offering the
   edit step safe — the hold delays publication, never cancels it.

## Worker changes

The compile job becomes two idempotent halves; `compileTimelapse` dispatches
on what exists:

**A. Original build (unchanged pipeline + bookkeeping).** Runs when
`original_video_r2_key` is absent — i.e., every first compile. Identical
sampling → segment build → stream-copy assembly, plus:
- Write output to `timelapses/{id}/original.mp4`; set
  `original_video_r2_key`.
- Record `video_units` (the units whose segments actually made it in, in
  order) and `video_copy_aligned` (true on the copy path).
- **Publish, or hold.** Re-read `edit_hold_until` at the end of the build
  (it may have lapsed during the minutes it ran). Hold active → leave the
  session `stopped` with `video_r2_key` null: everything is built, nothing
  is published. No hold → publish exactly as before.
- **Fix the assembly re-encode fallback to pin the GOP** (reuse
  `SEGMENT_ENCODE_ARGS`' `-g/-keyint_min/-sc_threshold/open-gop`): today the
  fallback emits default x264 keyframes (~every 250 frames, scene-cut on),
  which would break lossless cutting. Cheap and correct regardless of this
  feature.

**B. Cut apply + publish.** Runs when `original_video_r2_key` and
`video_units` exist — i.e. the user published a held session with cuts:
- Compute kept video-second ranges: map each `video_units[i]` through the
  membership rule → contiguous kept index runs.
- `video_copy_aligned = true`: per kept range, an input seek to its IDR
  (`-ss`) plus an exact copied packet count (`-frames:v n×30`) into a TS
  intermediate, then stream-copy concat → `timelapses/{id}/edited.mp4`.
  Lossless, seconds. (NOT concat `inpoint`/`outpoint`: outpoint is
  dts-based and B-frame dts offsets leak ~2 frames of the cut region past
  each boundary — caught by the worker's frame-exact test.)
- `video_copy_aligned = false`: one frame-exact re-encode of the original
  through a `select` filter with the pinned args (rare; CRF 18).
- Verify frame count = kept units × 30, exactly on the copy path.
- Regenerate the thumbnail from `edited.mp4` (the first minute may be cut).
- Point `video_r2_key` at `edited.mp4`, persist authoritative
  `cut_seconds`, clear the hold, status `complete` — **then** delete the
  uncut original and null its key. Ordering matters: deleting first would
  leave a crash pointing the session at bytes that no longer exist.

Notes:
- The cut path **never downloads capture units** — it needs only
  `original.mp4`, so it is unaffected by screenshot retention.
- Publishing *without* cuts never reaches the worker at all: the server
  repoints `video_r2_key` at the already-built original
  (`lib/publish.ts#publishHeldSession`), which is also what the hold-expiry
  job calls. One helper, one atomic guard, so a user's publish and the
  expiry job racing each other publish exactly once.

### Retention & privacy for cut content

Cut minutes vanish from the published video, so the uncut original is
deleted **immediately** after an edited publish — not kept for a re-edit
window. `EDIT_WINDOW_DAYS = 7` remains only as a retention backstop in the
daily job, for originals orphaned by a crashed publish. Uncut sessions keep
their single video file forever, as today.

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
  - Footer: kept/removed durations (server-authoritative), optional "Not
    now", and a primary button that reads **"Save & publish"** with cuts or
    **"Publish as recorded"** without — publishing is the way out, not an
    optional extra step.
  - Polls `/units` while the preview is still compiling, and counts down to
    the hold's auto-publish (louder in the last two minutes) so the user
    always knows the timelapse is safe but not yet out.
- **`<StopChoiceModal>`**: the stop confirmation — keep recording / stop &
  save / edit & save. This is where editing is offered; there is no
  post-publication entry point.
- Wiring: `LookoutRecorder` routes every Stop button through the modal and
  renders the editor inline after an `edit` stop. `SessionDetail` shows a
  **review panel** for any session with a live `editHoldUntil` (Edit & save
  / Publish as recorded / countdown), and suppresses the compile spinner
  there — "processing" under "ready to review" would contradict itself.
- Pure helpers with tests (style of `computeBestTracked.ts`): unit↔interval
  mapping, kept-range computation, gap detection.

### Desktop (`clients/desktop`)

- `NamingModal` (already the stop confirmation) gains **Edit & Save**
  alongside Save & Stop and Resume — the three choices the user asked for,
  in the place they already exist.
- The main window is a fixed 480×640 — too small for precise timeline
  scrubbing — so editing opens a **dedicated resizable 960×720 window**
  (`EditorWindow.tsx`, route `#/editor?token=…`, Tauri `WebviewWindow`
  labeled `editor-*`). Publishing emits `lookout-edited`; the main window
  remounts the open `SessionDetail` and refreshes the gallery.
- **While that window is open the main window steps aside**, showing only
  an icon and "Edit your timelapse in the edit window." (click to bring it
  to the front). Two live views of one session would just compete for
  attention. The main window learns the editor opened from an event and
  then *polls* for the window's existence — the poll is what guarantees it
  can never get stuck behind the placeholder if the editor is force-quit.
- Both stop paths (`RecordPage` and `DesktopRecorder`) send
  `{ edit: true }` and open the editor window; `SessionDetail`'s `onEdit`
  override reopens it from the review panel.
- No Rust changes — capture/tray/upload untouched (window creation +
  close permissions added to the default capability).

### Web (`clients/web`)

- The hosted recorder renders the SDK's `<LookoutRecorder>`, so it inherits
  the stop modal and editor. `?edit=false` on the recorder URL maps to
  `editing={false}` for programs that want one-click stops.

## Docs

- `packages/server/API.md`: new endpoints/fields, membership rule, cut
  semantics, recompile limits, retention of originals.
- `docs/integration.md`: "Edits and cuts" section for program authors —
  `trackedSeconds` now reflects cuts, `/timings` filters by default, new
  fields (`cuts`, `cutSeconds`, `uncutTrackedSeconds`), stale-cache note,
  and that adopting requires nothing.
- `clients/react/API.md`: `<TimelapseEditor>`, new client methods.

## Tests

- **Shared** (`packages/server/test/cuts.unit.test.ts`): membership,
  normalization/merge/clamp, kept ranges, cut-seconds in both tracking
  modes.
- **Server integration** (`packages/server/test/edits.integration.test.ts`):
  stop with/without `{edit}` (including the no-captures case); `/units`
  across every editability state; PUT cuts validation matrix and the
  "published sessions are immutable" guarantee; publish semantics (instant
  without cuts, worker handoff with cuts, idempotent against the expiry
  job, 202 while publishing, 409 once lapsed); timings filtering
  (+`includeCut`); trackedSeconds subtraction in `GET`/`status`/`batch`.
- **Worker** (`packages/worker/test/cutVideo.test.ts`, real ffmpeg): cuts
  built from a production-shaped original are frame-exact via stream copy
  (zero tolerance), head/tail ranges, the re-encode fallback, and
  `computeKeptRanges` output feeding the cutter directly.
- **React** (`editorMath.test.ts`): region↔interval round-trips including
  across pause gaps, normalization, gap detection.
- **Desktop legacy** (`legacy_client.rs`): stop path byte-identical.

## Rollout order

Server and worker must both be deployed before any client sends
`{ edit: true }` — a hold set by the server but ignored by an old worker
would leave a session `stopped` until the expiry job publishes it (safe,
but a 30-minute wait). Deploy order:

1. `@lookout/shared`: `CutInterval`, membership/normalize helpers,
   constants (`MAX_CUT_INTERVALS`, `MAX_USER_RECOMPILES`,
   `EDIT_HOLD_MINUTES`, `EDIT_WINDOW_DAYS`).
2. Migrations `0018_session_edits` + `0019_edit_hold`.
3. Worker: GOP-pinned assembly fallback, `video_units` bookkeeping,
   hold-aware publish, cut-apply path. (Inert — nothing sets a hold yet.)
4. Server: stop `{edit}`, units/cuts/publish endpoints, timings + response
   fields, hold-expiry job. (Inert until a client opts in.)
5. `@lookout/react`: api client, `<StopChoiceModal>`, `<TimelapseEditor>`,
   review panel.
6. Web + desktop surfaces; desktop release.
7. Docs; announce to program authors.

Sessions compiled before step 3 have no `video_units` — they simply never
offer editing, and old clients never request a hold, so both keep working
unchanged.

## Edge cases ledger

- **Bucket-mode / legacy sessions**: membership falls back to
  `requested_at`; `cut_seconds` = distinct cut minute-buckets × 60.
- **Mixed-format sessions**: irrelevant post-compile — cuts operate on the
  compiled video's second grid.
- **Build-failure holes**: `video_units` records what's actually in the
  video, so the mapping stays exact even when compile skipped undecodable
  units.
- **Hold expires mid-build**: the build re-reads the hold at the end and
  publishes normally if it lapsed; the expiry job skips sessions with no
  original yet (and clears their hold so the next build publishes).
- **User publishes while the expiry job fires**: both go through
  `publishHeldSession`'s atomic guard, so exactly one wins; the loser's
  endpoint returns `200 instant` because the timelapse is out either way.
- **PUT cuts racing publication**: the write is guarded on
  `status='stopped' AND edit_hold_until > now()`, so a published session's
  numbers can never move.
- **Failed cut publish**: pg-boss retries; final failure marks `failed` as
  today. Admin recompile re-enters half A (the original was deleted), which
  rebuilds from capture units and re-applies the same cut list.
- **`videoWebmUrl` legacy field**: unchanged (static please-update video).

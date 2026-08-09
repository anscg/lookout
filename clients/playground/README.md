# SDK playground

A harness for exercising `@lookout/react` against a real server — built to
check the edit (cuts) flow, which is hard to eyeball inside the desktop app.

```bash
npm run dev --workspace @lookout/playground   # http://localhost:5199
```

Paste an API base URL and a session token. Both persist in localStorage.

## Getting an editable session

Editing only exists during a session's **edit hold**, so a plain stop won't
do. Create and stop one with the hold:

```bash
# 1. Create (needs a program API key)
curl -X POST "$API/api/internal/sessions" \
  -H 'Content-Type: application/json' -H "X-API-Key: $KEY" \
  -d '{"metadata":{"why":"playground"}}'

# 2. Record a few minutes in the Record tab with the returned token.

# 3. Stop it WITH a hold — this is what makes it editable.
curl -X POST "$API/api/sessions/$TOKEN/stop" \
  -H 'Content-Type: application/json' -d '{"edit":true}'
```

The hold is a lease: it lapses about two minutes after the last
`POST /:token/editing`. The editor renews it while open, so leaving the
Editor tab up keeps the session alive; leaving the playground closed lets
it publish itself, after which it is no longer editable (by design —
published data must not change under the programs consuming it).

## Tabs

- **Editor** — `<TimelapseEditor>` inside a resizable box. Presets cover the
  shapes that broke layout before (short, narrow, the desktop window's
  actual minimum); the corner drags to anything else. The dock must stay
  on screen and the video must letterbox at every size.
- **Detail** — `<SessionDetail>`, which renders the hold's review panel.
- **Record** — the full `<LookoutRecorder>` flow, including the stop modal
  with "Edit & save".

## The Server truth panel

Polls `/status` and `/units` every 2s and shows them next to the editor.
Most bugs in this feature were the client and server disagreeing, so the
panel exists to make that visible rather than inferable from a 400:

- `editable` / `editableReason` — `preparing` while the preview compiles
  (the editor should show a progress ring, not an error), `published` once
  it's out.
- **Verify against server** sends the editor's current cut list to
  `PUT /cuts` and prints the response. **`unitsCut` must equal the number
  the editor's footer says was removed.** A mismatch there is what used to
  surface as "Cut list would remove the entire timelapse" on Save. The
  button writes the cut list; it does not publish.

## Note on the SDK build

The playground excludes `@lookout/react` from Vite's dep pre-bundling, so a
rebuild of the SDK shows up on reload without restarting the dev server.
The other clients don't, which is why SDK changes can appear not to take
effect there — restart their dev server after
`npm run build --workspace @lookout/react`.

# lookout-core

The capture engine behind Lookout's desktop app, as a plain Rust library with
no UI-toolkit dependency. The Tauri app in `../../src` is one shell over it;
a GTK/libadwaita, Qt, or headless shell links the same crate.

What lives here:

- **Capture sources** (`sources`): monitor and window enumeration, including the
  on-screen window geometry used for redaction.
- **Frame capture** (`capture`): stitched multi-source grabs, Filtered Apps
  redaction, SIMD downscale, JPEG encode. PipeWire/portal capture on Linux.
- **Clips** (`clips`): hardware H.264 per-minute clips (VideoToolbox, Media
  Foundation, GStreamer).
- **Capture loop** (`capture_loop`): the self-scheduling upload tick, clip
  cutting, live-preview frames, sleep/pause recovery.
- **Upload pipeline** (`upload`): presigned URL → R2 PUT → confirm, with the
  retry/backoff policy and error shaping.
- **Recording clock** (`timer`): the once-a-second menu-bar timer, kept in
  step with the web UI's rules.
- **Filtered Apps list** (`apps`) and **capture diagnostics**
  (`capture_diagnostics`).
- **Server API** (`api`): the session lifecycle (status, pause, resume,
  stop, rename, video, cut editing, edit lease), the program registry, the
  announcement banner, and the gallery batch lookup. Responses are the
  server's JSON verbatim; errors carry the HTTP status so UI code can branch
  on it. Shells call these instead of speaking HTTP themselves.

## Writing a shell

Implement `Frontend` (three methods: receive a `CoreEvent`, say whether the
live preview is being looked at, display the clock text), build a `Core`, and
drive it:

```rust
use std::sync::Arc;
use lookout_core::{Core, CoreEvent, Frontend};

struct MyShell;

impl Frontend for MyShell {
    fn emit(&self, event: CoreEvent) {
        // forward to your UI; `event.name()` is the stable wire name
    }
    fn wants_preview_frames(&self) -> bool { true }
    fn set_tray_title(&self, time_text: &str) { /* "04:59" */ }
}

// Inside a tokio runtime:
let core = Core::new(Arc::new(MyShell), "Lookout GNOME", env!("CARGO_PKG_VERSION"));
core.configure(session_token, api_base_url)?;
core.start_capture_loop(sources, 1920, 1080, 85)?;
// ...
core.stop_capture_loop()?;
```

Session *creation* happens on the program's website and reaches a shell as
a `lookout://` deep link carrying the token; everything after that goes
through `Core`'s `api` methods (`core.session_status(&cfg)`, `core.session_stop(&cfg, edit)`,
...). Response shapes are documented in `packages/server/API.md` and typed in
`packages/shared/src/types.ts`.

See the crate-level docs in `src/lib.rs` for the full contract.

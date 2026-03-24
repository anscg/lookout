/// Registers a WebView2 `PermissionRequested` event handler that auto-grants
/// camera and microphone access, eliminating the native permission prompt on
/// Windows.
///
/// Must be called after the Tauri window is created (e.g. from `setup()`).
/// This is the workaround until WRY PR #1654 lands and Tauri exposes it.
#[cfg(target_os = "windows")]
pub fn register_permission_handler(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2PermissionRequestedEventArgs, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let result = window.with_webview(|webview| {
        // SAFETY: `controller()` and the COM pointer lifetimes are managed by
        // WRY for the duration of the window. We hold no reference across
        // thread boundaries; the closure is invoked synchronously.
        let core = unsafe { webview.controller().CoreWebView2().unwrap() };

        let handler = PermissionRequestedEventHandler::create(Box::new(move |_sender, args| {
            let args: Option<ICoreWebView2PermissionRequestedEventArgs> = args;
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND_CAMERA; // default
                unsafe { args.PermissionKind(&mut kind).ok() };

                if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                    || kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                {
                    unsafe {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW).ok();
                    }
                }
            }
            Ok(())
        }));

        // The webview2-com-sys binding types the token as a plain i64.
        let mut _token: i64 = 0;
        unsafe {
            core.add_PermissionRequested(&handler, &mut _token)
                .unwrap_or_else(|e| {
                    eprintln!("[windows-permissions] failed to register handler: {e:?}");
                });
        }
    });

    if let Err(e) = result {
        eprintln!("[windows-permissions] with_webview failed: {e:?}");
    }
}

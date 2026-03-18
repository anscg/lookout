mod capture;

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

/// App state shared across commands.
pub struct AppState {
    pub config: Mutex<Option<SessionConfig>>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    pub token: String,
    pub api_base_url: String,
}

#[derive(Serialize)]
pub struct CaptureResult {
    /// Base64-encoded JPEG bytes
    pub base64: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: usize,
}

#[derive(Serialize, Deserialize)]
pub struct UploadUrlResponse {
    #[serde(rename = "uploadUrl")]
    pub upload_url: String,
    #[serde(rename = "r2Key")]
    pub r2_key: String,
    #[serde(rename = "screenshotId")]
    pub screenshot_id: String,
    #[serde(rename = "minuteBucket")]
    pub minute_bucket: i32,
    #[serde(rename = "nextExpectedAt")]
    pub next_expected_at: String,
}

#[derive(Serialize, Deserialize)]
pub struct ConfirmResponse {
    pub confirmed: bool,
    #[serde(rename = "trackedSeconds")]
    pub tracked_seconds: i64,
    #[serde(rename = "nextExpectedAt")]
    pub next_expected_at: String,
}

/// Initialize the session config so Rust knows where the server is.
#[tauri::command]
fn configure(token: String, api_base_url: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    *config = Some(SessionConfig { token, api_base_url });
    Ok(())
}

/// Take a native screenshot of the primary monitor, encode as JPEG, return base64.
#[tauri::command]
fn take_screenshot(max_width: u32, max_height: u32, jpeg_quality: u8) -> Result<CaptureResult, String> {
    capture::take_screenshot(max_width, max_height, jpeg_quality)
}

/// Full capture-upload-confirm pipeline in Rust (no browser CORS issues).
#[tauri::command]
async fn capture_and_upload(
    max_width: u32,
    max_height: u32,
    jpeg_quality: u8,
    state: State<'_, AppState>,
) -> Result<ConfirmResponse, String> {
    let config = {
        let guard = state.config.lock().map_err(|e| e.to_string())?;
        guard.clone().ok_or("Not configured — call configure() first")?
    };

    // Step 1: Native screenshot
    let screenshot = capture::take_screenshot(max_width, max_height, jpeg_quality)?;
    let jpeg_bytes = base64_decode(&screenshot.base64)?;

    // Step 2: Get presigned URL from server
    let client = reqwest::Client::new();
    let upload_url_resp: UploadUrlResponse = client
        .get(format!(
            "{}/api/sessions/{}/upload-url",
            config.api_base_url, config.token
        ))
        .send()
        .await
        .map_err(|e| format!("Failed to get upload URL: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse upload URL response: {e}"))?;

    // Step 3: Upload JPEG to R2
    client
        .put(&upload_url_resp.upload_url)
        .header("Content-Type", "image/jpeg")
        .body(jpeg_bytes.clone())
        .send()
        .await
        .map_err(|e| format!("R2 upload failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("R2 upload rejected: {e}"))?;

    // Step 4: Confirm upload with server
    let confirm_resp: ConfirmResponse = client
        .post(format!(
            "{}/api/sessions/{}/screenshots",
            config.api_base_url, config.token
        ))
        .json(&serde_json::json!({
            "screenshotId": upload_url_resp.screenshot_id,
            "width": screenshot.width,
            "height": screenshot.height,
            "fileSize": screenshot.size_bytes,
        }))
        .send()
        .await
        .map_err(|e| format!("Confirmation failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse confirmation: {e}"))?;

    Ok(confirm_resp)
}

fn base64_decode(b64: &str) -> Result<Vec<u8>, String> {
    use base64_engine::*;
    ENGINE.decode(b64).map_err(|e| format!("Base64 decode failed: {e}"))
}

mod base64_engine {
    pub use base64::engine::general_purpose::STANDARD as ENGINE;
    pub use base64::Engine;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppState {
            config: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            configure,
            take_screenshot,
            capture_and_upload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

//! Small secret store for device credentials (program pairing tokens).
//!
//! Secrets live OUTSIDE the webview's localStorage on purpose: a device
//! credential outlives any one session token and grants "create a session as
//! this user" against a program's backend, so it shouldn't sit in web storage
//! alongside cache-like state that debugging code happily dumps.
//!
//! Storage is a JSON object in the app config dir, written atomically and
//! chmod 0600 on Unix. That's deliberate scope: an OS-keychain backend
//! (Keychain/DPAPI/Secret Service) is a strict upgrade that can slot in
//! behind the same three commands later without touching the frontend.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

/// Serializes writers so two quick set/delete calls can't interleave their
/// read-modify-write cycles and drop one another's entries.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    Ok(dir.join("secrets.json"))
}

fn read_all(app: &tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    let path = store_path(app)?;
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("corrupt secret store: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(e) => Err(format!("read secret store: {e}")),
    }
}

fn write_all(app: &tauri::AppHandle, map: &HashMap<String, String>) -> Result<(), String> {
    let path = store_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string(map).map_err(|e| e.to_string())?;
    fs::write(&tmp, raw).map_err(|e| format!("write secret store: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, &path).map_err(|e| format!("commit secret store: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn secret_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().map_err(|_| "secret store lock poisoned")?;
    let mut map = read_all(&app)?;
    map.insert(key, value);
    write_all(&app, &map)
}

#[tauri::command]
pub fn secret_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let map = read_all(&app)?;
    Ok(map.get(&key).cloned())
}

#[tauri::command]
pub fn secret_delete(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().map_err(|_| "secret store lock poisoned")?;
    let mut map = read_all(&app)?;
    map.remove(&key);
    write_all(&app, &map)
}

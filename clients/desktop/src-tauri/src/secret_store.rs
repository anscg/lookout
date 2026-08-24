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

    // The mode is set when the file is CREATED, not after it is written.
    // Writing first and chmodding after leaves the credential readable for the
    // window in between (whatever the umask allows, usually 0644), and a plain
    // `fs::write` would happily follow a symlink or inherit the mode of a file
    // someone else pre-created at that path.
    //
    // `create_new` is what closes that: it fails rather than opening an
    // existing file or a link, so a stale temp file is cleared first and a
    // planted one is an error instead of a hijack. The chmod failing is fatal
    // too — silently continuing would publish the token to every local user.
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);

        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }

        // Only ever our own leftover, since the rename below is atomic.
        if tmp.exists() {
            fs::remove_file(&tmp).map_err(|e| format!("clear stale secret temp: {e}"))?;
        }

        let mut file = opts
            .open(&tmp)
            .map_err(|e| format!("create secret store: {e}"))?;

        // Belt and braces on platforms where the open mode was advisory.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("secure secret store: {e}"))?;
        }

        use std::io::Write;
        file.write_all(raw.as_bytes())
            .map_err(|e| format!("write secret store: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("flush secret store: {e}"))?;
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

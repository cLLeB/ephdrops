//! Ephemeral Drops — Tauri desktop shell.
//!
//! The UI is the same React client served from `../client/dist`. Rust only
//! provides the two native capabilities the WebView cannot do reliably itself:
//!
//!   * `open_external`    — open a URL in the OS default handler. Tauri's
//!                          WebView silently swallows `window.open()`, which is
//!                          why share buttons appeared dead; routing through the
//!                          opener plugin in Rust is the reliable fix.
//!   * `save_file_dialog` — show a native Save dialog and write decrypted bytes
//!                          to disk. WebView2 drops `<a download>` clicks, so
//!                          downloads must go through a native dialog.

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Uniform result shape returned to the JS layer: `{ success, error? }`.
#[derive(Serialize)]
struct CmdResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl CmdResult {
    fn ok() -> Self {
        Self { success: true, error: None }
    }
    fn err<S: Into<String>>(message: S) -> Self {
        Self { success: false, error: Some(message.into()) }
    }
}

/// Open a URL (https, mailto, app protocol, …) in the OS default handler.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> CmdResult {
    match app.opener().open_url(url, None::<&str>) {
        Ok(()) => CmdResult::ok(),
        Err(e) => CmdResult::err(e.to_string()),
    }
}

/// Show a native Save dialog and write the given base64 payload to the chosen
/// path. Returns `{ success: false, error: "cancelled" }` when the user
/// dismisses the dialog (the JS side treats that as a non-error).
#[tauri::command]
fn save_file_dialog(app: tauri::AppHandle, base64_data: String, file_name: String) -> CmdResult {
    // Decode first so we fail fast on a malformed payload before prompting.
    let bytes = match general_purpose::STANDARD.decode(base64_data.as_bytes()) {
        Ok(b) => b,
        Err(e) => return CmdResult::err(format!("decode error: {e}")),
    };

    // Blocking dialog — safe here because Tauri runs commands off the main
    // thread; the plugin marshals the dialog onto the UI thread internally.
    let picked = app
        .dialog()
        .file()
        .set_file_name(&file_name)
        .blocking_save_file();

    let Some(picked) = picked else {
        return CmdResult::err("cancelled");
    };

    let path = match picked.into_path() {
        Ok(p) => p,
        Err(e) => return CmdResult::err(format!("path error: {e}")),
    };

    match std::fs::write(&path, &bytes) {
        Ok(()) => CmdResult::ok(),
        Err(e) => CmdResult::err(format!("write error: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_external, save_file_dialog])
        .run(tauri::generate_context!())
        .expect("error while running Ephemeral Drops");
}

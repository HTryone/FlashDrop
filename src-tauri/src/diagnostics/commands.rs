// 诊断命令（薄胶水，业务在 store/logger/panic_hook）。§3 采集层 B。
use tauri::AppHandle;

use crate::diagnostics::logger::LogEntry;
use crate::diagnostics::store;
use serde_json::json;

#[tauri::command]
pub fn diagnostics_capture(entries: Vec<LogEntry>) {
    for e in &entries {
        store::append(e);
    }
}

#[tauri::command]
pub fn diagnostics_query() -> Vec<LogEntry> {
    store::read_recent()
}

#[tauri::command]
pub fn diagnostics_export(_app: AppHandle, share: bool) -> Result<String, String> {
    store::export_zip(share)
}

// Android 专用：返回 (文件名, base64 字节)，Web 侧经 mediastore_insert 落 Download/ArkPulse/log（复用现有权限）。
#[tauri::command]
pub fn diagnostics_export_android(
    _app: AppHandle,
    share: bool,
) -> Result<serde_json::Value, String> {
    let (name, bytes) = store::export_zip_android(share)?;
    Ok(json!({ "name": name, "bytes": bytes }))
}

#[tauri::command]
pub fn diagnostics_clear() -> Result<(), String> {
    store::clear()
}

// 诊断命令（薄胶水，业务在 store/logger/panic_hook）。§3 采集层 B。
use tauri::AppHandle;

use crate::diagnostics::logger::LogEntry;
use crate::diagnostics::store;

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

#[tauri::command]
pub fn diagnostics_clear() -> Result<(), String> {
    store::clear()
}

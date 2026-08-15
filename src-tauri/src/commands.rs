// 命令层（薄胶水层，类比前端 .vue）：只做参数透传 + 错误映射，业务逻辑全部下沉到
// file_writer / path_resolver。禁止在此类函数里写文件 IO 或路径计算。
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub fn open_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    crate::file_writer::open_file(state.inner(), &path)
}

#[tauri::command]
pub fn write_chunk(
    state: State<'_, AppState>,
    handle: String,
    data: Vec<u8>,
) -> Result<(), String> {
    // data 由 Tauri 把前端 Uint8Array 二进制直传（非 JSON 数字数组），修 D1。
    crate::file_writer::write_chunk(state.inner(), &handle, &data)
}

#[tauri::command]
pub fn close_file(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    crate::file_writer::close_file(state.inner(), &handle)
}

#[tauri::command]
pub fn abort_file(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    crate::file_writer::abort_file(state.inner(), &handle)
}

#[tauri::command]
pub fn resolve_save_path(dir: String, name: String) -> String {
    crate::path_resolver::resolve_save_path(&dir, &name)
}

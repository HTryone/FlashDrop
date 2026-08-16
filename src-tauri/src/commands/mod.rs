// 命令层（薄胶水层，类比前端 .vue）：只做参数透传 + 错误映射 + IPC 载荷格式解码，
// 业务逻辑全部下沉到 file_writer / path_resolver。禁止在此类函数里写文件 IO 或路径计算。
use base64::Engine;
use tauri::ipc::{InvokeBody, Request};
use tauri::State;

use crate::files::file_writer;
use crate::files::path_resolver;
use crate::state::AppState;

#[tauri::command]
pub fn open_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    file_writer::open_file(state.inner(), &path)
}

/// 桌面路径：二进制 Raw 载荷直传，零膨胀。
///
/// 【性能铁律·不可退化】数据块必须作为 invoke 的「整个 args」传入（前端 `invoke(cmd, bytes, {headers})`），
/// 句柄走请求头。一旦把数据塞进 `{handle, data}` 这样的对象，Tauri 的 processIpcMessage 会走
/// JSON.stringify + Array.from(Uint8Array) → 4MB 二进制膨胀成 12~16MB 数字数组文本，
/// 桌面浪费 3~4 倍带宽与 CPU，手机端直接把 WebView 主线程打死（表现为速度 0 + 看门狗超时）。
#[tauri::command]
pub fn write_chunk(state: State<'_, AppState>, request: Request<'_>) -> Result<(), String> {
    let handle = request
        .headers()
        .get("x-fd-handle")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "缺少文件句柄请求头 x-fd-handle".to_string())?;
    match request.body() {
        InvokeBody::Raw(data) => file_writer::write_chunk(state.inner(), handle, data),
        InvokeBody::Json(_) => {
            Err("write_chunk 只接受二进制载荷；安卓端请调用 write_chunk_b64".to_string())
        }
    }
}

/// 安卓路径：base64 文本载荷。
///
/// 安卓 WebView 的 IPC 只能传字符串，Tauri 的 InvokeBody::Raw 在安卓不可用（官方限制）。
/// base64 膨胀 1.33x，远优于 JSON 数字数组的 3~4x，是该平台的最优解。
#[tauri::command]
pub fn write_chunk_b64(
    state: State<'_, AppState>,
    handle: String,
    data: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("载荷 base64 解码失败: {e}"))?;
    file_writer::write_chunk(state.inner(), &handle, &bytes)
}

#[tauri::command]
pub fn close_file(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    file_writer::close_file(state.inner(), &handle)
}

#[tauri::command]
pub fn abort_file(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    file_writer::abort_file(state.inner(), &handle)
}

#[tauri::command]
pub fn resolve_save_path(dir: String, name: String) -> Result<String, String> {
    path_resolver::resolve_save_path(&dir, &name)
}

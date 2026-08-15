// 核心落盘逻辑（类比前端 .ts 核心）：打开/追加/落盘/中止，全部纯函数操作 AppState。
// 命令层 commands.rs 只做参数透传与错误映射，不在此堆业务逻辑。
use std::fs::OpenOptions;
use std::io::Write;

use crate::state::AppState;

/// 打开（或创建）文件用于追加写入，返回句柄 id。
/// 仅 create+append 打开，不读取、不覆盖已有内容；父目录不存在则递归创建。
pub fn open_file(state: &AppState, path: &str) -> Result<String, String> {
    let p = std::path::PathBuf::from(path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .map_err(|e| format!("打开文件失败 {path}: {e}"))?;
    let handle = uuid::Uuid::new_v4().to_string();
    state.files.lock().unwrap().insert(
        handle.clone(),
        crate::state::FileEntry {
            file: std::sync::Arc::new(std::sync::Mutex::new(file)),
            path: p,
        },
    );
    Ok(handle)
}

/// 追加写入一块数据。取出条目后立即释放全局锁，仅锁单文件 —— 多文件并行互不阻塞（修 D2）。
pub fn write_chunk(state: &AppState, handle: &str, data: &[u8]) -> Result<(), String> {
    let entry = {
        let files = state.files.lock().unwrap();
        files
            .get(handle)
            .cloned()
            .ok_or_else(|| format!("文件句柄不存在: {handle}"))?
    };
    let mut f = entry.file.lock().unwrap();
    f.write_all(data).map_err(|e| format!("写入失败: {e}"))?;
    Ok(())
}

/// 关闭并强制落盘（sync_all），从表中移除句柄。
pub fn close_file(state: &AppState, handle: &str) -> Result<(), String> {
    if let Some(entry) = state.files.lock().unwrap().remove(handle) {
        let f = entry.file.lock().unwrap();
        f.sync_all().map_err(|e| format!("落盘失败: {e}"))?;
    }
    Ok(())
}

/// 中止：释放句柄并删除未完成的半截文件（修 D3 句柄泄漏 + 残留）。
pub fn abort_file(state: &AppState, handle: &str) -> Result<(), String> {
    if let Some(entry) = state.files.lock().unwrap().remove(handle) {
        let _ = entry.file.lock().unwrap().sync_all();
        let _ = std::fs::remove_file(&entry.path);
    }
    Ok(())
}

// 状态模型（核心）：全局仅持有一张「句柄 id -> 文件条目」表。
// 关键：表用全局锁保护「查找/插入/移除」，但每条目内部是独立的 Arc<Mutex<File>>，
// 写入时取出条目后立即释放全局锁，之后只锁单文件 —— 多文件并行下载互不阻塞（修 D2）。
use std::collections::HashMap;
use std::fs::File;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// 单个打开文件的条目：文件句柄（可跨命令调用共享） + 其最终路径（abort 时删文件用）。
#[derive(Clone)]
pub struct FileEntry {
    pub file: Arc<Mutex<File>>,
    pub path: PathBuf,
}

/// 全局应用状态：被 Tauri 托管，命令通过 State 注入。
pub struct AppState {
    pub files: Mutex<HashMap<String, FileEntry>>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            files: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

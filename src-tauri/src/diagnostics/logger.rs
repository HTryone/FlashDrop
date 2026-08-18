// 结构化日志条目（Web/Rust 字段对齐 §types.ts）。同步写、带 platform/traceId。
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub ts: u64,
    pub level: String, // debug/info/warn/error
    pub channel: String,
    pub scope: String,
    #[serde(default)]
    pub msg: String,
    #[serde(default)]
    pub data: Option<String>,
    #[serde(default, rename = "trace_id")]
    pub trace_id: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
}

impl LogEntry {
    pub fn error(scope: &str, msg: String, platform: &str) -> Self {
        Self {
            ts: now_ms(),
            level: "error".to_string(),
            channel: "crash".to_string(),
            scope: scope.to_string(),
            msg,
            data: None,
            trace_id: None,
            platform: Some(platform.to_string()),
        }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

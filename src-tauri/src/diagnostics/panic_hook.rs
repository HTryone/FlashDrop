// panic 兜底（§3.2）：panic 时同步写错误日志 + crash-*.json 再退出，不丢尾。
// 仅覆盖 Rust 侧 panic；segfault/OOM/webview 崩溃由系统机制兜底（§3.2 硬崩溃边界）。
use std::sync::atomic::{AtomicBool, Ordering};

use crate::diagnostics::logger::LogEntry;
use crate::diagnostics::store;

static HOOKED: AtomicBool = AtomicBool::new(false);

pub fn install() {
    if HOOKED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::panic::set_hook(Box::new(|info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        let entry = LogEntry::error(
            "panic_hook",
            format!("{} @ {}", info, loc),
            &crate::diagnostics::store::current_platform(),
        );
        store::append(&entry);
        store::write_crash_snapshot(&entry);
    }));
}

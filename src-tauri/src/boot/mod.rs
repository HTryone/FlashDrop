// 壳层启动配置（类比前端 .ts 核心逻辑层）：集中管理「WebView 加载哪个源」。
//
// ⚠️ 换域名只改这里一处：REMOTE_URL 是 App 唯一的外置域名配置点。
//    改完重打 APK / 桌面包即生效（app 是冷更新，符合预期）。
//    前端 dist 走热更新（推 Cloudflare），不在此处写死。
//
// 职责边界（架构铁律）：本文件只决定「加载谁」，不写任何业务；
// 落盘 / 传输等业务逻辑全在远程 dist + Rust 各核心模块（commands/file_writer/...）。

/// App 唯一外置域名配置点：换域名改这里。
pub const REMOTE_URL: &str = "https://flashdrop.pages.dev";

/// 解析 WebView 启动加载的源。
/// - dev（debug）：走本地 dev server（桌面 / 安卓 dev 经 adb reverse 转发，localhost 可达），保留热重载。
/// - release：加载远程域名（热更新前端）。
pub fn resolve_remote_url() -> String {
    if cfg!(debug_assertions) {
        "http://localhost:3001".to_string()
    } else {
        REMOTE_URL.to_string()
    }
}

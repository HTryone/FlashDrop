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
/// - dev（debug）：也走远程 flashdrop.pages.dev（后端服务全在线上，本地无 server.mjs）。
/// - release：加载远程域名（热更新前端）。
/// 注：前端代码调试用 vite dev（3002/3003），但壳始终加载线上版本；
/// 热重载仅在前端源码改动后重新部署到 CF 才生效。
pub fn resolve_remote_url() -> String {
    REMOTE_URL.to_string()
}

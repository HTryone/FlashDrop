// 壳层启动页 URL 解析。
//
// 为什么不用 WebviewUrl::App("splash/splashscreen.html")？
// Tauri v2 在 frontendDist（dist/）存在时，asset server 会对 WebviewUrl::App 的未知路径做 SPA fallback：
// 把 /splash/splashscreen.html 当成前端路由，直接返回 dist/index.html。
// 结果 WebView 的 URL 仍是 /splash/splashscreen.html，但文档已经是 Vue 应用；
// Vue Router 没有匹配该路径的路由，<router-view> 渲染为空，用户就看到"顶栏+空白主体"。
//
// 修复：把 splash HTML 用 data URI 直接喂给 WebView，完全绕过 asset server，杜绝 SPA fallback。
// HTML 内容通过 include_str! 在编译期嵌入 Rust 二进制，仍属壳层资源，不随前端热更新走。
//
// 远程地址由 Rust 直接编译进 HTML（替换占位符 {{REMOTE}}），不依赖 WebView 的
// initialization_script 注入——data URI 页面的脚本注入行为在各 WebView 版本上不可靠，
// 一旦注入不执行，splash 会永远停在"启动配置缺失"而不跳转。
use base64::{engine::general_purpose, Engine as _};
use tauri::AppHandle;

const SPLASH_HTML: &str = include_str!("../../splash/splashscreen.html");

pub fn startup_url(_app: &AppHandle) -> tauri::WebviewUrl {
    // 外置架构唯一域名配置点（boot::resolve_remote_url → boot::REMOTE_URL）。
    let remote = crate::boot::resolve_remote_url();
    let html = SPLASH_HTML.replace("{{REMOTE}}", &remote);
    let b64 = general_purpose::STANDARD.encode(html.as_bytes());
    let data_uri = format!("data:text/html;base64,{b64}");
    tauri::WebviewUrl::External(tauri::Url::parse(&data_uri).expect("启动页 data URI 构造失败"))
}

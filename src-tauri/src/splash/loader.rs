// 壳层启动页 URL 解析。
//
// 启动页改用 Rust 自定义协议 `arkpulse-splash` 提供 splash HTML（内容经 include_str!
// 编译进 Rust 二进制，仍属壳层资源、不随前端热更新走、不进 dist）。
//
// 为什么不用 data: URI？
// 1) wry 安卓端初始化 IPC 时会把"当前页面 URL"当 http::Uri 解析，data: 不是合法
//    http URI → InvalidUri(InvalidFormat) 直接 abort（Tauri 官方 issue #13461，已 logcat 实锤）。
// 2) data: 是 opaque origin，从启动页发 fetch() 探活远程属已知脆弱点；Android 官方
//    亦推荐 WebViewAssetLoader（自定义 scheme + http origin），避免 data:/file://。
//
// 自定义协议 origin 合法（安卓/Windows = http://arkpulse-splash.localhost，
// mac/iOS/Linux = arkpulse-splash://localhost），IPC 不崩、fetch 正常，且完全绕过
// asset server，不触发 dist 存在时的 SPA fallback 空白。双端统一走此协议。
use tauri::AppHandle;

const SPLASH_HTML: &str = include_str!("../../splash/splashscreen.html");

// 组装 splash HTML：把 {{REMOTE}} 占位符替换为外置域名配置（boot::REMOTE_URL 唯一配置点）。
pub fn splash_html() -> String {
    let remote = crate::boot::resolve_remote_url();
    SPLASH_HTML.replace("{{REMOTE}}", &remote)
}

// 主窗口首屏 URL：双端统一走自定义协议（合法 http origin，非 opaque）。
pub fn startup_url(_app: &AppHandle) -> tauri::WebviewUrl {
    // Tauri 平台约定：mac/iOS/Linux 用 scheme://localhost，Windows/Android 用 http://scheme.localhost。
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "linux"))]
    let url = "arkpulse-splash://localhost/splashscreen.html";
    #[cfg(any(target_os = "windows", target_os = "android"))]
    let url = "http://arkpulse-splash.localhost/splashscreen.html";
    tauri::WebviewUrl::External(tauri::Url::parse(url).expect("启动页自定义协议 URL 构造失败"))
}

// 注册 arkpulse-splash 自定义协议：把 splash HTML 以 text/html 提供（含远程地址注入）。
// 链式返回 builder，便于在 lib.rs 装配链中直接调用。
pub fn register_splash_protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_uri_scheme_protocol("arkpulse-splash", |_ctx, _request| {
        tauri::http::Response::builder()
            .header("Content-Type", "text/html")
            .body(splash_html().into_bytes())
            .expect("splash 自定义协议响应构造失败")
    })
}

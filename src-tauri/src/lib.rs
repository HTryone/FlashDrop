// 应用装配层（类比前端 main.ts）：只做「装配」——注册插件、托管状态、挂载命令处理器。
// 业务逻辑全部下沉到 file_writer / path_resolver / state 等核心模块，本文件不写业务。
mod boot;
mod commands;
mod files;
mod splash;
mod state;

use boot::resolve_remote_url;
use state::AppState;
use tauri::webview::Color;
use tauri::WebviewWindowBuilder;

// 设备标识（壳注入，网页同步读取）：桌面 = 'windows'，手机 = 'phone'。
// 当前仅出 Windows 桌面 + Android，故桌面统一标 'windows'；后续加 macOS/Linux 再扩展此分支。
#[cfg(target_os = "android")]
const CLIENT_KIND: &str = "phone";
#[cfg(not(target_os = "android"))]
const CLIENT_KIND: &str = "windows";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(arkpulse_android_fs::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::write_chunk,
            commands::write_chunk_b64,
            commands::close_file,
            commands::abort_file,
            commands::resolve_save_path,
        ])
        .setup(|app| {
            // 外置架构：主窗口首屏加载壳层内嵌的本地启动页（src-tauri/splash/splashscreen.html），
            // 经 bundle.resources 打进安装包/APK，离线可用、不随远程前端热更新走（壳冷更新层）。
            // 启动页内 JS 探活远程前端：连上即跳转到远程、离线显示「重试中」持续重试；
            // 不需要 Rust 第二窗口、不需要固定计时、安卓也不会黑屏（首屏永远是壳层本地页）。
            // 双端加载路径由 splash 模块封装（桌面 resource_dir+External / 安卓 App）。
            let url = resolve_remote_url();

            // 壳在网页代码运行前注入：①设备标识（远程页读 window.__ARKPULSE_CLIENT__ 知是哪端）；
            // ②启动页读取 window.__ARKPULSE_REMOTE__ 作为跳转目标。
            let inject = format!(
                "window.__ARKPULSE_CLIENT__={{kind:'{kind}'}};window.__ARKPULSE_REMOTE__='{remote}';",
                kind = CLIENT_KIND,
                remote = url
            );

            // 主窗口首屏 = 壳层本地启动页（splash 模块按双端解析 URL）。
            let builder =
                WebviewWindowBuilder::new(app, "main", splash::startup_url(app.handle()))
                    .title("ArkPulse")
                    .visible(true)
                    .background_color(Color(11, 14, 22, 255)) // 消除 WebView 原生白底闪白
                    .initialization_script(inject);

            // 桌面：窗口在创建前就算好 75% 逻辑尺寸并居中，避免先出现默认小窗再 resize。
            // 安卓保持全屏，不在此设尺寸。
            #[cfg(not(target_os = "android"))]
            let builder = {
                let (w, h) = if let Ok(Some(monitor)) = app.primary_monitor() {
                    let scale = monitor.scale_factor();
                    let phys = monitor.size();
                    let w = (phys.width as f64 / scale * 0.75) as u32;
                    let h = (phys.height as f64 / scale * 0.75) as u32;
                    (w, h)
                } else {
                    (1024, 768)
                };
                builder.inner_size(w as f64, h as f64).center()
            };

            let _main = builder.build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

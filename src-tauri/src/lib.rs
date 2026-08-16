// 应用装配层（类比前端 main.ts）：只做「装配」——注册插件、托管状态、挂载命令处理器。
// 业务逻辑全部下沉到 file_writer / path_resolver / state 等核心模块，本文件不写业务。
mod boot;
mod commands;
mod file_writer;
mod path_resolver;
mod state;

use boot::resolve_remote_url;
use state::AppState;
use tauri::WebviewUrl;
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
            // 外置架构：WebView 加载远程前端（release）/ 本地 dev server（debug）。
            // 窗口 label 仍为 "main"，capabilities 授权照常生效，远程页可 invoke 本地命令。
            let url = resolve_remote_url();
            // 壳在网页代码运行前注入设备标识（同步、零网络）；远程页读 window.__FLASHDROP_CLIENT__ 即知是哪端。
            let inject = format!("window.__FLASHDROP_CLIENT__={{kind:'{}'}};", CLIENT_KIND);
            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                    .title("FlashDrop")
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

            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

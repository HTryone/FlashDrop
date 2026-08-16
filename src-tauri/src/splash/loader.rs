// 壳层启动页 URL 解析：双端加载路径不同（Tauri v2 对 frontendDist 与 bundle.resources
// 的解析机制不同），按 cfg 分叉。页面内 JS 自行 fetch 探活远程前端后 location.replace 跳转，
// Rust 不收遮罩、不设固定计时、不建第二窗口，安卓也不会黑屏（首屏永远是壳层本地页）。
use tauri::AppHandle;

#[cfg(desktop)]
use tauri::Manager;

#[cfg(desktop)]
pub fn startup_url(app: &AppHandle) -> tauri::WebviewUrl {
    match app.path().resource_dir() {
        Ok(dir) => {
            let p = dir.join("splash").join("splashscreen.html");
            if p.exists() {
                return tauri::WebviewUrl::External(tauri::Url::from_file_path(&p).unwrap_or_else(
                    |_| {
                        eprintln!("[splash] 资源路径无效: {:?}", p);
                        tauri::Url::parse("about:blank").unwrap()
                    },
                ));
            }
            eprintln!("[splash] 启动页缺失: {}", p.display());
        }
        Err(e) => eprintln!("[splash] resource_dir 缺失: {e}"),
    }
    // 兜底：理论上不应走到
    tauri::WebviewUrl::App("splash/splashscreen.html".into())
}

#[cfg(mobile)]
pub fn startup_url(_app: &AppHandle) -> tauri::WebviewUrl {
    // 安卓：bundle.resources 打进 APK assets/，WebviewUrl::App 直接读 assets 内相对路径。
    tauri::WebviewUrl::App("splash/splashscreen.html".into())
}

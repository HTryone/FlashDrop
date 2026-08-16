// 启动遮罩模块（业务层，类比前端的 composables/*）。
// 职责：①创建独立原生遮罩窗口（加载打包内本地 splashscreen.html，离线可用）；
// ②监听远程前端真实挂载信号（'arkpulse-ready'）；③裁定线程：总时长上限 5s，
// 最坏 5 秒必进主窗口，网慢/断网在 1.5s、3s 各重拉一次。
// 装配层 lib.rs 只调用 setup_splash，本模块全部遮罩逻辑不回流到 lib.rs。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::webview::Color;
#[cfg(desktop)]
use tauri::Url;
use tauri::{AppHandle, Listener, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn setup_splash(app: AppHandle, url: &str) {
    // 遮罩窗口加载地址：
    // - 桌面：从内嵌资源目录加载（bundle.resources 把 src-tauri/splash/ 打进安装包，落 exe 同目录 splash/）。
    //   注意 WebviewUrl::App 只认 frontendDist(dist/)，内嵌资源在 exe 同目录，必须用 resource_dir() + External(file://) 加载。
    // - 安卓：从 APK assets/splash/ 加载（安卓 resource_dir=asset://localhost，App 变体正好服务 assets）。
    // logo 已内联进 HTML，无子资源加载失败问题；离线时遮罩照常显示。
    #[cfg(desktop)]
    let webview_url = match app.path().resource_dir() {
        Ok(dir) => {
            let p = dir.join("splash").join("splashscreen.html");
            WebviewUrl::External(Url::from_file_path(&p).unwrap_or_else(|_| {
                eprintln!("启动遮罩：资源路径不可用 {:?}", p);
                Url::parse("about:blank").unwrap()
            }))
        }
        Err(e) => {
            eprintln!("启动遮罩：找不到资源目录 {e}");
            return;
        }
    };
    #[cfg(mobile)]
    let webview_url = WebviewUrl::App("splash/splashscreen.html".into());

    // 底色深蓝 #0b0e16，消除 WebView 原生白底闪白。
    let splash_builder = WebviewWindowBuilder::new(&app, "splash", webview_url)
        .title("ArkPulse")
        .visible(true)
        .background_color(Color(11, 14, 22, 255));

    // 以下桌面专用窗口属性在安卓 WebviewWindowBuilder 不支持，必须整行 cfg 隔离，不能插链式调用。
    // 安卓 splash 全屏 + 主窗口初始隐藏，本就盖住，无需这些装饰属性。
    #[cfg(not(target_os = "android"))]
    let splash_builder = splash_builder.always_on_top(true);
    #[cfg(not(target_os = "android"))]
    let splash_builder = splash_builder.decorations(false);
    #[cfg(not(target_os = "android"))]
    let splash_builder = splash_builder.resizable(false);

    // 桌面：遮罩与主窗口同尺寸同位置精确盖住；安卓保持全屏。
    #[cfg(not(target_os = "android"))]
    let splash_builder = {
        let (w, h) = if let Ok(Some(monitor)) = app.primary_monitor() {
            let scale = monitor.scale_factor();
            let phys = monitor.size();
            let w = (phys.width as f64 / scale * 0.75) as u32;
            let h = (phys.height as f64 / scale * 0.75) as u32;
            (w, h)
        } else {
            (1024, 768)
        };
        splash_builder.inner_size(w as f64, h as f64).center()
    };

    let _splash = match splash_builder.build() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("启动遮罩窗口创建失败: {e}");
            return;
        }
    };

    // 就绪信号：远程前端真实挂载后发 'arkpulse-ready'，错误页不发，避免误判。
    let loaded = Arc::new(AtomicBool::new(false));
    let loaded_for_event = loaded.clone();
    app.listen("arkpulse-ready", move |_e| {
        loaded_for_event.store(true, Ordering::SeqCst);
    });

    // 裁定线程：总时长上限 5s（最坏 5 秒必进主窗口）。
    // 期间：远程前端真实挂载即提前收遮罩；网慢/断网则在 1.5s、3s 各重拉一次（1~2 次重试）；
    // 离线最终露出浏览器原生失败页，不弹任何自定义错误。
    let retry_url = url.to_string();
    let handle = app.clone();
    const TOTAL_MS: u64 = 5000;
    const RETRY_AT: [u64; 2] = [1500, 3000]; // 1.5s、3s 各重试一次
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        let mut next_retry = 0;
        loop {
            if loaded.load(Ordering::SeqCst) {
                break; // 远程前端已就绪，提前收遮罩
            }
            if handle.get_webview_window("splash").is_none() {
                return; // 遮罩已被收起
            }
            let elapsed = start.elapsed().as_millis() as u64;
            if next_retry < RETRY_AT.len() && elapsed >= RETRY_AT[next_retry] {
                // 到点未就绪：重拉远程前端（网慢/断网重试）
                if let Some(main) = handle.get_webview_window("main") {
                    let js = format!("window.location.replace({:?})", retry_url);
                    let _ = main.eval(&js);
                }
                next_retry += 1;
            }
            if elapsed >= TOTAL_MS {
                break; // 最坏 5 秒，强制进入
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        // 收遮罩 + 显主窗口（无论成功与否）
        if let Some(splash) = handle.get_webview_window("splash") {
            let _ = splash.close();
        }
        if let Some(main) = handle.get_webview_window("main") {
            let _ = main.show();
        }
    });
}

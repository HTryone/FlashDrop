// ArkPulse 安卓原生桥接插件（独立 crate）。
//
// 设计铁律（项目纪律）：新原生能力必须进独立插件，否则 `tauri android` 重新生成会覆盖原生代码。
// 下列命令的「真实实现」在安卓端由 Kotlin（android/src/.../ArkPulseAndroidFsPlugin.kt）接管 IPC；
// Rust 侧命令体仅在桌面构建下注册（移动端不注册 Rust handler，由 Kotlin @Command 接管）。
// 桌面端这些能力无意义，返回明确错误，且全部由前端 `isPhone()` 守卫，PC 永不触发。

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

// 签名与 Kotlin @Command 对齐：name 必填；relative_path（子目录）/ bytes（base64 直写）可选。
// 桌面板为 stub，PC 永不触发（前端 isPhone() 守卫）。
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn mediastore_insert(
    _name: String,
    _relative_path: Option<String>,
    _bytes: Option<String>,
) -> Result<String, String> {
    Err("仅支持 Android".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn saf_create_child(_tree_uri: String, _name: String) -> Result<String, String> {
    Err("仅支持 Android".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn saf_take_permission(_tree_uri: String) -> Result<(), String> {
    Err("仅支持 Android".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn show_save_dialog(_title: String, _message: String) -> Result<(), String> {
    Err("仅支持 Android".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn set_keep_screen_on(_enabled: bool) -> Result<(), String> {
    Err("仅支持 Android".into())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::new("arkpulse-android-fs");

    // Android 走 Kotlin 插件；桌面注册 Rust stub 供统一前缀调试。
    #[cfg(not(target_os = "android"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        mediastore_insert,
        saf_create_child,
        saf_take_permission,
        show_save_dialog,
        set_keep_screen_on
    ]);

    builder
        .setup(|_app, _api| {
            // 注册 Kotlin 插件类，使 PluginManager 能路由 IPC 到 @Command 方法。
            // 包名 + 类名必须与 ArkPulseAndroidFsPlugin.kt 的 package/class 完全一致。
            #[cfg(target_os = "android")]
            _api.register_android_plugin(
                "com.arkpulse.arkpulseandroidfs",
                "ArkPulseAndroidFsPlugin",
            )?;
            Ok(())
        })
        .build()
}

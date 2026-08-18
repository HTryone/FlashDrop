// ArkPulse 安卓原生桥接插件（独立 crate）。
//
// 设计铁律（项目纪律）：新原生能力必须进独立插件，否则 `tauri android` 重新生成会覆盖原生代码。
// 下列命令的「真实实现」在安卓端由 Kotlin（android/src/.../ArkPulseAndroidFsPlugin.kt）接管 IPC；
// Rust 侧命令体在桌面构建下编译但不会被调用（移动端路由到 Kotlin @Command）。
// 桌面端这些能力无意义，返回明确错误，且全部由前端 `isAndroid()` 守卫，PC 永不触发。

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

// 签名与 Kotlin @Command 对齐：name 必填；relative_path（子目录）/ bytes（base64 直写）可选。
// 桌面板为 stub，PC 永不触发（前端 isPhone() 守卫）。
#[tauri::command]
fn mediastore_insert(
    _name: String,
    _relative_path: Option<String>,
    _bytes: Option<String>,
) -> Result<String, String> {
    Err("仅支持 Android".into())
}

#[tauri::command]
fn saf_create_child(_tree_uri: String, _name: String) -> Result<String, String> {
    Err("仅支持 Android".into())
}

#[tauri::command]
fn saf_take_permission(_tree_uri: String) -> Result<(), String> {
    Err("仅支持 Android".into())
}

#[tauri::command]
fn show_save_dialog(_title: String, _message: String) -> Result<(), String> {
    Err("仅支持 Android".into())
}

#[tauri::command]
fn set_keep_screen_on(_enabled: bool) -> Result<(), String> {
    Err("仅支持 Android".into())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("arkpulse-android-fs")
        .invoke_handler(tauri::generate_handler![
            mediastore_insert,
            saf_create_child,
            saf_take_permission,
            show_save_dialog,
            set_keep_screen_on
        ])
        .build()
}

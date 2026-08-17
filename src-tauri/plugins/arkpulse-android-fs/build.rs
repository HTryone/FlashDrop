// Tauri v2 插件权限清单生成器。
// 必须在插件 crate 内放置 build.rs 并依赖 tauri-plugin（build feature），
// 否则主工程 tauri_build::build() 无法发现 arkpulse-android-fs:* 权限，
// capabilities 中引用这些权限会 panic（Permission ... not found）。
// 插件名取自 CARGO_PKG_NAME；命令列表需与 lib.rs 注册的命令一致。
fn main() {
    tauri_plugin::Builder::new(&[
        "mediastore_insert",
        "saf_create_child",
        "saf_take_permission",
        "show_save_dialog",
        "set_keep_screen_on",
    ])
    .android_path("android")
    .build();
}

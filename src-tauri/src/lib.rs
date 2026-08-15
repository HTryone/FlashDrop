// 应用装配层（类比前端 main.ts）：只做「装配」——注册插件、托管状态、挂载命令处理器。
// 业务逻辑全部下沉到 file_writer / path_resolver / state 等核心模块，本文件不写业务。
mod commands;
mod file_writer;
mod path_resolver;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::write_chunk,
            commands::close_file,
            commands::abort_file,
            commands::resolve_save_path,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

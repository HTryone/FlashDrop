#![cfg_attr(not(any(debug_assertions, test)), windows_subsystem = "windows")]
// 桌面端入口：仅调用 lib 中的 run()。核心装配在 lib.rs（类比前端 main.ts）。

fn main() {
    app_lib::run();
}

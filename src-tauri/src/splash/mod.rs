// 壳层启动页模块登记。业务逻辑见 loader.rs，本文件只做模块登记与重导出（§1.6 死纪律）。
pub mod loader;

pub use loader::startup_url;

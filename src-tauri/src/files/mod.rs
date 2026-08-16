// 文件 IO 核心逻辑集合（类比前端 .ts 核心层）：落盘写入 + 保存路径解析。
// 命令层 commands 只做透传，业务逻辑全部下沉到这里。
pub mod file_writer;
pub mod path_resolver;

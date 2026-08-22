// Tauri 接入层：Rust 后端接管落盘，绕过 FSA 不兼容。
// 安卓三级级联：L1 MediaStore → L2 std::fs 探针 → L3 持久 SAF → 绝对兜底逐文件 SAF。
// 桌面端直写 std::fs，用户可在 App 内修改默认下载目录。
//
// 本文件已拆分为 ./writers/ 子模块（shared / file-writer / saf-writer / factory / sinks / index），
// 此处仅作 barrel 再导出，保持现有导入方（filesink.ts、p2p/sinks.ts）零改动。
export { isTauriEnv } from './env';
export * from './writers';

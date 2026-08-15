// 核心路径解析（类比前端 .ts 核心）：生成不重名的保存路径。
// 浏览器 FSA 由系统保证唯一；Rust 直写需自行处理「目标已存在」冲突。
use std::path::Path;

/// 在目录 dir 下，基于 name 生成不冲突的最终路径；已存在则追加 (1) (2) …
pub fn resolve_save_path(dir: &str, name: &str) -> String {
    let base = Path::new(dir);
    let candidate = base.join(sanitize(name));
    if !candidate.exists() {
        return candidate.to_string_lossy().to_string();
    }
    let stem = candidate
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    let ext = candidate
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let mut i = 1;
    loop {
        let candidate = base.join(format!("{stem} ({i}){ext}"));
        if !candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
        i += 1;
    }
}

/// 去除文件名中的路径分隔符与非法字符（Windows/Unix 通用），避免路径穿越。
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

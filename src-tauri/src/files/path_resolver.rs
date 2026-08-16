// 核心路径解析（类比前端 .ts 核心）：生成不重名的保存路径，并确认目标目录真实可写。
// 浏览器 FSA 由系统保证唯一；Rust 直写需自行处理「目标已存在」冲突。
use std::path::Path;

/// 在目录 dir 下，基于 name 生成不冲突的最终路径；已存在则追加 (1) (2) …
///
/// 返回 Err 的语义是「此目录不可用」，前端据此走 SAF 兜底（安卓未取得「全部文件访问」权限时）。
/// 旧版返回 String 永不失败且不建目录 → 前端拿到一个父目录不存在/无权限的路径，
/// 后续 open_file 必失败，而 SAF 兜底分支永远不会被触发。
pub fn resolve_save_path(dir: &str, name: &str) -> Result<String, String> {
    let base = Path::new(dir);
    ensure_writable_dir(base)?;
    let candidate = base.join(sanitize(name));
    if !candidate.exists() {
        return Ok(candidate.to_string_lossy().to_string());
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
            return Ok(candidate.to_string_lossy().to_string());
        }
        i += 1;
    }
}

/// 确认目录存在且真的能写入：先递归创建，再落一个探针文件后删除。
///
/// 只靠 create_dir_all 不足以判定可写——目录已存在时它直接返回 Ok，
/// 而安卓「全部文件访问」权限被撤销后目录仍在、写入却会 EACCES。探针写入是确定性判据。
fn ensure_writable_dir(base: &Path) -> Result<(), String> {
    std::fs::create_dir_all(base).map_err(|e| format!("目标目录无法创建: {e}"))?;
    let probe = base.join(".arkpulse-write-probe");
    std::fs::write(&probe, b"0").map_err(|e| format!("目标目录不可写: {e}"))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 不重名时原样返回() {
        let dir = std::env::temp_dir().join("fd-test-a");
        let p = resolve_save_path(dir.to_str().unwrap(), "x.bin").unwrap();
        assert!(p.ends_with("x.bin"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 重名时追加序号() {
        let dir = std::env::temp_dir().join("fd-test-b");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("y.bin"), b"1").unwrap();
        let p = resolve_save_path(dir.to_str().unwrap(), "y.bin").unwrap();
        assert!(p.ends_with("y (1).bin"), "实际: {p}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 探针文件不残留() {
        let dir = std::env::temp_dir().join("fd-test-c");
        resolve_save_path(dir.to_str().unwrap(), "z.bin").unwrap();
        assert!(!dir.join(".arkpulse-write-probe").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

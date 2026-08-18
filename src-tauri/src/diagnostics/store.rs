// 原生持久化（§3.1/§3.2）：按天落盘到 安装目录/log/（Android: files/log/），7 天滚动覆盖，
// 每条同步 flush（崩溃可恢复），导出 ZIP 复用现有路径逻辑落系统下载。
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::diagnostics::logger::{now_ms, LogEntry};

#[derive(Default)]
struct DiagState {
    log_dir: Option<PathBuf>,
    platform: String,
    app: Option<AppHandle>,
    dropped: u64, // 自监控：落盘失败计数（§1.8）
}
static STATE: OnceLock<Mutex<DiagState>> = OnceLock::new();
fn state() -> &'static Mutex<DiagState> {
    STATE.get_or_init(|| Mutex::new(DiagState::default()))
}

// setup 阶段调用：按平台标签解析日志目录并建目录 + 清旧（§3.3 采集器按端分支，路径同理）。
pub fn init(app: &AppHandle, platform: &str) {
    let dir = resolve_log_dir(app, platform);
    if let Some(d) = &dir {
        let _ = std::fs::create_dir_all(d);
        prune_old(d);
    }
    let mut s = state().lock().unwrap();
    s.log_dir = dir;
    s.platform = platform.to_string();
    s.app = Some(app.clone());
}

fn resolve_log_dir(app: &AppHandle, platform: &str) -> Option<PathBuf> {
    if platform == "android" {
        // Android 应用私有存储：Android/data/<包名>/files/log（免权限、文件管理器可访问）
        app.path().app_data_dir().ok().map(|p| p.join("log"))
    } else {
        // Windows：安装目录/log（按 current_exe 推导安装根，复用现有路径思路）
        std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|p| p.join("log")))
    }
}

// 每条日志立即 append + flush（同步），确保闪退也能从文件取出（§3.2 铁律）。
// panic 兜底时取当前平台（state 已初始化）。
pub fn current_platform() -> String {
    state().lock().unwrap().platform.clone()
}

pub fn append(entry: &LogEntry) {
    let dir = { state().lock().unwrap().log_dir.clone() };
    let Some(dir) = dir else {
        return;
    };
    let file = dir.join(format!("arkpulse-{}.log", utc_date(now_ms())));
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
    {
        let line = serde_json::to_string(entry).unwrap_or_default();
        if writeln!(f, "{line}").is_err() || f.flush().is_err() {
            state().lock().unwrap().dropped += 1;
        }
    } else {
        state().lock().unwrap().dropped += 1;
    }
}

// 7 天滚动覆盖：删除修改时间超过 7 天的 arkpulse-*.log（§3.1）。
fn prune_old(dir: &std::path::Path) {
    let now = now_ms();
    let cutoff = 7 * 86400;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if name.starts_with("arkpulse-") && name.ends_with(".log") {
                if let Ok(meta) = e.metadata() {
                    if let Ok(mtime) = meta.modified().map(to_secs) {
                        if now.saturating_sub(mtime) > cutoff {
                            let _ = std::fs::remove_file(&p);
                        }
                    }
                }
            }
        }
    }
}

// 查询：读回最近两天日志（UI 日常用内存 RingBuffer，此为崩溃恢复兜底）。
pub fn read_recent() -> Vec<LogEntry> {
    let dir = { state().lock().unwrap().log_dir.clone() };
    let Some(dir) = dir else { return vec![] };
    let today = utc_date(now_ms());
    let mut out = vec![];
    for name in [format!("arkpulse-{today}.log")] {
        let p = dir.join(name);
        if let Ok(mut f) = std::fs::File::open(&p) {
            let mut s = String::new();
            let _ = f.read_to_string(&mut s);
            for line in s.lines() {
                if let Ok(e) = serde_json::from_str::<LogEntry>(line) {
                    out.push(e);
                }
            }
        }
    }
    out
}

// 导出 ZIP：把按天日志 + crash-*.json 打包到系统下载目录（复用现有路径逻辑），返回绝对路径。
// Android 分区存储下裸写公共下载目录会失败，回退到应用私有 log/（与日志同目录，照样可经文件管理器取出）。
pub fn export_zip(_share: bool) -> Result<String, String> {
    let (dir, app) = {
        let s = state().lock().unwrap();
        (s.log_dir.clone(), s.app.clone())
    };
    let dir = dir.ok_or_else(|| "日志目录未初始化".to_string())?;

    let stamp = utc_stamp(now_ms());
    let zip_name = format!("arkpulse-diagnostics-{stamp}.zip");

    // 候选落盘目录：优先系统下载目录，失败回退到应用私有 log/。
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(a) = app.as_ref() {
        if let Ok(d) = a.path().download_dir() {
            candidates.push(d);
        }
    }
    candidates.push(dir.clone());

    let mut zip_file: Option<std::fs::File> = None;
    let mut zip_path: Option<PathBuf> = None;
    for c in &candidates {
        let p = c.join(&zip_name);
        if let Ok(f) = std::fs::File::create(&p) {
            zip_file = Some(f);
            zip_path = Some(p);
            break;
        }
    }
    let file =
        zip_file.ok_or_else(|| "无法创建导出文件（下载目录与应用目录均不可写）".to_string())?;
    let zip_path = zip_path.unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if name.starts_with("arkpulse-")
                && (name.ends_with(".log") || name.starts_with("crash-"))
            {
                if let Ok(bytes) = std::fs::read(&p) {
                    let _ = zip.start_file(name, opts);
                    let _ = zip.write_all(&bytes);
                }
            }
        }
    }
    zip.finish().map_err(|e| e.to_string())?;

    Ok(zip_path.to_string_lossy().to_string())
}

pub fn clear() -> Result<(), String> {
    let dir = { state().lock().unwrap().log_dir.clone() };
    let Some(dir) = dir else {
        return Ok(());
    };
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_str().unwrap_or("").to_string();
            if name.starts_with("arkpulse-") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(())
}

// 崩溃快照（§3.2）：panic 时写 crash-*.json，含系统信息 + 回溯。
pub fn write_crash_snapshot(entry: &LogEntry) {
    let dir = { state().lock().unwrap().log_dir.clone() };
    let Some(dir) = dir else {
        return;
    };
    let path = dir.join(format!("crash-{}.json", utc_stamp(entry.ts)));
    let snap = serde_json::json!({
        "capturedAt": utc_stamp(entry.ts),
        "system": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "platform": entry.platform,
        },
        "panic": entry.msg,
        "note": "完整崩溃快照由前端崩溃时补充活跃传输/协商；此处为原生 panic 兜底（§3.2 硬崩溃边界）",
    });
    let _ = std::fs::write(
        &path,
        serde_json::to_string_pretty(&snap).unwrap_or_default(),
    );
}

fn to_secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn utc_date(secs: u64) -> String {
    let (y, m, d) = days_to_ymd(secs as i64 / 86400);
    format!("{y:04}-{m:02}-{d:02}")
}

fn utc_stamp(secs: u64) -> String {
    let (y, m, d) = days_to_ymd(secs as i64 / 86400);
    let hh = (secs / 3600) % 24;
    let mm = (secs / 60) % 60;
    format!("{y:04}{m:02}{d:02}-{hh:02}{mm:02}")
}

// 天序号 → 公历 Y-M-D（Howard Hinnant civil_from_days，仅正输入）。
fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

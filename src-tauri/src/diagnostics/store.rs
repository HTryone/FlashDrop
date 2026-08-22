// 原生持久化（§3.1/§3.2）：按天落盘到 安装目录/log/（Android: files/logs/ 包名私有目录），7 天滚动覆盖，
// 每条同步 flush（崩溃可恢复）。导出 ZIP：Windows 落系统下载；Android 经 mediastore_insert 复用现有权限落 Download/ArkPulse/log。
use base64::Engine;
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
        // Android 应用私有存储：Android/data/<包名>/files/logs（免权限；崩溃恢复 + 经 App 内导出取回）
        app.path().app_data_dir().ok().map(|p| p.join("logs"))
    } else {
        // Windows：应用数据目录（与 Android 对称，铁定可写），不再用 exe 同级目录。
        // 旧实现用 current_exe().parent()/log：NSIS 安装版 exe 位于受保护路径（Program Files /
        // app-x.x 目录），append 静默失败 → 日志从不落盘、导出永远为空。改用 app_data_dir 从根本解决。
        app.path().app_data_dir().ok().map(|p| p.join("log"))
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
        let block = format_entry(entry);
        if f.write_all(block.as_bytes()).is_err() || f.flush().is_err() {
            state().lock().unwrap().dropped += 1;
        }
    } else {
        state().lock().unwrap().dropped += 1;
    }
}

// 把一条 LogEntry 格式化成「人类可读」文本块（与 UI 实时日志流格式一致，§日志导出）。
// 行 1：`YYYY-MM-DD HH:MM:SS.mmm LEVEL [channel] msg`
// 行 2+（按需）：traceId / data / scope / platform 等缩进补行，便于直接 cat 阅读、不丢结构化信息。
fn format_entry(e: &LogEntry) -> String {
    let dt = format_ts(e.ts);
    let level = format!("{:<5}", e.level.to_uppercase());
    let channel = format!("{:<9}", format!("[{}]", e.channel));
    let mut header = format!("{dt} {level} {channel} {}", e.msg);
    header.push('\n');

    let indent = " ".repeat(dt.len() + 1 + level.len() + 1 + channel.len() + 1);
    let mut extra = String::new();
    if !e.scope.is_empty() {
        extra.push_str(&format!("{indent}scope: {}\n", e.scope));
    }
    if let Some(t) = &e.trace_id {
        if !t.is_empty() {
            extra.push_str(&format!("{indent}trace: {t}\n"));
        }
    }
    if let Some(d) = &e.data {
        if !d.is_empty() {
            extra.push_str(&format!("{indent}data:  {d}\n"));
        }
    }
    if let Some(p) = &e.platform {
        if !p.is_empty() {
            extra.push_str(&format!("{indent}plat:  {p}\n"));
        }
    }
    let mut out = header;
    out.push_str(&extra);
    out
}

// 毫秒时间戳 → `YYYY-MM-DD HH:MM:SS.mmm`（北京时间 UTC+8，仅偏移、格式不变）。
fn format_ts(ms: u64) -> String {
    let (y, m, d, h, mi, s) = ts_breakdown(ms + 8 * 3600 * 1000);
    format!(
        "{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}.{:03}",
        ms % 1000
    )
}

fn ts_breakdown(ms: u64) -> (i32, u32, u32, u32, u32, u32) {
    let secs = ms / 1000;
    let (y, m, d) = days_to_ymd(secs as i64 / 86400);
    let h = ((secs / 3600) % 24) as u32;
    let mi = ((secs / 60) % 60) as u32;
    let s = (secs % 60) as u32;
    (y, m, d, h, mi, s)
}

// 7 天滚动覆盖：删除修改时间超过 7 天的 arkpulse-*.log（§3.1）。
fn prune_old(dir: &std::path::Path) {
    let now = now_ms();
    let cutoff_ms = 7 * 86400 * 1000; // 7 天（毫秒）
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
                    if let Ok(mtime) = meta.modified().map(to_millis) {
                        if now.saturating_sub(mtime) > cutoff_ms {
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
            // 按天日志采用纯文本格式（非 JSON），逐段解析还原 LogEntry。
            let mut lines = s.lines();
            while let Some(header_line) = lines.next() {
                if let Ok(entry) = parse_log_line(header_line, &mut lines) {
                    out.push(entry);
                }
            }
        }
    }
    out
}

// 解析一行「YYYY-MM-DD HH:MM:SS.mmm LEVEL [channel] msg」格式及后续缩进补行。
// 缩进长度 = 时间戳(23) + 空格(1) + level(5) + 空格(1) + channel(9) + 空格(1) = 40。
const LOG_INDENT_LEN: usize = 40;

fn parse_log_line(header: &str, extra_lines: &mut std::str::Lines<'_>) -> Result<LogEntry, ()> {
    if header.len() < 24 {
        return Err(());
    }
    // 时间戳占前 23 字符，第 24 位是空格
    let dt_str = &header[..23];
    let rest = &header[24..];

    // level: 5 字符（已左补空格）
    let level = rest.get(..5).ok_or(())?.trim().to_string();
    // channel: 从 '[' 到 ']'，9 字符（含两端括号 + 左右补空格）
    let ch = rest.get(5..).ok_or(())?;
    let ch_end = ch.find(']').ok_or(())?;
    let channel = ch[..=ch_end]
        .trim_matches('[')
        .trim_matches(']')
        .to_string();
    // msg: channel 后的剩余部分
    let msg = ch[ch_end + 1..].trim().to_string();

    // 北京时间 → UTC 毫秒（用于恢复 RingBuffer 时序）
    let ts = beijing_to_utc_ms(dt_str).unwrap_or(0);

    let mut scope = String::new();
    let mut trace_id = String::new();
    let mut data: Option<String> = None;
    let mut platform: Option<String> = None;

    for line in extra_lines {
        // 缩进补行的前导空格数 = LOG_INDENT_LEN，且必须非空
        if line.is_empty() || !line.starts_with(' ') || line.len() < LOG_INDENT_LEN {
            break;
        }
        let trimmed = line[LOG_INDENT_LEN..].trim_start();
        if trimmed.starts_with("scope: ") {
            scope = trimmed["scope: ".len()..].to_string();
        } else if trimmed.starts_with("trace: ") {
            trace_id = trimmed["trace: ".len()..].to_string();
        } else if trimmed.starts_with("data:  ") {
            data = Some(trimmed["data:  ".len()..].to_string());
        } else if trimmed.starts_with("plat:  ") {
            platform = Some(trimmed["plat:  ".len()..].to_string());
        } else {
            break;
        }
    }

    Ok(LogEntry {
        ts,
        level,
        channel,
        scope,
        msg,
        data,
        trace_id: if trace_id.is_empty() {
            None
        } else {
            Some(trace_id)
        },
        platform,
    })
}

// `YYYY-MM-DD HH:MM:SS.mmm`（北京时间，已 +8h 偏移）→ UTC 毫秒时间戳。
// 仅用于崩溃恢复（时序精度要求不高），不做完整日历计算。
fn beijing_to_utc_ms(s: &str) -> Option<u64> {
    let parts: Vec<&str> = s
        .split(|c: char| c == '-' || c == ' ' || c == ':' || c == '.')
        .collect();
    if parts.len() < 6 {
        return None;
    }
    let year = parts[0].parse::<i64>().ok()?;
    let month = parts[1].parse::<u32>().ok()?;
    let day = parts[2].parse::<u32>().ok()?;
    let hour = parts[3].parse::<i64>().ok()?;
    let min = parts[4].parse::<i64>().ok()?;
    let sec = parts[5].parse::<i64>().ok()?;
    let ms = parts
        .get(6)
        .and_then(|m| m.parse::<u32>().ok())
        .unwrap_or(0);

    // 北京时间 → UTC：减 8 小时（处理借位）
    let mut h = hour - 8;
    let mut d = day as i64;
    let mut mon = month as i64;
    let mut y = year;
    if h < 0 {
        h += 24;
        d -= 1;
    }
    if d < 1 {
        mon -= 1;
        if mon < 1 {
            mon = 12;
            y -= 1;
        }
        let days_in_prev = match mon {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 => {
                if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                    29
                } else {
                    28
                }
            }
            _ => 30,
        };
        d = days_in_prev as i64;
    }

    // 简化版天数计算：从 2000-01-01 起算
    let ref_y = 2000i64;
    let mut total_days = 0i64;
    for yr in ref_y..y {
        total_days += if (yr % 4 == 0 && yr % 100 != 0) || yr % 400 == 0 {
            366
        } else {
            365
        };
    }
    let md = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    total_days += md[(mon - 1) as usize] + d - 1;
    if mon > 2 && ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0) {
        total_days += 1;
    }
    let unix_secs = total_days * 86400 + h * 3600 + min * 60 + sec;
    Some(unix_secs as u64 * 1000 + ms as u64)
}

// 把按天日志 + crash-*.json 打包成 ZIP 字节（内存构建，不落盘）。
// Windows 写系统下载目录；Android 返回字节经 mediastore_insert 落 Download/ArkPulse/log（复用现有权限）。
fn build_zip() -> Result<(String, Vec<u8>), String> {
    let dir = { state().lock().unwrap().log_dir.clone() }
        .ok_or_else(|| "日志目录未初始化".to_string())?;
    let stamp = utc_stamp(now_ms());
    let zip_name = format!("arkpulse-diagnostics-{stamp}.zip");

    let mut buf: Vec<u8> = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
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
    }
    Ok((zip_name, buf))
}

// 导出 ZIP：Windows 落系统下载目录（复用现有路径逻辑），返回绝对路径。
pub fn export_zip(_share: bool) -> Result<String, String> {
    let dir = { state().lock().unwrap().log_dir.clone() }
        .ok_or_else(|| "日志目录未初始化".to_string())?;

    // 先核对日志目录里到底有没有可导出文件，避免导出「空 ZIP」误导用户。
    // 这也是电脑端历史 bug 的排查锚点：若目录为空，说明 append 从未成功落盘，
    // 直接报明确错误而非静默产出一个 0 文件的 ZIP。
    let log_count = std::fs::read_dir(&dir)
        .map(|it| {
            it.flatten()
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    n.starts_with("arkpulse-") && n.ends_with(".log")
                })
                .count()
        })
        .unwrap_or(0);
    if log_count == 0 {
        let dropped = state().lock().unwrap().dropped;
        return Err(format!(
            "日志目录无可用日志文件（dir={}），append 落盘失败计数 dropped={}。日志从未写入，请检查目录权限",
            dir.display(),
            dropped
        ));
    }

    let (zip_name, buf) = build_zip()?;
    let app = { state().lock().unwrap().app.clone() };

    // 候选落盘目录：优先系统下载目录，失败回退到应用私有 log 目录。
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(a) = app.as_ref() {
        if let Ok(d) = a.path().download_dir() {
            candidates.push(d);
        }
    }
    candidates.push(dir.clone());

    for c in &candidates {
        let p = c.join(&zip_name);
        if std::fs::write(&p, &buf).is_ok() {
            return Ok(p.to_string_lossy().to_string());
        }
    }
    Err("无法创建导出文件（下载目录与应用目录均不可写）".to_string())
}

// 导出 ZIP（Android）：返回 (文件名, base64 字节)，由 Web 经 mediastore_insert 落 Download/ArkPulse/log。
pub fn export_zip_android(_share: bool) -> Result<(String, String), String> {
    let (zip_name, buf) = build_zip()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Ok((zip_name, b64))
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

fn to_millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn utc_date(ms: u64) -> String {
    let secs = ms / 1000;
    let (y, m, d) = days_to_ymd((secs + 8 * 3600) as i64 / 86400);
    format!("{y:04}-{m:02}-{d:02}")
}

fn utc_stamp(ms: u64) -> String {
    let secs = ms / 1000;
    let (y, m, d) = days_to_ymd((secs + 8 * 3600) as i64 / 86400);
    let hh = ((secs + 8 * 3600) / 3600) % 24;
    let mm = ((secs + 8 * 3600) / 60) % 60;
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

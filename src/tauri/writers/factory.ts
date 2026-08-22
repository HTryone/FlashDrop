// 路径解析 + 写入器工厂：选保存位置（桌面对话框 / 安卓三级级联），构造对应写入器。
import { invoke } from '@tauri-apps/api/core';
import { save, open } from '@tauri-apps/plugin-dialog';
import { downloadDir, join } from '@tauri-apps/api/path';
import { beginDownload } from '../notify';
import type { SaveTarget, AnyTauriWriter } from './shared';
import {
  isAndroid,
  isContentUri,
  getDefaultSaveDir,
  setDefaultSaveDir,
  parentDir,
  androidBaseDir,
  tryResolveFs,
} from './shared';
import { TauriFileWriter } from './file-writer';
import { TauriSafWriter } from './saf-writer';
import { TauriSafStreamWriter } from './saf-stream-writer';
import { isX3StreamEnabled } from './shared';

// 中转：桌面弹系统保存对话框；安卓优先落系统下载目录（需 MANAGE 权限），失败走 SAF 每次选文件。
export async function tauriPickSavePath(name: string): Promise<SaveTarget | null> {
  if (isAndroid()) {
    // L1 MediaStore：固定 Download/ArkPulse，零权限零弹框（现代设备一锤定音）。
    // ⚠️ Kotlin 插件返回 JSObject {uri: "content://..."}，不可用 invoke<string>：
    //   invoke<string> 期望纯字符串，收到 JSObject 后会当 path 喂给 open_file →
    //   'invalid type: map, expected a string' 报错，下载秒挂。
    //   正确写法：invoke<{uri: string}>().then(r => r.uri)。
    try {
      const res = await invoke<{ uri: string }>('plugin:arkpulse-android-fs|mediastore_insert', { name });
      const uri = res.uri;
      beginDownload();
      return { kind: 'mediastore', uri };
    } catch {
      // L2 std::fs 探针直写（宽松 ROM / 老设备兜底）。
      try {
        const path = await tryResolveFs(name);
        setDefaultSaveDir(await androidBaseDir());
        beginDownload();
        return { kind: 'fs', path };
      } catch {
        // L3 兜底：SAF 逐文件选择器（每文件一次）。
        const uri = await save({
          title: '保存文件（未授权“全部文件访问”，请手动选择）',
          defaultPath: name,
        });
        if (!uri) return null;
        beginDownload();
        return { kind: 'saf', uri };
      }
    }
  }
  // 桌面默认落「下载目录」，不再弹保存框（用户可在 App 内改默认位置）。
  // 拿不到下载目录 / 该目录不可写时，才退回系统保存框兜底。
  const dir = (await getDefaultSaveDir()) || (await downloadDir().catch(() => '' as string));
  if (dir) {
    try {
      const finalPath = await invoke<string>('resolve_save_path', [dir, name] as any);
      setDefaultSaveDir(dir);
      return { kind: 'fs', path: finalPath };
    } catch {
      // 落到下方对话框兜底
    }
  }
  const defaultPath = dir ? await join(dir, name).catch(() => name) : name;
  // 注：join 失败时用原名兜底（上一行已处理），此处无需再 catch
  const picked = await save({ title: '保存文件', defaultPath });
  if (!picked) return null;
  // 兜底防御：任何平台上对话框若返回 content:// / file:// URI，一律走 SAF 写入器。
  // std::fs 打不开 URI，误当路径会让下载在第一次写入就失败（且错误常被误判成网络问题）。
  if (isContentUri(picked)) return { kind: 'saf', uri: picked };
  setDefaultSaveDir(parentDir(picked)); // 记住本次所在目录
  return { kind: 'fs', path: picked };
}

// 本地直传多文件 / P2P：桌面弹选文件夹对话框；安卓优先返回系统下载目录（需 MANAGE 权限），
// 失败返回 null，由 tauriBuildWriters 退化为逐文件 SAF 兜底。
export async function tauriPickSaveDir(): Promise<string | null> {
  if (isAndroid()) {
    try {
      const dir = await androidBaseDir();
      // 探测真实可写（Rust 侧 create_dir_all + 写探针）：无「全部文件访问」权限时抛错走 SAF。
      await invoke<string>('resolve_save_path', [dir, '.probe'] as any);
      setDefaultSaveDir(dir);
      return dir;
    } catch {
      return null; // 交给 tauriBuildWriters 走 SAF 逐文件
    }
  }
  // 桌面默认落「下载目录」，不再弹选文件夹框（用户可在 App 内改默认位置）。
  // 拿不到下载目录 / 该目录不可写时，才退回系统选文件夹框兜底。
  const saved = await getDefaultSaveDir();
  const dir = saved || (await downloadDir().catch(() => '' as string));
  if (dir) {
    try {
      await invoke<string>('resolve_save_path', [dir, '.probe'] as any);
      setDefaultSaveDir(dir);
      return dir;
    } catch {
      // 落到下方对话框兜底
    }
  }
  const picked = (await open({
    directory: true,
    title: '选择保存文件夹',
    defaultPath: saved || undefined,
  })) as unknown as string | null;
  if (picked) setDefaultSaveDir(picked);
  return picked ?? null;
}

// 统一构造多文件写入器（级联：L1 MediaStore → L2 std::fs → L3 持久 SAF → 绝对兜底逐文件 SAF）。
// 安卓返回 { writers, targets }；targets 用于关闭时汇总保存位置文案。桌面沿用原 L2 目录直写。
// 供「本地直传多文件」（filesink.ts）与「P2P 多文件」（TauriP2PSink）共用。
export async function tauriBuildWriters(
  files: { name: string }[],
): Promise<{ writers: AnyTauriWriter[]; targets: SaveTarget[] }> {
  const sanitize = (n: string) => String(n).replace(/[\\/]/g, '_');

  // 桌面（含 web 经 FSA，但本函数仅 isTauriEnv 内调用）：原 L2 目录直写。
  if (!isAndroid()) {
    const dir = await tauriPickSaveDir();
    if (!dir) throw new Error('未选择保存目录');
    const targets = await Promise.all(
      files.map(async (f) => {
        const finalPath = await invoke<string>('resolve_save_path', [dir, sanitize(f.name)] as any);
        return { kind: 'fs', path: finalPath } as SaveTarget;
      }),
    );
    const writers = await Promise.all(
      targets.map(async (t) => {
        const w = new TauriFileWriter((t as { path: string }).path);
        await w.ensureOpen();
        return w;
      }),
    );
    return { writers, targets };
  }

  // L1 MediaStore：批量插入 Download/ArkPulse，零弹框。
  try {
    const targets = await Promise.all(
      files.map(async (f) => {
        const res = await invoke<{ uri: string }>('plugin:arkpulse-android-fs|mediastore_insert', { name: sanitize(f.name) });
        return { kind: 'mediastore', uri: res.uri } as SaveTarget;
      }),
    );
    const writers = targets.map((t) => new TauriSafWriter((t as { uri: string }).uri));
    beginDownload();
    return { writers, targets };
  } catch {
    // L2 std::fs 探针直写（宽松 ROM / 老设备）。
    try {
      const dir = await tauriPickSaveDir();
      if (dir) {
        const targets = await Promise.all(
          files.map(async (f) => {
            const finalPath = await invoke<string>('resolve_save_path', [dir, sanitize(f.name)] as any);
            return { kind: 'fs', path: finalPath } as SaveTarget;
          }),
        );
        const writers = await Promise.all(
          targets.map(async (t) => {
            const w = new TauriFileWriter((t as { path: string }).path);
            await w.ensureOpen();
            return w;
          }),
        );
        beginDownload();
        return { writers, targets };
      }
    } catch {
      /* 落 L3 */
    }
    // L3 持久化 SAF：首次选一次文件夹，之后零弹框。
    try {
      const treeUri = await tauriResolveSafDir();
      if (treeUri) {
        const targets = await Promise.all(
          files.map(async (f) => {
            // ⚠️ Kotlin 插件返回 JSObject {uri: "content://..."}，同 L1 坑，不可 invoke<string>。
            //   此处若用 invoke<string>，SAF 路径会触发相同 'invalid type: map' 错误。
            const res = await invoke<{ uri: string }>('plugin:arkpulse-android-fs|saf_create_child', { tree_uri: treeUri, name: sanitize(f.name) });
            return { kind: 'saf', uri: res.uri } as SaveTarget;
          }),
        );
        const writers = targets.map((t) => new TauriSafWriter((t as { uri: string }).uri));
        beginDownload();
        return { writers, targets };
      }
    } catch {
      /* 落绝对兜底 */
    }
    // 绝对兜底：逐文件 SAF 选位置（每文件一次提示）。
    const uris = await Promise.all(
      files.map((f) =>
        save({ title: '保存文件（未授权“全部文件访问”）', defaultPath: sanitize(f.name) }),
      ),
    );
    if (uris.some((u) => !u)) throw new Error('用户取消了保存');
    const targets = uris.map((u) => ({ kind: 'saf', uri: u as string }) as SaveTarget);
    const writers = targets.map((t) => new TauriSafWriter((t as { uri: string }).uri));
    beginDownload();
    return { writers, targets };
  }
}

// L3 持久化 SAF：首次选一次文件夹，之后零弹框。tree URI 存 localStorage 跨重启复用。
const SAF_TREE_KEY = 'arkpulse.safTreeUri';
async function tauriResolveSafDir(): Promise<string | null> {
  const saved = localStorage.getItem(SAF_TREE_KEY);
  if (saved) {
    try {
      await invoke('plugin:arkpulse-android-fs|saf_take_permission', { tree_uri: saved }); // 复权（重启后仍有效，失败即失效）
      return saved;
    } catch {
      localStorage.removeItem(SAF_TREE_KEY);
    }
  }
  const picked = (await open({
    directory: true,
    title: '选择保存文件夹（ArkPulse）',
  })) as unknown as string | null;
  if (!picked) return null;
  try {
    await invoke('plugin:arkpulse-android-fs|saf_take_permission', { tree_uri: picked });
    localStorage.setItem(SAF_TREE_KEY, picked);
    return picked;
  } catch {
    localStorage.removeItem(SAF_TREE_KEY);
    return null;
  }
}

// ── X3（P2P 专用，新增，不并入 L1/L2/L3）──
// 路径与 L1 完全相同（mediastore_insert 返回的 Download/ArkPulse uri），零弹框。
// 仅写盘方式不同：TauriSafStreamWriter 走 saf_stream_open/append/close（PFD FileChannel 流式）。
// 仅当 isX3StreamEnabled() 为 true 时由 TauriP2PSink 调用；关闭时 P2P 走原 tauriBuildWriters（L1）。
export async function tauriBuildP2PWritersX3(
  files: { name: string }[],
): Promise<{ writers: AnyTauriWriter[]; targets: SaveTarget[] }> {
  const sanitize = (n: string) => String(n).replace(/[\\/]/g, '_');
  if (!isAndroid()) {
    // 桌面无 X3 语义，直接复用原 L2 目录直写。
    return tauriBuildWriters(files);
  }
  // 安卓：L1 拿 uri（路径不变），写入器换成 X3 流式。
  try {
    const targets = await Promise.all(
      files.map(async (f) => {
        const res = await invoke<{ uri: string }>('plugin:arkpulse-android-fs|mediastore_insert', { name: sanitize(f.name) });
        return { kind: 'safstream', uri: res.uri } as SaveTarget;
      }),
    );
    const writers = targets.map((t) => new TauriSafStreamWriter((t as { uri: string }).uri));
    beginDownload();
    return { writers, targets };
  } catch {
    // X3 开句柄失败 → 退回原 L1（零弹框，行为与关闭开关一致）。
    return tauriBuildWriters(files);
  }
}

// 下载完成提示桥（全软件端渲染，无 Vue 横幅）：
//   - 成功：原生「确定」确认弹窗（写明保存位置，点确定才关）+ 系统通知栏（美化：标题 + 位置，tap 唤起 App）。
//   - 失败：仅释放亮屏，不弹窗、不发通知。
// 所有调用均包 try/catch 容错：弹窗/通知不可用（老壳缺命令、权限拒）绝不阻断下载主流程。
import { isPhone } from './client';
import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { setKeepScreenOn } from './android-keepalive';

// 下载开始：亮屏保活（仅安卓）。
export function beginDownload(): void {
  if (!isPhone()) return;
  setKeepScreenOn(true);
}

// 下载结束汇总。usedSaf=true 表示该批次走了 L3（用户自选文件夹），位置文案相应变化。
export async function finishDownload(
  success: boolean,
  opts: { usedSaf: boolean; count: number },
): Promise<void> {
  if (!isPhone()) return;
  if (success) {
    const root = opts.usedSaf ? '你选择的文件夹' : '下载/ArkPulse';
    const locText =
      opts.count > 1 ? `已下载 ${opts.count} 个文件到：${root}` : `已保存到：${root}`;
    const title = '下载完成';

    // 1) 原生确认弹窗（点「确定」才关，不自动消失）
    try {
      await invoke('show_save_dialog', { title, message: locText });
    } catch {
      /* 弹窗不可用：继续发系统通知 */
    }

    // 2) 系统通知栏（仅首次下载开始时请求 POST_NOTIFICATIONS；被拒则静默跳过）
    try {
      const granted = await isPermissionGranted();
      if (!granted) {
        const res = await requestPermission();
        if (res !== 'granted') {
          setKeepScreenOn(false);
          return;
        }
      }
      await sendNotification({ title, body: locText });
    } catch {
      /* 通知不可用：忽略，不影响主流程 */
    }
  }
  setKeepScreenOn(false);
}

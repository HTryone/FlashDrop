// 下载完成提示桥（全软件端渲染，无 Vue 横幅）：
//   - 成功：原生「确定」确认弹窗（写明保存位置，点确定才关）+ 系统通知栏（美化：标题 + 位置，tap 唤起 App）。
//   - 失败：仅释放亮屏，不弹窗、不发通知。
// 所有调用均包 try/catch 容错：弹窗/通知不可用（老壳缺命令、权限拒）绝不阻断下载主流程。
import { isPhone } from './client';
import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission, sendNotification, removeAllActive } from '@tauri-apps/plugin-notification';
import { setKeepScreenOn } from './android-keepalive';

// 撤回/清掉所有已弹出（常驻）通知，避免「上次成功的已保存」误导成「本次取消的结果」。
function clearNotifications(): void {
  if (!isPhone()) return;
  void removeAllActive().catch(() => {});
}

// 下载开始：亮屏保活（仅安卓）+ 清掉上一轮残留通知。
export function beginDownload(): void {
  if (!isPhone()) return;
  clearNotifications();
  setKeepScreenOn(true);
}

// 首次启动索要 POST_NOTIFICATIONS（仅安卓）。用 localStorage 去重：只问一次，拒绝也不再骚扰。
// 从 finishDownload 迁入——原本「首次下载成功时才弹系统授权」体验差（用户正收文件被打断）。
// 先弹原生说明框（复用 show_save_dialog）解释用途，点确定再触发系统授权；说明框不可用则直接要。
const NOTIF_ASKED_KEY = 'arkpulse.notifPermAsked';
export async function requestNotificationAtLaunch(): Promise<void> {
  if (!isPhone()) return;
  if (localStorage.getItem(NOTIF_ASKED_KEY)) return;
  try {
    await invoke('plugin:arkpulse-android-fs|show_save_dialog', { title: '开启通知', message: 'ArkPulse 需要通知权限，以便文件下载完成时在通知栏提醒你保存位置。' });
  } catch {
    /* 说明框不可用：直接走系统授权 */
  }
  try {
    const granted = await isPermissionGranted();
    if (!granted) await requestPermission();
  } catch {
    /* 通知非必需，忽略 */
  } finally {
    localStorage.setItem(NOTIF_ASKED_KEY, '1');
  }
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
      opts.count > 1 ? `已保存 ${opts.count} 个文件到：${root}` : `已保存：${root}`;
    const title = '下载完成';

    // 1) 原生确认弹窗（点「确定」才关，不自动消失）
    try {
      await invoke('plugin:arkpulse-android-fs|show_save_dialog', { title, message: locText });
    } catch {
      /* 弹窗不可用：继续发系统通知 */
    }

    // 2) 系统通知栏（POST_NOTIFICATIONS 已在首次启动索要，这里仅发送；未授权静默跳过）
    try {
      const granted = await isPermissionGranted();
      if (granted) await sendNotification({ title, body: locText });
    } catch {
      /* 通知不可用：忽略，不影响主流程 */
    }
  } else {
    clearNotifications(); // 取消/失败：清掉任何常驻的「已保存」通知，不误导
  }
  setKeepScreenOn(false);
}

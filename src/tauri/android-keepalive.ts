// 下载期间亮屏保活桥：调用安卓原生 set_keep_screen_on（Kotlin 对 Activity 窗口加/清 FLAG_KEEP_SCREEN_ON）。
// 仅安卓生效；桌面 isAndroid() 为 false 时直接 no-op，PC 零改动。
import { isPhone } from './client';
import { invoke } from '@tauri-apps/api/core';

export function setKeepScreenOn(on: boolean): void {
  if (!isPhone()) return;
  invoke('set_keep_screen_on', { enabled: on }).catch(() => {});
}

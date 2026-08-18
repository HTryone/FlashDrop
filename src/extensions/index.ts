// 扩展/导航注册表：右侧「更多」里的模块清单。
//
// 【自动发现】不再手写 import / 数组：本文件用 import.meta.glob 扫描
//   src/extensions/<任意文件夹>/meta.ts
// 自动收集所有模块。以后加模块 = 在 src/extensions/ 下新建一个文件夹 + 写 meta.ts，
// 完全不用改本文件。
//
// 展示顺序由每个 meta.ts 里的 order 决定（越小越靠前）。
// 「更多」打开先显示模块选择页（目录），不强制默认项；
// 「首页」不在此列，由顶栏 ✕ 关闭后回到主界面。
// 文档类模块(kind==='doc')内部自带二级目录(ModuleView)。
// 平台过滤：meta.ts 声明 platforms 时，仅在该平台出现（日志模块 = 原生专属，Web 不显示）。

import type { Extension } from './types';
import { isWindows, isPhone } from '../tauri/client';

const files = import.meta.glob<{ default: Extension }>('./*/meta.ts', { eager: true });

// 当前是否原生端（PC 桌面 + 安卓）。Web 浏览器 → 仅展示声明含 'web' 的模块。
const native = isWindows() || isPhone();

export const extensions: Extension[] = Object.values(files)
  .map((m) => m.default)
  .filter((e) => {
    if (!e.platforms || e.platforms.length === 0) return true; // 未声明 → 全平台
    if (native) return e.platforms.includes('windows') || e.platforms.includes('phone');
    return e.platforms.includes('web');
  })
  .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

export type { Extension, ExtensionKind } from './types';

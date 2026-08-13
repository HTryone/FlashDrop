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

import type { Extension } from './types';

const files = import.meta.glob<{ default: Extension }>('./*/meta.ts', { eager: true });

export const extensions: Extension[] = Object.values(files)
  .map((m) => m.default)
  .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

export type { Extension, ExtensionKind } from './types';

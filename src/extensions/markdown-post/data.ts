import type { DocItem } from '../types';

// 每篇正文存于 ./posts/<id>.md（Vite `?raw` 引入），避免 data.ts 体积膨胀。
// 新增/编辑文档：在 posts/ 下放 <id>.md，并在下方数组登记元数据即可。
const mdFiles = import.meta.glob('./posts/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function loadMarkdown(id: string): string {
  const key = Object.keys(mdFiles).find((k) => k.includes(`${id}.md`)) ?? '';
  return mdFiles[key] ?? '';
}

export const moduleId = 'posts';

export const docs: DocItem[] = [
  {
    id: 'doc-zw37y2',
    title: 'FlashDrop 扩展模块 · 今日总结（2026-08-13）',
    module: 'posts',
    updatedAt: '2026-08-13',
    markdown: loadMarkdown('doc-zw37y2'),
  },
  {
    id: 'doc-hfummk',
    title: '闪传项目工作记录（08-15 ）',
    module: 'posts',
    updatedAt: '2026-08-15',
    markdown: loadMarkdown('doc-hfummk'),
  },
  {
    id: 'doc-bftaxl',
    title: '闪云项目工作记录（2026-08-16 ～ 08-17 ）',
    module: 'posts',
    updatedAt: '2026-08-17',
    markdown: loadMarkdown('doc-bftaxl'),
  },
];

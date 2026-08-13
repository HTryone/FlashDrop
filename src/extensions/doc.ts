// 后端文档模块公共逻辑（前端只读展示）：取数 + markdown 渲染。
// 内容由本地 data.ts（文档生成器工具产出）或后端（Workers + DB）提供；前端只拉取并渲染。
// 扩展端口：fetchDocs(moduleId) 统一走可配置源，后期接 Workers + DB 只改此实现与数据源约定。
import type { DocItem } from './types';

// 本地模块数据（文档生成器工具产出的 data.ts）：有则优先使用，免去后端。
// 工具生成的模块放在 src/extensions/<id>/data.ts，导出 { moduleId, docs }。
const localModules = import.meta.glob('./*/data.ts', { eager: true }) as Record<
  string,
  { moduleId?: string; docs?: DocItem[] }
>;

// 数据源入口（扩展端口）：约定 /api/<moduleId>/docs.json 返回 DocItem[] 或 { docs: DocItem[] }。
// 后期接 Workers + DB 时只改这里（含排序/过滤规则），UI 不变。
const docSource = (moduleId: string) => `/api/${moduleId}/docs.json`;

export async function fetchDocs(moduleId: string): Promise<DocItem[]> {
  // 1) 优先本地数据（工具生成的模块自带 data.ts，丢进 src/extensions/<id>/ 即生效，无需后端）
  for (const mod of Object.values(localModules)) {
    if (mod.moduleId === moduleId && Array.isArray(mod.docs)) {
      return mod.docs
        .filter((d) => !d.module || d.module === moduleId)
        .sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''));
    }
  }
  // 2) fallback：后端 API（未生成本地数据时走这里，兼容原项目动态模块）
  try {
    const res = await fetch(docSource(moduleId), { cache: 'no-store' });
    if (!res.ok) return [];
    const data = (await res.json()) as DocItem[] | { docs: DocItem[] };
    const list = Array.isArray(data) ? data : data.docs ?? [];
    return list
      .filter((d) => !d.module || d.module === moduleId)
      .sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''));
  } catch {
    return [];
  }
}

// markdown → HTML 的轻量渲染（纯函数，先转义再格式化，防 XSS；覆盖常用子集：标题/图片/链接/列表/表格/引用/代码/分隔线/行内格式）。
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 防协议注入：仅放行 http(s)/相对路径/锚点/data:image
function safeUrl(u: string): string {
  return /^(https?:\/\/|\/|#|\.\/|\.\.\/|data:image\/)/i.test(u) ? u : '#';
}

function inline(s: string): string {
  s = escapeHtml(s);
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, u) => {
      const a = String(alt).replace(/"/g, '&quot;');
      return `<img src="${safeUrl(u)}" alt="${a}" />`;
    })
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => {
      const url = safeUrl(u);
      return u.startsWith('http')
        ? `<a href="${url}" target="_blank" rel="noopener">${t}</a>`
        : `<a href="${url}">${t}</a>`;
    });
}

function splitRow(l: string): string[] {
  return l
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}
function isTableRow(l: string): boolean {
  return /^\s*\|.*\|\s*$/.test(l);
}
function isTableSep(l: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-');
}

export function renderMarkdown(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let inCode = false;
  let i = 0;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const raw = lines[i];

    // 代码块
    if (/^```/.test(raw.trim())) {
      if (inCode) {
        out.push('</code></pre>');
        inCode = false;
      } else {
        closeList();
        out.push('<pre><code>');
        inCode = true;
      }
      i++;
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(raw));
      i++;
      continue;
    }

    // 表格（当前行为表头行且下一行是分隔行）
    if (isTableRow(raw) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const head = splitRow(raw)
        .map((c) => `<th>${inline(c)}</th>`)
        .join('');
      let j = i + 2;
      const body: string[] = [];
      while (j < lines.length && isTableRow(lines[j]) && lines[j].trim() !== '') {
        body.push(
          '<tr>' + splitRow(lines[j]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>',
        );
        j++;
      }
      out.push(
        `<table><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table>`,
      );
      i = j;
      continue;
    }

    // 标题 1-6 级
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const n = h[1].length;
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      i++;
      continue;
    }

    // 引用
    const q = raw.match(/^>\s?(.*)$/);
    if (q) {
      closeList();
      out.push(`<blockquote>${inline(q[1])}</blockquote>`);
      i++;
      continue;
    }

    // 列表（无序 - / * ；有序 1.）
    const uli = raw.match(/^[-*]\s+(.*)$/);
    const oli = raw.match(/^\d+\.\s+(.*)$/);
    if (uli || oli) {
      if (uli) {
        if (listType !== 'ul') {
          closeList();
          out.push('<ul>');
          listType = 'ul';
        }
        out.push(`<li>${inline(uli[1])}</li>`);
      } else if (oli) {
        if (listType !== 'ol') {
          closeList();
          out.push('<ol>');
          listType = 'ol';
        }
        out.push(`<li>${inline(oli[1])}</li>`);
      }
      i++;
      continue;
    }

    // 分隔线（--- / *** / ___ 单独成行）
    if (/^(\s*[-*_]){3,}\s*$/.test(raw)) {
      closeList();
      out.push('<hr />');
      i++;
      continue;
    }

    closeList();
    if (raw.trim() === '') {
      out.push('');
      i++;
      continue;
    }
    out.push(`<p>${inline(raw)}</p>`);
    i++;
  }

  if (inCode) out.push('</code></pre>');
  closeList();
  return out.join('\n');
}

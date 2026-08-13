// 后端文档模块公共逻辑（前端只读展示）：取数 + markdown 渲染。
// 内容由后端（本地工具 / Workers + DB）按 moduleId 提供；前端只拉取并渲染。
// 扩展端口：fetchDocs(moduleId) 统一走可配置源，后期接 Workers + DB 只改此实现与数据源约定。

export interface DocItem {
  id: string;
  title: string;
  module: string; // 所属模块（后端建文档时选好归到哪个模块）
  markdown: string; // 文档正文（markdown 源）
  updatedAt?: string; // 排序用，如 '2026-08-13'
}

// 数据源入口（扩展端口）：约定 /api/<moduleId>/docs.json 返回 DocItem[] 或 { docs: DocItem[] }。
// 后期接 Workers + DB 时只改这里（含排序/过滤规则），UI 不变。
const docSource = (moduleId: string) => `/api/${moduleId}/docs.json`;

export async function fetchDocs(moduleId: string): Promise<DocItem[]> {
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

// markdown → HTML 的轻量渲染（纯函数，先转义再格式化，防 XSS；常用子集足够展示）。
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_m, t, u) =>
        u.startsWith('http')
          ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>`
          : `<a href="${u}">${t}</a>`,
    );
}

export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src).split('\n');
  const out: string[] = [];
  let inList = false;
  let inCode = false;

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line.trim())) {
      if (inCode) {
        out.push('</code></pre>');
        inCode = false;
      } else {
        closeList();
        out.push('<pre><code>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      closeList();
      out.push(`<blockquote>${inline(q[1])}</blockquote>`);
      continue;
    }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === '') {
      out.push('');
      continue;
    }
    out.push(`<p>${inline(line)}</p>`);
  }

  if (inCode) out.push('</code></pre>');
  closeList();
  return out.join('\n');
}

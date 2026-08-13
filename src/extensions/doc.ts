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
// 额外支持在文档中直接写白名单 HTML（img/a/br/center/div/span），用于图片设大小、居中、链接图片等（属性经白名单+安全过滤）。
// 标题 → 锚点 id（与 renderMarkdown 保持一致）
export function slugify(title: string, used = new Set<string>()): string {
  let id = title
    .replace(/[*`_~\[\]()!#]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w一-龥-]/g, '');
  if (!id) id = 'section';
  let uniq = id;
  let c = 1;
  while (used.has(uniq)) uniq = `${id}-${c++}`;
  used.add(uniq);
  return uniq;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 防协议注入：仅放行 http(s)/相对路径/锚点/data:image
function safeUrl(u: string): string {
  return /^(https?:\/\/|\/|#|\.\/|\.\.\/|data:image\/)/i.test(u) ? u : '#';
}

// 裸 HTML 属性白名单 + 安全过滤：仅保留白名单标签的指定属性，禁 on* 事件、对 src/href 走 safeUrl、清洗 style 危险指令。
const ALLOWED_ATTRS: Record<string, string[]> = {
  img: ['src', 'alt', 'width', 'height', 'title', 'style'],
  a: ['href', 'title', 'target', 'rel'],
  br: [],
  center: [],
  div: ['style'],
  span: ['style'],
  mark: [],
  kbd: [],
};
function filterAttrs(tag: string, attrs: string): string {
  const ok = ALLOWED_ATTRS[tag.toLowerCase()] || [];
  const out: string[] = [];
  const re = /([a-zA-Z-]+)\s*=\s*"([^"]*)"|([a-zA-Z-]+)\s*=\s*'([^']*)'|([a-zA-Z-]+)\s*=\s*([^\s>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs))) {
    const name = (m[1] || m[3] || m[5] || '').toLowerCase();
    const val = m[2] !== undefined ? m[2] : m[4] !== undefined ? m[4] : m[6];
    if (!ok.includes(name) || name.startsWith('on')) continue; // 非白名单属性 / 事件属性一律丢弃
    let v = val;
    if (name === 'src' || name === 'href') v = safeUrl(v);
    if (name === 'style') v = v.replace(/javascript:/gi, '').replace(/expression\s*\(/gi, '');
    out.push(`${name}="${v.replace(/"/g, '&quot;')}"`);
  }
  return out.length ? ' ' + out.join(' ') : '';
}
// 行内 markdown 语法（输入已转义）
function markdownInline(s: string): string {
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
    })
    .replace(/(?<!["(/])(https?:\/\/[^\s<]+)/g, (full: string) => {
      const m = full.match(/^(https?:\/\/[^\s<]+?)([.,;:!?)\]]*)$/);
      const url = m ? m[1] : full;
      const tail = m ? m[2] : '';
      return `<a href="${safeUrl(url)}" target="_blank" rel="noopener">${url}</a>${tail}`;
    })
    .replace(/(?<!["(/])(www\.[^\s<]+)/g, (full: string) => {
      const m = full.match(/^(www\.[^\s<]+?)([.,;:!?)\]]*)$/);
      const host = m ? m[1] : full;
      const tail = m ? m[2] : '';
      return `<a href="${safeUrl('https://' + host)}" target="_blank" rel="noopener">${host}</a>${tail}`;
    });
}
// 行内解析：先保护白名单裸 HTML（防被转义成文本），再对剩余文本转义+跑 markdown 语法。
// 占位符用私有区字符包裹，避免与正文冲突。
function inline(s: string): string {
  const store: string[] = [];
  const stash = (html: string) => {
    store.push(html);
    return `${store.length - 1}`;
  };
  // 1) 先保护行内代码，避免 HTML 解析器把 `<img>` 等也当标签解析
  let s2 = s.replace(/`([^`]+)`/g, (_m, code: string) =>
    stash(`<code>${escapeHtml(code)}</code>`),
  );
  // 2) 再保护白名单裸 HTML
  s2 = s2.replace(/<\s*(img|br)\b([^>]*?)\/?>/gi, (_m, tag: string, attrs: string) =>
    stash(`<${tag}${filterAttrs(tag, attrs)} />`),
  );
  s2 = s2.replace(
    /<\s*(a|center|div|span|mark|kbd)\b([^>]*)>([\s\S]*?)<\/\s*\1\s*>/gi,
    (_m, tag: string, attrs: string, inner: string) =>
      stash(`<${tag}${filterAttrs(tag, attrs)}>${inner.replace(/\uE000(\d+)\uE001/g, (_x, k) => store[+k] || '')}</${tag}>`),
  );
  const parts = s2.split(/(\d+)/);
  let out = '';
  for (const p of parts) {
    const m = p.match(/^(\d+)$/);
    out += m ? store[+m[1]] : markdownInline(escapeHtml(p));
  }
  return out;
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
// 表格分隔行 → 列对齐方式（left / center / right）
function alignOf(cell: string): string {
  const t = cell.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}
// 分隔线（单独成行、至少 3 个 - / * / _，如 --- *** ___）
function isHr(l: string): boolean {
  return /^(\s*[-*_]){3,}\s*$/.test(l);
}
// 列表项（无序 - * + 或有序 1.）
function isListItem(l: string): boolean {
  return /^(\s*)([-*+]|\d+\.)\s+/.test(l);
}

interface ListItem {
  indent: number;
  ordered: boolean;
  task: boolean;
  checked: boolean;
  text: string;
  children: ListItem[];
}
function parseListItem(raw: string): ListItem | null {
  const m = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
  if (!m) return null;
  const indent = m[1].replace(/\t/g, '  ').length;
  const ordered = /\d+\./.test(m[2]);
  let text = m[3];
  const tm = text.match(/^\[([ xX])\]\s+(.*)$/);
  let task = false;
  let checked = false;
  if (tm) {
    task = true;
    checked = tm[1].toLowerCase() === 'x';
    text = tm[2];
  }
  return { indent, ordered, task, checked, text, children: [] };
}
// 列表项集合 → 嵌套树 → HTML（支持任务列表、任意层级嵌套）
function renderListBlock(buf: string[]): string {
  const items = buf.map(parseListItem).filter((x): x is ListItem => x !== null);
  if (!items.length) return '';
  const root: ListItem = {
    indent: -1,
    ordered: false,
    task: false,
    checked: false,
    text: '',
    children: [],
  };
  const stack: { indent: number; node: ListItem }[] = [{ indent: -1, node: root }];
  for (const it of items) {
    while (stack.length && stack[stack.length - 1].indent >= it.indent) stack.pop();
    stack[stack.length - 1].node.children.push(it);
    stack.push({ indent: it.indent, node: it });
  }
  return renderNodes(root.children);
}
function renderNodes(nodes: ListItem[]): string {
  if (!nodes.length) return '';
  let html = '';
  let i = 0;
  while (i < nodes.length) {
    const type = nodes[i].ordered ? 'ol' : 'ul';
    let j = i;
    while (j < nodes.length && (nodes[j].ordered ? 'ol' : 'ul') === type) j++;
    const group = nodes.slice(i, j);
    html += `<${type}>`;
    for (const n of group) {
      const content = n.task
        ? `<input type="checkbox" disabled${n.checked ? ' checked' : ''} /> ${inline(n.text)}`
        : inline(n.text);
      html += `<li>${content}${n.children.length ? renderNodes(n.children) : ''}</li>`;
    }
    html += `</${type}>`;
    i = j;
  }
  return html;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  const usedIds = new Set<string>(); // 标题锚点 id 去重

  while (i < lines.length) {
    const line = lines[i];

    // 代码块（围栏 ```，支持语言标识 → 语言标签 + 复制按钮）
    if (/^```/.test(line.trim())) {
      const lang = (line.trim().match(/^```(\w*)/) || [])[1] || '';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结束的 ```
      const badge = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
      out.push(
        `<div class="code-block"><div class="code-head">${badge}<button class="code-copy" type="button">复制</button></div><pre><code>${escapeHtml(buf.join('\n'))}</code></pre></div>`,
      );
      continue;
    }

    // 表格（表头行 + 分隔行），分隔行支持列对齐 :--- :---: ---:
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      const head = splitRow(line)
        .map(
          (c, idx) =>
            `<th${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${inline(c)}</th>`,
        )
        .join('');
      let j = i + 2;
      const body: string[] = [];
      while (j < lines.length && isTableRow(lines[j]) && lines[j].trim() !== '') {
        body.push(
          '<tr>' +
            splitRow(lines[j])
              .map(
                (c, idx) =>
                  `<td${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${inline(c)}</td>`,
              )
              .join('') +
            '</tr>',
        );
        j++;
      }
      out.push(
        `<table><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table>`,
      );
      i = j;
      continue;
    }

    // 标题 1-6 级（允许前导空格与尾部 #，生成锚点 id 支持 #标题 跳转）
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const n = h[1].length;
      const uniq = slugify(h[2], usedIds);
      out.push(`<h${n} id="${uniq}">${inline(h[2])}</h${n}>`);
      i++;
      continue;
    }

    // 分隔线（--- / *** / ___ 单独成行）
    if (isHr(line) && !isListItem(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // 引用块（连续 > 行，支持嵌套：递归渲染去掉外层 > 后的内容）
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      const inner = buf.map((l) => l.replace(/^>\s?/, '')).join('\n');
      out.push(`<blockquote>${renderMarkdown(inner)}</blockquote>`);
      continue;
    }

    // 列表块（连续列表项，允许项间空行；支持任务列表与嵌套）
    if (isListItem(line)) {
      const buf: string[] = [];
      while (i < lines.length) {
        if (isListItem(lines[i])) {
          buf.push(lines[i]);
          i++;
        } else if (lines[i].trim() === '' && i + 1 < lines.length && isListItem(lines[i + 1])) {
          i++; // 跳过列表内的空行
        } else {
          break;
        }
      }
      out.push(renderListBlock(buf));
      continue;
    }

    // 段落：连续非空、非特殊行（软换行转 <br/>，贴近 Typora 所见即所得）
    if (line.trim() !== '') {
      const buf: string[] = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^```/.test(lines[i].trim()) &&
        !/^\s{0,3}#{1,6}\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !isListItem(lines[i]) &&
        !isHr(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<p>${buf.map((l) => inline(l)).join('<br/>')}</p>`);
      continue;
    }

    // 空行
    i++;
  }

  return out.join('\n');
}

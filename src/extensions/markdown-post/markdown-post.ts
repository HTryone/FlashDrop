// 帖子展示核心（前端只读）：内容由后端写好并构建，前端只负责拉取 + 渲染。
// 编辑/合成不在前端 —— 那是后端的活（本地工具导入 markdown → 自动构建页面；后期可接 Workers + DB）。
// 扩展端口：数据源统一走 fetchPosts()，后期换 Workers+DB 只改这一个实现，UI 不变。

export interface Post {
  id: string;
  title: string;
  markdown: string; // 帖子正文（markdown 源）
  updatedAt?: string;
}

// 数据源地址（扩展端口）：后期接 Workers + 数据库时，只改这个常量 / fetchPosts 实现。
// 当前指向一个待后端构建的静态清单；后端未就绪时返回空数组，UI 显示「暂无内容」。
const POSTS_SOURCE = '/api/posts.json';

async function fetchPosts(): Promise<Post[]> {
  try {
    const res = await fetch(POSTS_SOURCE, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = (await res.json()) as Post[] | { posts: Post[] };
    return Array.isArray(data) ? data : (data.posts ?? []);
  } catch {
    return [];
  }
}

export { fetchPosts };

// markdown → HTML 的轻量渲染（纯函数，先转义再格式化，防 XSS；常用子集足够展示）。
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inline(s: string): string {
  // 已在外部转义过，这里只在安全文本上套格式
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
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

    // 代码块围栏
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

    // 标题
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }

    // 引用
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      closeList();
      out.push(`<blockquote>${inline(q[1])}</blockquote>`);
      continue;
    }

    // 列表
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

    // 空行
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

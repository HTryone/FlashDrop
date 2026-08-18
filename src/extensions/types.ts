// 扩展模块类型定义（中性，供各 meta.ts / data.ts 与 index.ts 共用）。
import type { Component } from 'vue';

export type ExtensionKind = 'panel' | 'action' | 'doc';

export interface Extension {
  id: string; // 路由与选择页唯一标识，如 'usage'；对应 /ext/<id>
  title: string; // 选择页卡片标题
  desc: string; // 选择页卡片副描述
  icon: string; // emoji 图标
  kind: ExtensionKind;
  order?: number; // 选择页展示顺序，越小越靠前（缺省排最后）
  component?: Component; // kind==='panel'|'action' 时必填：点该模块渲染的页面组件
  moduleId?: string; // kind==='doc' 时必填：文档模块标识（本地 data.ts 或后端 /api/<moduleId>/docs.json）
  platforms?: Array<'windows' | 'phone' | 'web'>; // 可选：限定出现的平台；缺省 = 全平台都显示
}

// 文档项（doc 类模块的单篇）。数据由本地 data.ts 或后端提供；前端只读渲染。
export interface DocItem {
  id: string; // 单篇唯一标识，前端靠它切换 / 翻页
  title: string; // 左侧目录显示的总标题
  module: string; // 所属模块（建文档时归到哪个 moduleId）
  markdown: string; // 文档正文（markdown 源；用 # 表示一级标题小节）
  updatedAt?: string; // 排序用，如 '2026-08-13'
}

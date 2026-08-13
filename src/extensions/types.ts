// 扩展模块类型定义（中性，供各 meta.ts 与 index.ts 共用）。
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
  moduleId?: string; // kind==='doc' 时必填：后端数据源模块标识（决定拉取 /api/<moduleId>/docs.json）
}

// 扩展模块注册表：首页「扩展」抽屉里的内容。
// 以后新增模块，只需往这里加一项，并在 ExtensionsDrawer.vue 增加对应渲染即可。

export type ExtensionKind = 'panel' | 'action';

export interface Extension {
  id: string;
  title: string;
  desc: string;
  icon: string; // emoji 或字符
  kind: ExtensionKind;
}

export const extensions: Extension[] = [
  {
    id: 'usage',
    title: '使用说明',
    desc: '发送、接收、续传、加密的完整用法',
    icon: '📖',
    kind: 'panel',
  },
  {
    id: 'clearCache',
    title: '清空缓存',
    desc: '清除本机浏览器保存的偏好与临时数据',
    icon: '🧹',
    kind: 'action',
  },
];

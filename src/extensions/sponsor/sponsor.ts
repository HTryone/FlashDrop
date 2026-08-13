// 赞助链接配置：图片/链接由用户后续提供，先留占位接口。
// UI 见同目录 SponsorPanel.vue；内容只在「赞助链接」页面显示，抽屉仅列方框不外露。

export interface SponsorItem {
  imageUrl: string; // 二维码 / 图片地址；留空则显示占位方块
  link: string;     // 点击跳转地址；留空则不渲染跳转按钮
  title: string;
  desc: string;
}

// 后续新增赞助渠道：往数组里加一项即可（图片链接给用户填入）。
export const sponsors: SponsorItem[] = [
  {
    imageUrl: '',
    link: '',
    title: '请我喝杯咖啡',
    desc: '你的支持是「闪传 FlashDrop」持续维护与免费运营的动力。',
  },
];

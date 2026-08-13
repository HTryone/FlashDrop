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
    imageUrl: '/img/zz.png',
    link: '',
    title: '请我喝杯咖啡',
    desc: '我是一个独立的小开发者，也是「闪传 FlashDrop」的作者。不瞒你说，我对写代码其实并不算很在行，只是凭着一腔热爱，尽自己最大的努力把它一点点打磨出来。无论你是否愿意赞助，我都会继续发挥自己的一点余热，把这个工具认真做好——只希望它能在你传文件时，多带给你一点点省心和方便。你用得开心，就是对我最大的鼓励。',
  },
];

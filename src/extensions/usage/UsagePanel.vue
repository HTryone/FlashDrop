<template>
  <div class="usage">
    <h4>① 发送文件</h4>
    <ul>
      <li>打开「发送」页，点击选择区或把文件/文件夹<strong>拖入</strong>虚线框。</li>
      <li>可一次选多个文件或整个文件夹（自动保留目录结构）。</li>
      <li>可选填<strong>留言</strong>，接收方会看到。</li>
      <li>点「开始传输」自动分片续传；完成后生成 <strong>6 位分享码</strong>。</li>
      <li>点「复制链接」把带码的地址发给对方；想换码点「刷新」。「清空所选」可移除已选文件。</li>
    </ul>
    <h4>② 接收文件</h4>
    <ul>
      <li>打开「接收」页，粘贴分享码（或直接点对方发来的带码链接）。</li>
      <li>看到文件列表后，可<strong>逐个下载</strong>或「打包下载全部(zip)」。</li>
      <li>大文件下载支持断点续传（断网接着下，不用重来）。</li>
    </ul>
    <h4>③ 端到端加密（可选）</h4>
    <ul>
      <li>发送时开启「端到端加密」并设口令；文件在浏览器内逐片加密后才上传。</li>
      <li>服务器（含 R2）只存密文，零知识。接收方需输入<strong>同一口令</strong>才能解密。</li>
      <li>开启加密后不支持服务端 zip 打包，请逐文件下载解密。</li>
    </ul>
    <h4>④ 存储位置</h4>
    <ul>
      <li><strong>本地直传</strong>：文件直接存到运行服务的电脑（就是文件本身）。</li>
      <li><strong>线上 R2</strong>：文件落到 Cloudflare R2（需在服务端配置凭据后启用）。</li>
    </ul>
  </div>
</template>

<style scoped>
.usage h4 { margin: 14px 0 6px; color: var(--accent-2); }
.usage ul { margin: 0; padding-left: 18px; line-height: 1.7; font-size: 13.5px; color: var(--text-dim); }
.usage li { margin-bottom: 4px; }
.usage strong { color: var(--text); }
</style>

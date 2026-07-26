<script setup lang="ts">
import { ref } from 'vue';
import { extensions, type Extension } from '@/extensions';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const selected = ref<Extension | null>(null);
const cleared = ref(false);

function pick(ext: Extension) {
  selected.value = ext;
  cleared.value = false;
}

function back() {
  selected.value = null;
}

function doClearCache() {
  try {
    localStorage.clear();
    cleared.value = true;
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <transition name="fade">
    <div v-if="props.open" class="overlay" @click.self="emit('close')">
      <aside class="drawer">
        <header class="drawer-head">
          <span>扩展模块</span>
          <button class="x" @click="emit('close')">✕</button>
        </header>

        <div v-if="!selected" class="ext-list">
          <button v-for="ext in extensions" :key="ext.id" class="ext-item" @click="pick(ext)">
            <span class="ext-icon">{{ ext.icon }}</span>
            <span class="ext-text">
              <strong>{{ ext.title }}</strong>
              <small class="muted">{{ ext.desc }}</small>
            </span>
            <span class="ext-arrow">›</span>
          </button>
          <p class="faint hint">以后新增模块，只需在 <code>src/extensions/index.ts</code> 注册即可。</p>
        </div>

        <div v-else class="ext-detail">
          <button class="back" @click="back">‹ 返回</button>

          <template v-if="selected.id === 'usage'">
            <h3>使用说明</h3>
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
                <li><strong>本地磁盘</strong>：文件直接存到运行服务的电脑（就是文件本身）。</li>
                <li><strong>线上 R2</strong>：文件落到 Cloudflare R2（需在服务端配置凭据后启用）。</li>
              </ul>
            </div>
          </template>

          <template v-else-if="selected.id === 'clearCache'">
            <h3>清空缓存</h3>
            <p class="muted">这会清除本机浏览器中保存的偏好与临时数据（不影响已上传到服务器的文件）。</p>
            <button v-if="!cleared" class="btn danger" @click="doClearCache">确认清空本机缓存</button>
            <p v-else class="ok">✓ 已清空本机缓存</p>
          </template>
        </div>
      </aside>
    </div>
  </transition>
</template>

<style scoped>
.overlay {
  position: fixed; inset: 0; background: rgba(4, 7, 14, 0.55);
  display: flex; justify-content: flex-end; z-index: 50;
  backdrop-filter: blur(2px);
}
.drawer {
  width: 420px; max-width: 92vw; height: 100%;
  background: var(--bg-soft); border-left: 1px solid var(--border);
  display: flex; flex-direction: column; padding: 18px;
  animation: slidein 0.22s ease;
}
@keyframes slidein { from { transform: translateX(40px); opacity: 0.4; } to { transform: none; opacity: 1; } }
.drawer-head {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 16px; font-weight: 700; margin-bottom: 14px;
}
.x { background: none; border: none; color: var(--text-dim); font-size: 18px; }
.ext-list { display: flex; flex-direction: column; gap: 10px; overflow: auto; }
.ext-item {
  display: flex; align-items: center; gap: 12px; text-align: left;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 12px; color: var(--text);
}
.ext-item:hover { border-color: var(--accent); }
.ext-icon { font-size: 22px; }
.ext-text { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.ext-text small { font-size: 12px; }
.ext-arrow { color: var(--text-faint); font-size: 20px; }
.hint { font-size: 12px; margin-top: 12px; line-height: 1.6; }
.hint code { background: var(--panel-2); padding: 1px 5px; border-radius: 5px; }
.ext-detail { overflow: auto; }
.back { background: none; border: none; color: var(--accent); padding: 0; margin-bottom: 10px; font-size: 14px; }
.usage h4 { margin: 14px 0 6px; color: var(--accent-2); }
.usage ul { margin: 0; padding-left: 18px; line-height: 1.7; font-size: 13.5px; color: var(--text-dim); }
.usage li { margin-bottom: 4px; }
.usage strong { color: var(--text); }
.ok { color: var(--ok); font-weight: 600; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>

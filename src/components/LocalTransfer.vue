<script setup lang="ts">
import ProgressBar from './ProgressBar.vue';
import { useLocalReceive } from '@/composables/useLocalReceive';

// 由父组件（接收面板）指定渲染哪一侧；不传则两侧都渲染
const props = defineProps<{ side?: 'send' | 'receive' }>();

// 本地直传（HTTP + P2P）接收编排已抽到 src/composables/useLocalReceive.ts
const {
  recvRoom, recvPass, recvLinkInput, receiving, recvReady, senderOnline, recvFiles, recvProgress, recvFileProgress, recvSpeed, recvStatus, recvSegCount,
  parsePastedLink, localTransport, startRecv, onCancelRecv,
} = useLocalReceive();
</script>

<template>
  <div class="local">
    <!-- 接收 -->
    <section class="blk" v-if="!props.side || props.side === 'receive'">
      <h3>② 接收（输入房间码）</h3>
      <div class="recv-form">
        <input v-model="recvRoom" placeholder="房间码（链接打开时自动填入）" :disabled="receiving" />
      </div>
      <div class="recv-form">
        <input v-model="recvPass" type="text" placeholder="密钥（链接打开时自动填入，或手动输入）" :disabled="receiving" />
      </div>
      <div class="recv-form">
        <input v-model="recvLinkInput" placeholder="或粘贴整条分享链接自动解析" :disabled="receiving" />
        <button class="btn sm" @click="parsePastedLink">解析</button>
      </div>
      <div class="recv-form transport-switch">
        <span class="muted">直传方式：</span>
        <button class="btn sm" :class="{ on: localTransport === 'http' }" @click="localTransport = 'http'">HTTP 中继</button>
        <button class="btn sm" :class="{ on: localTransport === 'p2p' }" @click="localTransport = 'p2p'">P2P 直连</button>
      </div>
      <div class="presence">
        <span class="dot" :class="{ on: senderOnline }"></span>
        配对状态：{{ senderOnline ? '匹配成功 ✓' : '等待连接' }}
        <span class="transport" v-if="localTransport === 'http'">HTTP 流式中继</span>
        <span class="transport p2p" v-else>P2P 直连</span>
      </div>
      <div class="actions">
        <button v-if="!receiving" class="btn primary" :disabled="receiving" @click="startRecv">连接接收</button>
        <button v-else class="btn danger" @click="onCancelRecv">取消接收</button>
      </div>
      <div v-if="recvFiles.length" class="filelist">
        <div class="recv-summary" v-if="receiving || recvReady">
          <span class="sum-pct">总进度 {{ (recvProgress * 100).toFixed(0) }}%</span>
          <span class="sum-speed" v-if="recvSpeed != null">{{ recvSpeed.toFixed(1) }} MB/s</span>
        </div>
        <ProgressBar
          v-for="(f, i) in recvFiles"
          :key="f.name"
          :name="f.name"
          :size="f.size"
          :value="(recvFileProgress[i] ?? 0) * 100"
          :done="(recvFileProgress[i] ?? 0) >= 1"
        />
      </div>
      <div class="status">{{ recvStatus }}</div>
      <p class="hint e2ee-hint">🔒 已端到端加密：密钥仅在本机从链接 <code>#k=</code> 派生，服务器只转发密文、无法解密。</p>
    </section>
  </div>
</template>

<style scoped>
.local { display: flex; flex-direction: column; gap: 8px; }
.blk { display: flex; flex-direction: column; gap: 10px; }
.hint { font-size: 12.5px; color: var(--text-dim); margin: 0; }
.e2ee-hint {
  color: #3ecf8e;
  border-left: 2px solid #3ecf8e;
  padding: 6px 8px;
  margin: 4px 0 0 !important;
  background: rgba(62, 207, 142, 0.08);
  border-radius: 0 6px 6px 0;
}
.e2ee-hint code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgba(62, 207, 142, 0.16);
  padding: 0 4px;
  border-radius: 3px;
}
h3 { margin: 0; font-size: 15px; }
hr { border: none; border-top: 1px solid var(--border); margin: 6px 0; }
.filelist { display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow: auto; }
.recv-summary { display: flex; align-items: center; gap: 12px; font-size: 12.5px; padding: 2px 2px 4px; }
.sum-pct { color: var(--text-dim); font-variant-numeric: tabular-nums; }
.sum-speed { color: var(--accent-2); font-variant-numeric: tabular-nums; font-weight: 600; }
.total { font-size: 12.5px; color: var(--text-faint); }
.roominfo { display: flex; flex-direction: column; gap: 10px; }
.code { font-size: 14px; }
.code b { font-size: 18px; letter-spacing: 2px; color: var(--accent); }
.link { display: flex; gap: 8px; }
.link input { flex: 1; background: var(--bg-soft); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 8px; font-size: 12px; }
.actions { display: flex; gap: 12px; }
.recv-form { display: flex; gap: 8px; }
.recv-form input { flex: 1; background: var(--bg-soft); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 9px; font-size: 13px; }
.status { font-size: 12.5px; color: var(--text-dim); min-height: 16px; word-break: break-all; }
.btn { border: 1px solid var(--border); background: var(--panel-2); color: var(--text); border-radius: 8px; padding: 9px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
.btn.primary { background: var(--accent-grad); color: #07101f; border: none; }
.btn.sm { padding: 8px 12px; font-size: 12px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.presence { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-dim); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-faint); flex: none; }
.dot.on { background: #2ecc71; box-shadow: 0 0 6px #2ecc71; }
  .transport { margin-left: 8px; font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-dim); }
  .transport-switch { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-dim); }
  .btn.sm.on { background: var(--accent-grad); color: #07101f; border: none; }
  .transport.p2p { color: #7aa2ff; border-color: #7aa2ff; }
  .btn.danger { background: var(--danger, #e24b4a); color: #fff; border: none; }
  input[type=file] { font-size: 13px; color: var(--text-dim); }
</style>

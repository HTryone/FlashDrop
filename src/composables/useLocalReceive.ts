// 本地直传·接收调度员（composable）
// 职责：编排「接收端本地直传」的 UI 状态与生命周期，桥接两个底层引擎：
//   - HTTP 流式：src/https/receiver.ts（LocalReceiver）
//   - P2P 直连：src/p2p/receiver.ts（createP2PReceiver）
// 不触碰中转（TUS）链路；两条本地链路不互相融合，仅按 localTransport 二选一调用对应引擎。
import { ref, computed, watch, onUnmounted } from 'vue';
import { LocalReceiver } from '@/https';
import { resolveRelayBase } from '@/transfer/room';
import { createP2PReceiver } from '@/p2p';

export function useLocalReceive() {
  // UI 绑定的房间码 / 口令（与 LocalReceiver 内部状态双向同步）
  const recvRoom = ref(new URLSearchParams(location.search).get('room') || '');
  const recvPass = ref(new URLSearchParams(location.hash.slice(1)).get('k') || '');
  const recvLinkInput = ref('');
  const receiving = ref(false);
  const recvReady = ref(false);
  const senderOnline = ref(false);
  const recvFiles = ref<{ name: string; size: number }[]>([]);
  const recvProgress = ref(0);
  const recvFileProgress = ref<number[]>([]); // 逐文件进度 0..1，与 recvFiles 同序
  const recvSpeed = ref<number | null>(null); // MB/s，接收中按字节增量推算（单流总速度，只显示一条）
  const recvStatus = ref('输入房间码（或粘贴整条链接）后点连接');
  const recvSegCount = ref(1);
  const recvDone = ref(false);   // 接收完成态（显示「接收完成」+ 全新开始）
  const recvFailed = ref(false); // 接收失败态（两端回初始，房间码/口令可改）

  // 接收总字节数（由清单累加），用于把 0..1 进度还原成字节、进而算速度
  const recvTotalBytes = computed(() => recvFiles.value.reduce((a, f) => a + f.size, 0));
  // 速度采样：记录上次字节数与时间戳，每 ≥0.2s 取一次瞬时速度做平滑
  let _lastBytes = 0;
  let _lastT = 0;
  function sampleRecv(bytes: number, total: number) {
    recvProgress.value = total ? bytes / total : (total === 0 ? 1 : 0);
    const now = performance.now();
    if (_lastT) {
      const dt = (now - _lastT) / 1000;
      if (dt >= 0.2) {
        const inst = (bytes - _lastBytes) / dt / 1048576; // → MB/s
        recvSpeed.value = recvSpeed.value != null ? recvSpeed.value * 0.5 + inst * 0.5 : inst;
        _lastBytes = bytes;
        _lastT = now;
      }
    } else {
      _lastBytes = bytes;
      _lastT = now;
    }
  }
  function resetRecvSpeed() {
    recvSpeed.value = null;
    _lastBytes = 0;
    _lastT = 0;
  }

  // ========== HTTP 段（调用 @/https 引擎，不碰 P2P 代码）==========
  const receiver = new LocalReceiver({
    onStatus: (s) => { recvStatus.value = s; },
    onRecvReady: (v) => { recvReady.value = v; },
    onSenderOnline: (v) => { senderOnline.value = v; },
    onFiles: (files) => { recvFiles.value = files; recvFileProgress.value = []; },
    onFileProgress: (progs) => { recvFileProgress.value = progs; },
    onProgress: (p) => { sampleRecv(p * recvTotalBytes.value, recvTotalBytes.value); },
    onSegCount: (n) => { recvSegCount.value = n; },
    onReceiving: (v) => { receiving.value = v; if (v) { recvDone.value = false; recvFailed.value = false; } },
    onDone: () => { recvDone.value = true; recvFailed.value = false; receiving.value = false; },
    onFail: (msg) => {
      recvFailed.value = true; recvDone.value = false; receiving.value = false;
      recvFiles.value = []; recvFileProgress.value = []; recvProgress.value = 0;
      recvStatus.value = (msg || '接收失败') + '，已回到可重新连接状态，可改密码后重新点连接接收';
    },
  });

  // 从 URL 自动填入房间码 / 口令
  receiver.setRoom(recvRoom.value);
  receiver.setPass(recvPass.value);
  // 手动编辑输入框时同步给核心
  watch(recvRoom, (v) => receiver.setRoom(v));
  watch(recvPass, (v) => receiver.setPass(v));

  function parsePastedLink() {
    receiver.parseLink(recvLinkInput.value);
    recvRoom.value = receiver.room;
    recvPass.value = receiver.pass;
  }

  // ========== P2P 段（调用 @/p2p 引擎，复用同一房间码/口令，不触碰 HTTP 代码）==========
  const localTransport = ref<'http' | 'p2p'>('http');
  let p2pReceiver: ReturnType<typeof createP2PReceiver> | null = null;

  // 必须在用户手势内调用（连接接收按钮触发），拿到目录句柄；非 Chromium 返回 null 走兜底。
  async function pickSaveDir(): Promise<any | null> {
    const w = window as any;
    if (typeof w.showDirectoryPicker !== 'function') return null;
    try {
      const dir = await w.showDirectoryPicker({ mode: 'readwrite' });
      return dir;
    } catch (e: any) {
      return { __cancelled: true, __error: e?.name || String(e) };
    }
  }

  // 在用户手势内把目录句柄提升到 readwrite，避免后续异步回调里因缺用户激活抛 SecurityError。
  async function ensureRwPermission(dh: any): Promise<string> {
    if (!dh || typeof dh.requestPermission !== 'function') return 'granted';
    try {
      if (typeof dh.queryPermission === 'function') {
        const q = await dh.queryPermission({ mode: 'readwrite' });
        if (q === 'granted') return 'granted';
      }
      return await dh.requestPermission({ mode: 'readwrite' });
    } catch (e: any) {
      return `error:${e?.message || e}`;
    }
  }

  async function runP2PRecv() {
    const room = recvRoom.value;
    const pass = recvPass.value;
    if (!room || !pass) { recvStatus.value = '需要房间码和口令'; return; }
    const picked = await pickSaveDir();
    if (picked && (picked as any).__cancelled) {
      const errName = (picked as any).__error || '';
      recvStatus.value = errName ? `选择保存目录失败: ${errName}` : '已取消选择保存目录';
      return;
    }
    if (picked) {
      const perm = await ensureRwPermission(picked);
      if (perm !== 'granted') {
        recvStatus.value = perm.startsWith('error:')
          ? `目录授权失败: ${perm.slice(6)}`
          : '需要目录读写权限才能保存文件';
        return;
      }
    }
    // 重连/重新接收：先清旧清单与进度，等 manifest 到达后由 onFiles 重新填充（避免短暂显示上一次文件）
    receiving.value = true; recvReady.value = false; recvProgress.value = 0;
    recvFiles.value = []; recvFileProgress.value = [];
    recvStatus.value = 'P2P 信令协商中…';
    const inst = createP2PReceiver({
      relayBase: resolveRelayBase(),
      room,
      pass,
      dirHandle: (picked as any) || null,
      onFiles: (files) => { recvFiles.value = files; recvFileProgress.value = []; },
      onFileProgress: (progs) => { recvFileProgress.value = progs; },
      onState: (s, d) => {
        if (s === 'connected') { senderOnline.value = true; recvDone.value = false; recvFailed.value = false; recvStatus.value = 'P2P 直连已建立，等待文件清单…'; }
        else if (s === 'transferring') { senderOnline.value = true; recvDone.value = false; recvFailed.value = false; recvStatus.value = 'P2P 接收中…'; }
        else if (s === 'done') { receiving.value = false; recvDone.value = true; recvFailed.value = false; recvStatus.value = 'P2P 接收完成，文件已保存'; }
        else if (s === 'error') { senderOnline.value = false; receiving.value = false; recvFailed.value = true; recvStatus.value = `P2P 出错：${d || ''}`; }
        else if (s === 'aborted') { senderOnline.value = false; receiving.value = false; recvDone.value = false; recvFailed.value = false; recvStatus.value = '已取消'; }
      },
      // 发送端已加入房间并开始协商：提前点亮在线指示灯，给出「发送端在线」反馈
      onPeerJoined: () => {
        senderOnline.value = true;
        recvStatus.value = '发送端已连接，正在建立直连…';
      },
      // 发送端经信令房上线（WS 连上即触发，早于 SDP）：立刻点亮在线灯，不等 offer 到达
      onPeerPresent: () => {
        senderOnline.value = true;
        // 仅在尚未开始传输时显示「就位」提示；传输中/完成/出错时不倒退状态。
        // 否则息屏重连后 relay 再次推送 peer-joined 会把「接收中/已完成」覆盖回「等待开始传输」。
        if (!receiving.value && recvProgress.value === 0) {
          recvStatus.value = '发送端已就位，等待开始传输…';
        }
      },
      onProgress: (p) => { sampleRecv(p.received, p.total); },
      onFail: (e) => { recvStatus.value = `P2P 接收失败：${e.message}`; receiving.value = false; recvFailed.value = true; },
    });
    p2pReceiver = inst;
    try {
      await inst.connect();
    } catch (e: any) {
      recvStatus.value = `P2P 连接失败：${e?.message || e}`;
      receiving.value = false;
    }
  }

  function startRecv() {
    resetRecvSpeed();
    recvFileProgress.value = [];
    if (localTransport.value === 'p2p') { void runP2PRecv(); return; }
    receiver.start();
  }
  function onCancelRecv() {
    if (p2pReceiver) { p2pReceiver.abort(); p2pReceiver = null; }
    receiver.cancel();
    receiving.value = false;
    recvProgress.value = 0;
  }

  /** 全新开始：清空本次接收内容，回到「连接接收」初始态（房间码/口令一并清空） */
  function resetRecv() {
    receiving.value = false;
    recvReady.value = false;
    recvDone.value = false;
    recvFailed.value = false;
    recvFiles.value = [];
    recvFileProgress.value = [];
    recvProgress.value = 0;
    senderOnline.value = false;
    recvSegCount.value = 1;
    recvStatus.value = '输入房间码（或粘贴整条链接）后点连接';
    resetRecvSpeed();
    recvRoom.value = '';
    recvPass.value = '';
    receiver.setRoom('');
    receiver.setPass('');
    receiver.close();
    if (p2pReceiver) { try { p2pReceiver.abort(); } catch { /* ignore */ } p2pReceiver = null; }
  }

  onUnmounted(() => {
    if (p2pReceiver) { try { p2pReceiver.abort(); } catch { /* ignore */ } }
    receiver.close();
  });

  return {
    recvRoom, recvPass, recvLinkInput, receiving, recvReady, senderOnline, recvFiles, recvProgress, recvFileProgress, recvSpeed, recvStatus, recvSegCount, recvDone, recvFailed,
    parsePastedLink, localTransport, startRecv, onCancelRecv, resetRecv,
  };
}

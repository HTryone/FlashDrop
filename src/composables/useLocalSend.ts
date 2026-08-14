// 本地直传·发送调度员（composable）
// 职责：编排「发送端本地直传」的 UI 状态与生命周期，桥接两个底层引擎：
//   - HTTP 流式：src/https/sender.ts（LocalSender）
//   - P2P 直连：src/p2p/sender.ts（createP2PSender）
// 不触碰中转（TUS）链路——那条在 src/transfer/tus/useRelayTransfer.ts；两条本地链路也不互相融合，
// 仅按 localTransport 二选一调用对应引擎。
import { ref, computed, watch, onUnmounted, type Ref } from 'vue';
import type { QueuedFile } from '@/types/transfer';
import { LocalSender } from '@/https';
import { resolveRelayBase } from '@/transfer/room';
import { createP2PSender } from '@/p2p';
import { SignalingClient } from '@/p2p/signaling';

export function useLocalSend(files: Ref<QueuedFile[]>, clearSelected: () => void) {
  // ========== 公共状态（HTTP / P2P 共用，复用同一房间码/口令）==========
  const lRoom = ref('');
  const lPassphrase = ref('');
  const lSendLink = ref('');
  const lSending = ref(false);
  const lDone = ref(false);
  const lProgress = ref(0);
  const lTransferring = ref(false); // 真正开始发送数据时为 true（区别于 lSending：lSending 点发送即 true，含信令/连接阶段）
  const lStatus = ref('');
  const lPeerOnline = ref(false);
  const lSegIndex = ref(0);   // 当前段（0 基），用于 UI 展示
  // 发送端自身状态灯：房间一生成即亮，独立于对方是否在线（解决「只能靠接收端才亮」）
  const lSelfActive = computed(() => !!lRoom.value);

  // 本地直传模式总状态（三态推导，原 senderStatus 的 local 分支已下沉至此）
  const sendStatus = computed(() => {
    if (lDone.value) return '发送完成';
    if (lTransferring.value) return '传输中';
    return '待发送';
  });
  const sendStatusClass = computed(() => {
    if (lDone.value) return 'done';
    if (lTransferring.value) return 'busy';
    return 'idle';
  });

  // ========== HTTP 段（调用 @/https 引擎，不碰 P2P 代码）==========
  const sender = new LocalSender({
    onStatus: (s) => { lStatus.value = s; },
    onPeerOnline: (v) => { lPeerOnline.value = v; },
    onProgress: (p) => { lProgress.value = p; },
    onSegIndex: (i) => { lSegIndex.value = i; },
    onSending: (v) => { lSending.value = v; },
    onTransferring: (v) => { lTransferring.value = v; },
    onDone: () => { lDone.value = true; },
    onRoom: (room, link, pass) => { lRoom.value = room; lSendLink.value = link; lPassphrase.value = pass; },
  });

  function genRoom() {
    // 先清理旧的提前信令（重新生成房间时）
    if (p2pEarlySig) { p2pEarlySig.close(); p2pEarlySig = null; }
    sender.genRoom();
  }

  // ========== P2P 段（调用 @/p2p 引擎，复用同一房间码/口令/文件，不触碰 HTTP 代码）==========
  const localTransport = ref<'http' | 'p2p'>('http');
  let p2pSender: ReturnType<typeof createP2PSender> | null = null;
  // P2P 提前信令：genRoom 时即连 WS，不等点「开始传输」。
  // 这样对方一点「连接接收」，relay 就能通过 peer-joined 通知发送端亮灯。
  let p2pEarlySig: SignalingClient | null = null;

  // 确保提前信令 WS 已连：P2P 模式下、房间已存在、且尚未连接时才创建。
  // 关键修复：房间常在 http 模式下就生成（watch(lRoom) 当时因 mode!=='p2p' 已 return），
  // 用户之后才切到 P2P——必须在 watch(localTransport) 切到 p2p 时补连，否则发送端信令 WS 永不打开，
  // relay 的 peer-joined 无从送达，接收端一点「连接接收」发送端灯也不亮。
  function ensureEarlySig() {
    if (localTransport.value !== 'p2p') return;
    if (!lRoom.value || p2pEarlySig) return;
    p2pEarlySig = new SignalingClient({
      relayBase: resolveRelayBase(),
      room: lRoom.value,
      role: 'sender',
      onSignal: () => {}, // 占位：PeerLink 建立后会通过 setOnSignal 接管
      onPeerConnected: (role) => {
        if (role === 'receiver' && !lSending.value && !lDone.value) {
          lPeerOnline.value = true;
          lStatus.value = '对方已加入，可点「开始传输」';
        }
      },
    });
    p2pEarlySig.connect();
  }

  // 房间一生成（且当前已是 P2P 模式）即连提前信令
  watch(lRoom, () => ensureEarlySig());
  // 切到 P2P 模式（房间可能已先生成于 http 模式）时补连提前信令；切走则断开
  watch(localTransport, (mode) => {
    if (mode === 'p2p') ensureEarlySig();
    else if (p2pEarlySig) {
      p2pEarlySig.close();
      p2pEarlySig = null;
      lPeerOnline.value = false;
    }
  });

  async function runP2PLocalSend() {
    if (!lRoom.value || !lPassphrase.value) { lStatus.value = '请先生成房间'; return; }
    if (!files.value.length) { lStatus.value = '没有待发送文件'; return; }
    lSending.value = true; lProgress.value = 0; lDone.value = false; lTransferring.value = false;
    // P2P 连续流：发送期间把每文件行标记为传输中、进度清零（完成后才标记已完成）
    files.value.forEach((f) => { f.status = 'uploading'; f.uploaded = 0; });
    lStatus.value = '信令协商中…';
    const sender = createP2PSender({
      relayBase: resolveRelayBase(),
      room: lRoom.value,
      pass: lPassphrase.value,
      files: files.value.map((f) => f.file),
      onState: (s, d) => {
        if (s === 'signaling') { lStatus.value = '信令已接通，等待 ICE 协商…'; }
        else if (s === 'connecting') { lPeerOnline.value = true; lStatus.value = 'ICE 协商中…'; }
        else if (s === 'connected') { lPeerOnline.value = true; lStatus.value = '直连已建立'; }
        else if (s === 'transferring') { lPeerOnline.value = true; lTransferring.value = true; lStatus.value = '传输中…'; }
        else if (s === 'done') { lSending.value = false; lDone.value = true; lTransferring.value = false; lStatus.value = '发送完成'; files.value.forEach((f) => { f.status = 'done'; f.uploaded = f.file.size; }); }
        else if (s === 'error') { lSending.value = false; lPeerOnline.value = false; lTransferring.value = false; lStatus.value = `出错：${d || ''}`; files.value.forEach((f) => { f.status = 'pending'; f.uploaded = 0; }); }
        else if (s === 'aborted') { lSending.value = false; lPeerOnline.value = false; lTransferring.value = false; lStatus.value = '已取消'; files.value.forEach((f) => { f.status = 'pending'; f.uploaded = 0; }); }
      },
      // 对端信令到达（offer/answer）：更新状态反映协商进展。
      // 不再守卫 lPeerOnline——提前信令已在对方加入时亮灯，这里负责「点了发送后」的状态推进。
      onPeerJoined: () => {
        if (!lSending.value) return; // 还没点发送，不重复提示（提前信令的 onPeerConnected 已处理）
        lStatus.value = '对端已响应，ICE 协商中…';
      },
      // 对端经信令房上线（WS 连上即触发，早于 SDP）：兜底点亮在线灯（提前信令 WS 异常时仍能亮）
      onPeerPresent: (role) => {
        if (role === 'receiver') { lPeerOnline.value = true; lStatus.value = '对方已就位，可点「开始传输」'; }
      },
      onProgress: (p) => {
        lProgress.value = p.total ? p.sent / p.total : 0;
        // 按各文件大小比例把整体进度摊到每文件行（P2P 连续流，进度为近似值）
        let acc = 0;
        for (const f of files.value) {
          f.uploaded = p.sent <= acc ? 0 : Math.min(f.file.size, p.sent - acc);
          acc += f.file.size;
        }
      },
      onFail: (e) => { lSending.value = false; lStatus.value = `P2P 传输失败：${e.message}`; lDone.value = false; files.value.forEach((f) => { f.status = 'pending'; f.uploaded = 0; }); },
    });
    p2pSender = sender;
    try {
      await sender.connect(p2pEarlySig || undefined); // 复用提前连好的信令 WS
      p2pEarlySig = null; // 所有权已转移给 sender，避免重复 close
    } catch (e: any) {
      lStatus.value = `P2P 连接失败：${e?.message || e}`;
      lSending.value = false;
    }
  }

  function startLocalSend() {
    if (localTransport.value === 'p2p') { void runP2PLocalSend(); return; }
    sender.startSend(files.value.map((f) => ({ file: f.file })));
  }
  function cancelLocalSend() {
    if (p2pSender) { p2pSender.abort(); p2pSender = null; }
    if (p2pEarlySig) { p2pEarlySig.close(); p2pEarlySig = null; }
    if (lSending.value) sender.cancel();
  }
  function copyLocalLink() { navigator.clipboard?.writeText(sender.link); lStatus.value = '链接已复制'; }

  // 销毁当前房间（不保留），回到初始状态：清空所选文件 + 重新选直传方式（HTTP/P2P）+ 重新生成房间。
  function resetLocalRoom() {
    cancelLocalSend(); // 先停掉当前发送（若有）并释放连接
    sender.close();
    clearSelected();
    lRoom.value = '';
    lPassphrase.value = '';
    lSendLink.value = '';
    lSending.value = false;
    lDone.value = false;
    lProgress.value = 0;
    lTransferring.value = false;
    lStatus.value = '';
    lPeerOnline.value = false;
    lSegIndex.value = 0;
  }

  // 组件卸载时清理本地直传连接 + 提前信令（中转上传 abort 已在 useRelayTransfer 内处理）
  onUnmounted(() => {
    sender.close();
    if (p2pEarlySig) { p2pEarlySig.close(); p2pEarlySig = null; }
    if (p2pSender) { p2pSender.abort(); p2pSender = null; }
  });

  return {
    // 状态
    lRoom, lPassphrase, lSendLink, lSending, lDone, lProgress, lTransferring, lStatus, lPeerOnline, lSegIndex, lSelfActive,
    // 状态推导（下沉）
    sendStatus, sendStatusClass,
    // 传输方式
    localTransport,
    // 操作
    genRoom, startLocalSend, cancelLocalSend, copyLocalLink, resetLocalRoom,
  };
}

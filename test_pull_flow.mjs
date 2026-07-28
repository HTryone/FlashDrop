// 线上 Worker 端到端验证：sender WS → receiver GET → 是否收到 pull → POST 数据 → 接收端收到
// 用法: node test_pull_flow.mjs
const BASE = 'https://flashdrop-relay.315461.xyz';
const WS_BASE = 'wss://flashdrop-relay.315461.xyz';
const room = 'T' + Math.random().toString(36).slice(2, 7).toUpperCase();
console.log('房间:', room);

const log = (t, ...a) => console.log(new Date().toISOString().slice(11, 23), `[${t}]`, ...a);

let gotPull = false;
let gotRecvReadyEcho = false;

// 1. 发送端 WS 先连（模拟先点「开始传输」）
const senderWs = new WebSocket(`${WS_BASE}/ws/${room}?role=sender`);
await new Promise((res, rej) => {
  senderWs.onopen = () => { log('senderWS', '已连接'); res(); };
  senderWs.onerror = (e) => rej(new Error('senderWS 连接失败'));
});
senderWs.onmessage = (ev) => {
  const d = JSON.parse(ev.data);
  log('senderWS', '收到:', ev.data);
  if (d.type === 'pull') gotPull = true;
  if (d.type === 'recv-ready') gotRecvReadyEcho = true;
};

// 2. 先发一个 offer 短 POST（模拟前端行为，创建 room 的 writable）
const offer = new TextEncoder().encode('OFFER_TEST_' + room);
const postOffer = await fetch(`${BASE}/stream/${room}`, { method: 'POST', body: offer });
log('offer', 'POST 状态:', postOffer.status, await postOffer.text().catch(() => ''));

// 3. 接收端 GET 连上（模拟点「连接接收」）
log('recv', '发起 GET…');
const getResp = await fetch(`${BASE}/stream/${room}`);
log('recv', 'GET 状态:', getResp.status);
const reader = getResp.body.getReader();

// 读开场帧 + offer
let recvBytes = 0;
const readChunks = (async () => {
  while (true) {
    const { done, value } = await reader.read();
    if (done) { log('recv', 'EOF, 共收', recvBytes, '字节'); break; }
    recvBytes += value.length;
    log('recv', '收到', value.length, '字节 (累计', recvBytes + ')');
  }
})();

// 4. 等 2s 看 sender 是否收到 pull
await new Promise(r => setTimeout(r, 2500));
log('检查', 'gotPull =', gotPull);

if (!gotPull) {
  console.log('❌ Worker 未发 pull 信号 —— 线上 Worker 还是旧版（未部署 d0ec118）');
} else {
  console.log('✅ Worker 已发 pull 信号 —— 新版已部署');
  // 5. 推一段数据验证链路
  const data = new Uint8Array(1024 * 64).fill(7);
  const p = await fetch(`${BASE}/stream/${room}`, { method: 'POST', body: data });
  log('send', '数据 POST 状态:', p.status);
  await fetch(`${BASE}/stream/${room}/close`, { method: 'POST' });
  log('send', '已发 close');
  await Promise.race([readChunks, new Promise(r => setTimeout(r, 5000))]);
}
senderWs.close();
process.exit(0);

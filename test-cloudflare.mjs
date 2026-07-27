// 测试 Cloudflare Worker 的 WebSocket + HTTP 流式传输
// 模拟浏览器行为，诊断为什么接收端收不到数据
import WebSocket from 'ws';

const ROOM = 'DEBUG' + Date.now().toString(36).toUpperCase();
const BASE = 'https://flashdrop-relay.315461.xyz';
const WS_BASE = 'wss://flashdrop-relay.315461.xyz';

function log(side, msg) {
  console.log(`[${side}] ${new Date().toISOString().slice(11, 19)} ${msg}`);
}

function encodeMsg(payload) {
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(payload.length, 0);
  return Buffer.concat([hdr, payload]);
}

async function readExact(reader, n, buf) {
  while (buf.length < n) {
    const { done, value } = await reader.read();
    if (done) return null;
    buf.chunks.push(Buffer.from(value));
    buf.length += value.length;
  }
  const all = Buffer.concat(buf.chunks);
  const out = all.subarray(0, n);
  const rest = all.subarray(n);
  buf.chunks = [rest];
  buf.length = rest.length;
  return out;
}

async function readMsg(reader, buf) {
  const hdr = await readExact(reader, 4, buf);
  if (!hdr) return null;
  const len = hdr.readUInt32BE(0);
  if (len === 0) return null;
  return readExact(reader, len, buf);
}

async function runReceiver() {
  log('RECV', `连接 WebSocket /ws/${ROOM}?role=receiver`);
  const ws = new WebSocket(`${WS_BASE}/ws/${ROOM}?role=receiver`);
  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      log('RECV', 'WebSocket 已连接，发送 ready');
      ws.send(JSON.stringify({ type: 'ready' }));
      resolve();
    });
    ws.on('error', reject);
  });

  log('RECV', `发起 GET /stream/${ROOM}`);
  const resp = await fetch(`${BASE}/stream/${ROOM}`);
  log('RECV', `GET 返回: ${resp.status} ${resp.statusText}`);
  if (!resp.ok) throw new Error(`GET failed: ${resp.status}`);
  const reader = resp.body.getReader();
  const buf = { chunks: [], length: 0 };

  log('RECV', '等待 offer...');
  const offerPayload = await readMsg(reader, buf);
  if (!offerPayload) throw new Error('未收到 offer');
  const offer = JSON.parse(offerPayload.toString());
  log('RECV', `收到 offer: ${JSON.stringify(offer)}`);

  let totalBytes = 0;
  let frameCount = 0;
  while (true) {
    const payload = await readMsg(reader, buf);
    if (!payload) break;
    totalBytes += payload.length;
    frameCount++;
    log('RECV', `收到数据帧 #${frameCount}, ${payload.length} bytes`);
  }

  log('RECV', `EOF，共 ${frameCount} 帧，${totalBytes} bytes`);
  ws.close();
  return { offer, frameCount, totalBytes };
}

async function runSender() {
  log('SEND', `连接 WebSocket /ws/${ROOM}?role=sender`);
  const ws = new WebSocket(`${WS_BASE}/ws/${ROOM}?role=sender`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  log('SEND', 'WebSocket 已连接，等待 ready');

  await new Promise((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ready') {
        log('SEND', '收到 ready');
        resolve();
      }
    });
  });

  log('SEND', `发起 POST /stream/${ROOM}`);
  const offer = { type: 'offer', files: [{ name: 'test.bin', size: 1024 }] };
  const offerBytes = Buffer.from(JSON.stringify(offer));
  const dataFrame = Buffer.alloc(1024, 0xAB);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encodeMsg(offerBytes));
      controller.enqueue(encodeMsg(dataFrame));
      controller.close();
    }
  });

  const resp = await fetch(`${BASE}/stream/${ROOM}`, {
    method: 'POST',
    body: stream,
    duplex: 'half',
  });
  log('SEND', `POST 返回: ${resp.status} ${await resp.text()}`);

  const closeResp = await fetch(`${BASE}/stream/${ROOM}/close`, { method: 'POST' });
  log('SEND', `POST /close 返回: ${closeResp.status}`);

  ws.close();
}

async function main() {
  log('TEST', `测试房间: ${ROOM}`);
  const recvPromise = runReceiver();
  await new Promise(r => setTimeout(r, 1000));
  await runSender();
  const result = await recvPromise;
  log('TEST', `完成: frames=${result.frameCount}, bytes=${result.totalBytes}`);
  process.exit(result.frameCount === 1 && result.totalBytes === 1024 ? 0 : 1);
}

main().catch(e => {
  console.error('TEST ERROR:', e);
  process.exit(1);
});

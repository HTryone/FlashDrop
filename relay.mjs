// 本地磁盘模式 —— WebSocket 内存流转中继（不落盘）
//
// 协议（方案 C：管道 WSS 加密 + 文件块 E2EE 加密）：
//   连接：  ws(s)://<host>/relay?room=<ROOM>&role=sender|receiver
//   房间码 ROOM：6 位，仅用于在信令层把两端会合，中继不存储任何文件/密钥。
//
//   控制消息（JSON 文本）：
//     sender   -> relay : {type:'offer', name, size, totalChunks, chunkSize}
//     relay    -> receiver: {type:'offer', ...}            (转发)
//     receiver -> relay : {type:'ready'}
//     relay    -> sender : {type:'ready'}                 (通知可开始发数据)
//     relay    -> peer  : {type:'sender-joined'|'receiver-joined'}
//     relay    -> peer  : {type:'peer-left'}
//     either   -> relay : {type:'bye'}
//
//   数据消息（二进制）：
//     [chunkIndex u32 BE][iv 16B][ciphertext...]
//     密文由发送方浏览器端 E2EE 加密，中继只在内存里转发，看不到明文、不写磁盘。
//
//   任一方断开 -> 通知对端 peer-left -> 房间清空。无有效期、无登录码、关闭即止。

import { WebSocketServer } from 'ws';

export function attachRelay(server) {
  const wss = new WebSocketServer({ server, path: '/relay' });
  const rooms = new Map(); // room -> { sender, receiver }

  wss.on('connection', (ws, req) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      ws.close(1008, 'bad url');
      return;
    }
    const room = url.searchParams.get('room');
    const role = url.searchParams.get('role');
    if (!room || (role !== 'sender' && role !== 'receiver')) {
      ws.close(1008, 'need room & role');
      return;
    }
    ws.room = room;
    ws.role = role;

    let entry = rooms.get(room);
    if (!entry) {
      entry = {};
      rooms.set(room, entry);
    }
    if (role === 'sender') entry.sender = ws;
    else entry.receiver = ws;

    // 1:1 房间里已在场的对端（最多一个）
    const existing = role === 'sender' ? entry.receiver : entry.sender;
    if (existing && existing.readyState === existing.OPEN) {
      // 双向通知：老一端收到「新端加入」，新一端收到「对端已在线」
      existing.send(JSON.stringify({ type: 'peer-joined', role }));
      ws.send(JSON.stringify({ type: 'peer-joined', role: existing.role }));
    }

    ws.on('message', (data, isBinary) => {
      // 内存流转：原样转发给对端，绝不落盘；保持文本/二进制帧类型
      const peer = role === 'sender' ? entry.receiver : entry.sender;
      if (peer && peer.readyState === peer.OPEN) peer.send(data, { binary: isBinary });
    });

    ws.on('close', () => {
      const peer = role === 'sender' ? entry.receiver : entry.sender;
      if (peer && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ type: 'peer-left' }));
      if (entry.sender === ws) entry.sender = null;
      if (entry.receiver === ws) entry.receiver = null;
      if (!entry.sender && !entry.receiver) rooms.delete(room);
    });

    ws.on('error', () => {});
  });

  return wss;
}

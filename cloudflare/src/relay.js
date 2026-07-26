// 每个房间一个 Durable Object 实例，两端 WebSocket 在此会合、内存转发。
// 不落盘：文件数据只在两端 WebSocket 间流过内存。
// 使用 Hibernatable WebSocket：长连接、低内存；配合前端背压，内存只留“飞行中”的窗口。
export class Relay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = {}; // role -> WebSocket
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = url.searchParams.get('room');
    const role = url.searchParams.get('role');
    if (!room || !role) return new Response('need room & role', { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sessions[role] = server;

    const peerRole = role === 'sender' ? 'receiver' : 'sender';
    const peer = this.sessions[peerRole];
    if (peer && peer.readyState === 1) peer.send(JSON.stringify({ type: `${role}-joined` }));

    server.addEventListener('message', (event) => {
      const p = this.sessions[peerRole];
      if (p && p.readyState === 1) p.send(event.data); // 内存流转
    });
    server.addEventListener('close', () => {
      const p = this.sessions[peerRole];
      if (p && p.readyState === 1) p.send(JSON.stringify({ type: 'peer-left' }));
      delete this.sessions[role];
    });
    server.addEventListener('error', () => {});

    return new Response(null, { status: 101, webSocket: client });
  }
}

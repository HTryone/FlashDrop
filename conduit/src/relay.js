// 每个房间一个 Durable Object 实例，两端 WebSocket 在此会合、内存转发。
// 不落盘：文件数据只在两端 WebSocket 间流过内存。
// 使用 Hibernatable WebSocket API（state.acceptWebSocket），生产环境稳定可靠。
export class Relay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = url.searchParams.get('room');
    const role = url.searchParams.get('role');
    if (!room || !role) return new Response('need room & role', { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ room, role });
    this.state.acceptWebSocket(server);

    // 通知对端本端已加入
    const peer = this.findPeer(room, role === 'sender' ? 'receiver' : 'sender');
    if (peer) peer.send(JSON.stringify({ type: `${role}-joined` }));

    return new Response(null, { status: 101, webSocket: client });
  }

  findPeer(room, role) {
    const all = [...this.state.getWebSockets()];
    return all.find((ws) => {
      const att = ws.deserializeAttachment();
      return att && att.room === room && att.role === role;
    });
  }

  webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment();
    const peer = this.findPeer(att.room, att.role === 'sender' ? 'receiver' : 'sender');
    if (peer) peer.send(message); // 内存流转，保留文本/二进制类型
  }

  webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (att) {
      const peer = this.findPeer(att.room, att.role === 'sender' ? 'receiver' : 'sender');
      if (peer) peer.send(JSON.stringify({ type: 'peer-left' }));
    }
    ws.close();
  }

  webSocketError(ws) {
    ws.close();
  }
}

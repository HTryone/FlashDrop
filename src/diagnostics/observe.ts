// 全量请求埋点（§1.6 铁规：所有请求一律都看）。
// 全局包裹 fetch / WebSocket / RTCPeerConnection，自动留痕每一笔网络与协商事件，
// 脱敏（去 query/hash、ICE 候选只留类型），带 traceId（取当前传输上下文）。
// 仅观测、不改写返回/行为，确保不影响被测对象（§1.8 不阻塞业务）。

import { getTrace } from './trace';
import { log } from './logger';

// URL 脱敏：去 query/hash，避免房间码/口令/passphrase 进日志（§1.5 PII）。
function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url, location.origin);
    return u.origin + u.pathname;
  } catch {
    return url.replace(/\?.*$/, '').replace(/#.*$/, '');
  }
}

// ICE 候选脱敏：只留 typ（host/srflx/relay）+ 协议，绝不记 IP（§1.5 PII）。
function sanitizeCandidate(cand: string): string {
  const typ = /typ (\w+)/.exec(cand)?.[1] ?? '?';
  const proto = / (udp|tcp) /.test(cand) ? (cand.includes(' udp ') ? 'udp' : 'tcp') : '?';
  return `${typ}/${proto}`;
}

function attachTrace(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  const t = getTrace();
  return t ? { ...(data ?? {}), traceId: t } : data;
}

export function installObservers(): void {
  installFetch();
  installWebSocket();
  installWebRTC();
}

function installFetch() {
  if (!(globalThis as any).fetch || (globalThis as any).__diagFetchWrapped) return;
  const orig = (globalThis as any).fetch.bind(globalThis);
  (globalThis as any).__diagFetchWrapped = true;
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? '';
    const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
    const saUrl = sanitizeUrl(url);
    const attempt = init?.__attempt ?? 0;
    const t0 = performance.now();
    log('debug', 'net', 'fetch', `[req] ${method} ${saUrl}`, attachTrace({ attempt }));
    try {
      const resp = await orig(input, init);
      const dt = Math.round(performance.now() - t0);
      const cl = resp.headers?.get?.('content-length');
      const bytes = cl ? Number(cl) : undefined;
      log(
        resp.ok ? 'debug' : 'warn',
        'net', 'fetch',
        `[res] ${method} ${saUrl} -> ${resp.status} (${dt}ms)`,
        attachTrace({ status: resp.status, ms: dt, bytes, attempt }),
      );
      return resp;
    } catch (e: any) {
      const dt = Math.round(performance.now() - t0);
      log('error', 'net', 'fetch', `[err] ${method} ${saUrl} -> ${e?.message ?? e} (${dt}ms)`,
        attachTrace({ attempt, err: String(e?.name ?? e) }));
      throw e;
    }
  };
}

function installWebSocket() {
  const W = (globalThis as any).WebSocket;
  if (!W || W.__diagWsWrapped) return;
  W.__diagWsWrapped = true;
  const Orig = W as typeof WebSocket;
  const Wrapped = class extends Orig {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols as any);
      const sa = sanitizeUrl(String(url));
      log('debug', 'net', 'ws', `[new] ${sa}`, attachTrace());
      this.addEventListener('open', () => log('info', 'net', 'ws', `[opened] ${sa}`, attachTrace()));
      this.addEventListener('close', (e: any) =>
        log('info', 'net', 'ws', `[close] ${sa} code=${e.code} clean=${e.wasClean}`, attachTrace({ code: e.code, clean: e.wasClean })));
      this.addEventListener('error', () =>
        log('warn', 'net', 'ws', `[error] ${sa}`, attachTrace()));
      // 控制消息级埋点（§1.7 WebSocket 具体点）：方向 + type
      const send = this.send.bind(this);
      (this as any).send = (data: any) => {
        const type = typeof data === 'string' ? safeWsType(data) : 'binary';
        log('debug', 'net', 'ws', `[send] ${sa} ${type}`, attachTrace({ dir: 'out', type }));
        return send(data);
      };
    }
  } as any;
  (globalThis as any).WebSocket = Wrapped;
}

function safeWsType(data: string): string {
  try { const o = JSON.parse(data); return o?.type ?? 'json'; } catch { return 'text'; }
}

function installWebRTC() {
  const RPC = (globalThis as any).RTCPeerConnection;
  if (!RPC || RPC.prototype.__diagWrapped) return;
  const proto = RPC.prototype;
  proto.__diagWrapped = true;

  // 先保存原始方法引用，再包裹（避免调用链错乱）。
  const origCreateOffer = proto.createOffer;
  const origCreateAnswer = proto.createAnswer;
  const origSetLocal = proto.setLocalDescription;
  const origSetRemote = proto.setRemoteDescription;
  const origAddEv = proto.addEventListener;

  const wrapDesc = (orig: (...a: any[]) => Promise<any>, name: string) => {
    return function (this: any, ...args: any[]) {
      return orig.apply(this, args).then((desc: any) => {
        log('debug', 'p2p', 'negotiate', `[${name}] ${desc?.type ?? '?'} sdpLen=${desc?.sdp?.length ?? 0}`,
          attachTrace({ type: desc?.type, sdpLen: desc?.sdp?.length ?? 0 }));
        return desc;
      }, (e: any) => {
        log('error', 'p2p', 'negotiate', `[${name}] 失败: ${e?.message ?? e}`, attachTrace());
        throw e;
      });
    };
  };
  proto.createOffer = wrapDesc(origCreateOffer, 'createOffer');
  proto.createAnswer = wrapDesc(origCreateAnswer, 'createAnswer');
  proto.setLocalDescription = function (...args: any[]) {
    const d = args[0];
    log('debug', 'p2p', 'negotiate', `[setLocalDescription] ${d?.type ?? '?'} sdpLen=${d?.sdp?.length ?? 0}`,
      attachTrace({ type: d?.type }));
    return origSetLocal.apply(this, args);
  };
  proto.setRemoteDescription = function (...args: any[]) {
    const d = args[0];
    log('debug', 'p2p', 'negotiate', `[setRemoteDescription] ${d?.type ?? '?'} sdpLen=${d?.sdp?.length ?? 0}`,
      attachTrace({ type: d?.type }));
    return origSetRemote.apply(this, args);
  };

  proto.addEventListener = function (type: string, ...rest: any[]) {
    if (type === 'icecandidate') {
      const [cb, opt] = rest;
      const wrapped = (e: any) => {
        if (e?.candidate) {
          log('debug', 'p2p', 'negotiate', `[icecandidate] ${sanitizeCandidate(e.candidate.candidate ?? '')}`,
            attachTrace({ candidate: sanitizeCandidate(e.candidate.candidate ?? '') }));
        } else {
          log('debug', 'p2p', 'negotiate', `[icecandidate] null (归集完成)`, attachTrace());
        }
        cb?.(e);
      };
      return origAddEv.call(this, type, wrapped, opt);
    }
    if (type === 'connectionstatechange' || type === 'iceconnectionstatechange' || type === 'signalingstatechange' || type === 'icegatheringstatechange') {
      const [cb, opt] = rest;
      const wrapped = () => {
        const st = (type === 'connectionstatechange') ? this.connectionState
          : type === 'iceconnectionstatechange' ? this.iceConnectionState
          : type === 'signalingstatechange' ? this.signalingState
          : this.iceGatheringState;
        log(type === 'connectionstatechange' && (st === 'failed' || st === 'disconnected') ? 'warn' : 'info',
          'p2p', 'negotiate', `[${type}] ${st}`, attachTrace({ state: st }));
        cb?.();
      };
      return origAddEv.call(this, type, wrapped, opt);
    }
    if (type === 'datachannel') {
      const [cb, opt] = rest;
      const wrapped = (e: any) => {
        log('info', 'p2p', 'negotiate', `[datachannel] ${e?.channel?.label ?? '?'}`,
          attachTrace({ label: e?.channel?.label }));
        cb?.(e);
      };
      return origAddEv.call(this, type, wrapped, opt);
    }
    return origAddEv.call(this, type, ...rest);
  };
}

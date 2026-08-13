// 中转（TUS）接收端：单文件下载状态机（Vue 层）。
// 与 useRelayTransfer.ts（发送端会话状态机）对称——本文件是接收端的 Vue 层状态机，
// 底层流式落盘/解密在 stream-download.ts（非 Vue 引擎，可复用、可单测）。
// 放 src/transfer/tus/，遵循目录纪律（按传输方式分域，不新建兜底夹）。
// 铁律（2026-08-13 确立，不可删）：核心业务逻辑永远在此类 TypeScript 中实现，
// Vue 组件（ReceiveFileRow.vue）仅承担框架层职责（模板 + props 透传 + 事件绑定）。
import { ref, computed } from 'vue';
import type { ReceivedFile } from '@/types/transfer';
import { resolveTusBase } from '@/transfer/room';
import { streamDownloadToSink, type DownloadManifest } from '@/transfer/tus/stream-download';

/** 5s 滑动窗口瞬时速度采样器：替代全程平均，治 UI 滞后 + 速度失真。纯函数式，可单测。 */
class SpeedSampler {
  private samples: { t: number; r: number }[] = [];
  /** 每收到一段密文调用一次，记录当前累计接收字节与时间。 */
  push(received: number): void {
    const now = performance.now();
    this.samples.push({ t: now, r: received });
    while (this.samples.length > 1 && now - this.samples[0].t > 5000) this.samples.shift();
  }
  /** 返回真实瞬时速度（MB/s），窗口不足 2 个样本时为 0。 */
  speedMBps(): number {
    if (this.samples.length < 2) return 0;
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt > 0 ? (b.r - a.r) / 1048576 / dt : 0;
  }
}

export function useReceiveFile(props: {
  file: ReceivedFile;
  code: string;
  e2eeKey: string | null;
  encrypted: boolean;
}) {
  const busy = ref(false);
  const done = ref(false);
  const err = ref('');
  const progress = ref(0); // 0~1
  const speed = ref(0);    // MB/s
  const phase = ref('');
  let activeAbort: AbortController | null = null; // 当前下载的 AbortController，供“取消”按钮中断后台请求

  // 网络类错误（超时/失败）才提示网络原因；取消、授权失败不算网络问题
  const isNetworkError = computed(() => {
    const m = err.value;
    if (!m) return false;
    if (m.includes('取消') || m.includes('授权')) return false;
    return true;
  });

  async function onDownload() {
    err.value = '';
    done.value = false;
    busy.value = true;
    progress.value = 0;
    speed.value = 0;
    phase.value = '准备中…';
    const stats = { received: 0, total: 0 };
    const sampler = new SpeedSampler();
    // 每段密文到达即刷新进度 / 速度，不再依赖 setInterval 轮询（治 UI 滞后 + 速度失真）
    const onChunk = (delta: number) => {
      stats.received += delta;
      progress.value = stats.total ? Math.min(1, stats.received / stats.total) : 0;
      sampler.push(stats.received);
      speed.value = sampler.speedMBps();
    };
    const abortCtrl = new AbortController();
    activeAbort = abortCtrl; // 暴露给取消按钮
    try {
      const base = resolveTusBase();
      const manifestUrl = `${base}/download/${props.code}/${props.file.id}`;
      const mResp = await fetch(manifestUrl);
      if (!mResp.ok) throw new Error('获取下载信息失败 ' + mResp.status);
      const manifest: DownloadManifest = await mResp.json();
      stats.total = manifest.total;
      phase.value = '拉取加密数据中…';
      // 流式落盘（边下边解密边写盘）在 stream-download.ts 内完成，此处只驱动进度与状态
      const res = await streamDownloadToSink({ manifest, e2eeKey: props.e2eeKey, onChunk, signal: abortCtrl.signal });
      phase.value = '已保存到本机';
      progress.value = 1;
      done.value = true;
      if (res.permissionFallback) {
        // FSA 授权失败，已降级 StreamSaver/Blob 浏览器下载，文件仍会落地；给轻提示让用户知情
        err.value = '保存目录授权失败，已改用浏览器默认下载';
      }
    } catch (e: any) {
      const wasCancelled = abortCtrl.signal.aborted; // 用户主动取消时，catch 触发前信号已置位
      abortCtrl.abort(); // 出错/取消时立即终止所有后台 fetch，避免继续拉取浪费流量
      if (e?.message === 'SAVE_DIR_DENIED') {
        err.value = '保存目录授权失败，请重试';
      } else {
        err.value = wasCancelled ? '已取消下载' : (e?.message || '下载失败');
      }
    } finally {
      busy.value = false;
      activeAbort = null;
    }
  }

  function cancelDownload() {
    activeAbort?.abort(); // 复用同一 abort 路径，立即中断所有后台 fetch（用户手动取消）
  }

  return {
    busy, done, err, progress, speed, phase, isNetworkError,
    onDownload, cancelDownload,
  };
}

// 弹性滚动（过界回弹）：逻辑层，不塞进 .vue。
// 安卓原生 WebView 没有 iOS 那种橡皮筋，这里手写「到顶/到底还想滑 → 阻尼位移 → 松手回弹」。
// UI 只负责挂载（传入滚动容器 ref），不写任何手势/动画逻辑。
import { onMounted, onUnmounted, type Ref } from 'vue';

/**
 * 给滚动容器挂过界回弹。
 * @param target 滚动容器的元素 ref（如 App 的 .main）
 * @param options.damping 阻尼系数，越小回弹越「紧」
 */
export function useRubberBand(target: Ref<HTMLElement | null>, options?: { damping?: number }) {
  const damping = options?.damping ?? 0.4;
  let startY = 0;
  let currentOffset = 0;
  let isRubber = false;
  let ticking = false;

  function onTouchStart(e: TouchEvent) {
    const el = target.value;
    if (!el) return;
    startY = e.touches[0].clientY;
    currentOffset = 0;
    isRubber = false;
  }

  function onTouchMove(e: TouchEvent) {
    const el = target.value;
    if (!el) return;
    const y = e.touches[0].clientY;
    const dy = y - startY;
    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;

    // 仅在「已到边界仍想继续滑」时进入橡皮筋，否则放行原生滚动
    if ((atTop && dy > 0) || (atBottom && dy < 0)) {
      if (!isRubber) {
        isRubber = true;
        startY = y; // 以过界点为新基准，避免一次性跳变
      }
      e.preventDefault(); // 阻止原生滚动，改由我们接管位移
      const delta = y - startY;
      currentOffset = delta * damping;
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          if (target.value) target.value.style.transform = `translateY(${currentOffset}px)`;
          ticking = false;
        });
      }
    }
  }

  function onTouchEnd() {
    const el = target.value;
    if (!el || !isRubber) {
      isRubber = false;
      currentOffset = 0;
      return;
    }
    el.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)';
    el.style.transform = 'translateY(0)';
    const cleanup = () => {
      el.style.transition = '';
      el.style.transform = '';
      el.removeEventListener('transitionend', cleanup);
    };
    el.addEventListener('transitionend', cleanup);
    isRubber = false;
    currentOffset = 0;
  }

  onMounted(() => {
    const el = target.value;
    if (!el) return;
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
  });

  onUnmounted(() => {
    const el = target.value;
    if (!el) return;
    el.removeEventListener('touchstart', onTouchStart);
    el.removeEventListener('touchmove', onTouchMove);
    el.removeEventListener('touchend', onTouchEnd);
    el.removeEventListener('touchcancel', onTouchEnd);
  });
}

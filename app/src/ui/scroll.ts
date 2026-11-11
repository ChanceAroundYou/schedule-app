import { useCallback, useEffect, useRef } from 'react';

/**
 * 浮条：滚动条**浮在内容上、不占位**（用户 2026-10-09 报「滚动条不要占位置，
 * 不要挤现有元素」）。
 *
 * 原生滚动条在 Linux / Windows 上是**占位**的：容器一滚起来，内容就被挤窄
 * 一截，行里的东西跟着左右晃。这里把原生那条藏掉（样式在 tokens.css 的 `.osb`），
 * 自己在容器里画一根 4px 的，位置与原生那条**完全一致**（贴着内容盒右边），
 * 所以看着还是原来那根，只是不占地方了。
 *
 * 用法：
 *   const osb = useOverlayScrollbar<HTMLDivElement>();
 *   <div className="… osb" ref={osb}>
 *
 * 容器必须是 `position: relative` —— 钩子会自己补上，卸载时还原成原样。
 * 已经拿了一个 ref 的话把它传进来，钩子会一起写：
 *   useOverlayScrollbar<HTMLDivElement>(contentRef)。
 *
 * **2026-11-09 显示时机**：默认不主动显示，只有真的滚动（或拖动浮条）时淡入，
 * 停下来 800ms 淡出 —— 与 touchDamp.ts 的 THUMB_IDLE 同一口径。
 * 以前 paint() 里写 `opacity = can ? 1 : 0`：只要内容溢出就常显，而且
 * ResizeObserver / MutationObserver 每次重画都把它重新点亮，永远不淡出。
 *
 * ⚠️ **只挂在能上下滚的容器上**。这根轨道是竖向的（右侧 4px，滑块按
 * scrollTop 定位）；给纯横向容器挂上，滑块会永远钉在顶端、还会跟着内容
 * 横移 —— 2026-11-11 用户报的「周视图周四与周五之间的灰色短条」就是这个。
 * 横向容器保留 `.osb` class 隐藏原生条即可，不要调用本钩子。
 */
const OSB_IDLE = 800;

export function useOverlayScrollbar<T extends HTMLElement>(outer?: { current: T | null }) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = getComputedStyle(el).position;
    if (prev === 'static') el.style.position = 'relative';

    const track = document.createElement('div');
    track.className = 'osb-track';
    track.setAttribute('aria-hidden', 'true');
    const thumb = document.createElement('div');
    thumb.className = 'osb-thumb';
    track.appendChild(thumb);
    el.appendChild(track);

    let raf = 0;
    let idle = 0;
    let dragging = false;

    /** 只更新几何。没有纵向滚动空间的容器连滑块都不留 —— 见 reveal() 的回归注释 */
    const paint = () => {
      raf = 0;
      const view = el.clientHeight;
      const full = el.scrollHeight;
      const can = full > view + 1;
      if (!can) {
        track.style.opacity = '0';
        thumb.style.height = '0px';
        return;
      }
      /* 最短 26px —— 再短就没法点了 */
      const h = Math.max(26, Math.round((view * view) / full));
      thumb.style.height = h + 'px';
      /* ⚠️ **要加 el.scrollTop**：轨道是滚动容器里的绝对定位子元素，跟着内容
         一起滚；不补偿的话一滚浮条就跑到可视区上面（同一个病根，见
         app/src/app/touchDamp.ts 的 ::after 浮条，2026-10-23 一并修）。 */
      thumb.style.transform = `translateY(${Math.round(el.scrollTop + (el.scrollTop / (full - view)) * (view - h))}px)`;
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };

    /**
     * 只有真实滚动 / 拖动才调用：淡入，停手后计时淡出。拖着不放时不计时。
     *
     * **2026-11-11 回归教训**：昨天为修「切视图闪一下」把判据放宽成
     * `canY || canX`，结果每次**横向**滑动都会点亮这根**竖向**浮条：
     * 周视图没有纵向滚动空间 → 滑块永远钉在表头顶端；轨道是 absolute 定位、
     * 跟着内容一起横移 → 落在「周四与周五之间」。
     * 放宽判据 ≠ 支持横向滚动：横向容器要的是底部横条，是另一套东西。
     * 现在只认纵向，且周 / 三日视图已不再挂本钩子（见 WeekView）。
     */
    const reveal = () => {
      if (el.scrollHeight <= el.clientHeight + 1) return;
      /* 停在原点 = 只是内容变高 / 位置被归零，不是用户真的滚了 */
      if (el.scrollTop <= 0) return;
      track.style.opacity = '1';
      window.clearTimeout(idle);
      if (!dragging) idle = window.setTimeout(() => { track.style.opacity = '0'; }, OSB_IDLE);
    };
    const onScroll = () => { schedule(); reveal(); };

    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    /* 内容自己会长高（任务落地、抽屉展开）—— 那时候一个 scroll 事件都没有，
       但只该重算几何，不该让浮条平白冒出来 */
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true });

    /* 拖浮条 = 滚容器。触屏上也认，所以 thumb 自己 `touch-action: none`。 */
    let y0 = 0;
    let top0 = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      reveal();
      y0 = e.clientY;
      top0 = el.scrollTop;
      try { thumb.setPointerCapture(e.pointerId); } catch { /* 指针已经走了 */ }
      e.preventDefault();
    };
    const move = (e: PointerEvent) => {
      const view = el.clientHeight;
      const full = el.scrollHeight;
      const h = thumb.offsetHeight || 1;
      el.scrollTop = top0 + (e.clientY - y0) * ((full - view) / Math.max(1, view - h));
    };
    const up = (e: PointerEvent) => {
      dragging = false;
      reveal();
      try { thumb.releasePointerCapture(e.pointerId); } catch { /* 同上 */ }
    };
    thumb.addEventListener('pointerdown', down);
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', up);
    thumb.addEventListener('pointercancel', up);

    paint();
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(idle);
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      mo.disconnect();
      thumb.removeEventListener('pointerdown', down);
      thumb.removeEventListener('pointermove', move);
      thumb.removeEventListener('pointerup', up);
      thumb.removeEventListener('pointercancel', up);
      track.remove();
      if (prev === 'static') el.style.position = '';
    };
  }, []);

  return useCallback((el: T | null) => {
    ref.current = el;
    if (outer) outer.current = el;
  }, [outer]);
}

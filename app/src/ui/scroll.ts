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
 */
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
    const paint = () => {
      raf = 0;
      const view = el.clientHeight;
      const full = el.scrollHeight;
      const can = full > view + 1;
      /* 最短 26px —— 再短就没法点了 */
      const h = can ? Math.max(26, Math.round((view * view) / full)) : 0;
      thumb.style.height = h + 'px';
      thumb.style.transform = can && full > view
        ? `translateY(${Math.round((el.scrollTop / (full - view)) * (view - h))}px)`
        : 'none';
      track.style.opacity = can ? '1' : '0';
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };

    el.addEventListener('scroll', schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    /* 内容自己会长高（任务落地、抽屉展开）—— 那时候一个 scroll 事件都没有 */
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true });

    /* 拖浮条 = 滚容器。触屏上也认，所以 thumb 自己 `touch-action: none`。 */
    let y0 = 0;
    let top0 = 0;
    const down = (e: PointerEvent) => {
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
      try { thumb.releasePointerCapture(e.pointerId); } catch { /* 同上 */ }
    };
    thumb.addEventListener('pointerdown', down);
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', up);
    thumb.addEventListener('pointercancel', up);

    paint();
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', schedule);
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

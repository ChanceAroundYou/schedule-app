/**
 * resizeTimeline.ts —— 拉伸时间轴上下沿（鼠标 + 触屏）
 */

import { useEffect } from 'react';
import type { Task } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import * as store from '../data/store.ts';
import { HOUR_H, spanOf, type DayWindow } from '../domain/layout.ts';
import { domWindow } from './domWindow.ts';

/**
 * 拉伸时间轴上下沿（鼠标 + 触屏）。
 *
 * 拉伸全程按**实测**高度换算：时间轴高度随窗口和屏幕变，写死 HOUR_H 会越拖越偏。
 * 把时间窗和像素高度在按下那一刻一起存住，move 里直接用。
 */
function useResizeTimeline(host: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let rz: {
      id: string; y: number; edge: 'top' | 'bottom';
      start: number; end: number; dur: number; cur: number; curStart?: number;
      el: HTMLElement | null;
      /** 按下那一刻的时间窗与时间轴实测高度 —— 拉伸全程只用这一份，中途不重测 */
      win: DayWindow; boxH: number;
    } | null = null;

    /* 拉伸时的浮标：只显示持续时长。
       上沿拖动时 tag 在卡片**上方**，下沿拖动时在**下方**。 */
    let tip: HTMLDivElement | null = null;
    const showTip = (el: HTMLElement | null, dur: number, edge: 'top' | 'bottom') => {
      if (!el) return;
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'tl-dur-tag';
        document.body.appendChild(tip);
      }
      const r = el.getBoundingClientRect();
      tip.style.top = (edge === 'top' ? r.top - 26 : r.bottom + 6) + 'px';
      tip.style.left = r.left + 'px';
      tip.textContent = D.fmtDuration(dur);
    };
    const hideTip = () => { tip?.remove(); tip = null; };

    const getY = (e: MouseEvent | TouchEvent): number =>
      'touches' in e ? e.touches[0]?.clientY ?? 0 : e.clientY;

    const down = (e: MouseEvent | TouchEvent) => {
      const h = (e.target as HTMLElement).closest<HTMLElement>('[data-act="resize"],[data-act="resize-top"]');
      if (!h) return;
      const t = store.get().tasks[h.dataset.id || ''];
      if (!t) return;
      const start = D.timeToMin(t.time) || 0;
      const tl = el.querySelector<HTMLElement>('.timeline');
      const boxH = tl?.getBoundingClientRect().height || HOUR_H * 24;
      rz = {
        id: t.id, y: getY(e),
        edge: h.dataset.act === 'resize-top' ? 'top' : 'bottom',
        start, end: start + D.durOf(t.duration), dur: D.durOf(t.duration), cur: D.durOf(t.duration),
        el: el.querySelector<HTMLElement>(`.task-el--timed[data-id="${t.id}"]`),
        win: domWindow(tl), boxH,
      };
      rz.el?.classList.add('resizing');
      showTip(rz.el, rz.dur, rz.edge);
      e.preventDefault();
    };

    /* 分钟 → 纵向百分比。日视图的方块高度是百分比定位，跟这里必须同一种算法。 */
    const pct = (min: number) => (min - rz!.win.from) / spanOf(rz!.win) * 100;

    const move = (e: MouseEvent | TouchEvent) => {
      if (!rz) return;
      const minPerPx = spanOf(rz.win) / rz.boxH;
      const addMin = Math.round((getY(e) - rz.y) * minPerPx / 15) * 15;
      if (rz.edge === 'top') {
        // 底边固定：不能越过底边、不能早于 0:00
        const ns = Math.max(0, Math.min(rz.end - 15, rz.start + addMin));
        rz.curStart = ns;
        rz.cur = rz.end - ns;
        if (rz.el) {
          rz.el.style.top = pct(ns) + '%';
          rz.el.style.height = (rz.cur / spanOf(rz.win) * 100) + '%';
        }
      } else {
        rz.cur = Math.max(15, rz.dur + addMin);
        if (rz.el) rz.el.style.height = (rz.cur / spanOf(rz.win) * 100) + '%';
      }
      showTip(rz.el, rz.cur, rz.edge);
    };

    const up = () => {
      if (!rz) return;
      const patchFields: Partial<Task> = { duration: Math.max(15, rz.cur) };
      if (rz.edge === 'top' && rz.curStart != null) patchFields.time = D.minToTime(rz.curStart);
      rz.el?.classList.remove('resizing');
      hideTip();
      const id = rz.id;
      rz = null;
      store.patchTask(id, patchFields);
    };

    el.addEventListener('mousedown', down);
    el.addEventListener('touchstart', down, { passive: false });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('mouseup', up);
    document.addEventListener('touchend', up);
    return () => {
      el.removeEventListener('mousedown', down);
      el.removeEventListener('touchstart', down);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('mouseup', up);
      document.removeEventListener('touchend', up);
    };
  }, [host]);
}

export { useResizeTimeline };

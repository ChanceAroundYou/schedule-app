/**
 * resizeTimeline.ts —— 拉伸时间轴上下沿（鼠标 + 触屏）
 */

import { useEffect } from 'react';
import type { Task } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import * as store from '../data/store.ts';
import { HOUR_H, spanOf, type DayWindow } from '../domain/layout.ts';
import { drawTimeGuide, drawTimeCursor, clearTimeCursor, clearTimeGuide } from '../ui/dnd/guide.ts';
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
      /** 时间轴元素 —— 绿线/绿时间的宿主，跟 win 一起按下时存住 */
      tl: HTMLElement | null;
    } | null = null;
    let active = false;

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

    /* 触屏长按 100ms 才激活：避免划过误触。鼠标路径保持立即激活。 */
    let pendingTimer: number | null = null;
    let pendingStart: { x: number; y: number } | null = null;

    const activate = () => {
      if (!rz) return;
      active = true;
      rz.el?.classList.add('resizing');
      showTip(rz.el, rz.dur, rz.edge);
      if (rz.tl) {
        const at = rz.edge === 'top' ? rz.start : rz.end;
        drawTimeGuide(rz.tl, at, rz.win);
        drawTimeCursor(rz.tl, at, rz.win);
      }
    };

    const cancelPending = () => {
      if (pendingTimer != null) { clearTimeout(pendingTimer); pendingTimer = null; }
      pendingStart = null;
      active = false;
    };

    const down = (e: MouseEvent | TouchEvent) => {
      const h = (e.target as HTMLElement).closest<HTMLElement>('[data-act="resize"],[data-act="resize-top"]');
      if (!h) return;
      const t = store.get().tasks[h.dataset.id || ''];
      if (!t) return;
      const start = D.timeToMin(t.time) || 0;
      const tl = h.closest<HTMLElement>('.timeline, [data-timeline]');
      const boxH = tl?.getBoundingClientRect().height || HOUR_H * 24;
      rz = {
        id: t.id, y: getY(e),
        edge: h.dataset.act === 'resize-top' ? 'top' : 'bottom',
        start, end: start + D.durOf(t.duration), dur: D.durOf(t.duration), cur: D.durOf(t.duration),
        /* **从把手往上找自己那张卡**，不用全局 `[data-id=]` 抓：同一个任务可能
           同时存在于两处（视图切换的过渡帧、周视图 + 日视图同屏），全局查到的
           第一个未必是手里这张 —— 改错元素时卡片不动、绿线却按另一张卡的几何走，
           看起来就是「手指和线条差一截」。 */
        el: h.closest<HTMLElement>('.task-el'),
        win: domWindow(tl), boxH, tl,
      };
      active = false;
      const isTouch = 'touches' in e;
      if (isTouch) {
        pendingStart = { x: (e as TouchEvent).touches[0]?.clientX ?? 0, y: getY(e) };
        pendingTimer = window.setTimeout(() => {
          pendingTimer = null; pendingStart = null;
          if (rz) { active = true; activate(); }
        }, 250);
      } else {
        active = true;
        activate();
      }
      e.preventDefault();
    };

    /* 分钟 → 纵向百分比。日视图的方块高度是百分比定位，跟这里必须同一种算法。 */
    const pct = (min: number) => (min - rz!.win.from) / spanOf(rz!.win) * 100;

    const move = (e: MouseEvent | TouchEvent) => {
      /* 长按期间移动超过容差 → 取消激活（避免误触） */
      if (pendingTimer != null && pendingStart) {
        /* ⚠️ dx 必须是**相对按下点的位移**。这里原来写的是
           `touches?.[0]?.clientX ?? (e as MouseEvent).clientX - pendingStart.x` ——
           `??` 的左边在触屏上取到的是**绝对坐标**（几百 px 起步），`- pendingStart.x`
           只挂在右边那条鼠标分支上。于是长按那 250ms 里手指只要动一下，hypot 必然
           超过 8px → 判成误触 → 激活被取消 → 手指接着拖也拖不动，用户看到的就是
           「按住了却拉不动 / 手指和线条差一截」（2026-11-02 手机端报障）。 */
        const pt = (e as TouchEvent).touches?.[0] ?? (e as MouseEvent);
        if (Math.hypot(pt.clientX - pendingStart.x, getY(e) - pendingStart.y) > 8) cancelPending();
        return;
      }
      if (!rz || !active) return;
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
      /* 绿线跟到**正在拖的那条沿**：上沿 = 新开始时间，下沿 = 新结束时间。
         和整体拖拽的绿线是同一个 DOM 操作（guide.ts），只是喂进去的分钟值
         跟着当前沿走，所以拉伸时也有落点预览。 */
      if (rz.tl) {
        const at = rz.edge === 'top' ? (rz.curStart ?? rz.start) : rz.end - rz.dur + rz.cur;
        drawTimeGuide(rz.tl, at, rz.win);
        drawTimeCursor(rz.tl, at, rz.win);
      }
    };

    /* 收尾：把这一轮拉伸留下的视觉痕迹清干净（绿框 / 时长浮标 / 绿线 / 绿时间）。
       **不含写库** —— 写不写由调用方决定：正常松手写，被系统打断的触屏手势只撤销。 */
    const cleanup = (r: NonNullable<typeof rz>) => {
      r.el?.classList.remove('resizing');
      hideTip();
      clearTimeGuide();
      clearTimeCursor();
    };

    /**
     * 一次拉伸手势的终点。`commit=false` 时只清理、不写库（touchcancel / 窗口失焦）。
     *
     * ⚠️ **顺序是这条链上最容易被写坏的地方**（2026-11-02 用户报「拉完时长没变、
     * 卡片一直停在绿框、结束时间上还挂着一条绿虚线」）：不能再写成
     * `cancelPending(); if (!active) return;` —— `cancelPending()` 里会把
     * `active` 清成 false，于是**每一次正常松手**都命中「没激活」那条分支，
     * 写库和四样清理全部被跳过，只留下界面上的残局和没改的数据。
     * 现在的写法：先把状态取成快照、再在同一处清干净，最后才按快照决定写不写。
     */
    const endGesture = (commit: boolean) => {
      if (pendingTimer != null) { clearTimeout(pendingTimer); pendingTimer = null; }
      pendingStart = null;
      const wasActive = active;
      active = false;
      const r = rz;
      rz = null;
      if (!r) return;
      cleanup(r);
      /* 触屏轻点把手（长按没到 250ms 就抬手）→ 什么都没改，收干净就走 */
      if (!commit || !wasActive) return;
      const patchFields: Partial<Task> = { duration: Math.max(15, r.cur) };
      if (r.edge === 'top' && r.curStart != null) patchFields.time = D.minToTime(r.curStart);
      store.patchTask(r.id, patchFields);
    };

    const up = () => endGesture(true);
    /* 系统把手势抢走（来电话、通知栏下拉）时不会给 touchend —— 不兜这一下，
       绿线和绿框就永远留在屏幕上，直到用户再拉一次别的卡。 */
    const abort = () => endGesture(false);

    el.addEventListener('mousedown', down);
    el.addEventListener('touchstart', down, { passive: false });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('mouseup', up);
    document.addEventListener('touchend', up);
    document.addEventListener('touchcancel', abort);
    window.addEventListener('blur', abort);
    return () => {
      el.removeEventListener('mousedown', down);
      el.removeEventListener('touchstart', down);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('mouseup', up);
      document.removeEventListener('touchend', up);
      document.removeEventListener('touchcancel', abort);
      window.removeEventListener('blur', abort);
    };
  }, [host]);
}

export { useResizeTimeline };

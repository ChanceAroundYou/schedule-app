/**
 * dragCreate.ts —— 时间轴上「按住拉出一段时间」就地新建
 *
 * ## 为什么自己一条链路，而不是接 dnd-kit
 *
 * dnd-kit 那套是**搬东西**：先要有一个 draggable（已有任务），再挪到某个
 * droppable。这里要做的是**凭空画出一段时间** —— 按下那一刻还没有任何实体，
 * 松手才诞生一条草稿。两者会在 pointerdown 那一刻抢同一个事件，所以分开：
 * 这里只在「空白处按下」时接管，而且**要不要真的变成拉框由位移阈值决定** ——
 * 没超过阈值就什么都不做，退化回原来的「点空白就地新建」。
 *
 * ## 三段取舍（用户 2026-10-17 定的手感）
 *
 * · **15 分钟对齐、最短 30 分钟**。15 分钟是日历的最小刻度感，再细瞄不准；
 *   30 分钟是「点一下、手抖了一像素」的兜底下限 —— 否则一次误操作就造出
 *   一条 0 分钟的日程。
 * · **向上拉也算**：往回拉等于「把开始时间往前推」，这是时间轴的常识。
 * · **只认鼠标**（`pointerType === 'mouse'`）。手指按在触屏上是滚动列表的意思，
 *   让它同时也算「拉框」会变成两种手势互抢 —— 周视图本来就是要竖着滚的。
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import * as D from '../../domain/date.ts';
import { dragRange, spanOf, type DayWindow } from '../../domain/layout.ts';
import { settleDraftAndSet } from '../../ui/newCell.ts';

/** 吸附步长（分钟） */
export const DRAG_SNAP = 15;
/** 位移超过这么多像素才算「拉」，否则当成「点」交给原来的流程 */
const THRESHOLD = 6;

/** 正在拉的那一段时间。`zone` / `date` 决定松手后草稿落在哪 */
export interface DragRange {
  start: number;
  end: number;
  zone: string;
  date: string;
}

/** 按下这一点属于哪个时间轴 / 哪一列 */
export interface DragFrame {
  /** drop zone 的 id（`timeline:2026-10-17` / `week:2026-10-17`） */
  zone: string;
  date: string;
  /** 拿 rect 的那一层：它的顶边代表 `win.from`，它的底边代表 `win.to` */
  frame: HTMLElement;
}

const snap15 = (m: number): number => Math.round(m / DRAG_SNAP) * DRAG_SNAP;

/* 「起止怎么算」（收进窗内、向上拉的含义）在 domain/layout.ts 的 `dragRange()`
   —— 它是纯函数，和其他窗口换算一起由 domain.test.ts 覆盖；这里只管事件。 */

/**
 * 松手之后浏览器还会补一次 `click`，那一下会走老流程 —— 「按松手位置开草稿」，
 * 于是刚拉出来的时长被一个 60 分钟的默认值冲掉。这里把那一下拦掉。
 *
 * 只拦一次、400ms 后自动解除：万一这次拖拽最后没产生 click（比如在框外松手），
 * 也不能把用户之后的正常点击吃掉。
 */
function suppressClick(): void {
  const block = (ev: Event) => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  document.addEventListener('click', block, { capture: true, once: true });
  window.setTimeout(() => document.removeEventListener('click', block, { capture: true }), 400);
}

/**
 * 时间轴上的「拉一段时间」。**同一个 hook 服务日视图和周视图** —— 两者的差别
 * 只有「哪个 DOM 节点代表时间窗」（`zoneAt` 回答），换算与结算共用一份。
 */
export function useDragCreate({ win, zoneAt }: {
  win: DayWindow;
  /** 按下点在哪个时间轴的哪一列。返回 null = 这一下不参与拉框 */
  zoneAt: (target: HTMLElement) => DragFrame | null;
}): { range: DragRange | null; onPointerDown: (e: ReactPointerEvent) => void } {
  const [range, setRange] = useState<DragRange | null>(null);
  /* 卸载时兜底拆监听：拖到一半切了视图，pointerup 就没人收了 */
  const clean = useRef<(() => void) | null>(null);
  useEffect(() => () => clean.current?.(), []);

  const onPointerDown = (e: ReactPointerEvent): void => {
    /* 触屏留给滚动；中键/右键另有他用 */
    if (e.button !== 0 || e.pointerType !== 'mouse') return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    /* 任务卡（自带拖拽）、草稿输入框、任何行内按钮都不接管 ——
       它们是「操作已有的一条」，不是「拉出一条新的」 */
    if (target.closest('.task-el, .new-cell, [data-act], button')) return;

    const hit = zoneAt(target);
    if (!hit) return;

    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    let cur: DragRange | null = null;

    /** 纵坐标 → 分钟。每帧重取 rect：拖的过程中容器可能被滚过 */
    const minAt = (clientY: number): number => {
      const r = hit.frame.getBoundingClientRect();
      if (r.height <= 0) return win.from;
      const raw = win.from + ((clientY - r.top) / r.height) * spanOf(win);
      return snap15(Math.max(win.from, Math.min(win.to, raw)));
    };

    const done = (commit: boolean) => {
      clean.current?.();
      if (moved) suppressClick();
      if (commit && cur) {
        settleDraftAndSet({
          zone: cur.zone,
          date: cur.date,
          time: D.minToTime(cur.start),
          duration: cur.end - cur.start,
        });
      }
      cur = null;
      setRange(null);
    };

    const move = (ev: PointerEvent): void => {
      if (!moved) {
        if (Math.abs(ev.clientY - y0) < THRESHOLD && Math.abs(ev.clientX - x0) < THRESHOLD) return;
        moved = true;
        document.body.classList.add('is-drag-range');
        /* 捕获指针：拖到轴外面（甚至窗口外）松手也收得到 */
        try { hit.frame.setPointerCapture(ev.pointerId); } catch { /* 指针已释放，忽略 */ }
      }
      cur = { ...dragRange(minAt(y0), minAt(ev.clientY), win), zone: hit.zone, date: hit.date };
      setRange(cur);
    };
    /* 松手 = 建。Esc = 撤（`done(false)`），两种情况都吃掉随后的那次 click */
    const up = () => done(true);
    const cancel = () => done(false);
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') done(false); };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    clean.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      document.body.classList.remove('is-drag-range');
      clean.current = null;
    };
  };

  return { range, onPointerDown };
}

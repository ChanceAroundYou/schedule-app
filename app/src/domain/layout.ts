/**
 * layout.ts —— 时间轴上的摆放：重叠分列 + 时间段文案
 *
 * 重叠按「重叠簇」分列，不是全天一起分。旧算法把全天所有事件塞进一个
 * colEnds，cols 取全天最大值，于是**任何**一段重叠都会让当天所有方块一起
 * 变半宽 —— 不重叠的任务也跟着变窄。日视图与周视图共用这一份，
 * 占用底纹与方块宽度必须严格一致（底纹 left/width 用同一组 col/cols 算）。
 */

import * as D from './date.ts';

export interface Slot<T> {
  item: T;
  start: number;
  end: number;
}

export interface Placed<T> extends Slot<T> {
  /** 第几列 */
  col: number;
  /** 这一簇共几列 */
  cols: number;
}

/**
 * 就地给每个事件补上 col / cols，返回按开始时间排好序的新数组。
 *
 * 先按「重叠簇」切分：和当前簇最后一个任务有交集就并入，否则另起一组。
 * 组内再贪心分列：找最靠左且已空闲的那一列。
 */
export function layoutOverlap<T>(slots: Slot<T>[]): Placed<T>[] {
  const events: Placed<T>[] = slots
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((s) => ({ ...s, col: 0, cols: 1 }));

  const clusters: { items: Placed<T>[]; end: number }[] = [];
  let cur: { items: Placed<T>[]; end: number } | null = null;

  for (const e of events) {
    if (cur && e.start < cur.end) {
      cur.items.push(e);
      if (e.end > cur.end) cur.end = e.end;
    } else {
      cur = { items: [e], end: e.end };
      clusters.push(cur);
    }
  }

  for (const cl of clusters) {
    const colEnds: number[] = [];
    for (const e of cl.items) {
      let placed = false;
      for (let i = 0; i < colEnds.length; i++) {
        if (e.start >= colEnds[i]) {
          e.col = i;
          colEnds[i] = e.end;
          placed = true;
          break;
        }
      }
      if (!placed) {
        e.col = colEnds.length;
        colEnds.push(e.end);
      }
    }
    const cols = Math.max(1, colEnds.length);
    for (const e of cl.items) e.cols = cols;
  }

  return events;
}

/** 时间段文案：09:30 – 10:30，跨零点标「次日」 */
export function timeRange(start: number, dur: number): string {
  const s = D.minToTime(start);
  const end = start + (dur || 0);
  const e = end >= 1440
    ? '次日 ' + D.minToTime(Math.max(0, end - 1440))
    : D.minToTime(Math.min(1439, end));
  return s + ' – ' + e;
}

/** 一天 24 小时的像素高度 */
export const HOUR_H = 64;
export const DAY_H = HOUR_H * 24;

/* ================= 日视图的可见时间窗 ================= */

/**
 * 日视图只看 `[from, to)` 这一段（分钟）。默认 0–1440 = 整天。
 *
 * 有了它，日视图就能**按比例**摆事件（百分比而不是像素），于是时间轴的高度
 * 由容器说了算 —— 锁成单屏不滚动、把时间窗收窄到白天，两件事共用同一份算法。
 */
export interface DayWindow {
  from: number;
  to: number;
}

export const FULL_DAY: DayWindow = { from: 0, to: 1440 };

/** 窗宽（分钟）。下限 1 小时 —— 收得太窄时间轴就没法看了 */
export const MIN_SPAN = 60;

export function windowOf(ui: { dayFrom: number; dayTo: number }): DayWindow {
  const from = Math.max(0, Math.min(1439, Math.round(ui.dayFrom) * 60));
  let to = Math.max(0, Math.min(1440, Math.round(ui.dayTo) * 60));
  if (to - from < MIN_SPAN) to = Math.min(1440, from + MIN_SPAN);
  return { from, to };
}

export function spanOf(w: DayWindow): number {
  return w.to - w.from;
}

/**
 * 纵坐标 → 分钟。`boxH` 是时间轴**实测**高度。
 *
 * 刻意收 boxH 而不是收一个写死的高度常量：日视图的高度是 JS 按可见区域算出来的
 * （见 Views.fitWeekHeight），任何写死的换算都会在窗口一缩放就错位。
 * 顺手也把结果收进窗内并对齐 15 分钟。
 */
export function yToMin(y: number, boxH: number, w: DayWindow): number {
  if (boxH <= 0) return w.from;
  const raw = w.from + (y / boxH) * spanOf(w);
  const snapped = Math.round(raw / 15) * 15;
  return Math.max(w.from, Math.min(w.to - 15, snapped));
}

/** 分钟 → 纵向百分比（0–100）。窗外返回 null —— 窗外的东西不画 */
export function minToPct(min: number, w: DayWindow): number | null {
  if (min < w.from || min > w.to) return null;
  return (min - w.from) / spanOf(w) * 100;
}

/**
 * 一段时间段 → 纵向的 top / height（%），**跨过窗沿的按窗沿截断**。
 *
 * 完全在窗外才返回 null。跨沿的不能跟着消失 —— 07:00–09:00 那条在 08:00 起的
 * 窗里还露着后一小时，整条抹掉等于「这一小时明明有事，界面上却看不见」。
 *
 * 返回的 height 已经是最小可读高度之外的真实比例；太薄的由渲染层兜底。
 */
export function pctRange(start: number, end: number, w: DayWindow): { top: number; height: number } | null {
  const a = Math.max(start, w.from);
  const b = Math.min(end, w.to);
  if (b <= a) return null;
  const span = spanOf(w);
  return { top: (a - w.from) / span * 100, height: (b - a) / span * 100 };
}


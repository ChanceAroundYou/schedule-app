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

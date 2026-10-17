/**
 * coords.ts —— 指针坐标与时间计算
 */

import type { DragOverEvent, DragEndEvent } from '@dnd-kit/core';
import { getEventCoordinates } from '@dnd-kit/utilities';
import { FULL_DAY, yToMin, type DayWindow } from '../../domain/layout.ts';

/* ============================ 指针坐标 ============================ */

/**
 * 指针当前的横 / 纵坐标（视口坐标系）。
 *
 * **不能直接读 `activatorEvent.clientY`**：触摸拖拽的 activator 是 `TouchEvent`，
 * 它**没有** `clientX` / `clientY` —— 那两个在 `touches[0]` 上。读出来是 `undefined`，
 * 加上 `delta` 就是 `NaN`，一路传到 `minToTime()` 落库成字面量 `"NaN:NaN"`
 * （症状：日视图里拖一次任务，时间就废一次，**只有触摸会中招**，鼠标看不出来）。
 *
 * dnd-kit 自己的 `getEventCoordinates()` 已经把触屏 / 鼠标 / 键盘三种 activator
 * 归一了，直接用它，别再自己判类型。取不到就返回 `null`（键盘拖拽没有指针），
 * 调用方据此放弃本次落点，而不是拿 `NaN` 去写库。
 */
export function eventX(event: DragOverEvent | DragEndEvent): number | null {
  const c = getEventCoordinates(event.activatorEvent);
  return c ? c.x + event.delta.x : null;
}

export function eventY(event: DragOverEvent | DragEndEvent): number | null {
  const c = getEventCoordinates(event.activatorEvent);
  return c ? c.y + event.delta.y : null;
}

/* ============================ 时间计算 ============================ */

/** 纵坐标 → 分钟。`boxH` 由调用方量（见 zoneWindow 的注释） */
export function minFromY(zone: HTMLElement, clientY: number): number {
  const rect = zone.getBoundingClientRect();
  return yToMin(clientY - rect.top, rect.height, zoneWindow(zone));
}

/**
 * 周视图那一列现在和日视图 `.timeline` 同构（盒子就是可见时间窗，
 * `data-from` / `data-to` 写在同一个元素上），所以这一 overrides 被统一的
 * `minFromY` 吃掉 —— 以前要单独一条算式，是因为列曾经是「整天 1536px 高、
 * 可视区只是一扇窗」。留着它只会在将来又一次 px ↔ 百分比漂移。 */


/* ============================ zone 时间窗 ============================ */

/**
 * 从 zone 上读出时间窗。
 *
 * **时间轴不再有写死的高度**：日视图锁成单屏，高度是 JS 按可见区域算出来的，
 * 所以 px↔分钟只能现场量（`data-from` / `data-to` 是 DayView 渲染时写进去的）。
 * 读不到就按整天算 —— 只可能发生在这个函数被喂了非时间轴 zone 的时候。
 */
export function zoneWindow(zone: HTMLElement): DayWindow {
  const from = Number(zone.dataset.from);
  const to = Number(zone.dataset.to);
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) return { from, to };
  return FULL_DAY;
}

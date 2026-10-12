/**
 * domWindow.ts —— 从 DOM 上读出时间轴的时间窗
 */

import { FULL_DAY, type DayWindow } from '../domain/layout.ts';

/**
 * 日视图不再有固定像素高度（锁单屏 + 用户可收窄时间窗），所以 px↔分钟的换算
 * 必须知道**当前那一屏是哪几个小时**。DayView 把 `data-from` / `data-to`
 * 写在时间轴上，这里现场读回来。读不到就按整天算。
 */
function domWindow(zone: HTMLElement | null): DayWindow {
  const from = Number(zone?.dataset.from);
  const to = Number(zone?.dataset.to);
  if (zone && Number.isFinite(from) && Number.isFinite(to) && to > from) return { from, to };
  return FULL_DAY;
}

export { domWindow };

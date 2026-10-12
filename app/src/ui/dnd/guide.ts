/**
 * guide.ts —— 时间轴引导线 / 光标 / 时长标签的 DOM 操作
 *
 * 这些函数直接操作 DOM（创建/更新/删除元素），不涉及 React 状态。
 * 存在的理由：引导线需要**连续跟指针**（`onDragMove` 每次 pointer 移动都触发），
 * 而 React 重渲染太慢且会打断拖拽流程。
 */

import * as D from '../../domain/date.ts';
import * as store from '../../data/store.ts';
import { spanOf, type DayWindow } from '../../domain/layout.ts';


let guideLine: HTMLDivElement | null = null;

/**
 * 从 zone 上读出时间窗。
 *
 * **时间轴不再有写死的高度**：日视图锁成单屏，高度是 JS 按可见区域算出来的，
 * 所以 px↔分钟只能现场量（`data-from` / `data-to` 是 DayView 渲染时写进去的）。
 * 读不到就按整天算 —— 只可能发生在这个函数被喂了非时间轴 zone 的时候。
 */

/**
 * 画引导线。**位置按像素算，不按百分比**。
 *
 * 按百分比的问题是：`top: %` 会被浏览器按**整数像素**栅格对齐（布局像素），
 * 于是 1 分钟在 64px/h 下只值 1px，线在相邻分钟内看着不动，跨过某一像素
 * 边界才「跳」一格 —— 用户报「绿线是离散的，只能停在 0/15/30/45」。
 * 改成直接写像素：`min → px` 用同一份实测高度换算，和卡片、光标、
 * 落点四者共用同一个浮点分钟值，视觉上就是连续跟手的。
 *
 * 线的位置仍然**不对齐 15 分钟**（和落点保持同一套算法），否则线和松手点
 * 会对不上。
 */
function drawTimeGuide(zone: HTMLElement, min: number, win: DayWindow): void {
  if (!guideLine) {
    guideLine = document.createElement('div');
    guideLine.className = 'tl-guide';
    zone.appendChild(guideLine);
  }
  const boxH = zone.getBoundingClientRect().height;
  guideLine.style.top = ((min - win.from) / spanOf(win) * boxH) + 'px';
}

/** 左侧时间轴上的时间标签（显示绿线对应几点）。
 *  **挂在 `.timeline` 上，不是 `.tl-wrap`**：红线 `.tl-now span` 的基准是
 *  `.timeline`（`left: -56px` 相对 `.tl-now`，而 `.tl-now` 是 `.timeline` 的子元素）。
 *  挂在 `.tl-wrap` 上会差一个 padding-left（60px），时间标签和红线对不齐。
 *  **用 `transform: translateY(-8px)` 而不是 `top: -8px`**：JS 设置 `top` 为百分比，
 *  CSS 的 `top: -8px` 会被内联样式覆盖，导致文字掉到线下面。
 *  **位置同样按像素算**（理由同 drawTimeGuide），并且**线在哪个像素上字就在哪**。 */
function drawTimeCursor(zone: HTMLElement, min: number, win: DayWindow): void {
  let cursor = zone.querySelector<HTMLElement>('.tl-cursor');
  if (!cursor) {
    cursor = document.createElement('div');
    cursor.className = 'tl-cursor';
    zone.appendChild(cursor);
  }
  const boxH = zone.getBoundingClientRect().height;
  cursor.style.top = ((min - win.from) / spanOf(win) * boxH) + 'px';
  cursor.textContent = D.minToTime(min);
}

function clearTimeCursor(): void {
  document.querySelectorAll('.tl-cursor').forEach((el) => el.remove());
}

/** 卡片外侧下方持续时间标签 */
function showDurationTag(card: HTMLElement, taskId: string): void {
  const task = store.get().tasks[taskId];
  if (!task) return;
  let tag = document.querySelector<HTMLElement>('.tl-dur-tag[data-task="' + taskId + '"]');
  if (!tag) {
    tag = document.createElement('div');
    tag.className = 'tl-dur-tag';
    tag.dataset.task = taskId;
    document.body.appendChild(tag);
  }
  const r = card.getBoundingClientRect();
  tag.style.left = r.left + 'px';
  tag.style.top = (r.bottom + 2) + 'px';
  tag.textContent = D.fmtDuration(task.duration || 60);
}

function clearDurationTags(): void {
  document.querySelectorAll('.tl-dur-tag').forEach((el) => el.remove());
}

function clearTimeGuide(): void {
  if (guideLine) { guideLine.remove(); guideLine = null; }
}

export {
  drawTimeGuide,
  drawTimeCursor,
  clearTimeCursor,
  showDurationTag,
  clearDurationTags,
  clearTimeGuide,
};

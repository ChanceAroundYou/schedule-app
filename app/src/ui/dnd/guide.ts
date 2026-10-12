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
 * 画引导线。**位置按像素算，不对齐 15 分钟档**。
 *
 * 按百分比的问题是：`top: %` 会被浏览器按**整数像素**栅格对齐（布局像素），
 * 于是 1 分钟在 64px/h 下只值 1px，线在相邻分钟内看着不动，跨过某一像素
 * 边界才「跳」一格 —— 用户报「绿线是离散的，只能停在 0/15/30/45」。
 *
 * **线本身离散，档位由调用方给**：拖拽时 `timeline.ts` 传给这儿的是
 * 已经吸附到 15 分钟的分钟值（`minFromY`），所以线一档一档走，
 * 不跟卡片连续位置。卡片连续跟手，落点离散吸附 —— 两件事分开。
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

/** 左侧时间轴上的时间标签（显示绿线对应几点）。分钟值已由调用方吸附。 */
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

/**
 * scrollKeep.ts —— 开拖那一刻保住未定时区「滚到哪儿了」
 *
 * 症状（2026-10-24 用户：「怎么又回退了，拖动未定时任务的时候整个未定时区又滑动了」）：
 * 卡片要能从未定时区一路拖进时间轴，所以那一区在拖拽中被切成 `overflow: visible`
 * （calendar.css 的 `.allday-zone:has(.task-el.dragging)`）。**可滚容器一旦不再是
 * 滚容器，浏览器当场把 scrollTop 归零** —— 实测（tests/card-geometry.mjs 第九节同源）：
 * 滚 80px 的格子在切开的那一帧内容往下跳 80px，切回 auto 又能拿回 80。
 * 整格内容当场位移，用户看到的就是「区域替卡片滑」。
 *
 * 未定时区会真滚起来是 2026-10-24 之后的事（已完成的未定时任务也留在未定时区了），
 * 所以这条坑一直埋在那儿，那天才露头。
 *
 * 修法：开拖前记下它滚了多少（S），把 `-S` 写进 `--keep`；CSS 只在
 * `:has(.task-el.dragging)` 时把这一位移加回内容上。摘 `.dragging` 的那一次样式重算里
 * 三件事同时发生 —— overflow 回 auto、浏览器自己把 scrollTop 还原、translate 规则失效 ——
 * 互相抵消，不产生第二次位移。
 *
 * 为什么必须在 `onDragStart` 那一刻写、还要顺手挂 `data-keep`：`:not([data-pull]) > *`
 * 那条 320ms 过渡会把 translate 从 0 动到 -S，那正是一次肉眼可见的滑。`data-keep`
 * 在切换之前就那段把过渡关掉。
 */

/** 会被切成 overflow: visible 的两块 —— **和 calendar.css 的 `:has()` 那两条同步改** */
const ZONE_SELECTOR = '.allday-zone, .wun-cell';

/** 已经补过位移的容器，松手时撤掉 */
const kept: HTMLElement[] = [];

/** 被拖的那张卡（dnd-kit 的 active.id 就是元素上的 `data-id`，和 timeline.ts 同一个找法） */
function draggedCard(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.task-el[data-id="${id}"]`);
}

/** 开拖前调用：沿被拖卡往上找滚着的容器，把位移补进 `--keep` */
export function keepZoneScroll(id: string): void {
  releaseZoneScroll();
  let n: HTMLElement | null = draggedCard(id);
  while (n) {
    if (n.matches?.(ZONE_SELECTOR) && n.scrollTop > 0) {
      n.setAttribute('data-keep', '');            // 切换那一帧不给过渡
      n.style.setProperty('--keep', `${-n.scrollTop}px`);
      kept.push(n);
    }
    n = n.parentElement;
  }
}

/** 松手 / 取消时调用。和 React 摘 `.dragging` 在同一次事件里，所以只重算一次样式 */
export function releaseZoneScroll(): void {
  for (const n of kept) {
    n.removeAttribute('data-keep');
    n.style.removeProperty('--keep');
  }
  kept.length = 0;
}

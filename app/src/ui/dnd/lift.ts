/**
 * lift.ts —— 拖拽时把卡片「拎出」滚动容器
 *
 * **为什么需要**：拖拽不用浮层替身，被拖的就是卡片自己（dnd-kit 给一个
 * transform 位移）。但未定时区（`.allday-zone` / `.wun-cell`）和月视图格子
 * （`.cell-tasks`）为了能滚动设了 `overflow-y: auto` —— 卡片一旦被拖出这个框，
 * 就被容器**裁掉**，症状是「一拖就消失」（用户 2026-10-23 报：
 * 定时卡跟手、未定时卡整个消失，落点却还是对的）。
 * 定时卡所在的时间轴/列特意不裁剪（见 calendar.css 的「不许 overflow:hidden」），
 * 所以它没这问题。
 *
 * **做法**：拖起时把卡片改成 `position: fixed`（按拖起瞬间实测的 rect 定位定宽，
 * 继续吃 dnd-kit 的 transform 位移），并在原位插一个等高占位块 ——
 * 卡片从此不受任何祖先的 overflow 裁剪；占位块让其余卡片不跳动。松手恢复。
 *
 * ⚠️ 只在**会被裁的卡片**上启用（未定时卡 / 月视图胶囊），定时卡保持原样。
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

export function useDragLift(active: boolean) {
  const nodeRef = useRef<HTMLElement | null>(null);
  const [liftStyle, setLiftStyle] = useState<CSSProperties | null>(null);

  /* 给组件当一个「只记录节点」的 ref —— 和 dnd-kit 的 setNodeRef 一起挂 */
  const setNodeRef = useCallback((el: HTMLElement | null) => { nodeRef.current = el; }, []);

  useEffect(() => {
    if (!active) { setLiftStyle(null); return; }
    const el = nodeRef.current;
    if (!el || !el.parentElement) return;
    const r = el.getBoundingClientRect();
    /* 占位块：撑住原来的格子。flex 容器要 flex:0 0 auto，grid 容器按 DOM 顺序
       顶替被拖卡片的槽位。 */
    const ph = document.createElement('div');
    ph.className = 'drag-ph';
    ph.style.cssText = `width:${r.width}px;height:${r.height}px;flex:0 0 auto;pointer-events:none;`;
    el.parentElement.insertBefore(ph, el);
    setLiftStyle({
      position: 'fixed', left: r.left, top: r.top, width: r.width, height: r.height,
      margin: 0, zIndex: 90,
    });
    return () => { ph.remove(); };
  }, [active]);

  return { setNodeRef, liftStyle };
}

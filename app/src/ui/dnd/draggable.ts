/**
 * draggable.ts —— 时间轴方块拖拽项 + 放置区
 */

import { type CSSProperties } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { } from '@dnd-kit/utilities';

/* ============================ 时间轴拖拽 ============================ */

/**
 * 时间轴方块的拖拽项。
 *
 * 用于：.task-el（日视图，定时与未定时共用）、.wk-event（周视图）、
 * .pj-card（项目泳道）。列表行用 useSortableItem（SortableList 内部）。
 */
export function useDraggableEvent(id: string) {
  const { attributes, listeners, setNodeRef, transform, isDragging, node } = useDraggable({ id });
  const x = transform?.x ?? 0;
  const y = transform?.y ?? 0;
  /* **只取位移。** core 的 DndContext 里有一句
      `adjustScale(appliedTranslate, over?.rect, activeNodeRect)`，把 transform 的
      scaleX/scaleY 定成「落点 ÷ 自己」的尺寸比。日视图的落点是 `.timeline`
      （整天 1536px 高），方块只有几十像素高 → scaleY 能到 25 以上，
      一拖起来就铺满整屏。`CSS.Transform.toString` 会把这个比值一起烤进
      transform；`CSS.Translate` 只出 translate3d，尺寸锁死在提起时那一刻。 */
  const style: CSSProperties = {
    transform: `translate3d(${x}px, ${y}px, 0px)`,
    /* **被拖的那一项必须显式关掉 transition。** `.task-el--untimed` 自带
       `transition: background .14s, box-shadow .14s`，不关的话方块跟指针之间
       差 140ms —— 用户报「日视图拖动不跟手，明显和其他视图不同」：列表的被拖项
       在 `useSortableItem` 里显式关了 transition，周视图的 `.wk-event` 压根没有
       transform transition。 */
    transition: isDragging ? 'none' : undefined,
  };
  /* 原始位移一起交出去：`useClampedDraggableEvent` 要改 x，不必去
     正则解析这条刚拼出来的字符串（那是自己给自己下套）。 */
  return { ref: setNodeRef, style, isDragging, attributes, listeners, x, y, node };
}

/**
 * 纵向拖拽项（横向锁死）。
 *
 * 日视图专用：定时与未定时卡片**都只能纵向上下拖**，横向完全不能动 ——
 * `x` 在下面的 `translate3d(0px, …)` 里直接置 0。
 *
 * **纵向钳位不在这个 hook 里**（2026-10-12 重构）：统一交给 provider 级的
 * `clampTimelineDrag`（timeline.ts）—— dnd-kit 的 `useDraggable` **不接受**
 * 从这个 hook 返回的 `modifiers`，留在这儿只有 DayView 的 `drag.style` 会读，
 * 钳位那半是死代码，两处各写一份还容易只有一份对。这里只保留「横向锁死」。
 */
export function useClampedDraggableEvent(id: string) {
  const { x: _x, y, node: _node, ...drag } = useDraggableEvent(id);
  return {
    ...drag,
    style: { ...drag.style, transform: `translate3d(0px, ${y}px, 0px)` },
  };
}

/**
 * 放置区的 droppable。
 *
 * 每个 zone 需要 data-zone-id 属性，值与传入的 id 一致 ——
 * onDragOver / onDragEnd 靠它找回 DOM 元素。
 */
export function useDroppableZone(id: string) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return { ref: setNodeRef, isOver };
}

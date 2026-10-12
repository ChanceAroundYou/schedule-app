/**
 * draggable.ts —— 时间轴方块拖拽项 + 放置区
 */

import { useRef, useCallback, type CSSProperties } from 'react';
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
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id });
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
  return { ref: setNodeRef, style, isDragging, attributes, listeners, x, y };
}

/**
 * 水平钳制在父容器内的拖拽项。
 *
 * 只有日视图需要——周视图和泳道要水平拖动（跨列）。
 * `offsetLeft` / `offsetWidth` 是**未变换**的布局值，
 * 所以钳制跟当前 transform 无关，不会累积漂移。
 */
export function useClampedDraggableEvent(id: string) {
  const { x, y, ...drag } = useDraggableEvent(id);
  const nodeRef = useRef<HTMLElement | null>(null);

  const setRef = useCallback((el: HTMLElement | null) => {
    nodeRef.current = el;
    drag.ref(el);
  }, [drag.ref]);

  let clampedX = x;
  if (drag.isDragging && nodeRef.current) {
    const node = nodeRef.current;
    const parent = node.offsetParent as HTMLElement | null;
    if (parent) {
      const maxX = parent.offsetWidth - node.offsetLeft - node.offsetWidth;
      clampedX = Math.max(-node.offsetLeft, Math.min(x, maxX));
    }
  }

  return {
    ...drag,
    ref: setRef,
    /* **展开 `drag.style` 再覆盖 transform，别重新拼一个对象** —— 重新拼会把
       useDraggableEvent 里那句 `transition: 'none'` 弄丢，被拖的那一项又变回
       140ms 迟滞（日视图用的就是这个 hook）。 */
    style: { ...drag.style, transform: `translate3d(${clampedX}px, ${y}px, 0px)` },
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

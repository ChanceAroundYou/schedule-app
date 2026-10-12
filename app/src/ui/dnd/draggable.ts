/**
 * draggable.ts —— 时间轴方块拖拽项 + 放置区
 */

import { useEffect, useRef, type CSSProperties } from 'react';
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
 * 纵向拖拽项（横向锁死 + 纵向钳在容器内）。
 *
 * 日视图专用：定时与未定时卡片**都只能纵向上下拖**，横向完全不能动。
 * `x` 直接置 0，不随指针走。
 *
 * **纵向也钳住**：卡片顶部不能越过容器顶，底部不能越过容器底。
 * 在拖拽开始时量一次原始位置（那次 render 卡片还没挪走），之后按
 * `min/max` 算术 clamp `y` —— 不在每帧读 DOM，省掉一次强制布局。
 *
 * **不读 DOM 也安全**：node 可能在拖拽中被 dnd-kit 替换，所以用 `useRef`
 * 记住 node，在 effect 里延迟测量。但更简单的是：直接让 `DayView` 把
 * 容器高度传进来，按百分比算 bounds。这样完全避免读 DOM。
 */
export function useClampedDraggableEvent(id: string) {
  const { x: _x, y, node, isDragging, ...rest } = useDraggableEvent(id);
  const bounds = useRef<{ min: number; max: number } | null>(null);

  /* 用 useRef + useEffect 在拖拽开始后测量（避免 render 中读 DOM） */
  useEffect(() => {
    if (!isDragging || bounds.current) return;
    const el = node as unknown as HTMLElement | null;
    const container = el?.closest('.timeline') as HTMLElement | null;
    if (!el || !container) {
      bounds.current = { min: -Infinity, max: Infinity };
    } else {
      const cardH = el.getBoundingClientRect().height;
      const wrapEl = el.closest('.tl-events') as HTMLElement | null;
      const originalTop = (wrapEl?.offsetTop ?? 0) + el.offsetTop;
      bounds.current = {
        min: -originalTop,
        max: container.clientHeight - originalTop - cardH,
      };
    }
  }, [isDragging, node]);

  /* 松手后清掉，下次拖拽重新量 */
  useEffect(() => {
    if (isDragging) return;
    return () => { bounds.current = null; };
  }, [isDragging]);

  const clamped = bounds.current
    ? Math.max(bounds.current.min, Math.min(bounds.current.max, y))
    : y;

  return {
    ...rest, isDragging, x: 0, y: clamped,
    /* **展开 `drag.style` 再覆盖 transform，别重新拼一个对象** —— 重新拼会把
       useDraggableEvent 里那句 `transition: 'none'` 弄丢，被拖的那一项又变回
       140ms 迟滞（日视图用的就是这个 hook）。 */
    style: { ...rest.style, transform: `translate3d(0px, ${clamped}px, 0px)` },
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

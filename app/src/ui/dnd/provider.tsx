/**
 * provider.tsx —— 顶层 DndProvider
 */

import { useState, useCallback, type ReactNode } from 'react';
import {
  DndContext,
  type DragStartEvent, type DragOverEvent, type DragMoveEvent, type DragEndEvent, type Modifier,
} from '@dnd-kit/core';
import { setDragging } from '../dragState.ts';
import { keepZoneScroll, releaseZoneScroll } from './scrollKeep.ts';
import { DragCtx } from './context.ts';
import { useDragSensors } from './sensors.ts';

export interface DndProviderProps {
  children: ReactNode;
  modifiers?: Modifier[];
  onDragOver?: (event: DragOverEvent) => void;
  /** 每次 pointer 移动都触发 —— 引导线要连续跟指针，只能靠它（见 useTimelineDrag） */
  onDragMove?: (event: DragMoveEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
  onDragCancel?: () => void;
}

export function DndProvider({ children, modifiers, onDragOver, onDragMove, onDragEnd, onDragCancel }: DndProviderProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useDragSensors();

  const handleDragStart = useCallback((event: DragStartEvent) => {
    /* **先补滚动位移，再让 `.dragging` 落地**（见 scrollKeep.ts）：卡片一被标记，
       CSS 那条 `:has(.task-el.dragging)` 就把未定时区切成 overflow: visible，
       浏览器当场把它的 scrollTop 归零 —— 整格内容往下跳，看着就是「区域替卡片滑」。
       状态更新在这条之后才 flush，所以赶得上。 */
    keepZoneScroll(String(event.active.id));
    setActiveId(String(event.active.id));
    setDragging(true);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    releaseZoneScroll();
    setActiveId(null);
    setDragging(false);
    onDragEnd?.(event);
  }, [onDragEnd]);

  const handleDragCancel = useCallback(() => {
    releaseZoneScroll();
    setActiveId(null);
    setDragging(false);
    onDragCancel?.();
  }, [onDragCancel]);

  return (
    <DndContext
      sensors={sensors}
      modifiers={modifiers}
      /* **关掉 dnd-kit 自带的 AutoScroll**（2026-10-24 五项反馈⑤）。
         它默认开着：被拖的方块进入某个可滚容器边缘的阈值区，库就自己去
         scrollBy 那个容器 —— 未定时区恒 3.2 行高、周视图那一格更矮，
         卡片一挪就在阈值区里 ⇒ 「拖卡片的同时整个区域在滑」。
         用户的判据是「长按把卡片拽起来之后只拖卡片」，所以这里一律不代滚。
         键盘传感器本来就是 autoScrollEnabled = false，关掉后三条路一致。
         代价：拖到看不见的地方要先自己滚再拖 —— 排序都在一屏内，换得。 */
      autoScroll={false}
      onDragStart={handleDragStart}
      onDragOver={onDragOver}
      onDragMove={onDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {/*
      **不挂 DragOverlay。** dnd-kit 的碰撞检测用的是 `dragOverlay.rect`
      （浮层自己量到的矩形），不是被拖节点那个 —— 见 core.esm.js 里
      `draggingNodeRect = dragOverlay.rect ?? activeNodeRect`。浮层里放个空 div，
      量出来是 0×0，`rectIntersection` 的交集比全是 0，`over` 永远是 null，
      症状是「拖得动但永远放不到目标上」。

      不挂浮层时 dnd-kit 改用 `activeNodeRect`（它自己会量），碰撞检测就对了
      —— `SortableList` 那条 DndContext 一直没挂，所以列表排序从来是好的，
      只有时间轴 / 泳道这条坏。代价是没有「替身」跟着指针走，被拖的那块自己
      跟着走（和迁移前 `.touch-drag` 的行为一致）。
      */}
      <DragCtx.Provider value={{ activeId, activeKind: null }}>
        {children}
      </DragCtx.Provider>
    </DndContext>
  );
}

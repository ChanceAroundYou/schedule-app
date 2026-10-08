/**
 * dndkit.ts —— 基于 @dnd-kit 的拖放系统
 *
 * 替代 ui/dnd.ts 的那套「HTML5 drag + 自定义 pointer」双通路。
 * 鼠标走 MouseSensor、触摸走 TouchSensor（长按提起），键盘走 KeyboardSensor ——
 * 三条通路分开配，见 useDragSensors()。
 *
 * 架构分层：
 *   DndProvider（包裹整棵应用）
 *   ├── SortableContext（列表排序：设置页功能区 / 任务列表 / 打卡 / 项目泳道）
 *   │   └── useSortableItem（每个可拖拽项）
 *   ├── useDraggableEvent（时间轴方块，Phase 4 实现）
 *   ├── useDroppableZone（放置区，Phase 4 实现）
 *   └── （不挂 DragOverlay —— 碰撞检测会退化成 0×0，见 DndProvider 里的注释）
 *
 * 同步守卫：setDragging / isDragging 接口不变，engine.ts 的
 * `if (isDragging()) return` 照旧工作。
 */

import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import {
  DndContext, MouseSensor, TouchSensor, KeyboardSensor,
  useSensor, useSensors, useDraggable, useDroppable, DragOverlay,
  type DragStartEvent, type DragEndEvent, type DragOverEvent,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, rectSortingStrategy,
  sortableKeyboardCoordinates, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { setDragging } from './dragState.ts';
import * as D from '../domain/date.ts';
import * as store from '../data/store.ts';
import { DAY_H } from '../domain/layout.ts';
import { toast } from './kit.tsx';
import { LONG_PRESS_MS } from './hooks.ts';

/* ============================ 传感器 ============================ */

/**
 * 鼠标和触摸**分开配**，不是「PointerSensor 一把抓」。
 *
 * 鼠标：移动 8px 就开拖 —— 轻点（不移动）不触发，点行开抽屉不受影响。
 * 触摸：按住 LONG_PRESS_MS（480ms）才开拖，和这个应用「长按提起」的手感一致。
 *   用 delay 而不是 distance，是为了**把滚动让出来** —— 触摸下 distance 会让
 *   浏览器把手指移动判成滚动、直接发 pointercancel，拖拽根本起不来；
 *   而 touch-action: none 又会把整个列表的滚动一起禁掉。delay 期间不拦截，
 *   滚动照常，按住不动才提起。
 */
export function useDragSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: LONG_PRESS_MS, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/* ============================ 拖动态 ============================ */

interface DragState {
  activeId: string | null;
  activeKind: 'task' | 'habit' | 'nav' | null;
}

const DragCtx = createContext<DragState>({ activeId: null, activeKind: null });

/** 给 DragOverlay 和 sync 守卫读的当前拖动态 */
export function useDragSession(): DragState {
  return useContext(DragCtx);
}

/* ============================ DndProvider ============================ */

interface DndProviderProps {
  children: ReactNode;
  onDragStart?: (event: DragStartEvent) => void;
  onDragOver?: (event: DragOverEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
  onDragCancel?: () => void;
}

/**
 * 拖拽回调 context —— 让嵌套的拖拽区域（如设置页）可以注册自己的 onDragEnd。
 * 外层 DndProvider 的 onDragEnd 会调用这个 context 中注册的回调。
 */
interface DndCallbacks {
  register: (onDragEnd: ((event: DragEndEvent) => void) | null) => void;
}

const DndCallbacksCtx = createContext<DndCallbacks>({ register: () => {} });

export function DndProvider({ children, onDragStart, onDragOver, onDragEnd, onDragCancel }: DndProviderProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const nestedCallbackRef = useRef<((event: DragEndEvent) => void) | null>(null);

  const sensors = useDragSensors();

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    setDragging(true);
    onDragStart?.(event);
  }, [onDragStart]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveId(null);
    setDragging(false);
    // 先调用嵌套的回调（如设置页），再调用外层的回调
    nestedCallbackRef.current?.(event);
    onDragEnd?.(event);
  }, [onDragEnd]);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setDragging(false);
    onDragCancel?.();
  }, [onDragCancel]);

  const register = useCallback((onDragEnd: ((event: DragEndEvent) => void) | null) => {
    nestedCallbackRef.current = onDragEnd;
  }, []);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={onDragOver}
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
        <DndCallbacksCtx.Provider value={{ register }}>
          {children}
        </DndCallbacksCtx.Provider>
      </DragCtx.Provider>
    </DndContext>
  );
}

/**
 * 嵌套拖拽区域 —— 让设置页等组件可以注册自己的 onDragEnd 回调，
 * 而不需要创建新的 DContext。
 *
 * 用法：
 *   <DndScope onDragEnd={handleDragEnd}>
 *     <SortableContext items={items} strategy={rectSortingStrategy}>
 *       ...
 *     </SortableContext>
 *   </DndScope>
 */
export function DndScope({ children, onDragEnd }: { children: ReactNode; onDragEnd: (event: DragEndEvent) => void }) {
  const { register } = useContext(DndCallbacksCtx);

  useEffect(() => {
    register(onDragEnd);
    return () => register(null);
  }, [register, onDragEnd]);

  return <>{children}</>;
}

/* ============================ 可排序项 ============================ */

/**
 * 列表排序用的可拖拽项。
 *
 * 用于：设置页功能区、任务列表、打卡、项目泳道。
 * 时间轴方块用 useDraggableEvent（Phase 4 实现）。
 */
export function useSortableItem(id: string) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style: React.CSSProperties = {
    // 同 SortableItem：只要位移，不要缩放
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return { ref: setNodeRef, style, isDragging, attributes, listeners };
}

/* ============================ 可排序列表 ============================ */

/**
 * 一个完整的可排序列表：DndContext + SortableContext + onDragEnd 落库。
 *
 * 用法：
 *   <SortableList items={ids} onReorder={fn} renderItem={(id) => <Row id={id} />} />
 *
 * `onReorder` 收到的是**新的 id 顺序**，调用方负责把它写进 store。
 */
export function SortableList({ items, onReorder, renderItem, className, scope }: {
  items: string[];
  onReorder: (newItems: string[]) => void;
  renderItem: (id: string) => ReactNode;
  className?: string;
  /** 渲染成容器上的 `data-scope`。探针靠它定位列表，也是拖动作用域的标识 */
  scope?: string;
}) {
  const sensors = useDragSensors();
  const [activeId, setActiveId] = useState<string | null>(null);

  const onDragEnd = useCallback((event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = items.indexOf(String(active.id));
      const newIndex = items.indexOf(String(over.id));
      if (oldIndex >= 0 && newIndex >= 0) {
        onReorder(arrayMove(items, oldIndex, newIndex));
      }
    }
  }, [items, onReorder]);

  const activeItem = activeId ? renderItem(activeId) : null;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={items} strategy={rectSortingStrategy}>
        <div className={className} data-scope={scope}>
          {items.map((id) => (
            <SortableItem key={id} id={id}>
              {renderItem(id)}
            </SortableItem>
          ))}
        </div>
      </SortableContext>

      {/* 浮层跟着指针走，**不受 over 限制**。少了它，被拖的那块只在
          `over` 落在某个兄弟身上时才有 transform（见 useSortable 的
          `displaceItem = ... && isValidIndex(overIndex)`）—— 一离开容器，
          over 变 null，transform 整个丢掉，卡片就「飞回原位」。
          落点判定用的 `dragOverlay.rect` 量的是**浮层自己**，所以浮层里
          必须真有内容（renderItem 的结果），空 div 量出来 0×0。 */}
      <DragOverlay className="drag-overlay" dropAnimation={null}>{activeItem}</DragOverlay>
    </DndContext>
  );
}

/** SortableList 内部的单个可排序项 */
function SortableItem({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style: React.CSSProperties = {
    /* **只取位移，丢掉缩放。** `rectSortingStrategy` 会返回
       `scaleX/scaleY = 新位置尺寸 / 旧位置尺寸`，`CSS.Transform.toString`
       把它们一起烤进 transform —— 卡片落到高度不同的行上就被压扁 / 拉长。
       卡片必须保持刚提起时的形状，所以走 `CSS.Translate`。 */
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={'sortable-item' + (isDragging ? ' opacity-40' : '')}
    >
      {children}
    </div>
  );
}

/* ============================ 时间轴拖拽 ============================ */

/**
 * 时间轴方块的拖拽项。
 *
 * 用于：.tl-event（日视图）、.wk-event（周视图）、.pj-card（项目泳道）。
 * 列表行用 useSortableItem（SortableList 内部）。
 */
export function useDraggableEvent(id: string) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id });
  const style: React.CSSProperties = { transform: CSS.Transform.toString(transform) };
  return { ref: setNodeRef, style, isDragging, attributes, listeners };
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

/* ============================ 引导线 ============================ */

let guideLine: HTMLDivElement | null = null;

function drawTimeGuide(zone: HTMLElement, min: number): void {
  if (!guideLine) {
    guideLine = document.createElement('div');
    guideLine.className = 'tl-guide';
    const span = document.createElement('span');
    guideLine.appendChild(span);
    zone.appendChild(guideLine);
  }
  guideLine.style.top = `${min / 1440 * DAY_H}px`;
  const span = guideLine.querySelector('span');
  if (span) span.textContent = D.minToTime(min);
}

function clearTimeGuide(): void {
  if (guideLine) { guideLine.remove(); guideLine = null; }
}

/* ============================ 时间计算 ============================ */

function timeGuideMin(zone: HTMLElement, clientY: number): number {
  const rect = zone.getBoundingClientRect();
  const topMin = clientY - rect.top;
  const clamped = Math.max(0, Math.min(DAY_H - 24, topMin));
  return Math.max(0, Math.min(1425, Math.round(clamped / DAY_H * 1440 / 15) * 15));
}

function weekGuideMin(zone: HTMLElement, clientY: number): number {
  const rect = zone.getBoundingClientRect();
  const min = Math.round((clientY - rect.top) / DAY_H * 1440 / 15) * 15;
  return Math.max(0, Math.min(1425, min));
}

/* ============================ 拖拽 handlers ============================ */

/**
 * 时间轴 / 日历拖拽的 onDragOver + onDragEnd + onDragCancel。
 *
 * 用法（在 App.tsx 的 DndProvider 上）：
 *   const timelineDrag = useTimelineDrag();
 *   <DndProvider onDragOver={timelineDrag.onDragOver} onDragEnd={timelineDrag.onDragEnd}>
 *
 * zone 的 id 格式：
 *   timeline:{iso}    — 日视图时间轴
 *   week:{iso}        — 周视图列
 *   allday:{iso}      — 全天区
 *   day:{iso}         — 月视图格子
 *   proj:{pid}:{col}  — 项目泳道列
 */
export function useTimelineDrag() {
  const onDragOver = useCallback((event: DragOverEvent) => {
    const over = event.over;
    if (!over) { clearTimeGuide(); return; }

    const overId = String(over.id);
    const zone = document.querySelector<HTMLElement>(`[data-zone-id="${overId}"]`);
    if (!zone) return;

    const activatorEvent = event.activatorEvent as PointerEvent;
    const currentY = activatorEvent.clientY + event.delta.y;

    if (overId.startsWith('timeline:')) {
      const min = timeGuideMin(zone, currentY);
      drawTimeGuide(zone, min);
    } else if (overId.startsWith('week:')) {
      const min = weekGuideMin(zone, currentY);
      drawTimeGuide(zone, min);
    } else {
      clearTimeGuide();
    }
  }, []);

  const onDragEnd = useCallback((event: DragEndEvent) => {
    const over = event.over;
    clearTimeGuide();
    if (!over) return;

    const overId = String(over.id);
    const zone = document.querySelector<HTMLElement>(`[data-zone-id="${overId}"]`);
    if (!zone) return;

    const activeId = String(event.active.id);
    const activatorEvent = event.activatorEvent as PointerEvent;
    const currentY = activatorEvent.clientY + event.delta.y;
    const date = zone.dataset.date || null;

    if (overId.startsWith('timeline:')) {
      const min = timeGuideMin(zone, currentY);
      store.patchTask(activeId, { date, time: D.minToTime(min) });
      toast(`已改到 ${D.minToTime(min)}`);
      return;
    }

    if (overId.startsWith('week:')) {
      const min = weekGuideMin(zone, currentY);
      store.patchTask(activeId, { date, time: D.minToTime(min) });
      toast(`已改到 ${D.fmtMD(date || '')} ${D.minToTime(min)}`);
      return;
    }

    if (overId.startsWith('allday:') || overId.startsWith('day:')) {
      const task = store.get().tasks[activeId];
      if (task && task.time) {
        store.patchTask(activeId, { date });
        toast(`已改到 ${D.fmtMD(date || '')}`);
      } else {
        store.moveUntimed(activeId, date, null, 'after');
        toast(date ? `已改到 ${D.fmtMD(date)}` : '已移回待办箱');
      }
      return;
    }

    if (overId.startsWith('proj:')) {
      const col = overId.split(':')[2];
      const task = store.get().tasks[activeId];
      if (col === 'done') {
        if (task && !task.done) store.toggleTask(activeId);
      } else {
        store.setTaskDoing(activeId, col === 'doing');
      }
      const label = col === 'done' ? '已完成' : col === 'doing' ? '进行中' : '待办';
      toast(`已移到「${label}」`);
    }
  }, []);

  const onDragCancel = useCallback(() => {
    clearTimeGuide();
  }, []);

  return { onDragOver, onDragEnd, onDragCancel };
}

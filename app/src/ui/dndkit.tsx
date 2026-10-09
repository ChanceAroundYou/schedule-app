/**
 * dndkit.tsx —— 基于 @dnd-kit 的拖放系统
 *
 * 替代 ui/dnd.ts 的那套「HTML5 drag + 自定义 pointer」双通路。
 * 鼠标走 MouseSensor、触摸走 TouchSensor（长按提起），键盘走 KeyboardSensor ——
 * 三条通路分开配，见 useDragSensors()。
 *
 * ## 加新的可拖东西：从这几个 hook 里挑一个，别自己写 useSortable/useDraggable
 *
 * | 要做的事                | 用哪个                      | 现在用在                        |
 * |-------------------------|-----------------------------|---------------------------------|
 * | 列表里换顺序            | `SortableList`（整份）      | 待办箱 / 今天 / 逾期 / 已完成   |
 * | 列表里换顺序（自己排版）| `SortableZone` + `useSortableItem` | 设置页功能区               |
 * | 改时间 / 改位置         | `useDraggableEvent`        | 周视图方块、泳道卡片            |
 * | 同上但水平不许出框      | `useClampedDraggableEvent` | 日视图方块                      |
 *
 * **为什么不自己写**：每个 hook 都要复述同两条规矩 —— transform 只取位移
 * （`CSS.Translate`，丢掉 `adjustScale` 的 scale，否则一拖就铺满整屏）、
 * 被拖的那一项不给 transition（给了就迟滞半拍，用户说「不跟手」），而其余
 * 让位项**必须**给（不给就闪现）。抄一遍就有一份会漂，漂了还查不出来
 * （两套都「看着能用」）。
 *
 * 架构分层：
 *   DndProvider（包裹整棵应用，**不挂 DragOverlay**，见那里的注释）
 *   ├── SortableZone / SortableList（内层 context：排序，自带浮层）
 *   ├── useSortableItem（列表里的每一项）
 *   ├── useDraggableEvent（时间轴方块）
 *   ├── useDroppableZone（放置区）
 *   └── useTimelineDrag（日 / 周 / 泳道的落点计算）
 *
 * **长按和拖拽的分工不在这个文件里**，在 App.tsx 的 `lp`（`moved` 判据）。
 * 简述：TouchSensor 配的是 `{delay: 480ms, tolerance: 8}`，手指按住不动到点
 * dnd-kit 自己也会开拖，所以「有没有触发 onDragStart」区分不开长按和拖拽 ——
 * 唯一能分的是**手指有没有挪过**。
 *
 * 同步守卫：setDragging / isDragging 接口不变，engine.ts 的
 * `if (isDragging()) return` 照旧工作。
 */

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';
import {
  DndContext, MouseSensor, TouchSensor, KeyboardSensor,
  useSensor, useSensors, useDraggable, useDroppable, DragOverlay,
  type DragStartEvent, type DragOverEvent, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, rectSortingStrategy,
  sortableKeyboardCoordinates, arrayMove,
} from '@dnd-kit/sortable';
import { CSS, getEventCoordinates } from '@dnd-kit/utilities';
import { setDragging } from './dragState.ts';
import * as D from '../domain/date.ts';
import * as store from '../data/store.ts';
import { DAY_H, FULL_DAY, spanOf, yToMin, type DayWindow } from '../domain/layout.ts';
import { toast } from './kit.tsx';
import { cx } from './cx.ts';
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
  onDragOver?: (event: DragOverEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
  onDragCancel?: () => void;
}

export function DndProvider({ children, onDragOver, onDragEnd, onDragCancel }: DndProviderProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useDragSensors();

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    setDragging(true);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveId(null);
    setDragging(false);
    onDragEnd?.(event);
  }, [onDragEnd]);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setDragging(false);
    onDragCancel?.();
  }, [onDragCancel]);

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
        {children}
      </DragCtx.Provider>
    </DndContext>
  );
}

/* ============================ 可排序项 ============================ */

/**
 * 列表排序用的可拖拽项 —— **排序类拖拽的唯一入口**。
 *
 * 用于：设置页功能区、任务列表、打卡、项目泳道。
 * 时间轴方块用 useDraggableEvent（不是排序，是改时间）。
 */
export function useSortableItem(id: string) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({ id });

  const style: React.CSSProperties = {
    /* **只取位移，丢掉缩放。** `rectSortingStrategy` 会返回
       `scaleX/scaleY = 新位置尺寸 / 旧位置尺寸`，`CSS.Transform.toString`
       把它们一起烤进 transform —— 卡片落到高度不同的行上就被压扁 / 拉长。
       卡片必须保持刚提起时的形状，所以走 `CSS.Translate`。 */
    /* 被拖的那一项**位移整个丢掉**：跟着手指走的是 DragOverlay 里那份实体卡，
       这一项再按 dnd-kit 的 transform 挪到落点，就会和浮层里那份**叠在同一处**
       （两张卡重叠）。它自己留在原位、由调用方藏起来（`opacity-0`）。 */
    transform: isDragging ? 'none' : CSS.Translate.toString(transform),
    /* **被拖的那一项永远不给 transition。** 它在跟手指走，transition 会让它
       迟滞半拍，用户看到的就是「完全不跟手」。其余项（让位的那几格）不在跟
       手指走，动画正是要的效果 —— 这是「丝滑」的来源，缺了就变成闪现。
       判据是 `isDragging` 而不是让调用方传参：每一项自己就知道自己是不是被
       拖的那个，让调用点猜就等于给回归留个口子（设置页原来是「全不给」，让位
       全靠瞬移；曾经试过传 `animate`，参数本身就是个可以传错的东西）。 */
    transition: isDragging ? undefined : transition,
  };

  return { ref: setNodeRef, style, isDragging, isOver, attributes, listeners };
}

/* ============================ 排序区外壳 ============================ */

/**
 * 排序区外壳：自己一套 `DndContext` + `SortableContext` + `DragOverlay`。
 *
 * **为什么不共用顶层那个**：顶层的 `DndProvider` 故意不挂 `DragOverlay`
 * （见那里的注释：碰撞检测量的是浮层自己的 rect，空 div 量成 0×0，`over`
 * 永远是 null）。所以「跟着手指走的那一份」只能由**内层** context 承担 ——
 * 这样时间轴 / 泳道那条改时间的通路不受影响。
 *
 * 用法：
 *   <SortableZone items={ids} onDragEnd={fn} renderGhost={(id) => <Row id={id} />}>
 *     <ul>{ids.map((id) => <Chip key={id} id={id} />)}</ul>   // 每项自己 useSortableItem(id)
 *   </SortableZone>
 *
 * 出来是两样，和任务列表一模一样：**被拖的那一项留在原位**当「出处」锚点
 * （压暗 + 虚线 = 占位虚影），跟着指针走的是 `renderGhost` 画的那一份。
 */
export function SortableZone({ items, onDragEnd, renderGhost, children }: {
  items: string[];
  onDragEnd: (event: DragEndEvent) => void;
  /** 浮层里跟着指针走的那一份。**必须量得出矩形**（空 div 是 0×0，落点永远 null） */
  renderGhost: (id: string) => ReactNode;
  children: ReactNode;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useDragSensors();

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragEnd={(e) => { setActiveId(null); onDragEnd(e); }}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={items} strategy={rectSortingStrategy}>
        {children}
      </SortableContext>

      {/* 浮层跟着指针走，**不受 over 限制**。少了它，被拖的那块只在
          `over` 落在某个兄弟身上时才有 transform（见 useSortable 的
          `displaceItem = ... && isValidIndex(overIndex)`）—— 一离开容器，
          over 变 null，transform 整个丢掉，卡片就「飞回原位」。 */}
      <DragOverlay className="drag-overlay" dropAnimation={null}>
        {activeId ? renderGhost(activeId) : null}
      </DragOverlay>
    </DndContext>
  );
}

/* ============================ 可排序列表 ============================ */

/**
 * 一个完整的可排序列表 = `SortableZone` + 套一层 `<div class="sortable-item">`。
 *
 * 用法：
 *   <SortableList items={ids} onReorder={fn} renderItem={(id) => <Row id={id} />} />
 *
 * `onReorder` 收到的是**新的 id 顺序**，调用方负责把它写进 store。
 * 自己排版（要 `<li>`、要网格）的地方直接用 `SortableZone`。
 */
export function SortableList({ items, onReorder, renderItem, className, scope }: {
  items: string[];
  onReorder: (newItems: string[]) => void;
  renderItem: (id: string) => ReactNode;
  className?: string;
  /** 渲染成容器上的 `data-scope`。探针靠它定位列表，也是拖动作用域的标识 */
  scope?: string;
}) {
  const onDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = items.indexOf(String(active.id));
      const newIndex = items.indexOf(String(over.id));
      if (oldIndex >= 0 && newIndex >= 0) {
        onReorder(arrayMove(items, oldIndex, newIndex));
      }
    }
  }, [items, onReorder]);

  return (
    <SortableZone items={items} onDragEnd={onDragEnd} renderGhost={renderItem}>
      <div className={className} data-scope={scope}>
        {items.map((id) => (
          <SortableItem key={id} id={id}>
            {renderItem(id)}
          </SortableItem>
        ))}
      </div>
    </SortableZone>
  );
}

/** SortableList 内部的单个可排序项 */
function SortableItem({ id, children }: { id: string; children: ReactNode }) {
  const { ref, style, isDragging, isOver, attributes, listeners } = useSortableItem(id);

  return (
    <div
      ref={ref}
      style={style}
      {...attributes}
      {...listeners}
      /* 被拖的那一项**整个藏起来** —— 跟着手指走的是 DragOverlay 里那份实体卡，
         原位再留一个淡的就是「虚影锁定在原位」。占位虚影改由 `isOver` 那一格
         （`.drag-land`）画在落点上。 */
      className={cx('sortable-item', isDragging && 'opacity-0', isOver && 'drag-land')}
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
  const x = transform?.x ?? 0;
  const y = transform?.y ?? 0;
  /* **只取位移。** core 的 DndContext 里有一句
     `adjustScale(appliedTranslate, over?.rect, activeNodeRect)`，把 transform 的
     scaleX/scaleY 定成「落点 ÷ 自己」的尺寸比。日视图的落点是 `.timeline`
     （整天 1536px 高），方块只有几十像素高 → scaleY 能到 25 以上，
     一拖起来就铺满整屏。`CSS.Transform.toString` 会把这个比值一起烤进
     transform；`CSS.Translate` 只出 translate3d，尺寸锁死在提起时那一刻。 */
  const style: React.CSSProperties = { transform: `translate3d(${x}px, ${y}px, 0px)` };
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
    style: { transform: `translate3d(${clampedX}px, ${y}px, 0px)` },
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

/* ============================ 引导线 ============================ */

let guideLine: HTMLDivElement | null = null;

/**
 * 从 zone 上读出时间窗。
 *
 * **时间轴不再有写死的高度**：日视图锁成单屏，高度是 JS 按可见区域算出来的，
 * 所以 px↔分钟只能现场量（`data-from` / `data-to` 是 DayView 渲染时写进去的）。
 * 读不到就按整天算 —— 只可能发生在这个函数被喂了非时间轴 zone 的时候。
 */
function zoneWindow(zone: HTMLElement): DayWindow {
  const from = Number(zone.dataset.from);
  const to = Number(zone.dataset.to);
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) return { from, to };
  return FULL_DAY;
}

function drawTimeGuide(zone: HTMLElement, min: number, win: DayWindow): void {
  if (!guideLine) {
    guideLine = document.createElement('div');
    guideLine.className = 'tl-guide';
    const span = document.createElement('span');
    guideLine.appendChild(span);
    zone.appendChild(guideLine);
  }
  guideLine.style.top = ((min - win.from) / spanOf(win) * 100) + '%';
  const span = guideLine.querySelector('span');
  if (span) span.textContent = D.minToTime(min);
}

function clearTimeGuide(): void {
  if (guideLine) { guideLine.remove(); guideLine = null; }
}

/* ============================ 指针坐标 ============================ */

/**
 * 指针当前的横 / 纵坐标（视口坐标系）。
 *
 * **不能直接读 `activatorEvent.clientY`**：触摸拖拽的 activator 是 `TouchEvent`，
 * 它**没有** `clientX` / `clientY` —— 那两个在 `touches[0]` 上。读出来是 `undefined`，
 * 加上 `delta` 就是 `NaN`，一路传到 `minToTime()` 落库成字面量 `"NaN:NaN"`
 * （症状：日视图里拖一次任务，时间就废一次，**只有触摸会中招**，鼠标看不出来）。
 *
 * dnd-kit 自己的 `getEventCoordinates()` 已经把触屏 / 鼠标 / 键盘三种 activator
 * 归一了，直接用它，别再自己判类型。取不到就返回 `null`（键盘拖拽没有指针），
 * 调用方据此放弃本次落点，而不是拿 `NaN` 去写库。
 */
function eventX(event: DragOverEvent | DragEndEvent): number | null {
  const c = getEventCoordinates(event.activatorEvent);
  return c ? c.x + event.delta.x : null;
}

function eventY(event: DragOverEvent | DragEndEvent): number | null {
  const c = getEventCoordinates(event.activatorEvent);
  return c ? c.y + event.delta.y : null;
}

/* ============================ 时间计算 ============================ */

/** 纵坐标 → 分钟。`boxH` 由调用方量（见 zoneWindow 的注释） */
function minFromY(zone: HTMLElement, clientY: number): number {
  const rect = zone.getBoundingClientRect();
  return yToMin(clientY - rect.top, rect.height, zoneWindow(zone));
}

/** 周视图整列都是 24 小时、像素高度固定 —— 那一套还成立 */
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

    const currentY = eventY(event);
    if (currentY === null) return;

    if (overId.startsWith('timeline:')) {
      const min = minFromY(zone, currentY);
      drawTimeGuide(zone, min, zoneWindow(zone));
    } else if (overId.startsWith('week:')) {
      const min = weekGuideMin(zone, currentY);
      drawTimeGuide(zone, min, FULL_DAY);
    } else {
      clearTimeGuide();
    }
  }, []);

  const onDragEnd = useCallback((event: DragEndEvent) => {
    const over = event.over;
    clearTimeGuide();

    const activeId = String(event.active.id);
    const currentY = eventY(event);
    const currentX = eventX(event);
    /* 键盘拖拽没有指针坐标 —— 没有落点可算，保持原样，别拿 NaN 去写库 */
    if (currentY === null || currentX === null) return;

    /* 拖出外框（over 为 null）时**不去原位**：只要指针还横在时间轴上方，
       就按纵向最近的位置落 —— 拖到下方之外就落到最下方，拖到上方之外就落到最上方。
       `yToMin` 自己会收进窗内并对齐 15 分钟，所以「最近的位置」是免费的。 */
    if (!over) {
      const task = store.get().tasks[activeId];
      if (!task || !task.date) return;
      const tl = document.querySelector<HTMLElement>(`.timeline[data-zone-id="timeline:${task.date}"]`);
      if (tl) {
        const rect = tl.getBoundingClientRect();
        if (currentX >= rect.left && currentX <= rect.right) {
          const min = minFromY(tl, currentY);
          store.patchTask(activeId, { date: task.date, time: D.minToTime(min) });
          toast(`已改到 ${D.minToTime(min)}`);
        }
      }
      return;
    }

    const overId = String(over.id);
    const zone = document.querySelector<HTMLElement>(`[data-zone-id="${overId}"]`);
    if (!zone) return;

    const date = zone.dataset.date || null;

    if (overId.startsWith('timeline:')) {
      const min = minFromY(zone, currentY);
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

/**
 * sortable.tsx —— 列表排序：可排序项 / 排序区外壳 / 可排序列表
 */

import { useState, useCallback, type ReactNode, type CSSProperties } from 'react';
import {
  DndContext, DragOverlay,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, rectSortingStrategy, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cx } from '../cx.ts';
import { useDragSensors } from './sensors.ts';

/* ============================ 可排序项 ============================ */

/**
 * 列表排序用的可拖拽项 —— **排序类拖拽的唯一入口**。
 *
 * 用于：设置页功能区、任务列表、打卡、项目泳道。
 * 时间轴方块用 useDraggableEvent（不是排序，是改时间）。
 */
export function useSortableItem(id: string) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, over } = useSortable({ id });
  /* **被拖的那一项自己不算「落点」。** dnd-kit 的每个可排序项同时注册成
     droppable（拖拽接受区），碰撞检测不会把 active 自己排除掉 —— 提起那
     一瞬指针还压在原位上，`over.id === id` 于是 `isOver` 在自己身上为真，
     占位虚影就画在了出发的那一格。判据换成 `over` 的 id 与自己的 id 比，
     并且要求 `isDragging`（没拖起来时 `over` 可能是上一次残留）。 */
  const isOver = !!over && over.id !== id;

  const style: CSSProperties = {
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

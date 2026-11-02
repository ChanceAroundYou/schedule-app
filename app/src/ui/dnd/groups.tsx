/**
 * groups.tsx —— **跨容器**排序：把一个列表拆成若干组，拖到别的组就换归属
 *
 * 与 sortable.tsx 的分工：
 *   · `SortableZone` / `SortableList` = 一个容器内部排序（设置页、任务列表、打卡单项）
 *   · 本文件 = 多个容器之间搬运（打卡分类，2026-11-02）
 *
 * 为什么不能用 `SortableList` 拼几次：每次拼都是一个独立的 `DndContext`，
 * 一离开自己的 context 就没有落点了 —— 表现是「拖出组就飞回原位」。所以
 * 这里**只有一个 DndContext**，每组一个 `SortableContext`（dnd-kit 官方
 * 多容器示例的同一套结构）。
 *
 * 落点判定顺序（`onDrop` 的语义，调用方只需要写「挪到哪」）：
 *   1. 松手在**组容器**上（空组、或拖到组里但没压住任何一行）→ refId = null，
 *      表示落在该组末尾；
 *   2. 松手在**某一行**上 → refId = 那一行的 id，落点在它附近（前后由 store
 *      按「插到它那儿」处理）；
 *   3. 什么都没压到 → 不动。
 *
 * ⚠️ 碰撞检测换成 `closestCorners`（默认的 `rectIntersection` 在「容器 + 内部
 * 小行」同时注册时几乎总命中容器，于是永远判成「落到组末尾」，行与行之间的
 * 位置就永远插不进去）。这是 dnd-kit 官方多容器示例的选择，不是随手改的。
 */

import { useState, type ReactNode } from 'react';
import {
  DndContext, DragOverlay, closestCorners,
  useDroppable, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { cx } from '../cx.ts';
import { useDragSensors } from './sensors.ts';
import { useSortableItem } from './sortable.tsx';

/** 组容器的 droppable id 前缀。行 id 是 uuid，撞不上 */
const ZONE = 'grp:';

export interface SortableGroupData {
  /** 分类 id（未分类是空串） */
  id: string;
  /** 这一组里的行 id，按显示顺序 */
  items: string[];
}

export interface SortableGroupsProps {
  groups: SortableGroupData[];
  /** 拖完了：把 dragId 放进 toGroup（refId = 落点那一行，null = 组末尾） */
  onDrop: (dragId: string, toGroupId: string, refId: string | null) => void;
  /** 组头（折叠三角、名字、计数、删除）—— 由调用方决定长什么样 */
  renderHeader: (groupId: string) => ReactNode;
  /** 一行。**不要在这里套 useSortable**，本组件已经套过了 */
  renderItem: (itemId: string) => ReactNode;
  /** 组内容区为空时的提示（可选）。空组也要有一块能落下的地方 */
  emptyHint?: ReactNode;
}

export function SortableGroups({ groups, onDrop, renderHeader, renderItem, emptyHint }: SortableGroupsProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useDragSensors();

  const handleEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const dragId = String(e.active.id);
    const over = e.over;
    if (!over) return;
    const overId = String(over.id);
    if (overId === dragId) return;

    if (overId.startsWith(ZONE)) {
      onDrop(dragId, overId.slice(ZONE.length), null);
      return;
    }
    const host = groups.find((g) => g.items.includes(overId));
    // 落点行可能属于任何一组；找不到（理论上不会）就当未分类
    onDrop(dragId, host ? host.id : '', overId);
  };

  /** 拖的是哪一行 —— 浮层里要画它自己那份 */
  const activeGroup = activeId ? groups.find((g) => g.items.includes(activeId)) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      /* 与 provider / sortable 同一条理由：库自带的 AutoScroll 会让整页跟着滑 */
      autoScroll={false}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragEnd={handleEnd}
      onDragCancel={() => setActiveId(null)}
    >
      {groups.map((g) => (
        <GroupBox key={g.id || '__none'} group={g} header={renderHeader(g.id)} emptyHint={emptyHint}>
          {g.items.map((id) => (
            <SortableRow key={id} id={id}>{renderItem(id)}</SortableRow>
          ))}
        </GroupBox>
      ))}

      <DragOverlay className="drag-overlay" dropAnimation={null}>
        {activeId && activeGroup ? renderItem(activeId) : null}
      </DragOverlay>
    </DndContext>
  );
}

/** 一组的外壳：组头 + 可放置的内容区 */
function GroupBox({ group, header, emptyHint, children }: {
  group: SortableGroupData;
  header: ReactNode;
  emptyHint?: ReactNode;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: ZONE + group.id });
  const empty = group.items.length === 0;

  return (
    <section className={cx('hgroup', isOver && 'hgroup--over')} data-group={group.id || '__none'}>
      {header}
      <SortableContext items={group.items} strategy={rectSortingStrategy}>
        {/* `mc` 是列表的分列容器（≥1120px 两列），与原来那条平铺列表同一套 */}
        <div ref={setNodeRef} className={cx('hgroup-body mc', empty && 'hgroup-body--empty')}>
          {children}
          {/* 空组必须留一块**量得出矩形**的地方，否则拖不进去（0×0 的落点
              永远命中不了）。有内容时这块只是底部的补白，不占视觉。 */}
          {empty && (isOver ? <div className="hgroup-drop">放到这里</div> : (emptyHint || null))}
        </div>
      </SortableContext>
    </section>
  );
}

/** 组内的一行（与 SortableList 里那个包装层同一套视觉语义） */
function SortableRow({ id, children }: { id: string; children: ReactNode }) {
  const { ref, style, isDragging, isOver, attributes, listeners } = useSortableItem(id);
  return (
    <div
      ref={ref}
      style={style}
      {...attributes}
      {...listeners}
      className={cx('sortable-item', isDragging && 'opacity-0', isOver && 'drag-land')}
    >
      {children}
    </div>
  );
}

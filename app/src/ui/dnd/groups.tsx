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
 *   3. 什么都没压到（组间空隙、内容区空白）→ 碰撞判定兜底**就近落到最近的组**
 *      （2026-11-03 用户裁决：以前弹回原地，被当成「拖不进分类」）。
 *
 * ⚠️ 碰撞判定是**自定义**的（见下方 `collisionDetection`）：默认的
 * `rectIntersection` 在「容器 + 内部小行」同时注册时几乎总命中容器；纯
 * `closestCorners` 则在指针落在组间空隙时给 null（松手弹回）。现在的规则：
 * 指针压着行 → 行优先；在组内空白 → 落那个组；都不在 → 就近。
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  DndContext, DragOverlay, closestCorners, pointerWithin,
  useDroppable, type CollisionDetection, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { cx } from '../cx.ts';
import { useDragSensors } from './sensors.ts';
import { useSortableItem } from './sortable.tsx';

/** 组容器的 droppable id 前缀。行 id 是 uuid，撞不上 */
const ZONE = 'grp:';

/** 边缘自动滚的参数（2026-11-03）：上下缘各留多少 px 的「起滚带子」，以及每帧滚多少 px */
const SCROLL_EDGE = 64;
const SCROLL_SPEED = 14;

/**
 * 碰撞判定（2026-11-03 用户实测「拖不进分类」后重写）：
 *
 *  1. **指针压着行** → 行优先（落点插到那行附近，组内排序要这个精度）；
 *  2. 指针在**组的空白处**（组头、两行之间的缝、空组的提示区）→ 落到那个组；
 *  3. 指针不在任何落区里（组与组之间的 margin）→ 就近（closestCorners）。
 *
 * 旧版只有 `closestCorners` + droppable 挂在 44px 的 body 条上：拖途大段路程
 * `over` 是 null，松手直接弹回 —— 用户看到的就是「拖不进去」。
 */
const collisionDetection: CollisionDetection = (args) => {
  const within = args.pointerCoordinates ? pointerWithin(args) : [];
  const rows = within.filter((c) => !String(c.id).startsWith(ZONE));
  if (rows.length) return rows;
  if (within.length) return within;
  return closestCorners(args);
};

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

  /* ---- 边缘自动滚（2026-11-03 用户报「手机端从底部往上拖，页面不跟着滚」）----
     dnd-kit 自带的 autoScroll 有一堆内部生效条件（可滚祖先取的是 overNode 的、
     方向要靠 scrollIntent 记忆、阈值按被拖矩形与容器缘相交算），探针实测在本页
     **不生效**：拖拽明明激活（浮层都在）、指针压在容器上缘的阈值区里，
     #content.scrollTop 纹丝不动。不再指望库内部行为，自己滚，规则简单可测：
     拖拽期间指针进 #content 上/下缘 SCROLL_EDGE px 的带子（拖出内容区也一样，
     手指顶到屏幕边上更要继续滚），rAF 每帧 scrollBy 一口；拖拽结束/取消即停。
     ⚠️ 键盘拖拽没有 pointermove —— hasPointer 门挡住，不然指针坐标停在 (0,0)
     会被误判成「贴着上缘」一路滚到顶。 */
  useEffect(() => {
    if (!activeId) return;
    let raf = 0;
    let hasPointer = false;
    const pointer = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      hasPointer = true;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
    };
    const step = () => {
      if (hasPointer) {
        const el = document.getElementById('content');
        if (el) {
          const r = el.getBoundingClientRect();
          if (pointer.y < r.top + SCROLL_EDGE) el.scrollTop -= SCROLL_SPEED;
          else if (pointer.y > r.bottom - SCROLL_EDGE) el.scrollTop += SCROLL_SPEED;
        }
      }
      raf = requestAnimationFrame(step);
    };
    window.addEventListener('pointermove', onMove, true);
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove, true);
    };
  }, [activeId]);

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
      collisionDetection={collisionDetection}
      /* 库自带的 autoScroll 在本页实测不生效（见上方 useEffect 的说明），显式关掉：
         边缘滚动由我们自己的 rAF 实现，避免哪天库的内部条件凑齐了跟我们对滚、
         速度翻倍。时间轴场景（provider.tsx / sortable.tsx）与本组件无关。 */
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

/** 一组的外壳：组头 + 可放置的内容区。
 *  droppable 挂在**整个 section** 上（2026-11-03）：只挂 body 的话，可落区域
 *  只有空组那条 44px 窄条，用户把打卡项「放进分类」时落在组头/组内空白处
 *  都会被判到隔壁组或原地弹回。 */
function GroupBox({ group, header, emptyHint, children }: {
  group: SortableGroupData;
  header: ReactNode;
  emptyHint?: ReactNode;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: ZONE + group.id });
  const empty = group.items.length === 0;

  return (
    <section
      ref={setNodeRef}
      className={cx('hgroup', isOver && 'hgroup--over')}
      data-group={group.id || '__none'}
    >
      {header}
      <SortableContext items={group.items} strategy={rectSortingStrategy}>
        {/* `mc` 是列表的分列容器（≥1120px 两列），与原来那条平铺列表同一套 */}
        <div className={cx('hgroup-body mc', empty && 'hgroup-body--empty')}>
          {children}
          {/* 空组必须留一块**量得出矩形**的地方（0×0 的行落点命中不了）。
              有内容时这块只是底部的补白，不占视觉。 */}
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

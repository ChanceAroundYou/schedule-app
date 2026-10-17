/**
 * timeline.ts —— 时间轴拖拽的 onDragOver + onDragEnd + onDragCancel
 */

import { useRef, useCallback } from 'react';
import type { DragOverEvent, DragMoveEvent, DragEndEvent, Modifier } from '@dnd-kit/core';
import * as D from '../../domain/date.ts';
import * as store from '../../data/store.ts';
import { FULL_DAY } from '../../domain/layout.ts';
import { toast } from '../kit.tsx';
import {
  eventX, eventY, minFromY, weekGuideMin, zoneWindow,
} from './coords.ts';
import {
  drawTimeGuide, drawTimeCursor, clearTimeCursor,
  showDurationTag, clearDurationTags, clearTimeGuide,
} from './guide.ts';

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
  /* 当前指针压着的 zone。`onDragMove` 每次 pointer 移动都触发，但它**不带
     `over`**，所以引导线要连续跟指针，就得在这儿记下 `onDragOver` 找到的
     那个 zone（元素 + id —— id 用来区分 timeline / week 两种算法）。 */
  const zoneRef = useRef<{ el: HTMLElement; id: string } | null>(null);

  /* 日视图纵向钳位：卡片不能拖出 `.day-panel`（整个面板，含无时间区）。
     **夹的必须是 `.day-panel`**，不是 `.timeline` —— 后者只覆盖时间轴，
     夹它会把卡片挡在无时间区外（用户 2026-10-12：「没有办法把它拖到
     无时间的那片区域里了」）。`.day-panel` 是含 `.allday-zone` + `.tl-wrap`
     的整个面板，夹它才能在整个范围内拖动。 */
  const clampTimelineDrag: Modifier = ({ active, activeNodeRect, transform }) => {
    if (!active || !activeNodeRect) return transform;
    const el = document.querySelector<HTMLElement>(`.task-el--timed[data-id="${String(active.id)}"]`);
    const frame = el?.closest<HTMLElement>('.day-panel');
    if (!el || !frame) return transform;

    const rect = frame.getBoundingClientRect();
    const minY = rect.top - activeNodeRect.top;
    const maxY = rect.bottom - activeNodeRect.bottom;
    return { ...transform, y: Math.max(minY, Math.min(maxY, transform.y)) };
  };

  const onDragOver = useCallback((event: DragOverEvent) => {
    const over = event.over;
    if (!over) { zoneRef.current = null; clearTimeGuide(); clearTimeCursor(); return; }

    const overId = String(over.id);
    const zone = document.querySelector<HTMLElement>(`[data-zone-id="${overId}"]`);
    if (!zone) return;

    /* **绿线按 15 分钟档走，不跟卡片连续位置。** 用户要的是「绿线离散到
       0/15/30/45，松手后吸附到 15 分钟刻度」——绿线是落点预告，不是手指
       跟随器。卡片本身连续跟手（dnd-kit transform），绿线只告诉你松手后
       会落到哪个刻度。 */
    const activeId = String(event.active.id);
    const card = document.querySelector<HTMLElement>(`.task-el[data-id="${activeId}"]`);
    let min: number;
    if (card) {
      min = minFromY(zone, card.getBoundingClientRect().top);
      showDurationTag(card, activeId);
    } else {
      const currentY = eventY(event);
      if (currentY === null) return;
      min = minFromY(zone, currentY);
    }

    if (overId.startsWith('timeline:')) {
      zoneRef.current = { el: zone, id: overId };
      const win = zoneWindow(zone);
      drawTimeGuide(zone, min, win);
      drawTimeCursor(zone, min, win);
    } else if (overId.startsWith('week:')) {
      zoneRef.current = { el: zone, id: overId };
      drawTimeGuide(zone, weekGuideMin(zone, min), FULL_DAY);
    } else {
      zoneRef.current = null;
      clearTimeGuide();
      clearTimeCursor();
    }
  }, []);

  /* **引导线跟着指针走的唯一机会。** `onDragOver` 只在 `over` **变化**时触发 ——
     日视图的落点是整条时间轴，指针在轴内上下移动时 `over` 不变，
     `onDragOver` 不重复触发，绿线就停在进入那一刻不动（用户报「落点对应
     时间的绿线没有跟着动，到松手才出现」）。`onDragMove` 每次 pointer 移动
     都触发，连续更新只能放这儿。 */
  const onDragMove = useCallback((event: DragMoveEvent) => {
    const z = zoneRef.current;
    if (!z) return;

    /* 绿线按 15 分钟档走 */
    const activeId = String(event.active.id);
    const card = document.querySelector<HTMLElement>(`.task-el[data-id="${activeId}"]`);
    let min: number;
    if (card) {
      min = minFromY(z.el, card.getBoundingClientRect().top);
      showDurationTag(card, activeId);
    } else {
      const currentY = eventY(event);
      if (currentY === null) return;
      min = minFromY(z.el, currentY);
    }

    if (z.id.startsWith('timeline:')) {
      const win = zoneWindow(z.el);
      drawTimeGuide(z.el, min, win);
      drawTimeCursor(z.el, min, win);
    } else if (z.id.startsWith('week:')) {
      drawTimeGuide(z.el, weekGuideMin(z.el, min), FULL_DAY);
    }
  }, []);

  const onDragEnd = useCallback((event: DragEndEvent) => {
    const over = event.over;
    zoneRef.current = null;
    clearTimeGuide();
    clearTimeCursor();
    clearDurationTags();

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
      /* 落点跟绿线一致：用卡片顶部坐标，不用手指坐标。
         **吸附到 15 分钟档**（用户 2026-10-12：「松手后吸附到 15 分支刻度上」）——
         拖拽途中卡片连续跟手不跳，松手时才吸到档位，绿线预告的就是这个落点。
         未定时卡片拖到时间区也走这个分支。 */
      const card = document.querySelector<HTMLElement>(`.task-el[data-id="${activeId}"]`);
      const min = card
        ? minFromY(zone, card.getBoundingClientRect().top)
        : minFromY(zone, currentY);
      store.patchTask(activeId, { date, time: D.minToTime(min) });
      toast(`已改到 ${D.minToTime(min)}`);
      return;
    }

    if (overId.startsWith('week:')) {
      /* 落点跟绿线一致：用**卡片顶部**坐标，不用指针（用户 2026-10-17 报
         「想定位 6:00 却跳到 6:45」）。抓握点在卡片上的高低各不相同，指针坐标
         就把抓握偏移算进了落点；引导线（onDragOver / onDragMove）和日视图
         用的都是卡片顶，唯独松手这里是指针 —— 三处不一致，绿线预告的就不是
         实际落点。键盘拖拽没有卡片可量，退回指针坐标。 */
      const card = document.querySelector<HTMLElement>(`.task-el[data-id="${activeId}"]`);
      const min = card
        ? minFromY(zone, card.getBoundingClientRect().top)
        : weekGuideMin(zone, currentY);
      store.patchTask(activeId, { date, time: D.minToTime(min) });
      toast(`已改到 ${D.fmtMD(date || '')} ${D.minToTime(min)}`);
      return;
    }

    if (overId.startsWith('day:')) {
      /* 月视图格子：**改期不改时间**。定时任务拖到某天，时间时长原样带着走；
         以前这里和全天区共用 moveUntimed，会把 time / duration 一起清掉
         （用户 2026-10-17：月视图要能拖动任务定位到某一天）。未定时的才走
         moveUntimed —— 它负责在目标日那一组里重排序。 */
      const task = store.get().tasks[activeId];
      if (task && task.time) {
        store.patchTask(activeId, { date });
      } else {
        store.moveUntimed(activeId, date, null, 'after');
      }
      toast(date ? `已改到 ${D.fmtMD(date)}` : '已移回待办箱');
      return;
    }

    /* 有时间的卡片拖回无时间区也走 `moveUntimed`（它一次写 `{date, time:null}`
       并重排序）。分两支是因为：有时间的只 `patchTask({date})` 的话 **`time`
       没清**，任务算「改到同一天的同一时刻」，松手后原封不动停在时间轴上，
       看着就是「拖不回无时间区」（用户 2026-10-11）。 */
    if (overId.startsWith('allday:')) {
      store.moveUntimed(activeId, date, null, 'after');
      toast(date ? `已改到 ${D.fmtMD(date)}` : '已移回待办箱');
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
    zoneRef.current = null;
    clearTimeGuide();
    clearTimeCursor();
    clearDurationTags();
  }, []);

  return { modifiers: [clampTimelineDrag], onDragOver, onDragMove, onDragEnd, onDragCancel };
}

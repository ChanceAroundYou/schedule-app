/**
 * dndkit.tsx —— 基于 @dnd-kit 的拖放系统（桶文件）
 *
 * 实现已拆到 ./dnd/ 子目录，本文件保持 import 路径不变。
 *
 * 架构分层：
 *   DndProvider（包裹整棵应用，**不挂 DragOverlay**，见那里的注释）
 *   ├── SortableZone / SortableList（内层 context：排序，自带浮层）
 *   ├── useSortableItem（列表里的每一项）
 *   ├── useDraggableEvent（时间轴方块）
 *   ├── useDroppableZone（放置区）
 *   └── useTimelineDrag（日 / 周 / 泳道的落点计算）
 *
 * **触屏只有一条路：按住 TOUCH_DRAG_DELAY（250ms）开拖（TouchSensor 的 `delay`）。**
 * 长按操作层已于 2026-10-11 整体删除（用户明确要求），所以这里不再有
 * 「长按还是拖拽」的分叉 —— 手指挪没挪过都不弹东西，只决定拖不拖。
 *
 * 同步守卫：setDragging / isDragging 接口不变，engine.ts 的
 * `if (isDragging()) return` 照旧工作。
 */

export {
  useDragSensors,
  DragCtx,
  useDragSession,
  DndProvider,
  type DndProviderProps,
  useSortableItem,
  SortableZone,
  SortableList,
  useDraggableEvent,
  useClampedDraggableEvent,
  useDroppableZone,
  eventX,
  eventY,
  minFromY,
  zoneWindow,
  drawTimeGuide,
  drawTimeCursor,
  clearTimeCursor,
  showDurationTag,
  clearDurationTags,
  clearTimeGuide,
  useTimelineDrag,
} from './dnd/dnd.ts';

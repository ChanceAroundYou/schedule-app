/**
 * sensors.ts —— 拖拽传感器配置
 */

import { MouseSensor, TouchSensor, KeyboardSensor, useSensor, useSensors } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

/** 触摸拖拽延迟：按住 250ms 才开拖（2026-10-24 用户：「按的时间有点长」）。
 *  以前定 480ms 是为了和系统长按（文本选择 ~500ms）错开；文本选择已在
 *  触摸设备上全局禁掉（见 calendar.css 的 user-select:none），不再有竞争，
 *  就可以回到常规长按手感。滚动让位机制不变：delay 期间位移超 tolerance
 *  即取消激活、滚动照常 —— 边界由「动没动」决定，不由时间决定。 */
const TOUCH_DRAG_DELAY = 250;

/**
 * 鼠标和触摸**分开配**，不是「PointerSensor 一把抓」。
 *
 * 鼠标：移动 8px 就开拖 —— 轻点（不移动）不触发，点行开抽屉不受影响。
 * 触摸：按住 TOUCH_DRAG_DELAY 才开拖。
 *   用 delay 而不是 distance，是为了**把滚动让出来** —— 触摸下 distance 会让
 *   浏览器把手指移动判成滚动、直接发 pointercancel，拖拽根本起不来；
 *   而 touch-action: none 又会把整个列表的滚动一起禁掉。delay 期间不拦截，
 *   滚动照常，按住不动才提起。
 */
export function useDragSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_DRAG_DELAY, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

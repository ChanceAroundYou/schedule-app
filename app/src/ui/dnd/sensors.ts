/**
 * sensors.ts —— 拖拽传感器配置
 */

import { MouseSensor, TouchSensor, KeyboardSensor, useSensor, useSensors } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

/** 触摸拖拽延迟：按住这么久才开拖，把滚动让出来。
 *  480ms → 300ms（2026-10-24 五项反馈⑤）：480 比一般人「按住再拖」的那一下还长，
 *  于是手指已经动了、拖没起来，浏览器判成滚动 —— 用户看到的正是
 *  「拖卡片的同时整个区域在滑」。300ms 仍然是「有意按住」而不是误触的量级。
 *  ⚠️ 只改触摸。鼠标是 distance: 8，没有 delay 这一说。
 *
 *  与 dev 分支的差异（2026-10-25 合并时用户裁决）：dev 把它调到 250ms，
 *  理由是「文本选择已在触摸设备上全局禁掉、不再和系统长按竞速」—— 依据成立，
 *  但用户选了 300ms（比 250 更不像误触，比 480 明显更跟手）。**改这个数要问用户。** */
const TOUCH_DRAG_DELAY = 300;

/** 鼠标：移动多远开拖（也是「轻点不算拖」的那条线） */
const MOUSE_DISTANCE = 8;
/** 触摸：delay 窗口里手指移动超出这个数，这次拖拽作废、让给滚动 */
const TOUCH_TOLERANCE = 8;

/**
 * 鼠标和触摸**分开配**，不是「PointerSensor 一把抓」。
 *
 * 鼠标：移动 8px 就开拖 —— 轻点（不移动）不触发，点行开抽屉不受影响。
 * 触摸：按住 TOUCH_DRAG_DELAY 才开拖。
 *   用 delay 而不是 distance，是为了**把滚动让出来** —— 触摸下 distance 会让
 *   浏览器把手指移动判成滚动、直接发 pointercancel，拖拽根本起不来；
 *   而 touch-action: none 又会把整个列表的滚动一起禁掉。delay 期间不拦截，
 *   滚动照常，按住不动才提起。
 *
 * ⚠️ **开拖之后不让区域滑，靠的是两件事，缺一就复现⑤**：
 *   1. dnd-kit 的 `AbstractPointerSensor.handleMove` 只在**开拖之后**
 *      `event.preventDefault()`（delay 窗口里那条 if 直接 return）。所以
 *      「长按拽起 → 之后怎么动都不滚」是库保证的，别指望 CSS。
 *   2. dnd-kit 自带 AutoScroll（DndContext 的 `autoScroll` 默认 true）：
 *      拖着的方块进入某个可滚容器边缘的阈值区，它自己去 scrollBy 那个容器。
 *      未定时区只有 3.2 行高，卡片一挪就在那一区里 ⇒ 卡片被拖的同时区域在滑。
 *      已在 provider.tsx / sortable.tsx 两处关掉（键盘传感器本来就是关的，
 *      关掉之后三条路一致）。
 */
export function useDragSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: MOUSE_DISTANCE } }),
    useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_DRAG_DELAY, tolerance: TOUCH_TOLERANCE } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

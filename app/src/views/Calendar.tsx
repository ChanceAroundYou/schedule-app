/**
 * Calendar.tsx —— 日 / 周 / 月三视图（桶文件，保持 import 路径不变）
 *
 * 类名与 DOM 结构照抄 legacy/views.js —— styles.css 就是按这套写的。
 * 契约里最容易被「顺手简化」掉、但一改就出 bug 的几条：
 *
 *   · `.allday-zone` 上的 data-drop + data-date 必须挂在**最外层**。
 *     它内部有 padding，挂到内层 `.allday-items` 上的话，拖到留白、
 *     任务之间的空隙、容器边缘时 closest('[data-drop]') 找不到 zone，
 *     drop 静默失败 —— 用户看到的就是「有的任务拖不动」。
 *   · 时间轴的占用底纹 `.tl-busy` 必须与方块**同列宽**，不能整条铺满，
 *     否则两个穿插任务叠在一起时整段时间被染色。
 *   · 月视图行高只写**下限**（minmax(下限, auto)），不均分：
 *     均分会在 1920×1080 下拉出大片空白，而且刚好铺满时
 *     scrollHeight === clientHeight，滚轮彻底失效。
 */

import { DayView } from './calendar/DayView.tsx';
import { WeekView } from './calendar/WeekView.tsx';
import { MonthView } from './calendar/MonthView.tsx';

export { DayView } from './calendar/DayView.tsx';
export { WeekView } from './calendar/WeekView.tsx';
export { MonthView } from './calendar/MonthView.tsx';
export { useViewLayout } from './calendar/layout.ts';

/** 分发：按 ui.view 选视图 */
export function CalendarView({ state }: { state: import('../domain/types.ts').LocalState }) {
  const ui = state.ui;
  if (ui.view === 'day') return <DayView state={state} iso={ui.cursor} />;
  if (ui.view === 'week') return <WeekView state={state} iso={ui.cursor} />;
  return <MonthView state={state} iso={ui.cursor} />;
}

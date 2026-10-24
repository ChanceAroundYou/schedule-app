/**
 * Calendar.tsx —— 日 / 周 / 月三视图（桶文件，保持 import 路径不变）
 *
 * 类名与 DOM 结构照抄 legacy/views.js —— styles.css 就是按这套写的。
 * 契约里最容易被「顺手简化」掉、但一改就出 bug 的几条：
 *
 *   · 每个可落点的区块（`.allday-zone` / `.timeline` / `.week-col` / `.wun-cell` /
 *     `.month-cell`）必须把 `data-zone-id` + `data-date` 挂在**最外层**。
 *     拖 inset 是因为 —— 拖到留白、
 *     任务之间的空隙、容器边缘时 `closest('[data-zone-id]')` 找不到 zone，
 *     drop 静默失败 —— 用户看到的就是「有的任务拖不动」。
 *     同一个 `[data-zone-id]` 也被点击派发器认（点空格子就地新建），所以这两件事
 *     **认的是同一套区域划分**：改一边另一边必须跟着改，别给它们各起一套名字。
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
  if (ui.view === '3day') return <WeekView state={state} iso={ui.cursor} dayCount={3} />;
  if (ui.view === 'week') return <WeekView state={state} iso={ui.cursor} />;
  return <MonthView state={state} iso={ui.cursor} />;
}

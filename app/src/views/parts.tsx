/**
 * parts.tsx —— 列表行 / 胶囊 / 打卡条等公共片段（桶文件，保持 import 路径不变）
 *
 * 这里的类名和 DOM 结构是**照抄 legacy/views.js 的**，一个字都不能改 ——
 * styles.css（68KB）就是按这套类名写的，改名等于把设计系统推倒重来。
 *
 * 两处有意的改进：
 *   · 旧版用字符串拼 HTML，标题必须过一遍 U.esc()，漏一处就是 XSS。
 *     React 默认转义，所以这里**没有** esc，也不可能漏。
 *   · 行内按钮**不挂 onClick**，只写 `data-act` —— 全部由 App 在容器上做
 *     一次事件委托。行是 React 渲染的，拖动落库、同步落地都会换掉节点，
 *     逐行挂处理器会跟着一起丢；而委托只挂在容器上，永远有效。
 */

export { CheckBtn } from './parts/CheckBtn.tsx';
export { TaskRow, TaskPill, RepeatFlag, Empty, type TaskRowProps } from './parts/TaskRow.tsx';
export { CheckinStrip, HabitHeat, Caret, loadLevel } from './parts/Checkin.tsx';

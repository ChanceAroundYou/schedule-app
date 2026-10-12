/**
 * Lists.tsx —— 待办箱 / 今天 / 逾期 / 已完成（桶文件，保持 import 路径不变）
 *
 * 「逾期」是全应用唯一的口径来源：`!done && date && date < today`。
 * 「今天」**不含逾期** —— 这两条 2026-10-05 明确拆开过，之前混在一起
 * 会让同一条任务在两个徽标里各数一次。今天页顶部只给一条很轻的逾期提示。
 *
 * 每个 `data-drop="list"` 都要有自己的 `data-scope`：拖动排序的作用域就是它，
 * 跨作用域只改顺序、不搬家。「搬家」是改期按钮的职责。
 *
 * 这些组件**不接回调**，只写 `data-act` / `data-id` —— 点击由 App 统一委托。
 */

export { InboxView } from './lists/Inbox.tsx';
export { TodayView } from './lists/Today.tsx';
export { OverdueView } from './lists/Overdue.tsx';
export { DoneView } from './lists/Done.tsx';

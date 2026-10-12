/**
 * kit.tsx —— 应用内浮层与提示（桶文件）
 *
 * 存在的理由只有一条：**原生 confirm() / alert() / prompt() 在 PWA 里会被
 * 静默吞掉**（直接返回 false）。旧版就用原生 confirm，装成 App 之后
 * 表现是「点了删除完全没反应」，用户看不到任何提示，代码却以为他点了取消。
 *
 * 所以这里不导出任何原生对话框的包装 —— 要确认就走 useConfirm() 的 Promise，
 * 要提示就走 toast()。全应用没有第二套。
 *
 * 不再把原生 `<select>` 当作组件库基础。所有选择控件使用 `Dropdown`、`Chips` 或 `SheetPicker`。
 */

export { Btn } from './Btn.tsx';
export { Input, Textarea } from './Input.tsx';
export { Sheet } from './Sheet.tsx';
export { ConfirmProvider, useConfirm } from './Confirm.tsx';
export type { ConfirmOptions } from './Confirm.tsx';
export { toast, ToastHost } from './Toast.tsx';
export type { Toast } from './Toast.tsx';
export { IconBtn, MiniIconBtn } from './IconBtn.tsx';
export type { ElRef } from './IconBtn.tsx';
export { Dropdown } from './Dropdown.tsx';
export type { DropdownOption } from './Dropdown.tsx';
export { Chips } from './Chips.tsx';
export { SheetPicker } from './SheetPicker.tsx';
export { Card, Field, Row } from './Card.tsx';
export { InlineRename } from './InlineRename.tsx';

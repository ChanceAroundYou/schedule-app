/**
 * CalMenu.tsx —— 桌面端日程集多选下拉
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Layers } from 'lucide-react';
import type { LocalState } from '../../domain/types.ts';
import { useOutsideClose } from '../hooks.ts';
import { CalRow } from './CalRow.tsx';

/**
 * 桌面端：顶栏里的**下拉多选框**。
 *
 * 为什么不在侧栏：侧栏顺序是用户自己排的（`ui.navOrder`），塞个常驻控件进去
 * 会跟「底栏挑哪几项」抢位置；而「我在看哪几个集」是**全局**状态 —— 今天 /
 * 逾期 / 待办箱本来就跨集，放在顶栏哪儿都看得见。
 *
 * 移动端没有这个按钮：那边走「更多」抽屉里的入口 + 弹窗面板（CalSheet）。
 *
 * 触发键和移动端那格**长得一样**（用户 2026-10-09：「桌面端的显示也很古怪，
 * 请使用相同的图标和"日程集 x/y"文本」）：都是 Layers 图标 + 「日程集 x/y」。
 * x = 勾着的，y = 全部。箭头像个下拉留着 —— 它确实是下拉。
 */
export function CalMenu({ state }: { state: LocalState }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useOutsideClose(root, open, () => setOpen(false));
  /* Esc 关掉并把焦点还给触发键 —— 不还的话焦点掉到 body，键盘用户得从
     页首重新 Tab 一遍（同 Drawer / Sheet 那条约定）。 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const visible = state.cals;
  const shown = state.ui.cals;

  return (
    <div className="cal-menu" ref={root}>
      <button
        ref={btn}
        type="button"
        data-cal-menu
        className={'cal-menu-btn' + (open ? ' on' : '')}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="显示的日程集"
        onClick={() => setOpen(!open)}
      >
        <Layers size={13} className="shrink-0 opacity-70" />
        <span className="min-w-0 max-w-[10rem] truncate">日程集 {shown.length}/{visible.length}</span>
        <ChevronDown size={13} className="shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="cal-menu-pop" role="group" aria-label="显示的日程集">
          {visible.map((c) => <CalRow key={c.id} c={c} on={shown.includes(c.id)} />)}
        </div>
      )}
    </div>
  );
}

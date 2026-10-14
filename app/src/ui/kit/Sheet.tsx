/**
 * Sheet —— 底部浮层
 */

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cx } from '../cx.ts';
import { useFocusTrap, useModalFocus, useOutsideClose } from '../hooks.ts';
import { Btn } from './Btn.tsx';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** 面板底部固定的一排按钮 */
  footer?: ReactNode;
  /** 点遮罩是否关闭。确认类浮层通常设 false，逼用户做出选择 */
  dismissable?: boolean;
}

/**
 * 移动端风格的底部浮层，宽屏下变成居中卡片。
 *
 * z-index 必须压过底部标签栏（45）—— 否则抽屉会被标签栏盖住一截。
 */
export function Sheet({ open, onClose, title, children, footer, dismissable = true }: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const tid = useId();
  useOutsideClose(panel, open && dismissable, onClose);
  useFocusTrap(panel, open);
  useModalFocus(panel, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && dismissable) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, dismissable]);

  if (!open) return null;

  return createPortal(
    // 手机软键盘弹出时把整块顶上去：--kb 是 hooks.ts 量的键盘高度。
    // 里面那层 max-h 用 min(86dvh, 100%) —— 没键盘时还是原来的 86dvh，
    // 有键盘时 100% 就是「键盘上沿以上」那点空间，不会把按钮顶出屏幕。
    <div data-sheet-root="" className="fixed inset-0 z-[70] flex items-end justify-center pb-[var(--kb)] sm:items-center">
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title !== undefined ? tid : undefined}
        aria-label={title === undefined ? '提示' : undefined}
        tabIndex={-1}
        className={cx(
          'relative z-10 w-full max-w-md bg-[var(--panel)] text-[var(--text)]',
          'rounded-t-[var(--r-xl)] sm:rounded-[var(--r-xl)] shadow-xl max-h-[min(86dvh,100%)] flex flex-col',
        )}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
            <div className="text-[15px] font-semibold" id={tid}>{title}</div>
            <Btn variant="ghost" size="sm" onClick={onClose} aria-label="关闭">
              <X size={16} />
            </Btn>
          </div>
        )}
        {/* 底下留 16px + 安全区：原来只有 8px，最后一行贴死在面板底边上
            （用户 2026-10-09：「日程集的选择部分移动端请给顶多的空白，现在太挤了，
            都快贴死底部了」）。`env(safe-area-inset-bottom)` 在 iPhone 的
            圆角屏上再把 home 指示条那 34px 让出来。 */}
        <div className="osb overflow-y-auto px-5 pt-2 pb-[calc(16px+env(safe-area-inset-bottom))] text-sm leading-relaxed">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-5 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

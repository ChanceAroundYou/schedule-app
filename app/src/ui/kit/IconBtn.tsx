/**
 * IconBtn / MiniIconBtn —— 图标按钮
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx.ts';

interface IconBtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

export const IconBtn = forwardRef<HTMLButtonElement, IconBtnProps>(function IconBtn(
  { label, children, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cx(
        'inline-flex h-8 w-8 items-center justify-center rounded-[var(--r-pill)] transition',
        'text-[var(--text-2)] hover:bg-[var(--panel-3)]',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  );
});

/**
 * 行内紧凑图标按钮：24×24，用在**由 13px 文本撑高的行**里（成员行、邀请行）。
 *
 * 为什么不直接用 `IconBtn`：它是 32px，塞进成员行会把整行顶高 11px。
 * 为什么要有这个组件而不是各处手写：这个形状原先在 `Members.tsx`、
 * `Settings.tsx`、`Calendars.tsx` 里各写了一遍，圆角取的是 `--r-xs`
 * （风格轴最小那一档）而不是行内控件该用的 `--r-sm`，而且只有 hover 变红、
 * 没有按下态。收成一处，改一次三处都跟着走。
 *
 * 24px 是 WCAG 2.5.8 的下限 —— **别再往小改**（18px 的点按不准）。
 * `tone="danger"` 给「移出 / 撤回」这类会改变关系的操作。
 * `tone="primary"` 给「这一格是当前那一组里唯一要突出的动作」—— 行内改名的 ✓
 * （编辑态里它是唯一的提交动作，跟旁边灰色的 ✕ 得区分开）、默认日程集的星标。
 *
 * ⚠️ **这两个 tone 必须是这里的 prop，不能靠外面叠 `className`。**
 * 叠 `text-[var(--primary)]` 是不生效的：它和基类里的 `text-[var(--text-3)]`
 * 特异度一样，Tailwind 里同特异度只看**生成顺序**，谁后生成谁赢 —— 跟
 * `className` 写在前面还是后面无关。实测确认按钮拿到的是 `--text-3`
 * （`rgb(95,101,119)`），和旁边那个 ✕ 一模一样。见踩坑 17。
 * 同一条也解释了 `Btn` 为什么要拆 `chip` / `chipOn` 两档。
 *
 * ⚠️ **尺寸必须写 `h-[24px] w-[24px]`，不能写 `h-6 w-6`。**
 * Tailwind 的间距刻度是「0.25rem × n」，而本项目 `html { font-size: 14px }`
 * （tokens.css），于是 `1rem = 14px`、一档 = **3.5px** —— `h-6` 是 **21px**，
 * 比 24 差 3px。
 * 这个差不是「小一点无所谓」：21 < 24 就是没达到下限，而且肉眼看不出来。
 * 同一条也适用于别处写 `h-6` 当 24px 用的地方（本文件 `IconBtn` 的 `h-8`
 * 是 28px，达标，所以没暴露这个问题）。
 */
type MiniTone = 'danger' | 'primary';

const MINI_TONE: Record<MiniTone, string> = {
  danger: 'text-[var(--text-3)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]',
  primary: 'text-[var(--primary)] hover:bg-[var(--primary-soft)]',
};

export const MiniIconBtn = forwardRef<HTMLButtonElement, IconBtnProps & { tone?: MiniTone }>(
  function MiniIconBtn({ label, tone, children, className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        {...rest}
        className={cx(
          'inline-flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[var(--r-sm)] transition',
          'disabled:cursor-not-allowed disabled:opacity-40',
          tone ? MINI_TONE[tone] : 'text-[var(--text-3)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]',
          className,
        )}
      >
        {children}
      </button>
    );
  },
);

/** 给外部（比如在 effect 里）用的遮罩层元素引用类型别名 */
export type ElRef = React.RefObject<HTMLElement | null>;

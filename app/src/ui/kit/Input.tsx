/**
 * Input / Textarea —— 表单控件
 */

import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from '../cx.ts';

/* 输入框 / 文本域统一走这两个组件。
   样式全部引用 语义样式模块 的设计令牌（--input / --border-w / --r-md /
   --panel-2 / --primary），不在 .tsx 里写死颜色。
   需要特殊尺寸时用 className 覆盖，不要在组件里加 variant。

   字号是 **13px**，两档都是 —— 这不是随手挑的：13px 是界面文字那一档
   （成员名、列表行、行内改名的显示态），输入框里的字该跟它**一模一样**，
   否则点一下铅笔，同一行字会当场变大一号。

   ⚠️ 改这里的字号之前先看 `styles/tokens.css` 里 `input, select, textarea`
   那一条：它一度是**没有层**的作者样式，于是 `font-size: 14px` 把这里的
   `text-*` 全部吃掉了 —— 类名写得再对也不生效。现在它在 `@layer base` 里，
   工具类压得住；但**再往那条规则里加字号之前想清楚**（踩坑 17）。 */

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  dense?: boolean;
}

export function Input({ dense, className, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      className={cx(
        'w-full rounded-[var(--r-md)] border-[length:var(--border-w)] border-[var(--input)] bg-[var(--panel-2)] px-3 py-2 text-[13px] text-[var(--text)] outline-none transition',
        dense && 'h-[30px] w-auto px-2 text-[13px]',
        'focus:border-[var(--primary)] focus:bg-[var(--panel)] focus:shadow-[0_0_0_3px_var(--primary-soft),var(--shadow-md)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    />
  );
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...rest }, ref) => {
    return (
      <textarea
        ref={ref}
        {...rest}
        className={cx(
          'w-full rounded-[var(--r-md)] border-[length:var(--border-w)] border-[var(--input)] bg-[var(--panel-2)] px-3 py-2 text-[13px] text-[var(--text)] outline-none transition',
          'focus:border-[var(--primary)] focus:bg-[var(--panel)] focus:shadow-[0_0_0_3px_var(--primary-soft),var(--shadow-md)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      />
    );
  }
);

/**
 * Field —— 布局原语：一个小节（标题在上，内容在下）。
 *
 * `htmlFor` 传了才渲染成 `<label>`：小节标题大多是**一组控件的名字**
 * （色板 / 风格 / 深浅），那种该是 `div` —— 用 label 去套一组按钮，
 * 读屏会念成一个不存在的表单控件。真的是单个输入框时（日程集名字）才传
 * `htmlFor`，让它成为真正的 `<label>`。
 */
import type { ReactNode } from 'react';

export function Field({ label, htmlFor, icon, children, hint }: {
  label: string;
  htmlFor?: string;
  icon?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
}) {
  const head = 'mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-2)]';
  return (
    <div>
      {htmlFor
        ? <label htmlFor={htmlFor} className={head}>{icon}{label}</label>
        : <div className={head}>{icon}{label}</div>}
      {children}
      {hint && <div className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--text-3)]">{hint}</div>}
    </div>
  );
}

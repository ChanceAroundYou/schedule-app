/**
 * Card —— 布局原语：一张卡 = 一个主题。卡内一律由 `Field` 组成。
 *
 * 为什么放在组件库而不是设置页里：这套排法 `Settings.tsx` 和 `Members.tsx`
 * 都要用（成员 / 邀请那两块在两个地方渲染），而 `Members.tsx` 原先是把标题
 * 那一行 `mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-2)]`
 * **逐字抄了两遍**。抄出来的第二套一定会漂 —— 这正是这次要修的那类问题。
 *
 * 描边走 `--border-w` 而不是 Tailwind 的 `border`（写死 1px）：切到 flat 时
 * 全应用的线都变 2px，只有这里还是 1px，看着就像「这一块没跟上风格」。
 */
import type { ReactNode } from 'react';

export function Card({ icon, title, children, hint, extra }: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  hint?: ReactNode;
  /** 标题右边那一小块（比如「邀请收件箱」入口）。它是全局的，不属于卡里任何一个 Field */
  extra?: ReactNode;
}) {
  return (
    <section className="mb-4 rounded-[var(--r-lg)] border-[length:var(--border-w)] border-[var(--border)] p-4">
      <div className="mb-3 flex items-center gap-1.5">
        {/* 标题是 h2，`extra` 是它的**兄弟**而不是子节点 —— 里面可能是个按钮，
            交互内容套在标题里读屏会念成一团 */}
        <h2 className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-semibold">
          <span className="shrink-0 text-[var(--text-3)]">{icon}</span>
          <span className="min-w-0 truncate">{title}</span>
        </h2>
        {extra}
      </div>
      <div className="flex flex-col gap-3.5">{children}</div>
      {hint && <div className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-3)]">{hint}</div>}
    </section>
  );
}

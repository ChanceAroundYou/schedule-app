/**
 * Row —— 布局原语：一行控件（flex 换行 + 统一间距）。按钮排、输入框 + 按钮都走它。
 */
import type { ReactNode } from 'react';

export function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

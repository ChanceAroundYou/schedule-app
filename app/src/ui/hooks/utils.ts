/**
 * utils.ts —— 杂项 hooks（高度测量 / 防抖）
 */

import { useEffect, useState } from 'react';

/**
 * 把一个元素的实测高度写进 CSS 变量。
 *
 * 高度一律实算，不写 calc(100vh - N)：浏览器工具栏、缩放、系统字号都会让
 * 那个 N 猜错（实测差过 22px）。周视图的 sticky 表头就靠这个变量对齐。
 */
export function useMeasuredHeight<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  cssVar: string,
  deps: unknown[] = [],
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      el.style.setProperty(cssVar, el.getBoundingClientRect().height + 'px');
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, cssVar, ...deps]);
}

/** 防抖：搜索框这类高频输入用它，避免每个字符都重排整棵树 */
export function useDebounced<T>(value: T, ms = 180): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

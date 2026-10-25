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

/**
 * 实测一个元素的**自身高度**（不含滚动内容），返回像素数。
 *
 * 与 {@link useMeasuredHeight} 的区别：那条把高度写进 CSS 变量给别处对齐用；
 * 这里要把数字拿回 JS 里算算术（窄屏月视图格子能塞几行任务）。
 * 首帧返回 0，下一帧实测到就更新 —— 所以调用方要把 0 当「还没量到」处理。
 */
export function useElementHeight<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setH(el.getBoundingClientRect().height);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return h;
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


/**
 * 实测一个元素的**自身宽度**（不含滚动内容），返回像素数。
 *
 * 与 {@link useElementHeight} 对称；用于按设备实时算列宽（如周视图移动端），
 * 首帧返回 0，调用方要把 0 当「还没量到」处理。
 */
export function useElementWidth<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setW(el.getBoundingClientRect().width);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/**
 * hooks.ts —— React 与 store 的接缝
 *
 * store 的状态对象是**可变的**（每次写入深拷贝几百 KB 的 tasks 是纯浪费），
 * 所以订阅的不是状态本身，而是一个 version 计数器：版本变了就重渲染，
 * 渲染时直接读 store.get()。
 *
 * useSyncExternalStore 要求 getSnapshot 返回一个「变了就说明该重渲染」的值 ——
 * 计数器正好是这个语义，比每次都造一个新对象便宜得多。
 */

import { useSyncExternalStore, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as store from '../data/store.ts';
import type { LocalState } from '../domain/types.ts';

export function useStoreState(): LocalState {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store.get();
}

/**
 * 只看**当前选中的日程集**里那一份。日程 / 打卡 / 已完成这三个页面用它。
 *
 * 为什么在状态这一层过滤，而不是给每个查询函数加一个 calId 参数：
 * 下游十几个选择器全部只认 `s.tasks` / `s.habits`，过滤一次它们就不用动。
 * 「哪些页面跨集、哪些按集」是我们既定的一条界面约定（清单跨集，日程按集），
 * 表达成「这个页面拿到哪份 state」最直白，也不会有人忘了传参数。
 *
 * 今天 / 逾期 / 待办箱 / 垃圾箱**不**用这个 hook —— 它们是跨集的。
 */
export function useScopedState(): LocalState {
  const all = useStoreState();
  const version = store.getVersion();
  const cal = all.ui.cal;
  return useMemo(() => {
    if (!cal) return all;
    const tasks: LocalState['tasks'] = {};
    for (const [id, t] of Object.entries(all.tasks)) if (t.calId === cal) tasks[id] = t;
    const habits: LocalState['habits'] = {};
    for (const [id, h] of Object.entries(all.habits)) if (h.calId === cal) habits[id] = h;
    return { ...all, tasks, habits };
    // all 是可变的同一个引用，靠 version 触发重算
  }, [all, cal, version]);
}

/** 只关心状态里的一个派生值时用它，避免每次写入都重算整棵树 */
export function useStoreSelector<T>(pick: (s: LocalState) => T): T {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return pick(store.get());
}

/** 窗口宽度是否落在窄屏（与 styles.css 的 @media 断点必须一致） */
const NARROW = '(max-width: 900px)';

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

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

/** mousedown + capture 收起浮层。不用 capture 的话，面板内 input 的 blur 会抢先关掉它 */
export function useOutsideClose(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
): void {
  const cb = useRef(close);
  cb.current = close;
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) cb.current();
    };
    document.addEventListener('mousedown', on, true);
    return () => document.removeEventListener('mousedown', on, true);
  }, [ref, open]);
}

/** 长按（触屏没有 hover，排序 / 改期靠它）。只对非鼠标指针启用 */
export const LONG_PRESS_MS = 480;

export function useLongPress(onFire: (target: HTMLElement) => void, enabled = true) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  const start = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!enabled || e.pointerType === 'mouse') return;
    fired.current = false;
    const target = e.currentTarget;
    clear();
    timer.current = setTimeout(() => {
      fired.current = true;
      onFire(target);
    }, LONG_PRESS_MS);
  }, [clear, enabled, onFire]);

  return {
    onPointerDown: start,
    onPointerMove: clear,
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    /** 长按生效后抬手那一下会补一个 click，用它吞掉 */
    didFire: () => fired.current,
    resetFire: () => { fired.current = false; },
  };
}

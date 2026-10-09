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
 * 只看**侧栏勾选显示的那几个集**里那一份。日程 / 打卡 / 已完成用它。
 *
 * 为什么在状态这一层过滤，而不是给每个查询函数加一个 calId 参数：
 * 下游十几个选择器全部只认 `s.tasks` / `s.habits`，过滤一次它们就不用动。
 * 「哪些页面跨集、哪些按集」是我们既定的一条界面约定（清单跨集，日程按集），
 * 表达成「这个页面拿到哪份 state」最直白，也不会有人忘了传参数。
 *
 * **按 `ui.cals`（勾选的集合）过滤，不是 `ui.cal`（当前集）** —— 侧栏是
 * 多选的，勾三个就该看到三个集的条目。`ui.cal` 只管新东西落哪儿。
 * 一个都没勾就是空 state（日程页没有条目），这是用户主动选的结果，不是 bug。
 *
 * 今天 / 逾期 / 待办箱 / 垃圾箱**不**用这个 hook —— 它们是跨集的。
 */
export function useScopedState(): LocalState {
  const all = useStoreState();
  const version = store.getVersion();
  // join 成字符串当依赖：数组本身每次 setState 都是新引用，直接进依赖数组
  // 会让这行 memo 永远失效
  const shown = all.ui.cals.join(',');
  return useMemo(() => {
    const ids = new Set(shown ? shown.split(',') : []);
    if (!ids.size) return { ...all, tasks: {}, habits: {}, projects: {} };
    const tasks: LocalState['tasks'] = {};
    for (const [id, t] of Object.entries(all.tasks)) if (ids.has(t.calId)) tasks[id] = t;
    const habits: LocalState['habits'] = {};
    for (const [id, h] of Object.entries(all.habits)) if (ids.has(h.calId)) habits[id] = h;
    // 项目也是**按集**的（跟日程 / 打卡 / 已完成一样）：泳道看的是「这个集里
    // 在推进什么」，混着别人的会看不懂。跨集那四个页面（今天/逾期/待办箱/
    // 垃圾箱）照旧拿全量。
    const projects: LocalState['projects'] = {};
    for (const [id, p] of Object.entries(all.projects)) if (ids.has(p.calId)) projects[id] = p;
    return { ...all, tasks, habits, projects };
    // all 是可变的同一个引用，靠 version 触发重算
  }, [all, shown, version]);
}

/** 只关心状态里的一个派生值时用它，避免每次写入都重算整棵树 */
export function useStoreSelector<T>(pick: (s: LocalState) => T): T {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return pick(store.get());
}

/**
 * 浏览器报告的联网状态。
 *
 * 断网时**界面必须说话**：改动确实什么都没丢（在 outbox 里排队），但用户看不到
 * 这句话，只会以为「点了没保存」，然后重复操作。
 *
 * 用 `navigator.onLine` 而不是「上一次请求成不成功」：前者能立刻反映网线拔掉，
 * 后者的代价是每加一个探针就多一次请求。
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine,
  );
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    on();   // 事件监听之前状态可能就已经变了（比如从 bfcache 回来）
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);
  return online;
}

/**
 * 手机软键盘遮住了多少 —— 写进 `--kb`，给**定位固定**的那几个面用。
 *
 * 为什么要 JS：软键盘只压小**可视视口**（visualViewport），布局视口不动 ——
 * 所以 `100dvh` 还是满屏高，`position: fixed; bottom: 0` 的那几个面板
 * （详情抽屉、Sheet、登录页）下半截正好压在键盘底下，而且固定定位的元素
 * 浏览器没法替我们滚上来。页内正常滚动的输入框不用管，浏览器自己会滚。
 *
 * 两个数字都要减：`offsetTop` 是可视视口自己的偏移，iOS 上键盘弹出时它会跑，
 * 不减的话算出来的高度偏大、面板会被顶过头。
 *
 * 有的浏览器（viewport 里写了 `interactive-widget=resizes-content`）会连布局
 * 视口一起缩，那时 `innerHeight` 也跟着小，这里自然算出 0 —— 而那种模式下
 * `bottom: 0` 本来就贴着键盘上沿了，不用再动。两种情况都对。
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;   // 老浏览器：退回「浏览器自己滚」，不报错也不做事
    const apply = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', Math.round(kb) + 'px');
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      document.documentElement.style.removeProperty('--kb');
    };
  }, []);
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

/**
 * mousedown + capture 收起浮层。不用 capture 的话，面板内 input 的 blur 会抢先关掉它。
 *
 * `trigger` 是**开合那个按钮**。没有它就会跟开关自己打架：mousedown 先关，
 * 紧接着 click 又把状态翻回来 —— 表现是「点搜索键关不掉搜索框」，
 * 而且只在真机上出现（合成 click 不派发 mousedown，所以 `clickEl` 那套
 * 测试永远测不出来）。判据是「这一下是不是落在开关上」，不是「浮层开没开」。
 */
export function useOutsideClose(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
  trigger?: React.RefObject<HTMLElement | null>,
): void {
  const cb = useRef(close);
  cb.current = close;
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => {
      const el = ref.current;
      const t = e.target as Element | null;
      if (el && el.contains(t as Node)) return;
      if (trigger?.current?.contains(t as Node)) return;
      /* 嵌套浮层：「浮层里再弹一层」（SheetPicker、更多→日程集多选）。
         里面那层是 portal 到 body 的 —— DOM 上不是本面板的后代，于是 `contains`
         判不出来，这一下会被当成「点到外面」。capture 阶段的 mousedown 会**先一步**
         把本层关掉、连带把里层一起卸载，用户这一次点击就丢了：症状是「点选项没反应，
         浮层倒是没了」。而且只在真机上出现 —— 合成 click 不派发 mousedown，
         `clickEl` 那套测试永远测不出来（同上面 trigger 那条）。
         判据不是「在本面板外」，是「在**别的**浮层里」：拿落点自己那一棵
         `[data-sheet-root]` 跟本面板的比。落在本面板自己的遮罩上照旧要关。 */
      const own = (el?.closest('[data-sheet-root]') as Element | null) || null;
      const hit = (t?.closest?.('[data-sheet-root]') as Element | null) || null;
      if (hit && hit !== own) return;
      cb.current();
    };
    document.addEventListener('mousedown', on, true);
    return () => document.removeEventListener('mousedown', on, true);
  }, [ref, open, trigger]);
}

/**
 * 把 Tab 圈在一个浮层里。
 *
 * **为什么必须有**：`aria-modal="true"` 是对读屏的一句承诺 ——「外面那些是
 * 惰性的，别念」。没有这道圈，Tab 一路走到背后的列表上，读屏就把外面念出来了，
 * 那句承诺当场变成假话。所以凡是标了 aria-modal 的浮层都要挂这个。
 *
 * **它不抢焦点**：开浮层时焦点放哪由调用方决定（见 Drawer / Sheet 里那句
 * `panel.focus()`）。这一条是隐私性做不到的 —— 只圈住 Tab，不替谁聚焦。
 *
 * 过滤掉看不见的控件：导入备份那个 `<input type=file>` 常年藏起来，
 * 把它算进首尾会让 Tab 卡在一个没有焦点环的元素上。
 */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),'
  + 'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const root = ref.current;
      if (!root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((el) => el.getClientRects().length);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const cur = document.activeElement;
      const inside = cur instanceof HTMLElement && root.contains(cur);
      // 焦点本来就在圈外（比如刚打开、还没送进去）：Tab 往回拉，别让它顺着走
      if (e.shiftKey && (!inside || cur === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || cur === last)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [ref, active]);
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

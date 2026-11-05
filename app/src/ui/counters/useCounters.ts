/**
 * useCounters.ts —— 计数器（naonao / Kutai）的状态与写入
 *
 * 「+1」页与桌面小组件共用同一份服务端数据，这里管页面的读、写与对账。
 *
 * ## 为什么不存本地
 * 这个数字**会自己变**：服务端在每次读到它时结算「隔了几天 × 每日增量」。
 * 本地存一份副本，另一台设备或第二天打开就会对不上。所以一律以服务端返回的
 * `counters` 为准，点 `+` 只是先把界面改掉（免得等网络），拿到响应再覆盖。
 *
 * ## 一致性：三条来源，一个真相
 * 有四个地方会改这个数字（这一页、桌面小组件、另一台设备、每天 0 点的结算），
 * 它们之间没有共享内存，**唯一权威是服务端**。页面靠四路信号去对齐：
 *
 *   1. 自己写完 → 用响应里的 counters 覆盖（最快，也是主路径）
 *   2. 原生侧写完（桌面点了 +）→ 原生派发 `schedule:counters-changed`
 *      自定义事件，见 WidgetBridge.notifyCountersChanged。**同进程，零延迟**
 *   3. 窗口回到前台（focus / pageshow / visibilitychange / App resume）→ 重读
 *   4. 兜底轮询：页面可见时每 5s 读一次。给「另一台设备改了」「原生没通知到」
 *      这两类情况收尾
 *
 * 2026-10-27 之前只有「挂载时读一次 + focus」，而 Capacitor 的 WebView 里
 * visibilitychange 并不总触发，于是桌面点完再进 App 看到的还是旧值，
 * 得切一下页面（重新挂载）才更新 —— 就是用户报的那个现象。
 *
 * ## 轮询为什么不会把数字改回去
 * 一次轮询的响应可能在「用户刚点了 +」之后才回来，那份快照里没有这一下。
 * 两条保护：
 *   · 有写请求在飞时**不发起轮询**（`writes`）；
 *   · 只有最后一次请求的响应算数（`seq`），`load` 也占号。
 *
 * ## 连点为什么只认最后一个响应
 * 点两下 +，两个请求都在飞：第一个（+1）的响应若晚到，界面就从 2 掉回 1。
 * 桌面小组件那边为此专门改过（CounterStore.applyServer），这里是同一个坑。
 * 用递增序号丢弃过期响应；`load` 也占一个号，避免「刷新途中点了个 +」
 * 被旧快照盖回去。
 *
 * ## seq 够不够（2026-11-05 补：在途保留本地值）
 * `seq` 只保证「只认最后发出的请求的响应」，但 HTTP 不保证请求按发出顺序
 * 被服务端处理 —— 连点 10 下（5→15），最后一个请求可能先被处理（值才 5→6），
 * 它的响应通过 seq 检查，用中间值 6 覆盖了本地乐观值 15，界面先跳到 6，
 * 轮询读到最终值 15 又跳回来 —— 就是用户报的「跳到 7、又跳到 15」。
 *
 * 修法与桌面 CounterStore.sInflight 完全对齐：维护 `inflight`（id → 在飞数），
 * 响应回来时若该 id 还有在途请求，**保留本地乐观值**（不覆盖）；全回来后
 * 用服务端真值兜底（服务端夹了负数为 0 之类的也能自愈）。
 *
 * ## 为什么不每次 setList
 * 轮询每 5s 一次，若无条件 setList 就是每 5s 一次整页重渲染（还带着位图化的
 * 按钮）。所以先比对，值没变就返回原数组，React 会跳过渲染。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { fetchCounters, patchCounter, type Counter, type CounterPatch } from '../../data/api/counters.ts';
import { pushCounterCache, refreshCounterWidgets } from '../../data/widget.ts';

/** 正在编辑哪一格的哪个字段。value / name / daily 三选一。 */
export interface Editing {
  id: string;
  field: 'value' | 'name' | 'daily';
  draft: string;
}

/** 轮询间隔。比它更短只会白耗电，长一点则「另一台设备改的」要等太久 */
const POLL_MS = 5000;

/** 写完通知桌面的合并窗口：连点五下只刷一次组件 */
const WIDGET_REFRESH_MS = 250;

/** 原生侧派发的事件名。**改这里必须同步改 WidgetBridge.java** */
const NATIVE_EVENT = 'schedule:counters-changed';

/** 两份列表是否表示同一个状态（用来跳过无意义的重渲染） */
function sameCounters(a: Counter[], b: Counter[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (x.id !== y.id || x.name !== y.name || x.value !== y.value
      || x.dailyIncrement !== y.dailyIncrement) return false;
  }
  return true;
}

export function useCounters() {
  const [list, setList] = useState<Counter[]>([]);
  const [editState, setEditState] = useState<Editing | null>(null);
  const [err, setErr] = useState('');

  const seq = useRef(0);
  /** 在飞的写请求数。非 0 时不发起轮询 —— 那份快照里还没有这一下点击 */
  const writes = useRef(0);
  /** 当前列表的镜像。`send` 的乐观更新与 `apply` 的比对都读它 */
  const lastList = useRef<Counter[]>([]);
  /** 第一次成功读到之前的失败要显示；之后轮询失败就当没发生（别每 5s 闪一次错） */
  const everLoaded = useRef(false);

  /* 编辑态的镜像。`commit` 要读「当前编辑到一半的内容」，但它是由 blur / keydown
     这类**渲染之外**的事件触发的；用 setState 的 updater 里去发请求又会在
     StrictMode 下被执行两次（一次请求变两次）。所以留一份 ref。 */
  const editRef = useRef<Editing | null>(null);
  const setEdit = useCallback((v: Editing | null) => {
    editRef.current = v;
    setEditState(v);
  }, []);

  /** 落一份新快照。返回是否真的变了 —— 没变就不重渲染、也不推给桌面。 */
  const apply = useCallback((next: Counter[]): boolean => {
    const changed = !sameCounters(lastList.current, next);
    lastList.current = next;
    if (changed) setList(next);
    return changed;
  }, []);

  /** 在途登记：id → 在飞请求数。响应回来前，该 id 保留本地乐观值，不被服务端中间值覆盖 */
  const inflight = useRef<Map<string, number>>(new Map());

  const decInflight = useCallback((id: string) => {
    const cnt = (inflight.current.get(id) || 0) - 1;
    if (cnt <= 0) inflight.current.delete(id);
    else inflight.current.set(id, cnt);
  }, []);

  /**
   * 把服务端快照与本地合并：在途 id 保留本地值，其余用服务端。
   *
   * 连点时多个请求在飞，HTTP 不保证按发出顺序被服务端处理 —— 最后一个请求可能
   * 先返回，它的响应里是那一刻的中间值（比如 6，而非最终 15）。`seq` 只认
   * 最后发出的响应，但那个值可能是中间值 → 覆盖了本地乐观值。在途登记保证：
   * 只要还有请求在飞，该 id 就守住本地值；全回来后用服务端真值兜底。
   * 与桌面 CounterStore.sInflight 完全对齐（2026-11-05 修 App 内连点跳动）。
   */
  const merge = useCallback((server: Counter[]): Counter[] => {
    const inf = inflight.current;
    if (inf.size === 0) return server;
    const local = lastList.current;
    return server.map((s) => {
      if (!inf.has(s.id)) return s;
      const mine = local.find((c) => c.id === s.id);
      return mine ? { ...s, value: mine.value } : s;
    });
  }, []);

  /* 写完让桌面组件跟着变。页面上改了数字，桌面那块不该等下次点击才更新。
     合并一小会儿：连点五下只发一次刷新。 */
  const widgetTimer = useRef<number | null>(null);
  const scheduleWidgetRefresh = useCallback(() => {
    if (widgetTimer.current != null) window.clearTimeout(widgetTimer.current);
    widgetTimer.current = window.setTimeout(() => {
      widgetTimer.current = null;
      void refreshCounterWidgets();
    }, WIDGET_REFRESH_MS);
  }, []);

  /**
   * 读一次服务端。
   *
   * @param quiet 静默模式（轮询用）：失败不报错，也不清空已有数据
   */
  const load = useCallback(async (quiet = false) => {
    if (writes.current > 0) return;   // 写入在飞：别用旧快照盖掉乐观值
    const mine = ++seq.current;
    try {
      const next = await fetchCounters();
      if (mine !== seq.current) return;   // 期间又发了更新的请求，这份作废
      everLoaded.current = true;
      const merged = merge(next);         // 在途 id 保留本地值，防中间值覆盖
      if (apply(merged)) {
        // 数字真的变了才推桌面缓存：不然每 5s 一次轮询都会写一遍
        void pushCounterCache(merged);
      }
      setErr('');
    } catch (e) {
      if (mine !== seq.current) return;
      if (quiet && everLoaded.current) return;
      setErr(e instanceof Error ? e.message : '读不到计数器');
    }
  }, [apply, merge]);

  /* 进页面拉一次；之后四路信号对齐：回到窗口、切回标签页、App 回前台、
     原生侧写完的推送。最后加一路兜底轮询。 */
  useEffect(() => {
    void load();

    const wake = () => { void load(true); };
    const onVisible = () => { if (document.visibilityState === 'visible') wake(); };
    const onNative = () => { wake(); };

    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener(NATIVE_EVENT, onNative);
    document.addEventListener('visibilitychange', onVisible);

    /* App 从后台回来：Capacitor 的 appStateChange 比 visibilitychange 可靠
       （WebView 在部分机型上不报后者，这正是「切回来还是旧数字」的原因之一） */
    let dropAppListener: (() => void) | null = null;
    if (Capacitor.isNativePlatform()) {
      try {
        const pending = CapApp.addListener('appStateChange', (s) => {
          if (s.isActive) wake();
        });
        dropAppListener = () => { void pending.then((h) => h.remove()).catch(() => {}); };
      } catch (_) { /* 旧 APK 没有这个插件，退化成只看 visibilitychange */ }
    }

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (writes.current > 0) return;
      void load(true);
    }, POLL_MS);

    return () => {
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener(NATIVE_EVENT, onNative);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
      if (dropAppListener) dropAppListener();
      if (widgetTimer.current != null) window.clearTimeout(widgetTimer.current);
    };
  }, [load]);

  /** 先改界面、再发请求；成功用服务端返回覆盖，失败回滚成服务端最新值。 */
  const send = useCallback((id: string, patch: CounterPatch, optimistic?: (c: Counter) => Counter) => {
    if (optimistic) {
      const next = lastList.current.map((c) => (c.id === id ? optimistic(c) : c));
      lastList.current = next;
      setList(next);
    }
    const mine = ++seq.current;
    writes.current++;
    inflight.current.set(id, (inflight.current.get(id) || 0) + 1);  // 在途 +1
    patchCounter(id, patch)
      .then((next) => {
        writes.current--;
        decInflight(id);                  // 在途 -1（必须在 seq 丢弃之前减，否则永远不清零）
        if (mine !== seq.current) return;   // 后面还有更新的写，这次结果作废
        everLoaded.current = true;
        const merged = merge(next);         // 还有在途 → 保留本地乐观值
        if (apply(merged)) void pushCounterCache(merged);
        setErr('');
        scheduleWidgetRefresh();            // 桌面那块跟着变
      })
      .catch((e: unknown) => {
        writes.current--;
        decInflight(id);
        if (mine !== seq.current) return;   // 过期请求的失败不该盖住更新的结果
        setErr(e instanceof Error ? e.message : '没存上');
        void load(true);  // 回滚：以服务端为准
      });
  }, [apply, load, merge, scheduleWidgetRefresh, decInflight]);

  /** 把正在编辑的那一格提交掉（失焦 / 回车）。Escape 直接 setEdit(null) 不进来。 */
  const commit = useCallback(() => {
    const cur = editRef.current;
    if (!cur) return;
    setEdit(null);
    const { id, field, draft } = cur;
    if (field === 'name') {
      const v = draft.trim();
      if (v) send(id, { name: v });
      return;
    }
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n)) return;
    // 每日增量允许 0（关掉自动加）；值不允许负数（服务端也会夹）
    send(id, field === 'value' ? { value: Math.max(0, n) } : { dailyIncrement: Math.max(0, n) });
  }, [send, setEdit]);

  return { list, edit: editState, setEdit, err, send, commit, reload: load };
}

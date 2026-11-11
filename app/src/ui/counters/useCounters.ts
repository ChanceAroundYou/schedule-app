/**
 * useCounters.ts —— 计数器（naonao / Kutai）的状态与写入
 *
 * 「+1」页与桌面小组件共用同一份服务端数据，这里管页面的读、写与对账。
 *
 * ## 唯一权威 + 单调版本号（2026-11-11 重写）
 * 服务端每次真写都把 `rev` 加一，四个读入口（bootstrap / counters / 写响应 /
 * 原生推送）都带这个号。页面只维护两样东西：
 *
 *   · `base`   —— 已知**最高 rev 的服务端快照**（真值）
 *   · `pending`—— 我发出去但还没收到响应的写（意图）
 *
 * 屏幕上显示的是 `base + pending` 的投影，绝不把乐观值写进 `base`。
 * 于是这些老问题一起消失：
 *   · GET 比 POST 先到服务端、读到写之前的旧快照 → rev 更小，直接丢弃；
 *   · 连点两下，第一个响应晚到、带着中间值 → rev 更小，直接丢弃；
 *   · 另一台设备同时改了 → rev 更大，采信新值，再叠上我还没确认的意图。
 *
 * 以前那套「写后 2 秒冷却 + 写响应不采信 + 有写在飞就不轮询」全删了 ——
 * 那是用时间猜新旧，弱网下必然忽快忽慢。现在**只比较 rev**。
 *
 * ## 四路对齐
 *   1. 自己写完 → 用响应的 `counters`（rev 已推进）覆盖 base
 *   2. 原生侧写完（桌面点了 +）→ 事件带数据进真值总线，这里订阅
 *   3. 回到前台 / 切标签页 / App resume → 重读
 *   4. 兜底轮询：页面可见时每 5s 读一次（另一台设备、原生没通知到）
 *
 * ## 为什么先比对再 setList
 * 轮询每 5s 一次，无条件 setList 就是每 5s 一次整页重渲染（还带着位图化的
 * 按钮）。所以值没变就返回原数组，React 会跳过渲染。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import {
  fetchCounters, patchCounter, currentCounters, subscribeCounters,
  type Counter, type CounterPatch,
} from '../../data/api/counters.ts';
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

/** 与服务端 db/counters.js 的 MIN_VALUE / MAX_VALUE 一致 */
const MIN_VALUE = 0;
const MAX_VALUE = 999999;
const clamp = (v: number) => Math.max(MIN_VALUE, Math.min(MAX_VALUE, Math.round(v)));

/** 一次发出但还没收到响应的写。按数组顺序投影，所以「先设 300 再 +1」= 301。 */
interface PendingWrite {
  token: number;
  id: string;
  kind: 'delta' | 'set';
  amount: number;
}

/** 两份列表是否表示同一个状态（用来跳过无意义的重渲染） */
function sameCounters(a: Counter[], b: Counter[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (x.id !== y.id || x.name !== y.name || x.value !== y.value
      || x.dailyIncrement !== y.dailyIncrement
      || (x.rev || 0) !== (y.rev || 0)) return false;
  }
  return true;
}

export function useCounters() {
  const [list, setList] = useState<Counter[]>([]);
  const [editState, setEditState] = useState<Editing | null>(null);
  const [err, setErr] = useState('');

  /** 服务端权威快照（带 rev） */
  const base = useRef<Counter[]>([]);
  /** 未确认的写，按发生顺序排列 */
  const pending = useRef<PendingWrite[]>([]);
  /** 当前显示列表的镜像，用于跳过无意义重渲染 */
  const lastList = useRef<Counter[]>([]);
  /** 第一次成功读到之前的失败要显示；之后轮询失败就当没发生（别每 5s 闪一次错） */
  const everLoaded = useRef(false);
  const writeToken = useRef(0);

  /* 编辑态的镜像。`commit` 由 blur / keydown 这类渲染之外的事件触发；
     用 setState 的 updater 发请求会在 StrictMode 下被执行两次（一次请求变两次）。 */
  const editRef = useRef<Editing | null>(null);
  const setEdit = useCallback((v: Editing | null) => {
    editRef.current = v;
    setEditState(v);
  }, []);

  /** 把「服务端真值 + 未确认意图」投影成屏幕上该显示的列表 */
  const project = useCallback((): Counter[] => {
    const pend = pending.current;
    return base.current.map((s) => {
      let v = s.value;
      for (const w of pend) {
        if (w.id !== s.id) continue;
        v = w.kind === 'set' ? w.amount : v + w.amount;
      }
      const value = clamp(v);
      return value === s.value ? s : { ...s, value };
    });
  }, []);

  /** 落一份新快照。返回是否真的变了 —— 没变就不重渲染、也不推给桌面。 */
  const applyView = useCallback((): boolean => {
    const next = project();
    const changed = !sameCounters(lastList.current, next);
    lastList.current = next;
    if (changed) setList(next);
    return changed;
  }, [project]);

  /**
   * 收下一份服务端快照：**只认更大的 rev**。
   * 相等时仍采信服务端（同一个版本里它才是真值，本地可能残留乐观痕迹）；
   * 更小时整条丢弃 —— 这就是「跳一下又回去了」的根治点。
   */
  const accept = useCallback((server: Counter[]): boolean => {
    if (!Array.isArray(server) || !server.length) return false;
    const byId = new Map(base.current.map((c) => [c.id, c]));
    const next: Counter[] = [];
    for (const s of server) {
      const mine = byId.get(s.id);
      const rev = Number.isFinite(s.rev) ? Number(s.rev) : 0;
      if (mine && rev < (mine.rev || 0)) {
        next.push(mine);            // 过期响应：连值带名字一起作废
        byId.delete(s.id);
        continue;
      }
      next.push({ ...s, rev });
      byId.delete(s.id);
    }
    for (const leftover of byId.values()) next.push(leftover);
    base.current = next;
    return applyView();
  }, [applyView]);

  /* 写完让桌面组件跟着变。页面上改了数字，桌面那块不该等下次点击才更新。
     合并一小会儿：连点五下只刷一次组件。 */
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
   * @param quiet 静默模式（轮询用）：失败不报错，也不清空已有数据
   */
  const load = useCallback(async (quiet = false) => {
    try {
      const next = await fetchCounters();
      everLoaded.current = true;
      if (accept(next)) void pushCounterCache(base.current);
      setErr('');
    } catch (e) {
      if (quiet && everLoaded.current) return;
      setErr(e instanceof Error ? e.message : '读不到计数器');
    }
  }, [accept]);

  /* 进页面拉一次；之后四路信号对齐：真值总线、回到窗口、切回标签页、
     App 回前台，最后加一路兜底轮询。 */
  useEffect(() => {
    /* 入口的全局监听可能已经先收到过原生推送 —— 先看一眼总线，
       别让页面先闪一下旧数字再等网络。 */
    const cached = currentCounters();
    if (cached) accept(cached);
    void load();

    const wake = () => { void load(true); };
    const onVisible = () => { if (document.visibilityState === 'visible') wake(); };
    /* 原生事件带数据，入口已写进总线；这里只订阅，不直接监听 window，
       也不回推桌面缓存（桌面刚写完，别用 App 的缓存盖掉它的投影值）。
       旧 APK 的事件没有数据（空数组），那就当场重读一次。 */
    const unsubscribe = subscribeCounters((counters) => {
      if (counters.length) accept(counters);
      else void load(true);
    });

    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', onVisible);

    /* App 从后台回来：Capacitor 的 appStateChange 比 visibilitychange 可靠 */
    let dropAppListener: (() => void) | null = null;
    if (Capacitor.isNativePlatform()) {
      try {
        const p = CapApp.addListener('appStateChange', (s) => {
          if (s.isActive) wake();
        });
        dropAppListener = () => { void p.then((h) => h.remove()).catch(() => {}); };
      } catch (_) { /* 旧 APK 没有这个插件，退化成只看 visibilitychange */ }
    }

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void load(true);
    }, POLL_MS);

    return () => {
      unsubscribe();
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
      if (dropAppListener) dropAppListener();
      if (widgetTimer.current != null) window.clearTimeout(widgetTimer.current);
    };
  }, [load, accept]);

  /**
   * 先把意图投影到界面，再发请求；响应回来就采信服务端真值并撤回这份意图。
   * 失败则撤回意图并立刻重读一次（本地不该留着一个永远不会被确认的数）。
   */
  const send = useCallback((id: string, patch: CounterPatch) => {
    const token = ++writeToken.current;
    if (typeof patch.value === 'number') {
      pending.current.push({ token, id, kind: 'set', amount: patch.value });
    } else if (typeof patch.delta === 'number') {
      pending.current.push({ token, id, kind: 'delta', amount: patch.delta });
    }
    applyView();

    patchCounter(id, patch)
      .then((counters) => {
        pending.current = pending.current.filter((w) => w.token !== token);
        if (counters.length) accept(counters);
        else applyView();
        void pushCounterCache(base.current);
        setErr('');
        scheduleWidgetRefresh();
      })
      .catch((e: unknown) => {
        pending.current = pending.current.filter((w) => w.token !== token);
        applyView();
        setErr(e instanceof Error ? e.message : '没存上');
        void load(true);          // 回滚：以服务端为准
      });
  }, [accept, applyView, load, scheduleWidgetRefresh]);

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

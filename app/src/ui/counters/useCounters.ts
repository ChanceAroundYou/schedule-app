/**
 * useCounters.ts —— 计数器（naonao / Kutai）的状态与写入
 *
 * 「+1」页与（已删掉的）侧栏小卡片共用同一套逻辑，所以提到这里：
 * 一个页面只管画，读写与并发保护都在这。
 *
 * ## 为什么不存本地
 * 这个数字**会自己变**：服务端在每次读到它时结算「隔了几天 × 每日增量」。
 * 本地存一份副本，另一台设备或第二天打开就会对不上。所以一律以服务端返回的
 * `counters` 为准，点 `+` 只是先把界面改掉（免得等网络），拿到响应再覆盖。
 *
 * ## 连点为什么只认最后一个响应
 * 点两下 +，两个请求都在飞：第一个（+1）的响应若晚到，界面就从 2 掉回 1。
 * 桌面小组件那边为此专门改过（CounterStore.applyServer），这里是同一个坑。
 * 用递增序号丢弃过期响应；`load` 也占一个号，避免「刷新途中点了个 +」
 * 被旧快照盖回去。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCounters, patchCounter, type Counter, type CounterPatch } from '../../data/api/counters.ts';

/** 正在编辑哪一格的哪个字段。value / name / daily 三选一。 */
export interface Editing {
  id: string;
  field: 'value' | 'name' | 'daily';
  draft: string;
}

export function useCounters() {
  const [list, setList] = useState<Counter[]>([]);
  const [edit, setEditState] = useState<Editing | null>(null);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  /* 编辑态的镜像。`commit` 要读「当前编辑到一半的内容」，但它是由 blur / keydown
     这类**渲染之外**的事件触发的；用 setState 的 updater 里去发请求又会在
     StrictMode 下被执行两次（一次请求变两次）。所以留一份 ref。 */
  const editRef = useRef<Editing | null>(null);
  const setEdit = useCallback((v: Editing | null) => {
    editRef.current = v;
    setEditState(v);
  }, []);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await fetchCounters();
      if (mine === seq.current) { setList(next); setErr(''); }
    } catch (e) {
      if (mine === seq.current) setErr(e instanceof Error ? e.message : '读不到计数器');
    }
  }, []);

  /* 进页面拉一次；回到窗口 / 切回标签页时再拉（另一台设备或桌面组件改过的值
     要能看见）。不做定时轮询：这东西一天只自动变一次。 */
  useEffect(() => {
    void load();
    const onFocus = () => { void load(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  /** 先改界面、再发请求；成功用服务端返回覆盖，失败回滚成服务端最新值。 */
  const send = useCallback((id: string, patch: CounterPatch, optimistic?: (c: Counter) => Counter) => {
    if (optimistic) {
      setList((prev) => prev.map((c) => (c.id === id ? optimistic(c) : c)));
    }
    const mine = ++seq.current;
    patchCounter(id, patch)
      .then((next) => { if (mine === seq.current) { setList(next); setErr(''); } })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;   // 过期请求的失败不该盖住更新的结果
        setErr(e instanceof Error ? e.message : '没存上');
        void load();  // 回滚：以服务端为准
      });
  }, [load]);

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

  return { list, edit, setEdit, err, send, commit, reload: load };
}

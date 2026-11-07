/**
 * useFlow.ts —— 每日流程页的状态与写入
 *
 * 读写全在 `data/flowCache.ts`（本地副本 + 待发队列 + 服务端对齐），
 * 这里只做三件事：把缓存接进 React、管「看哪一天 / 模板还是当天」、
 * 把动作翻译成一次 `write()`。
 *
 * ## 为什么不在 LocalState 里
 *
 * 每日流程是**个人私有**的整份文档，和日程集、LWW 逐字段同步无关。
 * 塞进 LocalState 就得给它编一套 op 语义、改 persist / remote / 快照，
 * 而它真正需要的只是「整份存、整份取」。所以走 CounterView 那条路：
 * 页面自己拿数据，contentDispatch 里在日程集门禁之前返回。
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import * as D from '../../domain/date.ts';
import * as flow from '../../domain/flow.ts';
import * as cache from '../../data/flowCache.ts';

export type FlowMode = 'day' | 'template';

/** 前后各取几天。翻日期条时不用每次等网络；一周足够覆盖「昨天忘了勾」 */
const SPAN = 7;

export function useFlow(meId: string | null) {
  const [mode, setMode] = useState<FlowMode>('day');
  const [date, setDate] = useState(() => D.today());
  const [err, setErr] = useState('');

  // 缓存变化（本地写 / 网络回包 / 换账号）都从这一条路进来
  const snap = useSyncExternalStore(cache.subscribe, cache.snapshot, cache.snapshot);

  /* 账号变了就换了整份本地副本。`attach` 幂等，重复调用什么都没做 */
  useEffect(() => {
    cache.attach(meId);
  }, [meId]);

  /* 进页面拉一次服务端；失败不报错 —— 本地那份照样能看能改，联网后队列会补上 */
  useEffect(() => {
    if (!meId) return;
    const t = D.today();
    void cache.pull(D.addDays(t, -SPAN), D.addDays(t, SPAN));
  }, [meId]);

  /* 打开某一天：没有当天清单就按模板生成一份（用户 2026-11-07 确认的时机） */
  useEffect(() => {
    if (mode !== 'day') return;
    cache.ensureDay(date);
  }, [mode, date, snap.template]);

  const items = useMemo(() => {
    if (mode === 'template') return snap.template?.items ?? [];
    return snap.days[date]?.items ?? [];
  }, [mode, date, snap]);

  const doc = mode === 'template' ? 'template' : date;

  /** 一次写入：先本地生效，再排队发送 */
  const commit = useCallback((next: flow.FlowItem[]) => {
    cache.write(doc, next);
    setErr('');
  }, [doc]);

  const add = useCallback((title: string) => {
    const t = title.trim();
    if (!t || items.length >= flow.FLOW_MAX_ITEMS) return;
    commit([...items, flow.makeItem(t)]);
  }, [commit, items]);

  const toggle = useCallback((id: string) => {
    if (mode !== 'day') return;      // 模板没有「完成」这个概念
    commit(flow.toggleItem(items, id, Date.now()));
  }, [commit, items, mode]);

  const move = useCallback((id: string, to: number) => {
    const next = flow.moveItem(items, id, to);
    if (next === items) return;      // 越界 / 没动：不写，免得白白多一个 rev
    commit(next);
  }, [commit, items]);

  const remove = useCallback((id: string) => {
    commit(flow.removeItem(items, id));
  }, [commit, items]);

  const patch = useCallback((id: string, p: Partial<Pick<flow.FlowItem, 'title' | 'note' | 'at'>>) => {
    commit(flow.patchItem(items, id, p));
  }, [commit, items]);

  return {
    mode, setMode,
    date, setDate,
    items,
    progress: flow.progressOf(items),
    next: flow.currentItem(items),
    add, toggle, move, remove, patch,
    err, pendingCount: snap.pendingCount,
    /** 手动重试（页面上「未同步」那条提示点一下就重发） */
    retry: () => { void cache.flush(); },
  };
}

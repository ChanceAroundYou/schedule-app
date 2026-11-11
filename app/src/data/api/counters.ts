/**
 * counters.ts —— 计数器（naonao / Kutai）的读写与「真值总线」
 *
 * 服务端是**唯一权威**，本地不缓存：这是个会自己变的数字（每天 0 点结算
 * 「隔了几天 × 每日增量」），本地一缓存就会和另一台设备对不上。
 *
 * 和日程数据不同，计数器**不走 op/sync 通道**，也不能走 —— 那条通道是逐字段
 * 整值替换，并发 +1 会丢更新（见 server/lib/db/counters.js 开头的注释）。
 * 所以这里是独立的两个接口，形状与桌面小组件用的完全一致。
 *
 * ## rev：三份副本只认更大的号（2026-11-11）
 * App 内存、SharedPreferences、桌面原生缓存各有一份数字，以前靠「写后 2 秒
 * 内别信服务端」这种时间窗猜新旧，弱网和并发下就会「跳一下又回去了」。
 * 现在服务端每次真写都把 `rev` 加一，所有读入口（bootstrap / counters /
 * 写响应）都带着它，客户端只接受 `rev >= 本地` 的快照，过期响应一律丢弃。
 *
 * ## 真值总线
 * 原生侧写完计数器会派发 `schedule:counters-changed`（带数据）。这个事件
 * 由入口处**全局**装一次监听器（见 data/widget.ts），写进下面的模块级总线，
 * 而不是只在「+1」页挂载时才有人听。页面进来看一眼总线就能立刻显示真值，
 * 不必等 5 秒轮询。
 */

import { req } from './request.ts';

export interface Counter {
  id: string;
  name: string;
  value: number;
  /** 每天 0 点自动加多少。0 = 关掉。 */
  dailyIncrement: number;
  /** 上次结算到哪一天（YYYY-MM-DD，北京时间）。界面不显示，排查时有用。 */
  lastCreditDate?: string | null;
  /** 服务端单调值版本。旧服务端没有这个字段，客户端按 0 处理。 */
  rev?: number;
}

export interface CounterPatch {
  delta?: number;
  value?: number;
  name?: string;
  dailyIncrement?: number;
  /** 一次点击的凭据，服务端按它去重（重发不会多加一次） */
  opId?: string;
}

/** 拉一次当前值。**读的时候服务端会把「每天自动加」结算掉**，所以这里拿到的就是最新的。 */
export async function fetchCounters(): Promise<Counter[]> {
  const r = await req<{ counters: Counter[] }>('GET', 'widget/counters');
  return Array.isArray(r?.counters) ? r.counters : [];
}

/** 加减 / 设值 / 改名 / 改每日增量，四件事一条接口。返回写入后的全部计数器。 */
export async function patchCounter(id: string, patch: CounterPatch): Promise<Counter[]> {
  const opId = patch.opId || (typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const r = await req<{ counter: Counter; counters: Counter[] }>(
    'POST', 'widget/counter', { id, ...patch, opId },
  );
  return Array.isArray(r?.counters) ? r.counters : [];
}

/* ---------------------------------------------------------------- 真值总线 */

type Listener = (list: Counter[]) => void;
const listeners = new Set<Listener>();
let live: Counter[] | null = null;

/** 把一份服务端快照广播给所有订阅者，并留一份给随后才挂载的页面。
 *  空数组也是一次有效信号：表示「变了，但这次没带数据，页面自己重读」。 */
export function publishCounters(list: Counter[]): void {
  if (!Array.isArray(list)) return;
  if (list.length) live = list;
  for (const fn of listeners) {
    try { fn(list); } catch { /* 一个页面出错不该挡住别的订阅者 */ }
  }
}

export function subscribeCounters(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 页面刚挂载时先拿总线里的最新值，避免「切回来先闪一下旧数字」 */
export function currentCounters(): Counter[] | null {
  return live;
}

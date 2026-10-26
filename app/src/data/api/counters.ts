/**
 * counters.ts —— 计数器（naonao / Kutai）的读写
 *
 * 服务端是**唯一权威**，本地不缓存：这是个会自己变的数字（每天 0 点结算
 * 「隔了几天 × 每日增量」），本地一缓存就会和另一台设备对不上。
 *
 * 和日程数据不同，计数器**不走 op/sync 通道**，也不能走 —— 那条通道是逐字段
 * 整值替换，并发 +1 会丢更新（见 server/lib/db/counters.js 开头的注释）。
 * 所以这里是独立的两个接口，形状与桌面小组件用的完全一致。
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
}

export interface CounterPatch {
  delta?: number;
  value?: number;
  name?: string;
  dailyIncrement?: number;
}

/** 拉一次当前值。**读的时候服务端会把「每天自动加」结算掉**，所以这里拿到的就是最新的。 */
export async function fetchCounters(): Promise<Counter[]> {
  const r = await req<{ counters: Counter[] }>('GET', 'widget/counters');
  return Array.isArray(r?.counters) ? r.counters : [];
}

/** 加减 / 设值 / 改名 / 改每日增量，四件事一条接口。返回写入后的全部计数器。 */
export async function patchCounter(id: string, patch: CounterPatch): Promise<Counter[]> {
  const r = await req<{ counter: Counter; counters: Counter[] }>('POST', 'widget/counter', { id, ...patch });
  return Array.isArray(r?.counters) ? r.counters : [];
}

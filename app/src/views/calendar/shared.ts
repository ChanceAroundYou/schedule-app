/**
 * shared.ts —— 日 / 周 / 月三视图共用的小工具
 */
import { useSyncExternalStore } from 'react';

export const pad2 = (n: number): string => (n < 10 ? '0' + n : String(n));

export function hours24(): number[] {
  return Array.from({ length: 25 }, (_, h) => h);
}

export type LayoutEvent = {
  item: import('../../domain/types.ts').Task; start: number; end: number;
  col: number; cols: number;
  stack?: { i: number; n: number; key: string };
};

/* ---------------- 层叠翻层（三件以上重叠，方案 C） ----------------
   「谁在最上」是**同一簇所有卡片共享**的状态，放模块级小 store：
   键 = layoutOverlap 给的簇 key（簇首任务 id，全局唯一）。
   默认 0 = 最早开始的任务在最上；点压在下面的卡把它翻上来。 */

const stackTops = new Map<string, number>();
const stackSubs = new Map<string, Set<() => void>>();

export function stackTopOf(key: string, n: number): number {
  const v = stackTops.get(key);
  return v == null ? 0 : Math.min(v, n - 1);
}

export function setStackTop(key: string, i: number): void {
  stackTops.set(key, i);
  stackSubs.get(key)?.forEach((f) => f());
}

/** 订阅某簇的「最上层是第几件」。key 传 ''（无层叠）时恒返回 0，不订阅 */
export function useStackTop(key: string, n: number): number {
  return useSyncExternalStore(
    (cb) => {
      if (!key) return () => {};
      let s = stackSubs.get(key);
      if (!s) { s = new Set(); stackSubs.set(key, s); }
      s.add(cb);
      return () => { s?.delete(cb); };
    },
    () => (key ? stackTopOf(key, n) : 0),
  );
}

/**
 * habits.ts —— 打卡查询
 */

import type { LocalState, Habit } from '../types/types.ts';
import * as D from '../date.ts';
import { isGone, isTrashed } from './visibility.ts';

export function liveHabits(s: LocalState): Habit[] { return Object.values(s.habits).filter((h) => !isGone(h)); }

export function trashedHabits(s: LocalState): Habit[] {
  return Object.values(s.habits).filter(isTrashed).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

export function habitById(s: LocalState, id: string): Habit | null {
  const h = s.habits[id];
  return h && !isGone(h) ? h : null;
}

export function habitsTodayRemaining(s: LocalState): number {
  const t = D.today();
  return liveHabits(s).filter((h) => !h.log || !h.log[t]).length;
}

/**
 * 连续打卡天数：今天已打则从今天起算，否则从昨天起算。
 *
 * `todayIso` 可以传 —— 给小组件快照用（它要跟快照的日期范围用同一个
 * 「今天」，否则测试里固定日期就对不上）。
 */
export function habitStreak(h: Habit, todayIso: string = D.today()): number {
  if (!h || !h.log) return 0;
  let n = 0;
  let d = todayIso;
  if (!h.log[d]) {
    d = D.addDays(d, -1);
    if (!h.log[d]) return 0;
  }
  while (h.log[d]) { n++; d = D.addDays(d, -1); }
  return n;
}

/**
 * 历史最长连续天数（丙方案，2026-11-06）。
 *
 * 和 {@link habitStreak} 的区别：那个是「到现在还连着多少」，断了就归零；
 * 这个是「曾经最长连着多少」，断过也记得 —— 打卡页顶部那行汇总要用它，
 * 否则用户辛苦连了 30 天、断一天之后数字直接变 1，「坚持度」就白看了。
 *
 * 实现就在日期键上走一遍：`YYYY-MM-DD` 的字典序与时间序一致，
 * 相邻两天差 1 就续上。**不自己造日期序列** —— `log` 是稀疏表，
 * 按日期逐个问要跑几千次。
 */
export function habitBestStreak(h: Habit): number {
  if (!h || !h.log) return 0;
  const days = Object.keys(h.log).filter((d) => h.log![d]).sort();
  let best = 0;
  let run = 0;
  let prev = '';
  for (const d of days) {
    run = prev && D.diffDays(d, prev) === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return best;
}

/**
 * 打卡页顶部那行汇总（丙方案）。全部按**正在看的那一天**算，不是按今天 ——
 * 翻到 11-03 补打时，用户想看的是「那天到底打了几个」。
 *
 *   · `done / total`：那天打了几个 / 一共几项
 *   · `best`：所有项里最大的「当前连续」（截止那天）—— 断了就归零
 *   · `bestEver`：所有项里最大的「历史最长连续」—— 断过也记得
 *   · `month / monthDays`：那天所在月里**有打卡的天数** / 该月到今天的总天数
 *
 * `best` 和 `bestEver` 是两个不同的数：用户辛苦连 30 天、断一天之后前者变 0，
 * 后者还是 30 —— 顶部把两个都摆出来，「坚持度」才不因为一次漏打就白看了。
 */
export function habitDaySummary(habits: Habit[], iso: string): {
  done: number; total: number; best: number; bestEver: number; month: number; monthDays: number;
} {
  const ms = D.monthStart(iso);
  const monthLast = D.addDays(D.addMonths(ms, 1), -1);
  const today = D.today();
  const tms = D.monthStart(today);
  /* 分母 = 「这个月已经过了几天」。看的是本月就算到今天，过去的月算整月。 */
  const countedTo = ms < tms ? monthLast : (ms > tms ? null : today);
  const monthDays = countedTo ? D.diffDays(countedTo, ms) + 1 : 0;

  let done = 0;
  let best = 0;
  let bestEver = 0;
  const hitDays = new Set<string>();
  for (const h of habits) {
    const log = h.log || {};
    if (log[iso]) done++;
    const st = habitStreak(h, iso);
    if (st > best) best = st;
    const ever = habitBestStreak(h);
    if (ever > bestEver) bestEver = ever;
    for (const d of Object.keys(log)) {
      /* 未来的月是 0/0 —— 一天都还没过，报个数只会让人以为「这个月打了 0 天」。
         已经预约的预打仍然算进 `done`（那是「那天打了没」），但它不构成「坚持到几号」。 */
      if (countedTo && log[d] && d >= ms && d <= monthLast && d <= countedTo) hitDays.add(d);
    }
  }
  return { done, total: habits.length, best, bestEver, month: hitDays.size, monthDays };
}

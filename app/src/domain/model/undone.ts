/**
 * undone.ts —— 「这一天还没清空」的唯一口径
 *
 * 判哪几种情况算「这天有没做完的事」（用户 2026-11-06 定的口径：当天没做完的都算）：
 *   · 那天安排的普通任务没打勾 → 算（含已完成区里变灰的那种，只看 `done`）
 *   · 逾期：过去某天没做完 → 自然算（它就是「那天的任务没打勾」）
 *   · 打卡：只点亮**今天** —— 今天还有没打的卡，今天就算没清空
 *
 * 打卡为什么不点亮过去的日子：打卡记录是「打过的那天才有键」的稀疏表
 * （`Habit.log`），**没有任何地方记录「那天本来该打」**。按它回溯等于把这个人
 * 从建号以来的每一天都点亮 —— 那是噪音，不是提示。所以它只管今天这一格。
 *
 * **口径只在这里判一次**，消费方（三端）都调它：
 *   · 顶栏「找日期」面板 / 快速添加的月历密度短横（`MiniCalendar.loadOf`）
 *   · 周 / 3 日视图的日期头、日视图顶栏标题下方那颗小圆点
 *   · 桌面小组件的日期 chip（快照与原生兜底两条链路各自实现同一判据，
 *     见 ScheduleWidgetProvider.dayHasUndone）
 *
 * 「按哪几个集算」由**传进来的那份 state** 决定，不在这里二次过滤：
 * 日程页拿的是 `useScopedState`（已按侧栏勾选过滤），今天 / 逾期那几页拿的是全量
 * —— 那是它们各自的既有约定，这里不越权改。
 */
import type { LocalState } from '../types/types.ts';
import * as D from '../date.ts';
import { isGone } from './visibility.ts';
import { habitsTodayRemaining } from './habits.ts';

/**
 * 日期 → 「那天几条没做完」。一次遍历算完整张表，两处消费都从它派生：
 * 圆点要的是「有没有」（>0），月历密度短横要的是「几条」（宽度分三档）。
 * 分成两个函数各扫一遍 tasks 的话，两份判据迟早漂移 —— 所以只扫一遍。
 */
export function undoneLoads(s: LocalState): Map<string, number> {
  const loads = new Map<string, number>();

  for (const t of Object.values(s.tasks)) {
    if (isGone(t) || t.done || !t.date) continue;
    loads.set(t.date, (loads.get(t.date) || 0) + 1);
  }

  /* 未来（log 里正常不会有，防脏数据）也不点亮：打卡是「每天一次」的事，
     提前点亮还没到的日子等于凭空造出一条不存在的欠账。 */
  const habits = habitsTodayRemaining(s);
  if (habits > 0) {
    const t = D.today();
    loads.set(t, (loads.get(t) || 0) + habits);
  }

  return loads;
}

/** 给 `MiniCalendar` 的 `loadOf`：一次算好，逐格查表 */
export const undoneLoadOf = (s: LocalState): ((iso: string) => number) => {
  const loads = undoneLoads(s);
  return (iso) => loads.get(iso) || 0;
};

/** 有没做完的事的日期集合（三端圆点的判据） */
export function undoneDates(s: LocalState): Set<string> {
  return new Set(undoneLoads(s).keys());
}

/** 单点查询。批量场景请直接拿 undoneDates / undoneLoadOf 复用那一份。 */
export const hasUndone = (s: LocalState, iso: string): boolean =>
  undoneLoads(s).get(iso) !== undefined;

/**
 * RepeatRule —— 重复规则
 */

export type RepeatUnit = 'none' | 'day' | 'week' | 'month' | 'year';

export interface RepeatRule {
  unit: RepeatUnit;
  /** 每隔几个单位 */
  n: number;
  /** unit='week' 时生效；空数组表示沿用原日期的星期 */
  weekdays: number[];
  /** unit='month' 时生效。注意它和 task.date 是两回事，见 repeat.ts */
  monthday: number;
  /** unit='year' 时生效。1-12，表示每年的哪个月 */
  yearMonth?: number;
  end: null | { type: 'date'; date: string } | { type: 'count'; count: number };
}

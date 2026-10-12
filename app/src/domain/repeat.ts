/**
 * repeat.ts —— 重复规则：推进、派生 id、文案
 *
 * ⚠️ 这里是本次重构**最容易损坏数据**的地方，改动前先读完这一段。
 *
 * 旧版 DB.repeatAdvance() 在勾选完成时新建一个实例，**id 随机**。
 * 两台设备各自离线勾选同一条「每天」任务 → 各自新建一个实例 → 同步后任务翻倍。
 *
 * v4 把实例 id 改成**确定性派生**：
 *
 *     instanceId = `${seriesId}#${occurrenceDate}`
 *
 * 两台设备算出同一个 id，同步时自然合并成一条。seriesId 本身是系列第一条
 * 任务的 UUIDv4，一旦生成永不变。occurrenceDate 是这次发生**原本应该在的日期**，
 * 不是实际完成的日期。
 *
 * 不用 uuidv5：可读形式已经确定性，调试时还能肉眼对账，哈希没有额外收益。
 */

import * as D from './date.ts';
import type { RepeatRule, Task } from './types.ts';

export const REPEAT_UNITS: { value: RepeatRule['unit']; label: string }[] = [
  { value: 'day', label: '天' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
  { value: 'year', label: '年' },
];

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** 生成一份空的重复规则 */
export function emptyRepeat(date: string | null): RepeatRule {
  const d = date ? D.parseISO(date) : D.parseISO(D.today());
  return {
    unit: 'none',
    n: 1,
    weekdays: [],
    monthday: d.getDate(),
    yearMonth: d.getMonth() + 1,
    end: null,
  };
}

/** 把旧的字符串型 repeat 升级成对象（v3 之前的 'weekly' 之类） */
export function toRepeat(old: unknown, date: string | null): RepeatRule {
  const r = emptyRepeat(date);
  if (!old) return r;

  if (typeof old === 'string') {
    const map: Record<string, RepeatRule['unit']> = {
      none: 'none', daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year',
    };
    r.unit = map[old] || 'none';
    if (r.unit === 'week') r.weekdays = [D.weekdayOf(date || D.today())];
    return r;
  }

  if (typeof old === 'object') {
    const o = old as Partial<RepeatRule>;
    r.unit = o.unit || 'none';
    r.n = Math.max(1, Number(o.n) || 1);
    r.weekdays = Array.isArray(o.weekdays) ? o.weekdays.slice() : [];
    r.monthday = o.monthday || r.monthday;
    r.yearMonth = o.yearMonth || r.yearMonth;
    r.end = o.end || null;
  }
  return r;
}

export function repeatLabel(r: RepeatRule | null | undefined): string {
  if (!r || r.unit === 'none') return '';
  const n = Math.max(1, r.n || 1);
  const wd = (r.weekdays && r.weekdays.length)
    ? r.weekdays.slice().sort().map((d) => WEEKDAY_LABELS[d]).join('、')
    : '';

  if (r.unit === 'day') return n === 1 ? '每天' : '每 ' + n + ' 天';
  if (r.unit === 'week') {
    if (n === 1) return wd ? '每周' + wd : '每周';
    return '每 ' + n + ' 周' + (wd ? ' 的周' + wd : '');
  }
  if (r.unit === 'month') {
    const md = r.monthday ? r.monthday + ' 号' : '';
    return n === 1 ? ('每月' + (md ? ' ' + md : '')) : ('每 ' + n + ' 个月' + (md ? ' ' + md : ''));
  }
  const ym = r.yearMonth ? r.yearMonth + ' 月' : '';
  const ymd = r.monthday ? r.monthday + ' 号' : '';
  const ymStr = (ym || ymd) ? ' ' + ym + (ym && ymd ? ' ' : '') + ymd : '';
  return n === 1 ? ('每年' + ymStr) : ('每 ' + n + ' 年' + ymStr);
}

/** 单步推进：返回 base 之后的下一个发生日 */
export function repeatAdvance(rule: RepeatRule, base: string): string | null {
  if (!rule || rule.unit === 'none') return null;
  const n = Math.max(1, rule.n || 1);

  if (rule.unit === 'day') return D.addDays(base, n);

  if (rule.unit === 'week') {
    const wd = (rule.weekdays && rule.weekdays.length) ? rule.weekdays : [D.weekdayOf(base)];
    const span = 7 * n;
    for (let i = 1; i <= span; i++) {
      const d = D.addDays(base, i);
      if (wd.indexOf(D.weekdayOf(d)) >= 0) return d;
    }
    return D.addDays(base, span);
  }

  if (rule.unit === 'month') {
    // monthday 与 task.date 要分开看：每月 31 号的任务在 2 月会被截到月末，
    // 但 task.date 仍是 31 号。别用 task.date 反推 monthday。
    const day = rule.monthday || D.parseISO(base).getDate();
    const anchor = D.parseISO(D.addMonths(D.monthStart(base), n));
    const last = D.lastDayOfMonth(anchor.getFullYear(), anchor.getMonth() + 1);
    return anchor.getFullYear() + '-' + D.pad(anchor.getMonth() + 1) + '-' + D.pad(Math.min(day, last));
  }

  // year：用 yearMonth 指定月份，monthday 指定几号
  const month = rule.yearMonth || (D.parseISO(base).getMonth() + 1);
  const day = rule.monthday || D.parseISO(base).getDate();
  const targetYear = D.parseISO(base).getFullYear() + n;
  const last = D.lastDayOfMonth(targetYear, month);
  return targetYear + '-' + D.pad(month) + '-' + D.pad(Math.min(day, last));
}

/**
 * 下一个实例日期：一路补到今天（含）并检查结束条件。
 *
 * 收口条件是**「必须往前走」**，不是一个写死的次数上限。
 * 上限被证明是错的：一条 2020 年起的「每天」任务需要 2400+ 步才能补到今天，
 * 而原来那个 800 的 guard 在中途就断了，返回一个 2022 年的日期 ——
 * 于是每勾一次完成就凭空造出一个过去的实例，正是它本来要防的那个 bug。
 * 用 `next > cursor` 判据既能防死循环（规则卡住不动），又不会在大跨度上误伤。
 */
export function repeatNext(task: Task, base: string): string | null {
  const r = task.repeat;
  if (!r || r.unit === 'none') return null;

  const today = D.today();
  let cursor = base;
  let next = repeatAdvance(r, cursor);
  while (next && next < today && next > cursor) {
    cursor = next;
    next = repeatAdvance(r, cursor);
  }
  // 规则原地踏步（坏数据），宁可不建实例也不要造一个过去的
  if (!next || next <= cursor) return null;

  if (r.end) {
    if (r.end.type === 'date' && r.end.date && next > r.end.date) return null;
    if (r.end.type === 'count' && (task.repeatSeq || 0) + 1 > (r.end.count || 0)) return null;
  }
  return next;
}

/** 重复实例的确定性 id。两台设备各自离线算，结果必须一模一样。 */
export function instanceId(seriesId: string, occurrenceDate: string): string {
  return seriesId + '#' + occurrenceDate;
}

/** 系列根 id：非重复任务是 null，重复任务第一次创建时以自己的 id 为根 */
export function seriesRootOf(task: Pick<Task, 'id' | 'seriesId' | 'repeat'>): string | null {
  if (task.seriesId) return task.seriesId;
  if (task.repeat && task.repeat.unit !== 'none') return task.id;
  return null;
}

/**
 * 最后一次发生日期。
 *
 * `end.type === 'never'`（不结束）→ null，永远没有最后一次。
 * `end.type === 'date'` → ≤ end.date 的最后一次发生。
 * `end.type === 'count'` → 第 N 次发生。
 *
 * `base` 是任务日期（系列第一条的日期），不是今天。
 * 返回 null 表示算不出（没有结束条件 / 数据不对）。
 */
export function repeatLast(task: Task, base: string): string | null {
  const r = task.repeat;
  if (!r || r.unit === 'none') return null;
  if (!r.end) return null;

  if (r.end.type === 'date' && r.end.date) {
    let cursor = base;
    let next = repeatAdvance(r, cursor);
    while (next && next <= r.end.date) {
      cursor = next;
      next = repeatAdvance(r, cursor);
    }
    return cursor;
  }

  if (r.end.type === 'count' && r.end.count) {
    let cursor = base;
    for (let i = 1; i < r.end.count; i++) {
      cursor = repeatAdvance(r, cursor) || cursor;
    }
    return cursor;
  }

  return null;
}

/** 这个 id 是不是派生出来的重复实例（调试和迁移用） */
export function parseInstanceId(id: string): { seriesId: string; date: string } | null {
  const i = id.indexOf('#');
  if (i < 0) return null;
  return { seriesId: id.slice(0, i), date: id.slice(i + 1) };
}

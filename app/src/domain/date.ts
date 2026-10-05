/**
 * date.ts —— 日期与格式化。纯函数，不碰 DOM、不碰网络。
 *
 * 从 legacy/store.js 的 `U` 逐条搬过来。语义完全照旧，特别是这几条踩过坑的：
 *   · weekStart 以周一为一周起点（不是周日）
 *   · addMonths 先把日期截到 1 号再进月，避免 1/31 + 1 个月滚到 3/3
 *   · relLabel 的「逾期 N 天」与 DB.overdueCount 是同一个口径
 */

export const pad = (n: number): string => (n < 10 ? '0' + n : String(n));

export function iso(d: Date): string {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function today(): string {
  return iso(new Date());
}

export function parseISO(s: string): Date {
  const p = String(s).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

export function addDays(isoStr: string, n: number): string {
  const d = parseISO(isoStr);
  d.setDate(d.getDate() + n);
  return iso(d);
}

export function addMonths(isoStr: string, n: number): string {
  const d = parseISO(isoStr);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return iso(d);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseISO(a).getTime() - parseISO(b).getTime()) / 86400000);
}

/** 周一为一周起点 */
export function weekStart(isoStr: string): string {
  const d = parseISO(isoStr);
  const w = d.getDay() === 0 ? 7 : d.getDay();
  return addDays(isoStr, 1 - w);
}

export function monthStart(isoStr: string): string {
  const d = parseISO(isoStr);
  d.setDate(1);
  return iso(d);
}

/** 月视图网格：返回 42 天（6 周）的 iso 数组 */
export function monthMatrix(isoStr: string): string[] {
  const start = weekStart(monthStart(isoStr));
  const out: string[] = [];
  for (let i = 0; i < 42; i++) out.push(addDays(start, i));
  return out;
}

/** 当月最后一天是几号 */
export function lastDayOfMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate();
}

export function fmtMD(isoStr: string): string {
  const d = parseISO(isoStr);
  return d.getMonth() + 1 + '月' + d.getDate() + '日';
}

export function fmtFull(isoStr: string): string {
  const d = parseISO(isoStr);
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + wd;
}

export function weekdayShort(isoStr: string): string {
  const d = parseISO(isoStr);
  return ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
}

export function weekdayOf(isoStr: string): number {
  return parseISO(isoStr).getDay();
}

export function relLabel(isoStr: string): string {
  const n = diffDays(isoStr, today());
  if (n === 0) return '今天';
  if (n === 1) return '明天';
  if (n === 2) return '后天';
  if (n === -1) return '昨天';
  if (n < 0) return '逾期 ' + -n + ' 天';
  return fmtMD(isoStr);
}

export function timeToMin(t: string | null | undefined): number | null {
  if (!t) return null;
  const p = String(t).split(':');
  return Number(p[0]) * 60 + Number(p[1]);
}

export function minToTime(m: number): string {
  const v = Math.max(0, Math.min(1439, Math.round(m)));
  return pad(Math.floor(v / 60)) + ':' + pad(v % 60);
}

export function fmtDuration(min: number | null | undefined): string {
  if (!min) return '';
  if (min < 60) return min + '分钟';
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? h + '小时' + r + '分' : h + '小时';
}

export function nowMin(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/** 从时间戳取出日期部分，用于「已完成」按完成日分组 */
export function isoOfTs(ts: number): string {
  return iso(new Date(ts));
}

/**
 * 月视图格子里的负载简写。手机上格子只有 45px 宽，
 * 「3小时45分」会折行把日期数字挤扁，这里压成「3¾」这类极短形式。
 */
export function shortLoad(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return m + '分';
  if (!m) return h + '时';
  return h + '¾';
}

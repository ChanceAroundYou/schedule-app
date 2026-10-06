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

/**
 * 这一天是当月的第几周（1 起算）。月视图顶栏那行 range 用。
 *
 * 按「当月 1 号所在的那一周算第 1 周」往前补全周数 —— 不是简单地
 * `ceil(day / 7)`：那样 1 号落在周六时会把整个月算成 6 周。
 */
export function weekOfMonth(isoStr: string): number {
  const d = parseISO(isoStr);
  const first = parseISO(monthStart(isoStr));
  // 周一为一周之始，跟 weekStart 同一套约定
  const lead = (first.getDay() + 6) % 7;
  return Math.floor((d.getDate() + lead - 1) / 7) + 1;
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

/**
 * 时间轴上下沿的「微调」：把一次拖拽换成一档 15 分钟。
 *
 * 键盘走这里（方向键），鼠标走 App.tsx 里那段拖拽 —— **两处的算法必须一致**，
 * 所以算式只写在这一份：底边只改时长，上沿固定底边（同时改 time 和 duration）。
 * `dir` 是「沿时间轴往下（+1）/ 往上（-1）」，不是「变长 / 变短」——
 * 上沿往上拖是**变长**，跟着时间轴方向走才不会在两边写出相反的符号。
 *
 * 边界和拖拽一样：时长最少 15 分钟，上沿不早于 0:00。
 */
export function nudgeEdge(
  time: string | null | undefined, duration: number, edge: 'top' | 'bottom', dir: 1 | -1,
): { time?: string; duration: number } {
  const STEP = 15;
  const start = timeToMin(time) || 0;
  const end = start + (duration || 60);
  if (edge === 'bottom') return { duration: Math.max(STEP, (duration || 60) + dir * STEP) };
  const ns = Math.max(0, Math.min(end - STEP, start + dir * STEP));
  return { time: minToTime(ns), duration: end - ns };
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

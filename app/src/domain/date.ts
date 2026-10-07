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

/** 「10/7」—— 快速添加横条上那个小按钮里的写法。
 *  那儿是**两行**（上行日期、下行时间），一行只有十几像素高、几十像素宽，
 *  `fmtMD` 的「10月7日」会把按钮撑胖，所以另给一个最省的格式。 */
export function fmtSlashMD(isoStr: string): string {
  const d = parseISO(isoStr);
  return d.getMonth() + 1 + '/' + d.getDate();
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

/* ============================ 「找日期」输入框 ============================ */

/** 周几的中文写法 → 周几（weekStart 口径：周一 = 0） */
const WD_OFF: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };

/**
 * 把**一个**日期片段解析成 iso。给「找日期」那个输入框用，
 * 不能直接拿 `parse()` 顶 —— 两处差异，第二处更要紧：
 *
 * 1. `parse()` 是给「明天下午3点 交周报」这种整句用的，要在一句话里同时分辨
 *    日期 / 时间 / 时长 / 重复，所以认得不深（`1015`、`2026-10`、`上个月`
 *    这些它一律不认）。而这个输入框里只有一个日期，用户的心理预期是「怎么写都行」。
 * 2. **年份基准是 `baseIso`（面板当前所在的月份），不是今天。** 12 月翻到面板
 *    显示次年 1 月时输入「1月5日」，用户要的是明年 1 月 5 号。
 *
 * `todayIso` 只影响相对说法（今天 / 明天 / 裸周几），默认取真实今天；
 * 测试传固定值，否则用例会随日期漂移。
 */
export function parseDateText(raw: string, baseIso?: string, todayIso?: string): string | null {
  const s = String(raw == null ? '' : raw).trim().replace(/\s+/g, '');
  if (!s) return null;
  const today = todayIso || iso(new Date());
  const base = parseISO(baseIso || today);
  const y = base.getFullYear();
  let m: RegExpMatchArray | null;

  /** 拼日期。**超过当月天数要截到月末** —— 用户写 2月30日 不该给他报错 */
  const mk = (yy: number, mo: number, dd: number): string | null => {
    if (!(yy >= 1970 && yy <= 2999)) return null;
    if (mo < 1 || mo > 12) return null;
    if (dd < 1 || dd > 31) return null;
    return iso(new Date(yy, mo - 1, Math.min(dd, lastDayOfMonth(yy, mo))));
  };

  /* ---- 相对说法 ---- */
  if (/^(今天|今日|今|当天)$/.test(s)) return today;
  if (/^(昨天|昨日)$/.test(s)) return addDays(today, -1);
  if (/^前天$/.test(s)) return addDays(today, -2);
  if (/^大前天$/.test(s)) return addDays(today, -3);
  if (/^(明天|明日)$/.test(s)) return addDays(today, 1);
  if (/^后天$/.test(s)) return addDays(today, 2);
  if (/^(大后天)$/.test(s)) return addDays(today, 3);
  if ((m = s.match(/^(\d+)天(后|後|前)$/))) {
    return m[2] === '前' ? addDays(today, -(+m[1])) : addDays(today, +m[1]);
  }

  /* ---- 周几：下周三 / 本周五 / 周一 ---- */
  if ((m = s.match(/^(下下|下|本|这)?(?:周|星期|礼拜)([一二三四五六日天1-7])?$/))) {
    let off = WD_OFF[m[2] || '一'];
    if (m[2] && /^[1-7]$/.test(m[2])) off = (+m[2]) - 1;
    let ws = weekStart(today);
    if (m[1] === '下') ws = addDays(ws, 7);
    else if (m[1] === '下下') ws = addDays(ws, 14);
    let d = addDays(ws, off);
    // 裸周几取**下一个**：「周三」在周五输入，用户要的是下周三，不是两天前那个。
    // parse.ts 里那条日期规则就是这么写的，两处口径必须一致 —— 不然同一句
    // 「周三」在标题里和在找日期框里会跳到两个不同的日子。
    if (!m[1] && d < today) d = addDays(d, 7);
    return d;
  }

  /* ---- 月份偏移：下下个月 / 上个月 / 本月 ---- */
  if (/^(下下个?月)$/.test(s)) return monthStart(addMonths(today, 2));
  if (/^(下个?月|下月)$/.test(s)) return monthStart(addMonths(today, 1));
  if (/^(这个?月|本月|当月)$/.test(s)) return monthStart(today);
  if (/^(上个?月|上月)$/.test(s)) return monthStart(addMonths(today, -1));

  /* ---- 完整日期 ---- */
  // 2026-10-15 / 2026/10/15 / 2026.10.15 / 2026年10月15日
  if ((m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/))) return mk(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return mk(+m[1], +m[2], +m[3]);   // 20261015
  // 2026-10 / 2026年10月 / 202610 → 那个月的 1 号
  if ((m = s.match(/^(\d{4})[-/.年](\d{1,2})月?$/))) return mk(+m[1], +m[2], 1);
  if ((m = s.match(/^(\d{4})(\d{2})$/))) return mk(+m[1], +m[2], 1);

  /* ---- 只给月日：年份沿用 `baseIso` 所在的年份 ---- */
  if ((m = s.match(/^(\d{1,2})[-/.月](\d{1,2})日?$/))) return mk(y, +m[1], +m[2]);
  // 1015 → 10月15日。**月份必须合法**，否则 2026 这种纯年份会被它吃掉
  if ((m = s.match(/^(\d{2})(\d{2})$/)) && +m[1] >= 1 && +m[1] <= 12) return mk(y, +m[1], +m[2]);
  if ((m = s.match(/^(\d{1,2})月?$/))) return mk(y, +m[1], 1);                    // 10月 / 10
  if ((m = s.match(/^(\d{4})$/))) return mk(+m[1], 1, 1);                          // 2026
  return null;
}

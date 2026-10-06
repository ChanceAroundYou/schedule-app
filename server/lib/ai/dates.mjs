/**
 * dates.mjs —— 服务端要用的那点日期算术
 *
 * 前端有一份完整的 `app/src/domain/date.ts`。这边**没有**复用它，因为它是
 * TypeScript、跑在浏览器里，而后端是 CommonJS 的 Node —— 跨这条线共享代码
 * 要引一层构建，代价比这几行大。
 *
 * 所以规矩是：**这里只做纯日历字符串（YYYY-MM-DD）上的算术，语义必须和
 * 前端那份一致。** 哪天发现两边算得不一样了，以 `domain/date.ts` 为准
 * （它被 51 条单测锁着），改这边。
 *
 * 算术一律走 UTC 正午再取日期。用本地时间加 86400000 的话，夏令时切换那天
 * 会整整偏一天 —— 而这类 bug 一年只在两个特定日子出现，测不到也查不出。
 */

const DAY_MS = 24 * 3600 * 1000;

/** YYYY-MM-DD */
export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  // Date.parse 会把 2026-02-31 这样的日期滚到 3 月，得回头核对一遍
  return new Date(t).toISOString().slice(0, 10) === s;
}

export function toMs(iso) { return Date.parse(`${iso}T00:00:00Z`); }
export function fromMs(ms) { return new Date(ms).toISOString().slice(0, 10); }

/** 本地时区的今天。**不是** UTC 的今天 —— 用户眼里的「今天」是本地的 */
export function today(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(iso, n) { return fromMs(toMs(iso) + n * DAY_MS); }

/** 含头含尾的天数差（to - from） */
export function daysBetween(from, to) {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

/** 闭区间的每一天。区间反了或者太长（>400 天）就返回空数组，别让模型把我们撑死 */
export function eachDay(from, to) {
  if (!isIsoDate(from) || !isIsoDate(to)) return [];
  const n = daysBetween(from, to);
  if (n < 0 || n > 400) return [];
  const out = [];
  for (let i = 0; i <= n; i += 1) out.push(addDays(from, i));
  return out;
}

/** 0=周日 … 6=周六，与前端 Date.getDay() 一致 */
export function weekday(iso) { return new Date(toMs(iso)).getUTCDay(); }

export const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 'YYYY-MM-DD HH:MM' → 分钟数；非法返回 null */
export function minutesOfTime(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function timeOfMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

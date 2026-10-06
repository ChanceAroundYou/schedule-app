/**
 * parse.ts —— 自然语言解析：把「明天下午3点 交周报 2小时 每周一」拆成任务字段
 *
 * 识别成功的片段会从原文里摘掉，剩下干净的任务标题。
 * 返回 { title, date, time, duration, repeat, chips }，未识别的字段为 null。
 *
 * ⚠️ rulesOf() 返回的**数组顺序是有意义的**，不能重排：
 *   · 「重复」整组必须在「日期」整组之前 —— 否则「每周一」会被后面的日期规则
 *     当成「周一」解析成一个具体日期
 *   · 「大后天」必须排在「后天」前面，「大前天」必须排在「前天」前面
 *   · 「下下周一」必须排在「下周一」前面
 *   · 完整日期（2026年10月5日）必须排在「N号/N日」之前，否则 15 被单独吃掉
 * 这套顺序是踩出来的，改动前先读 legacy 分支的历史。
 *
 * ⚠️ **带明确星期/日号的重复规则必须自己写 o.date**（firstWeekday / firstMonthday）。
 * 只设 o.repeat 不设 o.date 的话，QuickAdd 的 `p?.date ?? defaultDate(state)`
 * 会回落到今天 —— 于是「每周一」在周二建就落在周二，「每月31号」落在 6 号。
 * 「每天 / 每周 / 每月 / 每年」这四条不带具体日子，首次就是今天，不需要写。
 */

import * as D from './date.ts';
import type { RepeatRule } from './types.ts';

const CN: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
const WD: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const PERIOD: Record<string, number> = {
  早上: 0, 早晨: 0, 上午: 0, 凌晨: 0, 中午: 12, 下午: 12,
  傍晚: 12, 晚上: 12, 夜里: 12, 半夜: 0,
};

const PERIODS = '早上|早晨|上午|凌晨|中午|下午|傍晚|晚上|夜里|半夜';
const NUM = '(?:[0-9]{1,2}|[一二三四五六七八九十两]{1,3})';

/** 中文数字 / 阿拉伯数字 → number。识别不了返回 null。 */
export function cn(s: string | null | undefined): number | null {
  if (s == null || s === '') return null;
  const str = String(s);
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  const i = str.indexOf('十');
  if (i >= 0) {
    const a = str.slice(0, i);
    const b = str.slice(i + 1);
    const A = a === '' ? 1 : CN[a];
    if (A == null) return null;
    let n = A * 10;
    if (b !== '') {
      const B = CN[b];
      if (B == null) return null;
      n += B;
    }
    return n;
  }
  if (str.length === 1) return CN[str] == null ? null : CN[str];
  return null;
}

const pad = (n: number) => (n < 10 ? '0' + n : String(n));

interface Ctx {
  leftOk: boolean;
  rightOk: boolean;
  isolated: boolean;
  beforeNum: boolean;
}

export interface ParseOut {
  title: string;
  date: string | null;
  time: string | null;
  duration: number | null;
  repeat: RepeatRule | null;
  chips: string[];
}

interface Rule {
  re: RegExp;
  fn: (o: ParseOut, m: RegExpExecArray, ctx: Ctx) => string | null;
}

/** 未来某周的第 N 天 */
function nthWeekday(todayIso: string, weeks: number, wd: number): string {
  const base = D.addDays(D.weekStart(todayIso), weeks * 7);
  const want = wd === 0 ? 7 : wd;
  return D.addDays(base, want - 1);
}

/**
 * 「每周X / 工作日」的**首次**发生日：从今天起找到第一个落在 wds 里的日子。
 * wds 用 getDay() 口径（0=周日），含今天。
 *
 * ⚠️ 重复规则必须自己把首次日期写进 o.date。不写的话 QuickAdd 会回落到
 * `defaultDate()` = 今天 —— 那正是「每周一」落在周二、「每月31号」落在 6 号的原因。
 */
function firstWeekday(todayIso: string, wds: number[]): string {
  for (let i = 0; i < 7; i++) {
    const d = D.addDays(todayIso, i);
    if (wds.includes(D.weekdayOf(d))) return d;
  }
  return todayIso;
}

/** 「每月N号」的首次发生日：从今天起找到第一个 N 号（短月截到月末），含今天。 */
function firstMonthday(todayIso: string, dd: number): string {
  const d0 = D.parseISO(todayIso);
  const y = d0.getFullYear();
  const mo = d0.getMonth() + 1;
  /** 与 mkDate 同一套截断：31 号在 2 月落到 28/29 号 */
  const at = (yy: number, mm: number) => yy + '-' + pad(mm) + '-' + pad(Math.min(dd, D.lastDayOfMonth(yy, mm)));
  const thisMonth = at(y, mo);
  if (thisMonth >= todayIso) return thisMonth;
  return mo === 12 ? at(y + 1, 1) : at(y, mo + 1);
}

function rulesOf(todayIso: string): Rule[] {
  const curMonth = D.parseISO(todayIso).getMonth() + 1;
  const curYear = D.parseISO(todayIso).getFullYear();

  /** 组装 YYYY-MM-DD，自动处理跨年与当月天数上限 */
  function mkDate(mo: number, dd: number): string {
    let y = curYear;
    if (mo < curMonth) y += 1;
    const last = D.lastDayOfMonth(y, mo);
    return y + '-' + pad(mo) + '-' + pad(Math.min(dd, last));
  }

  const rep = (
    unit: RepeatRule['unit'],
    weekdays: number[],
    monthday: number,
  ): RepeatRule => ({ unit, n: 1, weekdays, monthday, end: null });

  return [
    /* ============ 重复（必须在日期之前，否则「每周一」会被「周一」吃掉） ============ */
    {
      re: /工作日/g,
      fn: (o) => {
        const wds = [1, 2, 3, 4, 5];
        o.repeat = rep('week', wds, 1);
        o.date = firstWeekday(todayIso, wds);
        return '工作日重复';
      },
    },
    {
      re: /(?:每个?|每)\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
      fn: (o, m) => {
        const wds = [WD[m[1]]];
        o.repeat = rep('week', wds, 1);
        o.date = firstWeekday(todayIso, wds);
        return '每周' + m[1];
      },
    },
    {
      re: /(?:每个?|每)\s*(?:周|星期|礼拜)/g,
      fn: (o) => {
        o.repeat = rep('week', [D.weekdayOf(o.date || todayIso)], 1);
        return '每周';
      },
    },
    {
      re: /(?:每个?|每)\s*月\s*([0-9]{1,2}|[一二三四五六七八九十]{1,2})\s*[号日]/g,
      fn: (o, m) => {
        const d = cn(m[1]) || 1;
        o.repeat = rep('month', [], d);
        o.date = firstMonthday(todayIso, d);
        return '每月' + d + '号';
      },
    },
    {
      re: /(?:每个?|每)\s*月/g,
      fn: (o) => {
        o.repeat = rep('month', [], D.parseISO(o.date || todayIso).getDate());
        return '每月';
      },
    },
    { re: /(?:每天|每日|天天)/g, fn: (o) => { o.repeat = rep('day', [], 1); return '每天'; } },
    { re: /(?:每个?|每)\s*年/g, fn: (o) => { o.repeat = rep('year', [], 1); return '每年'; } },

    /* ============ 日期 ============ */
    {
      re: /([0-9]{4})\s*[-/年]\s*([0-9]{1,2})\s*[-/月]\s*([0-9]{1,2})\s*[日号]?/g,
      fn: (o, m) => {
        const mo = Number(m[2]);
        const dd = Number(m[3]);
        if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null;
        o.date = m[1] + '-' + pad(mo) + '-' + pad(dd);
        return D.fmtMD(o.date);
      },
    },
    { re: /(?:今天|今日)/g, fn: (o) => { o.date = todayIso; return '今天'; } },
    { re: /(?:明天|明日)/g, fn: (o) => { o.date = D.addDays(todayIso, 1); return '明天'; } },
    { re: /大后天/g, fn: (o) => { o.date = D.addDays(todayIso, 3); return '大后天'; } },
    { re: /后天/g, fn: (o) => { o.date = D.addDays(todayIso, 2); return '后天'; } },
    { re: /大前天/g, fn: (o) => { o.date = D.addDays(todayIso, -3); return '大前天'; } },
    { re: /前天/g, fn: (o) => { o.date = D.addDays(todayIso, -2); return '前天'; } },
    { re: /昨天|昨日/g, fn: (o) => { o.date = D.addDays(todayIso, -1); return '昨天'; } },

    {
      re: /下下\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
      fn: (o, m) => { o.date = nthWeekday(todayIso, 2, WD[m[1]]); return D.fmtMD(o.date); },
    },
    {
      re: /下\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
      fn: (o, m) => { o.date = nthWeekday(todayIso, 1, WD[m[1]]); return D.fmtMD(o.date); },
    },
    {
      re: /(?:本|这)\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
      fn: (o, m) => { o.date = nthWeekday(todayIso, 0, WD[m[1]]); return D.fmtMD(o.date); },
    },
    {
      re: /(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
      fn: (o, m) => {
        let d = nthWeekday(todayIso, 0, WD[m[1]]);
        if (d < todayIso) d = D.addDays(d, 7);
        o.date = d;
        return D.fmtMD(d);
      },
    },
    {
      re: new RegExp(NUM + '\\s*(?:天|日)\\s*(?:以)?后', 'g'),
      fn: (o, m, ctx) => {
        if (!ctx.isolated) return null;
        const n = cn(m[0].replace(/[天日以后\s]/g, ''));
        if (n == null) return null;
        o.date = D.addDays(todayIso, n);
        return n + '天后';
      },
    },
    {
      re: /(?:下个?月|下月)\s*([0-9]{1,2}|[一二三四五六七八九十]{1,2})\s*[号日]/g,
      fn: (o, m) => {
        const d = D.parseISO(D.addMonths(todayIso, 1));
        const dd = cn(m[1]);
        if (!dd) return null;
        const last = D.lastDayOfMonth(d.getFullYear(), d.getMonth() + 1);
        o.date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(Math.min(dd, last));
        return D.fmtMD(o.date);
      },
    },
    {
      re: new RegExp('([0-9]{1,2}|[一二三四五六七八九十]{1,2})\\s*月\\s*(' + NUM + ')\\s*[号日]', 'g'),
      fn: (o, m, ctx) => {
        if (!ctx.leftOk) return null;
        const mo = cn(m[1]);
        const dd = cn(m[2]);
        if (!mo || !dd || mo < 1 || mo > 12) return null;
        o.date = mkDate(mo, dd);
        return D.fmtMD(o.date);
      },
    },
    {
      re: new RegExp('(' + NUM + ')\\s*[号日](?![\\u4e00-\\u9fa5])', 'g'),
      fn: (o, m, ctx) => {
        if (!ctx.isolated) return null;
        const dd = cn(m[1]);
        if (!dd || dd > 31) return null;
        o.date = mkDate(curMonth, dd);
        if (o.date < todayIso) o.date = mkDate(curMonth + 1, dd);
        return D.fmtMD(o.date);
      },
    },
    {
      re: /([0-9]{1,2})\s*[/\-]\s*([0-9]{1,2})(?![0-9])/g,
      fn: (o, m, ctx) => {
        if (ctx.beforeNum) return null;
        const mo = Number(m[1]);
        const dd = Number(m[2]);
        if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null;
        o.date = mkDate(mo, dd);
        return D.fmtMD(o.date);
      },
    },
    {
      re: /(?:这个?月底|这个?月末|月底|月末)/g,
      fn: (o) => {
        const d = D.parseISO(todayIso);
        const last = D.lastDayOfMonth(d.getFullYear(), d.getMonth() + 1);
        o.date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(last);
        return '月底';
      },
    },
    {
      re: /(?:下个?月|下月)/g,
      fn: (o) => { o.date = D.addMonths(todayIso, 1); return D.fmtMD(o.date); },
    },

    /* ============ 时长 ============ */
    {
      re: new RegExp(NUM + '\\s*(?:个)?\\s*(?:小时|钟头)(?:\\s*(' + NUM + ')\\s*分(?:钟)?)?', 'g'),
      fn: (o, m) => {
        const hm = m[0].match(new RegExp('^(' + NUM + ')'));
        if (!hm) return null;
        const v = (cn(hm[1]) || 0) * 60 + (m[1] ? (cn(m[1]) || 0) : 0);
        if (!v) return null;
        o.duration = Math.min(720, v);
        return D.fmtDuration(v);
      },
    },
    {
      re: /([0-9]{1,3}|[一二三四五六七八九十]{1,3})\s*分钟/g,
      fn: (o, m) => {
        const v = cn(m[1]);
        if (!v) return null;
        o.duration = Math.min(720, v);
        return D.fmtDuration(v);
      },
    },
    { re: /半小时/g, fn: (o) => { o.duration = 30; return '30分钟'; } },

    /* ============ 时间 ============ */
    {
      re: new RegExp('(' + PERIODS + ')?\\s*([0-9]{1,2})\\s*[:：]\\s*([0-9]{1,2})', 'g'),
      fn: (o, m) => {
        let h = Number(m[2]);
        const mi = Number(m[3]);
        if (h > 23 || mi > 59) return null;
        if (m[1] && PERIOD[m[1]] === 12 && h < 12) h += 12;
        o.time = pad(h % 24) + ':' + pad(mi);
        return o.time;
      },
    },
    {
      re: new RegExp('(' + PERIODS + ')?\\s*(' + NUM + ')\\s*点(?:\\s*(半|一刻|三刻))?(?:\\s*(' + NUM + ')\\s*分(?:钟)?)?', 'g'),
      fn: (o, m, ctx) => {
        let h = cn(m[2]);
        let mi = 0;
        if (h == null || h > 23) return null;
        if (m[3]) mi = ({ 半: 30, 一刻: 15, 三刻: 45 } as Record<string, number>)[m[3]];
        if (m[4]) mi = cn(m[4]) || 0;

        if (m[1]) {
          if (PERIOD[m[1]] === 12 && h < 12) h += 12;
          else if (PERIOD[m[1]] === 0 && h === 12) h = 0;
          o.time = pad(h % 24) + ':' + pad(mi);
          return o.time;
        }
        /* 没有时段修饰：要求整段独立成词，避免「有三点要说明」被误判成 03:00。
           带「半/刻/分」时信号足够强，不需要独立成词；单独「N点」才要求。 */
        if (mi === 0 && !ctx.isolated) return null;
        if (h < 8) h += 12;   /* 口语里不修饰的「3点」多半指下午 */
        o.time = pad(h % 24) + ':' + pad(mi);
        return o.time;
      },
    },
    {
      re: /([0-9]{1,2})\s*(?:pm|PM)/g,
      fn: (o, m) => {
        const h = Number(m[1]);
        if (h > 23) return null;
        o.time = pad((h < 12 ? h + 12 : h) % 24) + ':00';
        return o.time;
      },
    },
    {
      re: /([0-9]{1,2})\s*(?:am|AM)/g,
      fn: (o, m) => {
        const h = Number(m[1]);
        if (h > 23) return null;
        o.time = pad(h % 24) + ':00';
        return o.time;
      },
    },
  ];
}

/**
 * 逐条规则扫一遍。
 *
 * 不用 String.replace 是因为拿不到「匹配位置对应的原始串」的类型化写法；
 * 这里手写扫描，语义与 replace 完全一致（从左到右、不重叠、上下文取自本轮输入）。
 */
function applyRule(rule: Rule, src: string, o: ParseOut): string {
  const re = new RegExp(rule.re.source, 'g');
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    const full = m[0];

    // 零长匹配会让 lastIndex 原地不动 → 死循环。现有规则不会产生，
    // 但规则是可扩展的，这里兜一手。
    if (full === '') {
      out += src.slice(last, m.index + 1);
      last = m.index + 1;
      re.lastIndex = m.index + 1;
      continue;
    }

    const offset = m.index;
    const before = src.slice(0, offset);
    const after = src.slice(offset + full.length);
    const leftOk = offset === 0 || /\s$/.test(before);
    const rightOk = offset + full.length === src.length || /^\s/.test(after);

    const ctx: Ctx = {
      leftOk,
      rightOk,
      isolated: leftOk && rightOk,
      beforeNum: /[0-9/.\-]$/.test(before),
    };

    const label = rule.fn(o, m, ctx);
    out += src.slice(last, offset);
    out += label ? ' ' : full;
    if (label) o.chips.push(String(label));
    last = offset + full.length;
  }

  out += src.slice(last);
  return out;
}

/** 解析入口。解析不出任何东西时 title 回退成原文。 */
export function parse(input: string, todayIso?: string): ParseOut | null {
  const base = todayIso || D.today();
  const text = String(input || '').trim();
  if (!text) return null;

  const o: ParseOut = { title: '', date: null, time: null, duration: null, repeat: null, chips: [] };

  let s = text;
  for (const rule of rulesOf(base)) s = applyRule(rule, s, o);

  o.title = s
    .replace(/\s{2,}/g, ' ')
    .replace(/^[，,。.、；;：:\-\s]+/, '')
    .replace(/[，,。.、；;：:\-\s]+$/, '')
    .trim();
  if (!o.title) o.title = text;
  o.chips = o.chips.filter(Boolean);
  return o;
}

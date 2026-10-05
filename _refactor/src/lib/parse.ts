/**
 * 自然语言解析：把「明天下午3点 交周报 2小时 每周一」拆成任务字段。
 *
 * 两个关键设计：
 * 1. 规则表按优先级排列，识别成功的片段会从原文里摘掉，剩下的就是干净标题。
 *    顺序不能随便调 —— 「重复」必须排在「日期」前面，
 *    否则「每周一」的「周一」会先被日期规则吃掉。
 * 2. ctx.isolated 表示这段文字前后都是空白（独立成词）。
 *    靠它避免「有三点要说明」被当成「3点」的时间。
 *    带「半/刻/分」时信号足够强，不要求独立成词。
 */
import type { Clock, Iso, Repeat } from './types'
import { addDays, addMonths, fmtDuration, fmtMD, monthStart, parseIso, pad, today as todayFn, weekdayOf } from './date'

const CN: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}
const WD: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }
/**时段词→ 小时偏移。0 = 不偏移，12 = 下午要 +12 */
const PERIOD: Record<string, number> = {
  早上: 0, 早晨: 0, 上午: 0, 凌晨: 0, 中午: 12, 下午: 12,
  傍晚: 12, 晚上: 12, 夜里: 12, 半夜: 0,
}

const PERIODS = '早上|早晨|上午|凌晨|中午|下午|傍晚|晚上|夜里|半夜'
const NUM = '(?:[0-9]{1,2}|[一二三四五六七八九十两]{1,3})'

/** 中文数字转阿拉伯数字，支持「十」「十五」「二十三」 */
export function cn(s: string | null | undefined): number | null {
  if (s == null || s === '') return null
  const str = String(s)
  if (/^\d+$/.test(str)) return parseInt(str, 10)
  const i = str.indexOf('十')
  if (i >= 0) {
    const a = str.slice(0, i)
    const b = str.slice(i + 1)
    const A = a === '' ? 1 : CN[a]
    if (A == null) return null
    let n = A * 10
    if (b !== '') {
      const B = CN[b]
      if (B == null) return null
      n += B
    }
    return n
  }
  if (str.length === 1) return CN[str] ?? null
  return null
}

/** 未来某周的第 N 天（周一起算） */
function nthWeekday(today: Iso, weeks: number, wd: number): Iso {
  const base = addDays(weekStartLocal(today), weeks * 7)
  const want = wd === 0 ? 7 : wd
  return addDays(base, want - 1)
}

function weekStartLocal(s: Iso): Iso {
  const d = parseIso(s)
  const w = d.getDay() === 0 ? 7 : d.getDay()
  return addDays(s, 1 - w)
}

export interface Parsed {
  title: string
  date: Iso | null
  time: Clock | null
  duration: number | null
  repeat: Repeat | null
  /** 识别出的可读标签，输入框下方回显「已识别：明天 15:00 2小时」 */
  chips: string[]
}

type Ctx = {
  leftOk: boolean
  rightOk: boolean
  /** 前面紧挨着数字/斜杠/点/横杠 —— 「3/5」里的 5 不是日期 */
  beforeNum: boolean
  isolated: boolean
}

type Rule = {
  re: RegExp
  fn: (o: Parsed, m: RegExpMatchArray, ctx: Ctx) => string | null
}

function rulesOf(today: Iso): Rule[] {
  const curMonth = parseIso(today).getMonth() + 1
  const curYear = parseIso(today).getFullYear()

  /** 组装 YYYY-MM-DD，自动处理跨年与当月天数上限 */
  const mkDate = (mo: number, dd: number): Iso => {
    let y = curYear
    if (mo < curMonth) y += 1
    const last = new Date(y, mo, 0).getDate()
    return y + '-' + pad(mo) + '-' + pad(Math.min(dd, last))
  }

  return [
    /* ============ 重复（必须排在日期之前） ============ */
    {
      re: /工作日/g,
      fn: (o) => {
        o.repeat = { unit: 'week', n: 1, weekdays: [1, 2, 3, 4, 5], monthday: 1, end: null }
        return '工作日重复'
      },
    },
    {
      re: /(?:每个?|每)\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
      fn: (o, m) => {
        o.repeat = { unit: 'week', n: 1, weekdays: [WD[m[1]!]!], monthday: 1, end: null }
        return '每周' + m[1]
      },
    },
    {
      re: /(?:每个?|每)\s*(?:周|星期|礼拜)/g,
      fn: (o) => {
        o.repeat = { unit: 'week', n: 1, weekdays: [weekdayOf(o.date || today)], monthday: 1, end: null }
        return '每周'
      },
    },
    {
      re: /(?:每个?|每)\s*月\s*([0-9]{1,2}|[一二三四五六七八九十]{1,2})\s*[号日]/g,
      fn: (o, m) => {
        const d = cn(m[1]) || 1
        o.repeat = { unit: 'month', n: 1, weekdays: [], monthday: d, end: null }
        return '每月' + d + '号'
      },
    },
    {
      re: /(?:每个?|每)\s*月/g,
      fn: (o) => {
        o.repeat = { unit: 'month', n: 1, weekdays: [], monthday: parseIso(o.date || today).getDate(), end: null }
        return '每月'
      },
    },
    {
      re: /(?:每天|每日|天天)/g,
      fn: (o) => { o.repeat = { unit: 'day', n: 1, weekdays: [], monthday: 1, end: null }; return '每天' },
    },
    {
      re: /(?:每个?|每)\s*年/g,
      fn: (o) => { o.repeat = { unit: 'year', n: 1, weekdays: [], monthday: 1, end: null }; return '每年' },
    },

    /* ============ 日期 ============ */
    {
      re: /([0-9]{4})\s*[-/年]\s*([0-9]{1,2})\s*[-/月]\s*([0-9]{1,2})\s*[日号]?/g,
      fn: (o, m) => {
        const mo = Number(m[2]), dd = Number(m[3])
        if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null
        o.date = m[1] + '-' + pad(mo) + '-' + pad(dd)
        return fmtMD(o.date)
      },
    },
    { re: /(?:今天|今日)/g, fn: (o) => { o.date = today; return '今天' } },
    { re: /(?:明天|明日)/g, fn: (o) => { o.date = addDays(today, 1); return '明天' } },
    { re: /大后天/g, fn: (o) => { o.date = addDays(today, 3); return '大后天' } },
    { re: /后天/g, fn: (o) => { o.date = addDays(today, 2); return '后天' } },
    {
      re: /下下\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
      fn: (o, m) => { o.date = nthWeekday(today, 2, WD[m[1]!]!); return fmtMD(o.date) },
    },
    {
      re: /下\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
      fn: (o, m) => { o.date = nthWeekday(today, 1, WD[m[1]!]!); return fmtMD(o.date) },
    },
    {
      re: /(?:本|这)\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
      fn: (o, m) => { o.date = nthWeekday(today, 0, WD[m[1]!]!); return fmtMD(o.date) },
    },
    {
      // 光秃秃的「周一」：本周已过就顺延到下周
      re: /(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
      fn: (o, m) => {
        let d = nthWeekday(today, 0, WD[m[1]!]!)
        if (d < today) d = addDays(d, 7)
        o.date = d
        return fmtMD(d)
      },
    },
    {
      re: new RegExp(NUM + '\\s*(?:天|日)\\s*(?:以)?后', 'g'),
      fn: (o, m, ctx) => {
        if (!ctx.isolated) return null
        const n = cn(m[0].replace(/[天日以后\s]/g, ''))
        if (n == null) return null
        o.date = addDays(today, n)
        return n + '天后'
      },
    },
    {
      re: /(?:下个?月|下月)\s*([0-9]{1,2}|[一二三四五六七八九十]{1,2})\s*[号日]/g,
      fn: (o, m) => {
        const d = parseIso(addMonths(today, 1))
        const dd = cn(m[1])
        if (!dd) return null
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
        o.date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(Math.min(dd, last))
        return fmtMD(o.date)
      },
    },
    {
      re: new RegExp('([0-9]{1,2}|[一二三四五六七八九十]{1,2})\\s*月\\s*(' + NUM + ')\\s*[号日]', 'g'),
      fn: (o, m, ctx) => {
        if (!ctx.leftOk) return null
        const mo = cn(m[1]), dd = cn(m[2])
        if (!mo || !dd || mo < 1 || mo > 12) return null
        o.date = mkDate(mo, dd)
        return fmtMD(o.date)
      },
    },
    {
      // 光秃秃的「15号」：本月已过就顺延到下月
      re: new RegExp('(' + NUM + ')\\s*[号日](?![一-龥])', 'g'),
      fn: (o, m, ctx) => {
        if (!ctx.isolated) return null
        const dd = cn(m[1])
        if (!dd || dd > 31) return null
        o.date = mkDate(curMonth, dd)
        if (o.date < today) o.date = mkDate(curMonth + 1, dd)
        return fmtMD(o.date)
      },
    },
    {
      // 「3/5」这种斜杠格式：前面紧挨数字就跳过（怕误伤分数、版本号）
      re: /([0-9]{1,2})\s*[/-]\s*([0-9]{1,2})(?![0-9])/g,
      fn: (o, m, ctx) => {
        if (ctx.beforeNum) return null
        const mo = Number(m[1]), dd = Number(m[2])
        if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null
        o.date = mkDate(mo, dd)
        return fmtMD(o.date)
      },
    },
    {
      re: /(?:这个?月底|这个?月末|月底|月末)/g,
      fn: (o) => {
        const d = parseIso(today)
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
        o.date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(last)
        return '月底'
      },
    },
    {
      re: /(?:下个?月|下月)/g,
      fn: (o) => { o.date = addMonths(today, 1); return fmtMD(o.date) },
    },

    /* ============ 时长 ============ */
    {
      re: new RegExp(NUM + '\\s*(?:个)?\\s*(?:小时|钟头)(?:\\s*(' + NUM + ')\\s*分(?:钟)?)?', 'g'),
      fn: (o, m) => {
        const hm = m[0].match(new RegExp('^(' + NUM + ')'))
        if (!hm) return null
        const v = (cn(hm[1]!) || 0) * 60 + (m[1] ? (cn(m[1]) || 0) : 0)
        if (!v) return null
        o.duration = Math.min(720, v)
        return fmtDuration(v)
      },
    },
    {
      re: new RegExp('([0-9]{1,3}|[一二三四五六七八九十]{1,3})\\s*分钟', 'g'),
      fn: (o, m) => {
        const v = cn(m[1])
        if (!v) return null
        o.duration = Math.min(720, v)
        return fmtDuration(v)
      },
    },
    { re: /半小时/g, fn: (o) => { o.duration = 30; return '30分钟' } },

    /* ============ 时间 ============ */
    {
      re: new RegExp('(' + PERIODS + ')?\\s*([0-9]{1,2})\\s*[:：]\\s*([0-9]{1,2})', 'g'),
      fn: (o, m) => {
        let h = Number(m[2]), mi = Number(m[3])
        if (h > 23 || mi > 59) return null
        if (m[1] && PERIOD[m[1]] === 12 && h < 12) h += 12
        o.time = pad(h % 24) + ':' + pad(mi)
        return o.time
      },
    },
    {
      re: new RegExp('(' + PERIODS + ')?\\s*(' + NUM + ')\\s*点(?:\\s*(半|一刻|三刻))?(?:\\s*(' + NUM + ')\\s*分(?:钟)?)?', 'g'),
      fn: (o, m, ctx) => {
        let h = cn(m[2]), mi = 0
        if (h == null || h > 23) return null
        if (m[3]) mi = { 半: 30, 一刻: 15, 三刻: 45 }[m[3]!] ?? 0
        if (m[4]) mi = cn(m[4]) || 0
        if (m[1]) {
          if (PERIOD[m[1]] === 12 && h < 12) h += 12
          else if (PERIOD[m[1]] === 0 && h === 12) h = 0
          o.time = pad(h % 24) + ':' + pad(mi)
          return o.time
        }
        // 没时段词：整点要求独立成词（避免「有三点要说明」）；带半/刻/分则信号够强
        if (mi === 0 && !ctx.isolated) return null
        // 口语里不修饰的「3点」多半指下午
        if (h < 8) h += 12
        o.time = pad(h % 24) + ':' + pad(mi)
        return o.time
      },
    },
    {
      re: /([0-9]{1,2})\s*(?:pm|PM)/g,
      fn: (o, m) => {
        const h = Number(m[1])
        if (h > 23) return null
        o.time = pad((h < 12 ? h + 12 : h) % 24) + ':00'
        return o.time
      },
    },
    {
      re: /([0-9]{1,2})\s*(?:am|AM)/g,
      fn: (o, m) => {
        const h = Number(m[1])
        if (h > 23) return null
        o.time = pad(h % 24) + ':00'
        return o.time
      },
    },
  ]
}

/** 解析入口。返回 null 表示输入为空。 */
export function parse(input: string, baseToday?: Iso): Parsed | null {
  const today = baseToday || todayFn()
  const text = String(input || '').trim()
  if (!text) return null

  const o: Parsed = { title: '', date: null, time: null, duration: null, repeat: null, chips: [] }
  let s = text

  for (const rule of rulesOf(today)) {
    const re = new RegExp(rule.re.source, 'g')
    s = s.replace(re, (full, ...args) => {
      const groups = args.slice(0, -2) as (string | undefined)[]
      const offset = args[args.length - 2] as number
      const whole = args[args.length - 1] as string
      const before = whole.slice(0, offset)
      const after = whole.slice(offset + full.length)
      const ctx: Ctx = {
        leftOk: offset === 0 || /\s$/.test(before),
        rightOk: offset + full.length === whole.length || /^\s/.test(after),
        beforeNum: /[0-9/.−-]$/.test(before),
      }
      ctx.isolated = ctx.leftOk && ctx.rightOk

      const m = [full, ...groups] as unknown as RegExpMatchArray
      const label = rule.fn(o, m, ctx)
      if (label) {
        o.chips.push(String(label))
        return ' '
      }
      return full
    })
  }

  o.title = s
    .replace(/\s{2,}/g, ' ')
    .replace(/^[，,。.、；;：:\-\s]+/, '')
    .replace(/[，,。.、；;：:\-\s]+$/, '')
    .trim()
  if (!o.title) o.title = text
  o.chips = o.chips.filter(Boolean)
  return o
}

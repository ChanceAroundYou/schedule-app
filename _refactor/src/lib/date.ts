/**
 * 日期与格式化工具。
 *
 * 全部函数都是纯函数，不碰全局状态 —— 这也是单元测试的主要目标。
 * 命名保持与旧版一致（pad / iso / parse / addDays …），
 * 迁移时对照着看不用重新记。
 */
import type { Clock, Iso, Repeat, RepeatUnit } from './types'

export const pad = (n: number): string => (n < 10 ? '0' + n : String(n))

/** Date -> 'YYYY-MM-DD'（用本地时区，不要用 toISOString，那是 UTC 会差一天） */
export const iso = (d: Date): Iso =>
  d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())

export const today = (): Iso => iso(new Date())

/** 'YYYY-MM-DD' -> Date（本地零点） */
export const parseIso = (s: Iso): Date => {
  const p = String(s).split('-')
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
}

export const addDays = (s: Iso, n: number): Iso => {
  const d = parseIso(s)
  d.setDate(d.getDate() + n)
  return iso(d)
}

export const addMonths = (s: Iso, n: number): Iso => {
  const d = parseIso(s)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  // 1月31日 +1 个月不该变成 3月3日，先钳到目标月最后一天
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, last))
  return iso(d)
}

export const diffDays = (a: Iso, b: Iso): number =>
  Math.round((parseIso(a).getTime() - parseIso(b).getTime()) / 86400000)

/** 周一为一周起点 */
export const weekStart = (s: Iso): Iso => {
  const d = parseIso(s)
  const w = d.getDay() === 0 ? 7 : d.getDay()
  return addDays(s, 1 - w)
}

export const monthStart = (s: Iso): Iso => {
  const d = parseIso(s)
  d.setDate(1)
  return iso(d)
}

/** 月视图网格：返回 42 天（6 周）的 iso，凑满整月不出现半行 */
export const monthMatrix = (s: Iso): Iso[] => {
  const start = weekStart(monthStart(s))
  const out: Iso[] = []
  for (let i = 0; i < 42; i++) out.push(addDays(start, i))
  return out
}

export const fmtMD = (s: Iso): string => {
  const d = parseIso(s)
  return d.getMonth() + 1 + '月' + d.getDate() + '日'
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export const fmtFull = (s: Iso): string => {
  const d = parseIso(s)
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEKDAYS[d.getDay()]
}

export const weekdayShort = (s: Iso): string => ['日', '一', '二', '三', '四', '五', '六'][parseIso(s).getDay()] ?? ''

export const weekdayOf = (s: Iso): number => parseIso(s).getDay()

/** 相对今天的说法：今天 / 明天 / 逾期 3 天 / 10月15日 */
export const relLabel = (s: Iso): string => {
  const n = diffDays(s, today())
  if (n === 0) return '今天'
  if (n === 1) return '明天'
  if (n === 2) return '后天'
  if (n === -1) return '昨天'
  if (n < 0) return '逾期 ' + -n + ' 天'
  return fmtMD(s)
}

/** 'HH:mm' -> 分钟数；null 进 null 出 */
export const timeToMin = (t: Clock | null): number | null => {
  if (!t) return null
  const p = String(t).split(':')
  return Number(p[0]) * 60 + Number(p[1])
}

export const minToTime = (m: number): Clock => {
  const v = Math.max(0, Math.min(1439, Math.round(m)))
  return pad(Math.floor(v / 60)) + ':' + pad(v % 60)
}

export const fmtDuration = (min: number): string => {
  if (!min) return ''
  if (min < 60) return min + '分钟'
  const h = Math.floor(min / 60)
  const r = min % 60
  return r ? h + '小时' + r + '分' : h + '小时'
}

/**
 * 时长的极简写法，用在月视图格子里。
 * 「3小时45分」在 40px 宽的格子里会折成三行把日期数字挤扁，
 * 所以压成「3¾」这种形式。
 */
export const shortLoad = (min: number): string => {
  if (!min) return ''
  if (min < 60) return min + '分'
  const h = Math.floor(min / 60)
  const r = min % 60
  if (!r) return h + '时'
  // 45 分以内用 ¾ / ½ 记号，更短
  if (r === 45) return h + '¾'
  if (r === 30) return h + '½'
  if (r === 15) return h + '¼'
  return h + '时'
}

export const fmtMoney = (n: number): string =>
  (Number(n) || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })

/** 今天的时刻（分钟数），时间轴上画「当前时刻」线用 */
export const nowMin = (): number => {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

/* ---------------- 重复规则 ---------------- */

export const emptyRepeat = (date?: Iso | null): Repeat => ({
  unit: 'none',
  n: 1,
  weekdays: [],
  monthday: date ? parseIso(date).getDate() : parseIso(today()).getDate(),
  end: null,
})

const UNIT_MAP: Record<string, RepeatUnit> = {
  none: 'none',
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year',
}

/** 把旧的字符串型 repeat（'daily'）升级成对象，读取历史数据时走这里 */
export const toRepeat = (old: unknown, date?: Iso | null): Repeat => {
  const r = emptyRepeat(date)
  if (!old) return r
  if (typeof old === 'string') {
    r.unit = UNIT_MAP[old] ?? 'none'
    if (r.unit === 'week') r.weekdays = [weekdayOf(date ?? today())]
    return r
  }
  const o = old as Partial<Repeat>
  r.unit = o.unit ?? 'none'
  r.n = Math.max(1, Number(o.n) || 1)
  r.weekdays = Array.isArray(o.weekdays) ? o.weekdays.slice() : []
  r.monthday = o.monthday || r.monthday
  r.end = o.end ?? null
  return r
}

const WD_LABEL = ['日', '一', '二', '三', '四', '五', '六']

export const repeatLabel = (r: Repeat | null | undefined): string => {
  if (!r || r.unit === 'none') return ''
  const n = Math.max(1, r.n || 1)
  const wd = r.weekdays && r.weekdays.length
    ? r.weekdays.slice().sort().map((d) => WD_LABEL[d] ?? '').join('、')
    : ''
  if (r.unit === 'day') return n === 1 ? '每天' : '每 ' + n + ' 天'
  if (r.unit === 'week') {
    if (n === 1) return wd ? '每周' + wd : '每周'
    return '每 ' + n + ' 周' + (wd ? ' 的周' + wd : '')
  }
  if (r.unit === 'month') {
    const md = r.monthday ? r.monthday + ' 号' : ''
    return n === 1 ? '每月' + (md ? ' ' + md : '') : '每 ' + n + ' 个月' + (md ? ' ' + md : '')
  }
  return n === 1 ? '每年' : '每 ' + n + ' 年'
}

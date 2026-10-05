/**
 * 数据层：localStorage 持久化 + 全部增删改查。
 *
 * 设计要点：
 * 1. 单一状态树 AppState，一次性读写，React 侧用 useSyncExternalStore 订阅。
 * 2. 所有写操作都先改内存再 save()，不做增量写 —— 数据量是几百条量级，
 *    全量 JSON.stringify 的开销可以忽略，换来的是「不存在写了一半的状态」。
 * 3. normalize() 承担历史数据升级。每次读档都跑一遍，保证老数据能平滑迁移。
 */
import type { AppState, DayLoad, Iso, NavKey, Repeat, Task, TrashItem, Habit, UiState } from './types'
import {
  addDays, addMonths, monthStart, parseIso, pad, timeToMin, today, toRepeat, weekdayOf,
} from './date'

const STORE_KEY = 'schedule-app-v1'
const STATE_VERSION = 3

export const NAV_ALL: NavKey[] = ['inbox', 'today', 'overdue', 'calendar', 'habits', 'done', 'trash']

let state: AppState = emptyState()
const listeners = new Set<() => void>()

export const uid = (): string =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

/* ================= 初始化 ================= */

function emptyState(): AppState {
  const t = today()
  return {
    version: STATE_VERSION,
    tasks: [],
    trash: [],
    habits: [],
    ui: {
      nav: 'today', view: 'day', cursor: t, theme: 'light', search: '',
      navOrder: [...NAV_ALL],
      navBottom: ['trash'],
      tdoneOpen: false,
    },
  }
}

/** 首次打开时给的示例数据，让人一眼看懂怎么用 */
function seed(): AppState {
  const t = today()
  const base = emptyState()
  const mk = (p: Partial<Task>): Task => ({
    id: uid(), title: '', note: '', date: null, time: null, duration: 60,
    done: false, repeat: toRepeat(null, p.date ?? null), repeatSeq: 0, order: 0,
    createdAt: Date.now(), doneAt: null, source: null,
    ...p,
  })
  base.tasks = [
    mk({ title: '团队早会', date: t, time: '09:30', duration: 30, done: true, doneAt: Date.now() }),
    mk({ title: '整理季度汇报大纲', note: '先列结构，再填数据', date: t, time: '14:00', duration: 90, order: 0 }),
    mk({ title: '取快递', date: t, order: 1 }),
    mk({ title: '牙医复诊', note: '带上次的片子', date: addDays(t, 1), time: '15:30' }),
    mk({
      title: '交房租', date: addDays(t, -2),
      repeat: { unit: 'month', n: 1, weekdays: [], monthday: 2, end: null },
      createdAt: Date.now() - 86400000 * 3,
    }),
    mk({ title: '研究一下新显示器', note: '等发工资再说', order: 0 }),
    mk({ title: '给导师发季度进展', order: 1, createdAt: Date.now() + 1000 }),
  ]
  base.habits = [
    { id: uid(), title: '学英语', order: 0, log: {}, createdAt: Date.now() },
    { id: uid(), title: '学西班牙语', order: 1, log: {}, createdAt: Date.now() },
    { id: uid(), title: '训练小狗', order: 2, log: {}, createdAt: Date.now() },
  ]
  return base
}

export function load(): void {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const s = JSON.parse(raw) as Partial<AppState>
      if (s && Array.isArray(s.tasks)) {
        state = s as AppState
        normalize()
        return
      }
    }
  } catch (e) {
    console.warn('读取本地数据失败', e)
  }
  state = seed()
  save()
}

export function save(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state))
  } catch (e) {
    console.warn('保存失败', e)
  }
  listeners.forEach((fn) => fn())
}

/** 订阅状态变化。返回取消订阅函数。 */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const getState = (): AppState => state

/** 仅测试用：直接塞入状态，不落盘 */
export function __setState(s: AppState): void {
  state = s
  normalize()
}

/* ================= 归一化 ================= */

export function normalize(): void {
  const s = state
  s.version = STATE_VERSION
  s.tasks = s.tasks || []
  s.trash = (s.trash || []).filter((x) => x && x.kind === 'task')
  s.habits = s.habits || []
  s.ui = s.ui || ({} as UiState)

  // 已下线的模块：清单 / 备忘录
  delete (s as Record<string, unknown>).lists
  delete (s as Record<string, unknown>).notes
  delete (s as Record<string, unknown>).notebooks

  if (s.ui.theme !== 'dark') s.ui.theme = 'light'
  if (s.ui.view !== 'week' && s.ui.view !== 'month') s.ui.view = 'day'
  if (!NAV_ALL.includes(s.ui.nav)) s.ui.nav = 'today'
  if (!s.ui.cursor) s.ui.cursor = today()
  if (typeof s.ui.search !== 'string') s.ui.search = ''
  if (typeof s.ui.tdoneOpen !== 'boolean') s.ui.tdoneOpen = false

  // 侧栏顺序：缺项补到末尾，多余的丢掉
  const order = Array.isArray(s.ui.navOrder) ? s.ui.navOrder.filter((k) => NAV_ALL.includes(k)) : []
  NAV_ALL.forEach((k) => { if (!order.includes(k)) order.push(k) })
  s.ui.navOrder = order
  // 只有「从未设置过」才给默认分组；空数组是用户主动把垃圾箱拖出后的合法状态
  s.ui.navBottom = Array.isArray(s.ui.navBottom)
    ? s.ui.navBottom.filter((k) => order.includes(k))
    : ['trash']

  s.habits.forEach((h, i) => {
    h.log = h.log || {}
    if (h.order == null) h.order = i
  })

  // 未定时任务补排序位：按天分桶，同一天内沿用出现顺序
  const bucket: Record<string, number> = {}
  s.tasks.forEach((t) => {
    t.repeat = toRepeat(t.repeat, t.date)
    if (!t.time && t.order == null) {
      const key = t.date || '_'
      if (bucket[key] == null) bucket[key] = 0
      t.order = bucket[key]!
    }
    if (!t.duration) t.duration = 60
  })
}

/* ================= 查询 ================= */

export const taskById = (id: string): Task | null =>
  state.tasks.find((t) => t.id === id) ?? null

/** 未定时任务之间的比较：手动顺序位 > 创建时间 */
const orderCmp = (a: Task, b: Task): number => {
  const oa = a.order == null ? 1e9 : a.order
  const ob = b.order == null ? 1e9 : b.order
  if (oa !== ob) return oa - ob
  return (a.createdAt || 0) - (b.createdAt || 0)
}

/** 排序：有时间的按时间排前面，未定时的按手动顺序 */
export function sortTasks(list: Task[]): Task[] {
  return list.slice().sort((a, b) => {
    const ta = timeToMin(a.time)
    const tb = timeToMin(b.time)
    if (ta !== null && tb !== null) return ta - tb
    if (ta !== null) return -1
    if (tb !== null) return 1
    return orderCmp(a, b)
  })
}

export function tasksOn(iso: Iso): Task[] {
  const kw = state.ui.search
  return sortTasks(state.tasks.filter((t) => {
    if (t.date !== iso) return false
    if (kw && !t.title.includes(kw) && !(t.note || '').includes(kw)) return false
    return true
  }))
}

/** 某天的负载：已排分钟数 + 未完成数 */
export function dayLoad(iso: Iso): DayLoad {
  const ts = state.tasks.filter((t) => t.date === iso && !t.done)
  let mins = 0
  ts.forEach((t) => { if (t.time) mins += t.duration || 0 })
  return { mins, count: ts.length }
}

/** 逾期未完成的任务数（有日期、已过期、还没做完） */
export const overdueCount = (): number => {
  const t = today()
  return state.tasks.filter((x) => !x.done && x.date && x.date < t).length
}

export const overdueList = (): Task[] => {
  const t = today()
  const kw = state.ui.search
  return state.tasks.filter((x) => {
    if (x.done || !x.date || x.date >= t) return false
    if (kw && !x.title.includes(kw) && !(x.note || '').includes(kw)) return false
    return true
  }).sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0))
}

export function counts(): Record<NavKey, number> {
  const t = today()
  return {
    inbox: state.tasks.filter((x) => !x.done && !x.date).length,
    today: state.tasks.filter((x) => !x.done && x.date === t).length,
    overdue: overdueCount(),
    calendar: 0,
    trash: state.trash.length,
    done: 0,
    habits: habitsTodayRemaining(),
  }
}

/* ================= 任务写入 ================= */

/** 某一天（或待办箱）里下一个可用的排序位 */
function nextOrder(date: Iso | null): number {
  let mx = -1
  state.tasks.forEach((t) => {
    if (t.date === date && !t.time && t.order != null && t.order > mx) mx = t.order
  })
  return mx + 1
}

export function addTask(data: Partial<Task>): Task {
  const t: Task = {
    id: uid(),
    title: data.title || '未命名任务',
    note: data.note || '',
    date: data.date ?? null,
    time: data.time ?? null,
    duration: data.duration || 60,
    done: false,
    repeat: toRepeat(data.repeat, data.date ?? null),
    repeatSeq: data.repeatSeq || 0,
    order: data.order != null ? data.order : nextOrder(data.date ?? null),
    createdAt: Date.now(),
    doneAt: null,
    source: data.source ?? null,
  }
  state.tasks.push(t)
  save()
  return t
}

export function updateTask(id: string, patch: Partial<Task>): Task | null {
  const t = taskById(id)
  if (!t) return null
  Object.assign(t, patch)
  save()
  return t
}

/** 只改 UI 状态，不动任务。用于翻页、切视图这类高频操作。 */
export function setUi(patch: Partial<UiState>): void {
  Object.assign(state.ui, patch)
  save()
}

/** 把未定时的任务移到 refId 之前 / 之后，并重排同一天的顺序位 */
export function reorderUntimed(id: string, date: Iso | null, refId: string | null, pos: 'before' | 'after'): void {
  const t = taskById(id)
  if (!t) return
  t.date = date
  t.time = null
  const sibs = state.tasks
    .filter((x) => !x.done && !x.time && x.date === date && x.id !== id)
    .sort(orderCmp)
  let idx = sibs.length
  if (refId) {
    const i = sibs.findIndex((x) => x.id === refId)
    if (i >= 0) idx = pos === 'before' ? i : i + 1
  }
  sibs.splice(idx, 0, t)
  sibs.forEach((x, i) => { x.order = i })
  save()
}

/* ================= 重复任务 ================= */

/** 单步推进：返回 base 之后的下一个发生日 */
function repeatAdvance(r: Repeat, base: Iso): Iso | null {
  if (!r || r.unit === 'none') return null
  const n = Math.max(1, r.n || 1)
  if (r.unit === 'day') return addDays(base, n)
  if (r.unit === 'week') {
    const wd = r.weekdays && r.weekdays.length ? r.weekdays : [weekdayOf(base)]
    const span = 7 * n
    for (let i = 1; i <= span; i++) {
      const d = addDays(base, i)
      if (wd.includes(weekdayOf(d))) return d
    }
    return addDays(base, span)
  }
  if (r.unit === 'month') {
    const day = r.monthday || parseIso(base).getDate()
    const m = parseIso(addMonths(monthStart(base), n))
    const last = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()
    return m.getFullYear() + '-' + pad(m.getMonth() + 1) + '-' + pad(Math.min(day, last))
  }
  return addMonths(base, 12 * n)
}

/** 下一个实例日期：补到今天之后，并检查结束条件 */
export function repeatNext(t: Task, base: Iso): Iso | null {
  const r = t.repeat
  if (!r || r.unit === 'none') return null
  let next = repeatAdvance(r, base)
  // 历史实例可能落后很多天（比如半年没打开过），要一直补到今天之后。
  // 800 次上限防止规则写错时死循环。
  let guard = 0
  while (next && next < today() && guard++ < 800) next = repeatAdvance(r, next)
  if (!next) return null
  if (r.end) {
    if (r.end.type === 'date' && r.end.date && next > r.end.date) return null
    if (r.end.type === 'count' && (t.repeatSeq || 0) + 1 > (r.end.count || 0)) return null
  }
  return next
}

export function toggleDone(id: string): Task | null {
  const t = taskById(id)
  if (!t) return null
  t.done = !t.done
  t.doneAt = t.done ? Date.now() : null
  // 重复任务：勾完就长出下一个实例，而不是消失
  if (t.done && t.repeat && t.repeat.unit !== 'none') {
    const base = t.date || today()
    const next = repeatNext(t, base)
    if (next) {
      t.repeatSeq = (t.repeatSeq || 0) + 1
      addTask({
        title: t.title, note: t.note, date: next, time: t.time,
        duration: t.duration,
        repeat: JSON.parse(JSON.stringify(t.repeat)) as Repeat,
        repeatSeq: t.repeatSeq, source: t.source,
      })
    }
  }
  save()
  return t
}

export function removeTask(id: string): void {
  const t = taskById(id)
  if (!t) return
  state.tasks = state.tasks.filter((x) => x.id !== id)
  toTrash(t)
  save()
}

/* ================= 每日打卡 ================= */

export const habitById = (id: string): Habit | null =>
  state.habits.find((h) => h.id === id) ?? null

export function addHabit(title: string): Habit | null {
  const s = title.trim()
  if (!s) return null
  const h: Habit = { id: uid(), title: s, order: state.habits.length, log: {}, createdAt: Date.now() }
  state.habits.push(h)
  save()
  return h
}

export function deleteHabit(id: string): void {
  state.habits = state.habits.filter((h) => h.id !== id)
  save()
}

/** 勾选 / 取消某一天的打卡（默认今天） */
export function toggleHabit(id: string, iso?: Iso): Habit | null {
  const h = habitById(id)
  if (!h) return null
  const d = iso || today()
  h.log = h.log || {}
  if (h.log[d]) delete h.log[d]
  else h.log[d] = true
  save()
  return h
}

/** 连续打卡天数：今天已打则从今天起算，否则从昨天起算（今天还没打不该断签） */
export function habitStreak(h: Habit | null | undefined): number {
  if (!h || !h.log) return 0
  let n = 0
  let d = today()
  if (!h.log[d]) {
    d = addDays(d, -1)
    if (!h.log[d]) return 0
  }
  while (h.log[d]) { n++; d = addDays(d, -1) }
  return n
}

export const habitsTodayRemaining = (): number => {
  const t = today()
  return state.habits.filter((h) => !h.log || !h.log[t]).length
}

/* ================= 垃圾箱 ================= */

function toTrash(payload: Task, from = '', groupId: string | null = null): void {
  const item: TrashItem = {
    id: uid(), kind: 'task',
    payload: JSON.parse(JSON.stringify(payload)) as Task,
    from, groupId, deletedAt: Date.now(),
  }
  state.trash.unshift(item)
}

export function restoreTrash(id: string): void {
  const item = state.trash.find((x) => x.id === id)
  if (!item) return
  const items = item.groupId
    ? state.trash.filter((x) => x.groupId === item.groupId)
    : [item]
  items.forEach((it) => {
    const t = it.payload
    t.repeat = toRepeat(t.repeat, t.date)
    state.tasks.push(t)
  })
  state.trash = state.trash.filter((x) => !items.includes(x))
  save()
}

export function removeTrashItem(id: string): void {
  state.trash = state.trash.filter((x) => x.id !== id)
  save()
}

export function emptyTrash(): void {
  state.trash = []
  save()
}

/* ================= 导入导出 ================= */

export function exportJSON(): string {
  return JSON.stringify(state, null, 2)
}

/** 导入会整份替换，先自动备份当前的，避免误操作丢数据 */
export function importJSON(text: string): boolean {
  try {
    const s = JSON.parse(text) as AppState
    if (!s || !Array.isArray(s.tasks)) return false
    localStorage.setItem(STORE_KEY + '-backup', JSON.stringify(state))
    state = s
    normalize()
    save()
    return true
  } catch (e) {
    console.warn('导入失败', e)
    return false
  }
}

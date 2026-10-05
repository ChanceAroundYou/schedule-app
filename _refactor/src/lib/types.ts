/**
 * 数据模型 —— 全应用共用的类型定义。
 *
 * 日期一律用 'YYYY-MM-DD' 字符串（Iso），不用 Date 对象：
 * localStorage 存的是 JSON，Date 序列化后带时区信息，
 * 跨时区/跨设备读回来会偏移一天。字符串没有这个问题。
 * 需要 Date 时用 lib/date.ts 的 parseIso() 现场构造。
 */

/** 'YYYY-MM-DD' */
export type Iso = string

/** 'HH:mm'，24 小时制；未定时的任务为 null */
export type Clock = string

export type NavKey = 'inbox' | 'today' | 'overdue' | 'calendar' | 'habits' | 'done' | 'trash'

export type ViewKey = 'day' | 'week' | 'month'

export type RepeatUnit = 'none' | 'day' | 'week' | 'month' | 'year'

/** 重复的结束条件 */
export type RepeatEnd =
  | null
  | { type: 'date'; date: Iso }
  | { type: 'count'; count: number }

export interface Repeat {
  unit: RepeatUnit
  /** 每隔几个单位 */
  n: number
  /** unit='week' 时生效；空表示沿用原日期的星期（0=周日 … 6=周六） */
  weekdays: number[]
  /** unit='month' 时用，几号 */
  monthday: number
  end: RepeatEnd
}

export interface Task {
  id: string
  title: string
  note: string
  /** null = 在待办箱，没有日期 */
  date: Iso | null
  /** null = 未定时 */
  time: Clock | null
  /** 分钟 */
  duration: number
  done: boolean
  repeat: Repeat
  /** 已经推到第几个实例（repeat.end.type='count' 时用） */
  repeatSeq: number
  /** 未定时任务的手动顺序位；定时任务不用 */
  order: number
  createdAt: number
  doneAt: number | null
  /** 从哪个重复实例来，用于避免重复生成 */
  source: string | null
}

export interface Habit {
  id: string
  title: string
  order: number
  /** iso -> true，只记「打了」，不记时间 */
  log: Record<Iso, true>
  createdAt: number
}

export type TrashKind = 'task'

export interface TrashItem {
  id: string
  kind: TrashKind
  payload: Task
  /** 从哪个页面删的，仅显示用 */
  from: string
  /** 同一次操作产生的多条 trash 共享 groupId，可整组还原 */
  groupId: string | null
  deletedAt: number
}

export interface UiState {
  nav: NavKey
  view: ViewKey
  /** 当前光标日期，日/周/月视图各自定位 */
  cursor: Iso
  theme: 'light' | 'dark'
  search: string
  /** 侧栏顺序，可拖动自定义 */
  navOrder: NavKey[]
  /** 哪些项在侧栏底部（窄屏时不存在，全部在「更多」里） */
  navBottom: NavKey[]
  /** 「今天已完成」区块是否展开 */
  tdoneOpen: boolean
}

export interface AppState {
  version: number
  tasks: Task[]
  trash: TrashItem[]
  habits: Habit[]
  ui: UiState
}

/** 某天的负载统计 */
export interface DayLoad {
  /** 已排分钟数 */
  mins: number
  /** 未完成任务数 */
  count: number
}

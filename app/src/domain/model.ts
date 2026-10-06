/**
 * model.ts —— 实体构造、查询口径、v3 → v4 迁移
 *
 * 查询口径必须**唯一**，旧版就吃过这个亏：`counts().today` 和 `overdueCount()`
 * 各写各的，同一个任务在两个徽标里各数了一次。这里全部收口到本文件。
 *
 * 全部是纯函数：state 传进来，结果传出去，不碰 localStorage、不碰网络。
 */

import * as D from './date.ts';
import { toRepeat } from './repeat.ts';
import type {
  AccentKey, Habit, LocalState, Project, ProjectStatus, Role, StyleKey, Task, ThemeMode, UiPrefs,
} from './types.ts';

/* ------------------------------------------------------------------ id */

/**
 * UUIDv4。
 *
 * crypto.randomUUID 只在安全上下文可用 —— 用 http://192.168.x.x 打开时会
 * 直接 undefined。局域网自测很常见，所以留一条 getRandomValues 的退路。
 */
export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();

  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newOpId(): string {
  return newId();
}

/**
 * hydrate 能接受的形状：id 与同步元数据齐了，业务字段可以缺。
 *
 * `calId` 在这里是可选的（SyncMeta 里是必填）—— 迁移进来的旧数据和
 * 还没归位的远端变更都还没有归属，hydrate 补成空串，由 store 落位。
 */
export type MetaLike = {
  id: string;
  calId?: string;
  _ts: Record<string, number>;
  _dev: Record<string, string>;
};

/* ------------------------------------------------------------- 可见性 */

export const isGone = (e: { deleted?: boolean; purged?: boolean }): boolean =>
  e.deleted === true || e.purged === true;

/** 垃圾箱 = 墓碑但还没彻底移除 */
export const isTrashed = (e: { deleted?: boolean; purged?: boolean }): boolean =>
  e.deleted === true && e.purged !== true;

export function allTasks(s: LocalState): Task[] { return Object.values(s.tasks); }
export function allHabits(s: LocalState): Habit[] { return Object.values(s.habits); }

/* --------------------------------------------------------- 日程集与权限 */

/**
 * 我在某个集里的角色。**权限判断的唯一入口** —— 别在别处写
 * `cal.role === 'owner'`，加一档角色时会漏掉那些散落的比较。
 */
export function roleOf(s: LocalState, calId: string | null | undefined): Role | null {
  if (!calId) return null;
  const c = s.cals.find((x) => x.id === calId);
  return c ? c.role : null;
}

/** 有没有集可写。false = 还没连上服务器（一个集都没同步下来） */
export function hasCals(s: LocalState): boolean { return s.cals.length > 0; }

/**
 * 按集过滤的一批实体。
 *
 * `calId === null` 表示**不过滤** —— 今天 / 逾期 / 待办箱 / 垃圾箱这几个页面
 * 是跨集的（用户既定：清单跨集，日程按集）。要用 `undefined` 表达「选中的集
 * 恰好是 null（还没同步下来）」时，先看 hasCals。
 */
export function inCal<T extends { calId: string }>(list: T[], calId: string | null): T[] {
  return calId === null ? list : list.filter((e) => e.calId === calId);
}

export function liveTasks(s: LocalState): Task[] { return allTasks(s).filter((t) => !isGone(t)); }
export function liveHabits(s: LocalState): Habit[] { return allHabits(s).filter((h) => !isGone(h)); }

export function trashedTasks(s: LocalState): Task[] {
  return allTasks(s).filter(isTrashed).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}
export function trashedHabits(s: LocalState): Habit[] {
  return allHabits(s).filter(isTrashed).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

/* --------------------------------------------------------------- 排序 */

/** 未定时任务之间的比较：手动顺序 > 创建时间 */
export function orderCmp(a: Task, b: Task): number {
  const oa = a.order == null ? 1e9 : a.order;
  const ob = b.order == null ? 1e9 : b.order;
  if (oa !== ob) return oa - ob;
  return (a.createdAt || 0) - (b.createdAt || 0);
}

/** 有时间的按时间排前面，未定时的按手动顺序 */
export function taskCmp(a: Task, b: Task): number {
  const ta = D.timeToMin(a.time);
  const tb = D.timeToMin(b.time);
  if (ta !== null && tb !== null) return ta - tb;
  if (ta !== null) return -1;
  if (tb !== null) return 1;
  return orderCmp(a, b);
}

export function sortTasks(list: Task[]): Task[] {
  return list.slice().sort(taskCmp);
}

/**
 * 列表排序：用户手动排过（ord 有值）就听用户的，否则用页面默认顺序。
 *
 * fallback 是各页面自己的默认口径（完成时刻倒序 / 逾期天数 / 未定时间位次）。
 * 没拖过的任务 ord 为 null，所以默认行为跟以前完全一样。
 */
export function ordCmp(fallback: (a: Task, b: Task) => number) {
  return (a: Task, b: Task): number => {
    const oa = a.ord;
    const ob = b.ord;
    if (oa != null && ob != null && oa !== ob) return oa - ob;
    if (oa != null && ob == null) return -1;
    if (oa == null && ob != null) return 1;
    return fallback(a, b);
  };
}

/* --------------------------------------------------------------- 查询 */

export function taskById(s: LocalState, id: string): Task | null {
  const t = s.tasks[id];
  return t && !isGone(t) ? t : null;
}

export function habitById(s: LocalState, id: string): Habit | null {
  const h = s.habits[id];
  return h && !isGone(h) ? h : null;
}

function matches(t: { title: string; note?: string }, kw: string): boolean {
  if (!kw) return true;
  const k = kw.toLowerCase();
  return t.title.toLowerCase().includes(k) || (t.note || '').toLowerCase().includes(k);
}

/** 某一天的任务（按时间/位次排好序） */
export function tasksOn(s: LocalState, isoDate: string): Task[] {
  const kw = s.ui.search || '';
  return sortTasks(liveTasks(s).filter((t) => t.date === isoDate && matches(t, kw)));
}

/** 某一天的未定时任务。已完成的剔除 —— 它们不再占日程位置 */
export function untimedOn(s: LocalState, isoDate: string): Task[] {
  return tasksOn(s, isoDate).filter((t) => !t.time && !t.done);
}

export function inboxTasks(s: LocalState): Task[] {
  const kw = s.ui.search || '';
  return liveTasks(s)
    .filter((t) => !t.done && !t.date && matches(t, kw))
    .sort(ordCmp(orderCmp));
}

export function todayTasks(s: LocalState): Task[] {
  const t = D.today();
  const kw = s.ui.search || '';
  return liveTasks(s)
    .filter((x) => !x.done && x.date === t && matches(x, kw))
    .sort(ordCmp(taskCmp));
}

export function todayDoneTasks(s: LocalState): Task[] {
  const t = D.today();
  const kw = s.ui.search || '';
  return liveTasks(s)
    .filter((x) => x.done && x.date === t && matches(x, kw))
    .sort(ordCmp((a, b) => (b.doneAt || 0) - (a.doneAt || 0)));
}

/** 逾期：有日期、已过期、还没完成。**唯一口径** */
export function overdueTasks(s: LocalState): Task[] {
  const t = D.today();
  const kw = s.ui.search || '';
  return liveTasks(s)
    .filter((x) => !x.done && x.date && x.date < t && matches(x, kw))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date! < b.date! ? -1 : 1;
      return ordCmp(orderCmp)(a, b);
    });
}

export function overdueCount(s: LocalState): number {
  const t = D.today();
  return liveTasks(s).filter((x) => !x.done && x.date && x.date < t).length;
}

export function doneTasks(s: LocalState): Task[] {
  const kw = s.ui.search || '';
  return liveTasks(s)
    .filter((t) => t.done && matches(t, kw))
    .sort(ordCmp((a, b) => (b.doneAt || 0) - (a.doneAt || 0)))
    .slice(0, 200);
}

export function habitsTodayRemaining(s: LocalState): number {
  const t = D.today();
  return liveHabits(s).filter((h) => !h.log || !h.log[t]).length;
}

export function counts(s: LocalState): {
  inbox: number; today: number; overdue: number; trash: number; habits: number;
} {
  const t = D.today();
  const live = liveTasks(s);
  return {
    inbox: live.filter((x) => !x.done && !x.date).length,
    today: live.filter((x) => !x.done && x.date === t).length,
    overdue: live.filter((x) => !x.done && x.date && x.date < t).length,
    trash: allTasks(s).filter(isTrashed).length + allHabits(s).filter(isTrashed).length,
    habits: habitsTodayRemaining(s),
  };
}

/** 某一天的负载：已排分钟数 + 任务数（周/月视图的负载感知用） */
export function dayLoad(s: LocalState, isoDate: string): { mins: number; count: number } {
  let mins = 0;
  let count = 0;
  for (const x of Object.values(s.tasks)) {
    if (isGone(x) || x.done || x.date !== isoDate) continue;
    count++;
    if (x.time) mins += x.duration || 60;
  }
  return { mins, count };
}

/** 连续打卡天数：今天已打则从今天起算，否则从昨天起算 */
export function habitStreak(h: Habit): number {
  if (!h || !h.log) return 0;
  let n = 0;
  let d = D.today();
  if (!h.log[d]) {
    d = D.addDays(d, -1);
    if (!h.log[d]) return 0;
  }
  while (h.log[d]) { n++; d = D.addDays(d, -1); }
  return n;
}

/** 「同一天、未定时间」这一组里下一个可用的位次 */
export function nextOrder(s: LocalState, date: string | null): number {
  let mx = -1;
  for (const t of Object.values(s.tasks)) {
    if (isGone(t)) continue;
    if (t.date === date && !t.time && t.order != null && t.order > mx) mx = t.order;
  }
  return mx + 1;
}

/* ------------------------------------------------------------- 实体构造 */

/**
 * 补全一条实体缺的数据字段。
 *
 * 为什么必须有：同步过来的是**逐字段增量**，一次可能只带 `{title}`。
 * 而所有查询函数都假设实体是完整的（`t.repeat.unit`、`t.title.toLowerCase()`），
 * 半个实体进来就是一个 TypeError。凡是「外部数据进入 state」的口子
 * —— 合并远端变更、应用快照、读 v3 旧数据 —— 都要过这一道。
 *
 * 只补**缺失**的字段，不覆盖已有值，也不碰 _ts / _dev。
 */
export function hydrateTask<T extends Partial<Task> & MetaLike>(e: T): T & Task {
  const t = e as T & Task;
  if (t.calId === undefined) t.calId = '';
  if (t.title === undefined) t.title = '未命名任务';
  if (t.note === undefined) t.note = '';
  if (t.date === undefined) t.date = null;
  if (t.time === undefined) t.time = null;
  if (t.duration === undefined) t.duration = 60;
  if (t.done === undefined) t.done = false;
  if (t.doneAt === undefined) t.doneAt = null;
  if (t.repeatSeq === undefined) t.repeatSeq = 0;
  if (t.seriesId === undefined) t.seriesId = null;
  if (t.order === undefined) t.order = null;
  if (t.ord === undefined) t.ord = null;
  if (t.createdAt === undefined) t.createdAt = 0;
  if (t.source === undefined) t.source = null;
  // repeat 可能是半个对象（远端只改了 unit），统一过一遍 toRepeat 补齐
  t.repeat = toRepeat(t.repeat, t.date ?? null);
  return t;
}

export function hydrateHabit<T extends Partial<Habit> & MetaLike>(e: T): T & Habit {
  const h = e as T & Habit;
  if (h.calId === undefined) h.calId = '';
  if (h.title === undefined) h.title = '未命名习惯';
  if (h.order === undefined) h.order = 0;
  if (!h.log || typeof h.log !== 'object') h.log = {};
  if (h.createdAt === undefined) h.createdAt = 0;
  return h;
}

export function makeTask(partial: Partial<Task> & { title: string }): Task {
  const date = partial.date ?? null;
  const t: Task = {
    id: partial.id || newId(),
    calId: partial.calId || '',
    title: partial.title || '未命名任务',
    note: partial.note || '',
    date,
    time: partial.time ?? null,
    duration: partial.duration || 60,
    done: partial.done ?? false,
    doneAt: partial.doneAt ?? null,
    repeat: partial.repeat || toRepeat(null, date),
    repeatSeq: partial.repeatSeq || 0,
    seriesId: partial.seriesId ?? null,
    order: partial.order ?? null,
    ord: partial.ord ?? null,
    createdAt: partial.createdAt || Date.now(),
    source: partial.source ?? null,
    _ts: partial._ts || {},
    _dev: partial._dev || {},
  };

  // 墓碑字段是可选的，**只在传了的时候才写上** —— 无条件写会让每条正常任务
  // 都带上 deleted: undefined，序列化进 localStorage 后到处都是空洞。
  if (partial.deleted) t.deleted = true;
  if (partial.purged) t.purged = true;
  if (partial.deletedAt != null) t.deletedAt = partial.deletedAt;
  if (partial.trashFrom != null) t.trashFrom = partial.trashFrom;

  return t;
}

export function makeHabit(title: string, order: number, calId: string, id?: string): Habit {
  return {
    id: id || newId(),
    calId,
    title,
    order,
    log: {},
    createdAt: Date.now(),
    _ts: {},
    _dev: {},
  };
}

/* ================================ 项目 ================================ */

/** 超过这么多天没动就在项目页里标 ⚠。**只在项目页标，不主动弹**（用户裁决） */
export const STALE_DAYS = 30;

export const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: '推进中', waiting: '等外部', paused: '搁置', done: '收尾',
};

const STATUS_ALL: readonly ProjectStatus[] = ['active', 'waiting', 'paused', 'done'];

export function hydrateProject<T extends Partial<Project> & MetaLike>(e: T): T & Project {
  const p = e as T & Project;
  if (p.calId === undefined) p.calId = '';
  if (p.name === undefined) p.name = '未命名项目';
  if (p.note === undefined) p.note = '';
  if (p.next === undefined) p.next = '';
  if (p.progress === undefined) p.progress = null;
  if (p.createdAt === undefined) p.createdAt = 0;
  if (!STATUS_ALL.includes(p.status)) p.status = 'active';
  // 进度写成 0–100 之外的数就钳回去 —— 界面上那是个 0..100 的输入框，
  // 但盘上那份可能是手改的
  if (p.progress !== null) {
    const n = Number(p.progress);
    p.progress = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  }
  return p;
}

export function makeProject(name: string, calId: string, id?: string): Project {
  const p: Project = {
    id: id || newId(),
    calId,
    name: name || '未命名项目',
    note: '',
    status: 'active',
    next: '',
    progress: null,
    createdAt: Date.now(),
    _ts: {},
    _dev: {},
  };
  return p;
}

export function allProjects(s: LocalState): Project[] { return Object.values(s.projects); }

export function liveProjects(s: LocalState): Project[] {
  return allProjects(s).filter((p) => !isGone(p));
}

export function projectById(s: LocalState, id: string | null | undefined): Project | null {
  if (!id) return null;
  const p = s.projects[id];
  return p && !isGone(p) ? p : null;
}

/** 挂在某个项目上的任务（含已完成的 —— 算进度要用）。墓碑不算 */
export function tasksOfProject(s: LocalState, id: string): Task[] {
  return liveTasks(s).filter((t) => t.projectId === id);
}

/**
 * 泳道里那一列。三态：`done` 被 `done` 决定，`doing` 只管「没做完但在做」。
 *
 * 用 `!!t.doing` 而不是 `t.doing === true`：远端来的可能是 0/1，
 * hydrateTask 不碰这个字段（它可选），别在这里被真值判断坑到。
 */
export function projectColumn(t: Task): 'todo' | 'doing' | 'done' {
  if (t.done) return 'done';
  return t.doing ? 'doing' : 'todo';
}

/**
 * 0–100。**手填值优先**，否则 = 关联任务里已完成的比例。
 *
 * 没有关联任务时返回 0 而不是 100 —— 「一个任务都没有」不等于「做完了」，
 * 那是「还没拆解」。泳道头会把这种情况写成 0/0 让用户看出来。
 */
export function projectProgress(s: LocalState, id: string): number {
  const p = projectById(s, id);
  if (p && p.progress !== null) return p.progress;
  const list = tasksOfProject(s, id);
  if (!list.length) return 0;
  return Math.round((list.filter((t) => t.done).length / list.length) * 100);
}

/**
 * 最后活动时刻 = 项目自身各字段的 `_ts` ∪ 关联任务的 `_ts` / `doneAt` / `createdAt`
 * 取最大。
 *
 * **只用会同步的数据。** `_ts` / `_dev` 虽然只存在本地，但 `applyRemote` 会把
 * 远端来的 `ts` 写进 `_ts`，所以它是**收敛的**、跨设备一致。
 * **不要另加一个 `touchedAt` 字段** —— 那需要「读一次就写一次」，
 * 会把只读浏览变成写入，白白产生 op，而且每台设备的「上次看」互相覆盖。
 */
export function projectTouchedAt(s: LocalState, id: string): number {
  const p = projectById(s, id);
  if (!p) return 0;
  let max = 0;
  const seen = (o: Record<string, number> | undefined) => {
    for (const v of Object.values(o || {})) if (v > max) max = v;
  };
  seen(p._ts);
  if (p.createdAt > max) max = p.createdAt;
  for (const t of tasksOfProject(s, id)) {
    seen(t._ts);
    if (t.createdAt > max) max = t.createdAt;
    if (t.doneAt && t.doneAt > max) max = t.doneAt;
  }
  return max;
}

/** 多少天没动了。算不出（没有任何时间戳）时给 0，别报一个吓人的巨大数 */
export function projectStaleDays(s: LocalState, id: string, now = Date.now()): number {
  const at = projectTouchedAt(s, id);
  if (!at) return 0;
  return Math.max(0, Math.floor((now - at) / 86400000));
}

/** 最久没动的排前面 —— 面板就是用来把「快被忘掉的那个」顶到眼前的 */
export function sortProjects(s: LocalState, list: Project[]): Project[] {
  return list.slice().sort((a, b) => {
    const d = projectTouchedAt(s, a.id) - projectTouchedAt(s, b.id);
    if (d) return d;
    return a.name.localeCompare(b.name);   // 都是 0（新建还没来得及动）时给个稳定序
  });
}

/* --------------------------------------------------------------- 界面偏好 */

const NAV_ALL = [
  'inbox', 'today', 'overdue', 'calendar', 'projects', 'habits', 'done', 'trash', 'settings',
];

/**
 * 可自定义的功能项 —— `navOrder` 与 `ui.tabs` 都只从这里面选。
 *
 * **设置不在里面，这是有意的**：它的入口固定在侧栏底部与「更多」抽屉里。
 * 放进来就等于允许用户把它自己隐藏掉，而「设置」正是他唯一能去改回来的地方 ——
 * 藏起来之后没有第二条路，界面上就是一个死角。
 */
export const CUSTOMIZABLE: readonly string[] = NAV_ALL.filter((k) => k !== 'settings');

/** 底栏最多放几项。「更多」恒占最后一格，所以总格数 ≤ 5（HIG 的 2–5 项） */
export const TAB_MAX = 4;

/**
 * 底栏兜底。**空栏等于没有导航**，所以过滤后不足 1 项就回落到这里。
 *
 * 顺序与 navOrder 的前 4 项一致 —— 底栏是 navOrder 的子集（见 normalizeUi），
 * 兜底值要是另排一套，用户会看到「恢复默认之后底栏顺序变了」。
 */
const DEFAULT_TABS: readonly string[] = ['inbox', 'today', 'overdue', 'calendar'];

/* 外观轴的白名单。**故意与 ui/theme.ts 的 ACCENTS / STYLES 重复** ——
   domain/ 不许引 ui/（那一层碰 DOM），而这两个列表的职责不同：
   那边是「渲染哪些选项」（Record<Key, …>，少一个键编译不过），
   这边是「磁盘上这个值还认不认」。加了新键要两边都补。 */
const ACCENT_ALL: readonly AccentKey[] = ['jade', 'azure', 'clay', 'plum', 'gold', 'slate'];
const STYLE_ALL: readonly StyleKey[] = ['soft', 'flat', 'notion'];
const THEME_ALL: readonly ThemeMode[] = ['auto', 'light', 'dark'];

export function defaultUi(): UiPrefs {
  return {
    nav: 'today',
    view: 'day',
    cursor: D.today(),
    theme: 'light',
    accent: 'jade',
    style: 'soft',
    search: '',
    navOrder: CUSTOMIZABLE.slice(),
    navBottom: ['trash'],
    tabs: DEFAULT_TABS.slice(),
    tdoneOpen: false,
    cal: null,
  };
}

export function normalizeUi(raw: Partial<UiPrefs> | undefined): UiPrefs {
  const d = defaultUi();
  const ui: UiPrefs = { ...d, ...(raw || {}) };

  // 三档都要认。写成 `!== 'dark' ? 'light'` 会把用户选的「跟随系统」每次刷新打回
  // 常亮 —— 而 auto 是合法值，不是「没选」。
  if (!THEME_ALL.includes(ui.theme)) ui.theme = 'light';
  if (!ACCENT_ALL.includes(ui.accent)) ui.accent = 'jade';
  if (!STYLE_ALL.includes(ui.style)) ui.style = 'soft';
  // cal 只保证是字符串或 null。它到底还存不存在要等服务器把集列表发下来，
  // 那一步在 store.setCals 里做 —— normalizeUi 是纯函数，不知道有哪些集。
  if (ui.cal != null && typeof ui.cal !== 'string') ui.cal = null;
  if (!['day', 'week', 'month'].includes(ui.view)) ui.view = 'day';
  if (!ui.cursor) ui.cursor = D.today();
  if (ui.nav === 'notes') ui.nav = 'today';
  if (!NAV_ALL.includes(ui.nav)) ui.nav = 'today';
  ui.search = ui.search || '';
  // 旧版遗留的键直接丢掉。走 unknown 中转是必须的 —— UiPrefs 没有索引签名，
  // 直接 as Record<string, unknown> 会被严格模式拦下。
  const bag = ui as unknown as Record<string, unknown>;
  delete bag.notebookId;
  delete bag.noteId;
  delete bag.listFilter;

  // order 只收 CUSTOMIZABLE 里的键：设置不进这个列表（见上面的注释）。
  // 过滤 + 补全用的是同一个列表，两边不一致时会出现「过滤掉的又被补回来」。
  const order = Array.isArray(ui.navOrder)
    ? ui.navOrder.filter((k) => CUSTOMIZABLE.includes(k))
    : [];
  for (const k of CUSTOMIZABLE) if (order.indexOf(k) < 0) order.push(k);
  ui.navOrder = order;

  // navBottom 不能用「空则默认」的写法 —— 那会把用户主动拖出底部的垃圾箱又塞回去。
  // 必须区分「从未设置（undefined）→ 给默认」与「空数组 → 用户有意为之，原样保留」。
  const bottom = Array.isArray(ui.navBottom)
    ? ui.navBottom.filter((k) => order.indexOf(k) >= 0)
    : null;
  ui.navBottom = bottom === null ? ['trash'] : bottom;

  // tabs 是 navOrder 的子集 —— 所以按 navOrder 的顺序重排它，而不是
  // 保留它在盘上自己的顺序。否则侧栏拖个序，底栏的顺序也跟着变，
  // 两个列表各排各的，用户不知道为什么。
  //
  // 与 navBottom 不同：**这里空栏没有合法解释**（底栏空着等于没有
  // 导航），所以 [] 与「没设置」一样回落到默认，不区分。
  const tabSet = new Set(
    Array.isArray(ui.tabs) ? ui.tabs.filter((k) => CUSTOMIZABLE.includes(k)) : [],
  );
  const tabList = order.filter((k) => tabSet.has(k)).slice(0, TAB_MAX);
  ui.tabs = tabList.length ? tabList : DEFAULT_TABS.slice();

  return ui;
}

/* -------------------------------------------------------- v3 → v4 迁移 */

interface V3Task {
  id?: string; title?: string; note?: string;
  date?: string | null; time?: string | null; duration?: number;
  done?: boolean; doneAt?: number | null;
  repeat?: unknown; repeatSeq?: number; order?: number; ord?: number | null;
  createdAt?: number; source?: string | null;
}

interface V3State {
  version?: number;
  tasks?: V3Task[];
  trash?: { id?: string; kind?: string; payload?: V3Task; from?: string; deletedAt?: number }[];
  habits?: { id?: string; title?: string; order?: number; log?: Record<string, true>; createdAt?: number }[];
  ui?: Partial<UiPrefs>;
}

export interface MigrationResult {
  tasks: Task[];
  habits: Habit[];
  ui: UiPrefs;
  /** 迁移时忽略掉的旧模块条目数（备忘录 / 清单 / 笔记本），只用于报告 */
  ignored: number;
}

/**
 * 把浏览器里那份 v3 数据转成 v4 实体。
 *
 * seriesId 的推法：给每个重复任务**以自己为系列根**（seriesId = 自己的 id）。
 * 不从「同标题 + 同 repeat」去归并历史实例 —— 那是猜，猜错就把两条无关的任务
 * 焊在一起。历史里已经产生的重复实例就让它各归各的，往后新派生的实例
 * 才会用确定性 id 收敛。
 */
export function migrateV3(raw: V3State): MigrationResult {
  const now = Date.now();
  const tasks: Task[] = [];
  const habits: Habit[] = [];
  let ignored = 0;

  for (const t of raw.tasks || []) {
    if (!t || typeof t !== 'object') { ignored++; continue; }
    const id = t.id || newId();
    const repeat = toRepeat(t.repeat, t.date ?? null);
    tasks.push({
      id,
      calId: '',   // 归属由 store.loadMigrated 落位 —— 迁移这一步还不知道有哪些集
      title: t.title || '未命名任务',
      note: t.note || '',
      date: t.date ?? null,
      time: t.time ?? null,
      duration: t.duration || 60,
      done: !!t.done,
      doneAt: t.doneAt ?? null,
      repeat,
      repeatSeq: t.repeatSeq || 0,
      seriesId: repeat.unit !== 'none' ? id : null,
      order: t.order ?? null,
      ord: t.ord ?? null,
      createdAt: t.createdAt || now,
      source: t.source ?? null,
      _ts: {},
      _dev: {},
    });
  }

  // 旧版的 trash 是整条任务的深拷贝快照。v4 用墓碑表达 —— 垃圾箱就是
  // deleted && !purged 的实体本身，这样删除才能同步到其他设备。
  for (const item of raw.trash || []) {
    if (!item || item.kind !== 'task' || !item.payload) { ignored++; continue; }
    const p = item.payload;
    const id = p.id || newId();
    tasks.push({
      id,
      calId: '',
      title: p.title || '未命名任务',
      note: p.note || '',
      date: p.date ?? null,
      time: p.time ?? null,
      duration: p.duration || 60,
      done: !!p.done,
      doneAt: p.doneAt ?? null,
      repeat: toRepeat(p.repeat, p.date ?? null),
      repeatSeq: p.repeatSeq || 0,
      seriesId: null,
      order: p.order ?? null,
      ord: p.ord ?? null,
      createdAt: p.createdAt || now,
      source: p.source ?? null,
      deleted: true,
      deletedAt: item.deletedAt || now,
      trashFrom: item.from || '任务列表',
      _ts: {},
      _dev: {},
    });
  }

  for (const h of raw.habits || []) {
    if (!h || typeof h !== 'object') { ignored++; continue; }
    habits.push({
      id: h.id || newId(),
      calId: '',
      title: h.title || '未命名习惯',
      order: h.order ?? 0,
      log: h.log || {},
      createdAt: h.createdAt || now,
      _ts: {},
      _dev: {},
    });
  }

  return { tasks, habits, ui: normalizeUi(raw.ui), ignored };
}

/**
 * 给迁移出来的实体补齐逐字段时间戳。
 *
 * 为什么单独一步：_ts 是「这个字段最后被写入的时刻」，只有 store 知道
 * 自己打算用哪个 ts 建 op。两边各写一次必然对不上，干脆由 store 统一填。
 */
export function fillTs<T extends { _ts: Record<string, number>; _dev: Record<string, string> }>(
  entity: T,
  fields: string[],
  ts: number,
  deviceId: string,
): T {
  for (const f of fields) {
    entity._ts[f] = ts;
    entity._dev[f] = deviceId;
  }
  return entity;
}

/** 一个实体里「属于数据」的字段名（排除 id / calId / _ts / _dev） */
export function dataFields(entity: Record<string, unknown>): string[] {
  return Object.keys(entity).filter((k) => k !== 'id' && k !== 'calId' && k !== '_ts' && k !== '_dev');
}

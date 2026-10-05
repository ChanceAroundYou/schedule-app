/**
 * store.ts —— 本地状态 + 写入通道
 *
 * 模型是「本地先写、后台补推」（server-authoritative + client outbox）：
 *   1. 用户操作 → 立刻改内存里的 state，界面马上反映，不等网络
 *   2. 同时压一条 op 进 outbox，落 localStorage
 *   3. engine 在后台把 outbox 推给服务器，成功才把它清掉
 *
 * 每条 op 只带**本次改动的那几个字段**，不是整条实体。这样两台设备分别改
 * 同一条任务的不同字段时能各自保住（逐字段 LWW），而不是后到的整条覆盖。
 *
 * state 是**可变对象**，订阅靠 version 计数器 —— 每次写入深拷贝一遍
 * tasks 是几百 KB 的浪费，而 useSyncExternalStore 只需要一个会变的快照值。
 */

import type { Entity, Habit, LocalState, Op, Task, UiPrefs } from '../domain/types.ts';
import {
  hydrateHabit, hydrateTask, liveHabits, trashedTasks, trashedHabits,
  makeTask, makeHabit, newOpId, normalizeUi, defaultUi, nextOrder, orderCmp,
} from '../domain/model.ts';
import { writeFields } from '../domain/merge.ts';
import { instanceId, repeatNext, seriesRootOf, toRepeat } from '../domain/repeat.ts';
import * as D from '../domain/date.ts';
import { deviceId } from './device.ts';

const KEY = 'schedule-app-v4';

/* ---------------------------------------------------------------- 状态 */

function blank(): LocalState {
  return {
    tasks: {}, habits: {}, cursor: 0, outbox: [],
    ui: defaultUi(), lastError: null, clockBlocked: [], syncing: false,
  };
}

let state: LocalState = blank();
let version = 0;
const listeners = new Set<() => void>();

export function get(): LocalState { return state; }
export function getVersion(): number { return version; }
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit(): void {
  version++;
  for (const fn of listeners) fn();
}

/* -------------------------------------------------------------- 持久化 */

/**
 * 写 localStorage 是同步的，而且要把整个 state 序列化一遍（可能几百 KB）。
 * 搜索框每敲一个字都写一次会明显卡手，所以攒 250ms 再写。
 * pagehide / 切后台时立刻落盘，别把最后几个字丢在定时器里。
 */
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; flushPersist(); }, 250);
}

export function flushPersist(): void {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* 配额满，忽略 */ }
}

export function load(): LocalState {
  let raw: string | null = null;
  try { raw = localStorage.getItem(KEY); } catch (_) { /* 隐私模式 */ }
  if (raw) {
    try {
      const p = JSON.parse(raw) as Partial<LocalState>;
      state = {
        tasks: p.tasks || {},
        habits: p.habits || {},
        cursor: Number(p.cursor) || 0,
        outbox: Array.isArray(p.outbox) ? p.outbox : [],
        ui: normalizeUi(p.ui),
        lastError: p.lastError ?? null,
        clockBlocked: Array.isArray(p.clockBlocked) ? p.clockBlocked : [],
        syncing: false,   // 瞬时状态，别把上次关页面时的 true 带进来
      };
      // 磁盘上那份可能是旧版本写的、或者上一轮同步只写了一半的稀疏实体
      for (const t of Object.values(state.tasks)) hydrateTask(t);
      for (const h of Object.values(state.habits)) hydrateHabit(h);
    } catch (_) {
      state = blank();   // 坏数据就当没存过，别让整个应用打不开
    }
  }
  version++;
  return state;
}

export function resetLocal(): void {
  state = blank();
  try { localStorage.removeItem(KEY); } catch (_) { /* 忽略 */ }
  emit();
}

/* ---------------------------------------------------------- 写入通道 */

export interface Change {
  entity: Entity;
  id: string;
  fields: Record<string, unknown>;
}

function bucketOf(e: Entity): Record<string, Task> | Record<string, Habit> {
  return (e === 'task' ? state.tasks : state.habits) as Record<string, Task> | Record<string, Habit>;
}

/**
 * 实体的「裸字段」视图 —— 按 key 读写任意字段。
 *
 * 走 unknown 中转是必须的：Task / Habit 都没有索引签名，直接断言成
 * Record<string, unknown> 会被严格模式拦下。这里确实是在做动态字段读写，
 * 类型系统帮不上忙，只能在边界上放开。
 */
type RawEntity = Record<string, unknown>;

function rawBucket(e: Entity): Record<string, RawEntity> {
  return bucketOf(e) as unknown as Record<string, RawEntity>;
}

/**
 * 一批改动用同一个时间戳。同一次用户操作算一个时刻 —— 分开取 Date.now()
 * 会让同一次点击产生的两个字段带上不同 ts，回放和调试时都对不上账。
 */
export function commitMany(items: Change[], opts: { queue?: boolean } = {}): void {
  if (!items.length) return;
  const ts = Date.now();
  const dev = deviceId();
  const queue = opts.queue !== false;

  for (const it of items) {
    const bucket = rawBucket(it.entity);
    let e = bucket[it.id];
    if (!e) e = bucket[it.id] = { id: it.id, _ts: {}, _dev: {} };
    writeFields(e as never, it.fields, ts, dev);
    if (it.entity === 'task') hydrateTask(e as never);
    else hydrateHabit(e as never);

    if (queue) {
      const op: Op = {
        opId: newOpId(), deviceId: dev, ts,
        entity: it.entity, entityId: it.id, fields: it.fields,
      };
      state.outbox.push(op);
    }
  }

  persist();
  emit();
}

/** 单个实体的一次改动 */
export function commit(entity: Entity, id: string, fields: Record<string, unknown>): void {
  commitMany([{ entity, id, fields }]);
}

/* ------------------------------------------------------- 应用远端变更 */

/** 服务器发来的一条字段变更。快照也先摊平成这个形状，走同一条合并路径。 */
export interface RemoteChange {
  entity: Entity;
  entityId: string;
  field: string;
  value: unknown;
  ts: number;
  deviceId: string;
}

/**
 * 把服务器来的字段变更合并进来。
 *
 * 快照和增量走的是**同一条路** —— 快照无非是一批 ts/_dev 齐全的变更而已。
 * 统一的好处是只有一套比较逻辑，不会出现「首屏同步和后续同步结果不一样」。
 *
 * @returns 远端数据是否真的改变了本地内容
 */
export function applyRemote(changes: RemoteChange[]): boolean {
  let touched = false;
  for (const c of changes) {
    const bucket = rawBucket(c.entity);
    let e = bucket[c.entityId];
    if (!e) e = bucket[c.entityId] = { id: c.entityId, _ts: {}, _dev: {} };

    const curTs = (e._ts as Record<string, number>)[c.field] ?? -Infinity;
    const curDev = (e._dev as Record<string, string>)[c.field] ?? '';
    if (!(c.ts > curTs || (c.ts === curTs && c.deviceId > curDev))) continue;

    e[c.field] = c.value;
    (e._ts as Record<string, number>)[c.field] = c.ts;
    (e._dev as Record<string, string>)[c.field] = c.deviceId;
    touched = true;
  }

  if (touched) {
    for (const t of Object.values(state.tasks)) hydrateTask(t);
    for (const h of Object.values(state.habits)) hydrateHabit(h);
    persist();
    emit();
  }
  return touched;
}

/** 把 { tasks: {id: {…}}, habits: {…} } 形式的快照摊平成一串字段变更 */
export function flattenSnapshot(
  snap: { tasks: Record<string, Task>; habits: Record<string, Habit> },
): RemoteChange[] {
  const out: RemoteChange[] = [];
  for (const [entity, bucket] of [['task', snap.tasks], ['habit', snap.habits]] as const) {
    for (const e of Object.values(bucket)) {
      const ts = (e._ts || {}) as Record<string, number>;
      const dev = (e._dev || {}) as Record<string, string>;
      for (const field of Object.keys(e)) {
        if (field === 'id' || field === '_ts' || field === '_dev') continue;
        out.push({
          entity, entityId: e.id, field,
          value: (e as unknown as Record<string, unknown>)[field],
          ts: ts[field] ?? 0, deviceId: dev[field] ?? '',
        });
      }
    }
  }
  return out;
}

export function setCursor(c: number): void {
  if (state.cursor === c) return;
  state.cursor = c;
  persist();
  emit();
}

export function ackOps(opIds: string[]): void {
  if (!opIds.length) return;
  const drop = new Set(opIds);
  const before = state.outbox.length;
  state.outbox = state.outbox.filter((o) => !drop.has(o.opId));
  if (state.outbox.length !== before) { persist(); emit(); }
}

export function setError(msg: string | null): void {
  state.lastError = msg;
  persist();
  emit();
}

export function setSyncing(v: boolean): void {
  if (state.syncing === v) return;
  state.syncing = v;
  emit();   // 不落盘：它只是「转圈圈图标要不要显示」
}

export function setClockBlocked(ids: string[]): void {
  state.clockBlocked = ids;
  persist();
  emit();
}

/* ------------------------------------------------------------ 界面偏好 */

/** 界面偏好**不进同步**：手机换主题不该把桌面也换了 */
export function setUi(patch: Partial<UiPrefs>): void {
  state.ui = { ...state.ui, ...patch };
  persist();
  emit();
}

/* ---------------------------------------------------------------- 任务 */

export interface TaskDraft {
  title: string;
  note?: string;
  date?: string | null;
  time?: string | null;
  duration?: number;
  repeat?: unknown;
  source?: string | null;
}

export function addTask(d: TaskDraft): string {
  const date = d.date ?? null;
  const t = makeTask({
    title: d.title,
    note: d.note || '',
    date,
    time: d.time ?? null,
    duration: d.duration || 60,
    repeat: toRepeat(d.repeat, date),
    seriesId: null,
    order: d.time ? null : nextOrder(state, date),
    createdAt: Date.now(),
    source: d.source ?? null,
  });
  // 非重复任务没有系列根；重复任务以自己为根（后续实例的 id 从这里派生）
  if (t.repeat.unit !== 'none') t.seriesId = t.id;

  commitMany([{ entity: 'task', id: t.id, fields: dataOf(t) }]);
  return t.id;
}

/**
 * 勾选 / 取消勾选。
 *
 * 勾上一条**重复**任务时会顺手派生下一个实例。这一步是本次重构的核心：
 * 新旧实现都是「完成即派生」，区别在实例 id 的来源。旧版 `randomUUID()`
 * 让两台设备各自离线勾选时派生出两个不同的实例，同步后任务翻倍；
 * 现在 id 是 `${seriesId}#${发生日}`，两边算出来一模一样，自然合并成一条。
 */
export function toggleTask(id: string): void {
  const t = state.tasks[id];
  if (!t || t.deleted) return;

  const done = !t.done;
  const now = Date.now();
  commit('task', id, { done, doneAt: done ? now : null });
  if (!done) return;

  const root = seriesRootOf(t);
  if (!root) return;

  const nextDate = repeatNext(t, t.date || D.today());
  if (!nextDate) return;

  const nextId = instanceId(root, nextDate);
  const existing = state.tasks[nextId];
  if (existing) {
    // 另一台设备已经建过这一次的实例了 —— 派生 id 相同，本来就是同一条。
    // **不重写字段**：本机这份标题/时间可能已经过期，重写会用旧值盖掉对方的编辑。
    // 只在它被误删的情况下救回来。
    if (existing.deleted === true) {
      commit('task', nextId, { deleted: false, deletedAt: null, purged: false });
    }
    return;
  }

  commit('task', nextId, {
    title: t.title, note: t.note,
    date: nextDate, time: t.time, duration: t.duration,
    done: false, doneAt: null,
    repeat: t.repeat, repeatSeq: (t.repeatSeq || 0) + 1,
    seriesId: root, order: null, ord: null,
    createdAt: now, source: t.source ?? null,
  });
}

export function patchTask(id: string, fields: Partial<Task>): void {
  const cur = state.tasks[id];
  if (!cur) return;
  // 改日期时把未定时的位次重算一下，否则会带着旧日期的 order 落到新日期上
  const next: Record<string, unknown> = { ...fields };
  if ('date' in fields && !cur.time && !('order' in fields)) {
    next.order = nextOrder(state, (fields.date ?? null) as string | null);
  }
  commit('task', id, next);
}

export function deleteTask(id: string, from = '任务列表'): void {
  if (!state.tasks[id]) return;
  commit('task', id, { deleted: true, deletedAt: Date.now(), trashFrom: from });
}

export function restoreTask(id: string): void {
  if (!state.tasks[id]) return;
  commit('task', id, { deleted: false, deletedAt: null, purged: false });
}

export function purgeTask(id: string): void {
  if (!state.tasks[id]) return;
  commit('task', id, { purged: true });
}

/**
 * 「不保留」= 留下墓碑（走同步通道，别的设备才知道要删）。
 * 「清空」= 打 purged，服务器快照就不再带它了。两者都是字段写入，没有物理删除。
 */
export function emptyTrash(): void {
  const items: Change[] = [];
  for (const t of trashedTasks(state)) items.push({ entity: 'task', id: t.id, fields: { purged: true } });
  for (const h of trashedHabits(state)) items.push({ entity: 'habit', id: h.id, fields: { purged: true } });
  commitMany(items);
}

/* ---------------------------------------------------------------- 打卡 */

export function addHabit(title: string): string {
  const h = makeHabit(title, liveHabits(state).length);
  commitMany([{ entity: 'habit', id: h.id, fields: dataOf(h) }]);
  return h.id;
}

export function toggleHabit(id: string, date = D.today()): void {
  const h = state.habits[id];
  if (!h || h.deleted) return;
  const log = { ...(h.log || {}) };
  if (log[date]) delete log[date];
  else log[date] = true;
  // log 是稀疏映射，整字段覆盖是最省事的写法；同一天在两端各勾一次会收敛到
  // 最后那次的状态，不会出现「两次都生效」这种半吊子结果。
  commit('habit', id, { log });
}

export function deleteHabit(id: string): void {
  if (!state.habits[id]) return;
  commit('habit', id, { deleted: true, deletedAt: Date.now() });
}

export function restoreHabit(id: string): void {
  if (!state.habits[id]) return;
  commit('habit', id, { deleted: false, deletedAt: null, purged: false });
}

/* ---------------------------------------------------------------- 排序 */

/**
 * 把某一列按新的先后顺序写回。
 *
 * 位次离散化（×10）而不是取前后中点 —— 中点做几次就会把浮点精度耗光，
 * 而重排一次列表最多也就写十几条，多出来的这点写入不值得为它引入分数索引。
 * **只写真的变了的那些**，所以常见情况是拖一次只推送一两条。
 *
 * 行为字段是分开的：任务用 `ord`，打卡用 `order`。这两个不是一回事 ——
 * 任务的 `order` 是「同一天未定时」那组的位次（由日期和时间决定归属），
 * 而 `ord` 才是「用户在任意列表里拖出来的顺序」。混用会让用户拖完下次
 * 渲染又弹回原位，看起来就是「拖不动」。打卡没有这个冲突，直接用 order。
 */
export function reorder(entity: Entity, orderedIds: string[]): void {
  const bucket = rawBucket(entity);
  const field = entity === 'task' ? 'ord' : 'order';
  const items: Change[] = [];
  orderedIds.forEach((id, i) => {
    const cur = bucket[id];
    if (!cur) return;
    const want = i * 10;
    if (cur[field] === want) return;
    items.push({ entity, id, fields: { [field]: want } });
  });
  commitMany(items);
}

/**
 * 拖放落地：把 id 插到 refId 之前 / 之后，整组重编号。
 *
 * `baseOrder` 是容器**当前的视觉顺序**（含 id 自己）。整组重排而不是只改
 * 被拖的那一个 —— 这是个序列，只写一个会留下空洞或重复，下次渲染顺序就乱了。
 *
 * 注意这里不碰日期：「搬家」是改期按钮的职责，拖动顺手做掉会让人措手不及。
 */
export function reorderWithin(
  entity: Entity, baseOrder: string[], id: string, refId: string | null, pos: 'before' | 'after',
): void {
  const rest = baseOrder.filter((x) => x !== id);
  let idx = rest.length;
  if (refId) {
    const at = rest.indexOf(refId);
    if (at >= 0) idx = pos === 'before' ? at : at + 1;
  }
  rest.splice(idx, 0, id);
  reorder(entity, rest);
}

/**
 * 把一个任务挪到另一天（未定时的全天区之间拖）。
 * 位次要按**目标日期**那一组重算，不能带着原日期的 order 过去。
 */
export function moveUntimed(id: string, date: string | null, refId: string | null, pos: 'before' | 'after'): void {
  const t = state.tasks[id];
  if (!t) return;

  const sibs = Object.values(state.tasks)
    .filter((x) => !x.deleted && !x.done && !x.time && x.date === date && x.id !== id)
    .sort(orderCmp);

  let idx = sibs.length;
  if (refId) {
    const at = sibs.findIndex((x) => x.id === refId);
    if (at >= 0) idx = pos === 'before' ? at : at + 1;
  }
  const seq = sibs.map((x) => x.id);
  seq.splice(idx, 0, id);

  const items: Change[] = [{ entity: 'task', id, fields: { date, time: null } }];
  seq.forEach((x, i) => {
    const cur = state.tasks[x];
    if (cur && cur.order !== i) items.push({ entity: 'task', id: x, fields: { order: i } });
  });
  commitMany(items);
}

/* ------------------------------------------------------------ 批量装载 */

/** 迁移进来的历史数据就地装载，同时把每条都排进 outbox 推给服务器 */
export function loadMigrated(tasks: Task[], habits: Habit[]): number {
  const items: Change[] = [];
  for (const t of tasks) {
    state.tasks[t.id] = t;
    items.push({ entity: 'task', id: t.id, fields: dataOf(t) });
  }
  for (const h of habits) {
    state.habits[h.id] = h;
    items.push({ entity: 'habit', id: h.id, fields: dataOf(h) });
  }
  commitMany(items);
  return items.length;
}

/** 一个实体里属于「数据」的那部分字段（排除 id 与同步元数据） */
function dataOf(e: Task | Habit): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(e)) {
    if (k === 'id' || k === '_ts' || k === '_dev') continue;
    out[k] = (e as unknown as Record<string, unknown>)[k];
  }
  return out;
}

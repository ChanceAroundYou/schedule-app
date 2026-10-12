/**
 * core.ts —— 可变状态本体 + 最底层工具
 *
 * 这个模块是整层的**根**：它不 import 同目录的任何一个文件，所以依赖图从这里
 * 单向长出去，没有环（state.ts 是可变单例，`load()` 还要回头用它）。
 *
 * state 是**可变对象**，订阅靠 version 计数器 —— 每次写入深拷贝一遍 tasks 是
 * 几百 KB 的浪费，而 useSyncExternalStore 只需要一个会变的快照值。
 */
import type {
  Cal, Entity, Invite, LocalState, Project, Task, Habit,
} from '../../domain/types.ts';
import { defaultUi, resolveDefaultCal } from '../../domain/model.ts';

/** localStorage 的 key。v1 是旧版的纯本地数据，只读不删（见 docs/踩坑.md） */
export const KEY = 'schedule-app-v4';

export function blank(): LocalState {
  return {
    tasks: {}, habits: {}, projects: {}, cals: [], invites: [], cursor: 0, outbox: [],
    ui: defaultUi(), lastError: null, clockBlocked: [], syncing: false,
    denied: 0, deniedCals: [], conflicts: [],
  };
}

export let state: LocalState = blank();
let version = 0;
const listeners = new Set<() => void>();

export function get(): LocalState { return state; }
export function getVersion(): number { return version; }
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function emit(): void {
  version++;
  for (const fn of listeners) fn();
}

/** 只有 load() / resetLocal() 会整体换掉 state */
export function setState(s: LocalState): void { state = s; }

/* ---------------------------------------------------------------- 桶 */

type AnyBucket = Record<string, Task> | Record<string, Habit> | Record<string, Project>;

/** 实体的「裸字段」视图 —— 按 key 读写任意字段。
 *
 * 走 unknown 中转是必须的：Task / Habit 都没有索引签名，直接断言成
 * Record<string, unknown> 会被严格模式拦下。这里确实是在做动态字段读写，
 * 类型系统帮不上忙，只能在边界上放开。 */
type RawEntity = Record<string, unknown>;

export function bucketOf(e: Entity): AnyBucket {
  if (e === 'habit') return state.habits;
  if (e === 'project') return state.projects;
  return state.tasks;
}

export function rawBucket(e: Entity): Record<string, RawEntity> {
  return bucketOf(e) as unknown as Record<string, RawEntity>;
}

/** 某个实体属于哪个集。新实体还没落位时归到当前选中的集。 */
export function calOf(entity: Entity, id: string): string {
  const e = rawBucket(entity)[id];
  const own = e && typeof e.calId === 'string' ? e.calId : '';
  return own || state.ui.cal || '';
}

/** 一个实体里属于「数据」的那部分字段（排除 id / calId 与同步元数据） */
export function dataOf(e: Task | Habit | Project): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(e)) {
    if (k === 'id' || k === 'calId' || k === '_ts' || k === '_dev') continue;
    out[k] = (e as unknown as Record<string, unknown>)[k];
  }
  return out;
}

/** 内容真的变了才写盘 / 通知 —— 每 15 秒一次轮询都会调它，不能每次都重渲染 */
export function differs<T>(cur: T[], next: T[]): boolean {
  return JSON.stringify(cur) !== JSON.stringify(next);
}

/* ------------------------------------------------------------ 归属修复 */

/**
 * 保证 `ui.cal` 指向一个真实存在、且我仍然在里面的集；
 * `ui.cals`（勾选显示的集合）里不留已消失的集。
 *
 * **集列表一变（被踢、自己退出、别人删了、刚接受邀请）就调它** —— 这是唯一
 * 「修」归属的地方：把指向已消失集的选择拉回来，顺手把勾选集合里那些已经
 * 不在的集清掉。散在各处判断迟早会留下一个指向已消失集的选择，表现是
 * 「界面一片空白，怎么点都没反应」。
 *
 * 优先保留用户当前的选择；它不在了才退到**默认日程集**（还没有默认就退到第一个）。
 * **`cal` 不在勾选集合里也补进去** —— 它是新建东西的归属集，不显示它的话
 * 新建的条目会当场「凭空消失」（写进去了但被过滤器滤掉），那比空页面更费解。
 */
export function resolveCal(): void {
  const ids = state.cals.map((c) => c.id);
  if (!state.ui.cal || !ids.includes(state.ui.cal)) {
    state.ui.cal = resolveDefaultCal(state.ui, state.cals);
  }
  if (state.ui.cal && !state.ui.cals.includes(state.ui.cal)) {
    state.ui.cals = [...state.ui.cals, state.ui.cal];
  }
  // 只清「已经不在列表里」的。**勾选状态本身不动** —— 用户勾成什么样就是
  // 什么样，这里没有立场替他重排（能不能勾成空是 toggleCal 的事）
  state.ui.cals = state.ui.cals.filter((id) => ids.includes(id));
}

/* ------------------------------------------------------------ 便捷读取 */

export function activeCal(): string | null { return state.ui.cal; }
export function getCals(): Cal[] { return state.cals; }
export function getInvites(): Invite[] { return state.invites; }
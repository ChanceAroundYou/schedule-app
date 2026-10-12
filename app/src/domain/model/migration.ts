/**
 * migration.ts —— v3 → v4 迁移
 */

import type { Task, Habit, UiPrefs } from '../types/types.ts';
import { toRepeat } from '../repeat.ts';
import { newId } from './id.ts';
import { normalizeUi } from './ui.ts';

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

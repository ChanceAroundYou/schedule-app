/**
 * conflicts.ts —— 冲突提示的记录与清除
 *
 * 判定在 `domain/merge.ts` 的 `findConflicts`，这里只管记与清。
 */
import type { FieldConflict } from '../../domain/types.ts';
import { state, bucketOf, emit } from './core.ts';
import { persist } from './persist.ts';

/** 同一个字段只留最新的一条；列表有上限，免得攒到天长地久 */
const CONFLICT_MAX = 50;

/**
 * 记下「两端都改过」的字段。
 *
 * 同一 (实体, 字段) 只留最新那条 —— 反复来同一条会把抽屉刷成一片。
 * 顺带丢掉实体已经不在本地的那些（被踢出集 / 彻底删掉），省得留一堆
 * 点不进去的记录。
 */
export function addConflicts(list: FieldConflict[]): void {
  if (!list.length) return;

  const kept = state.conflicts.filter((c) => {
    const bucket = bucketOf(c.entity);
    const e = bucket[c.entityId] as { deleted?: boolean; purged?: boolean } | undefined;
    if (!e || e.purged) return false;
    return !list.some((n) => n.entity === c.entity && n.entityId === c.entityId && n.field === c.field);
  });

  const next = kept.concat(list);
  state.conflicts = next.length > CONFLICT_MAX ? next.slice(next.length - CONFLICT_MAX) : next;
  persist();
  emit();
}

/** 用户点了「知道了」。按 (实体 id, 字段) 清 —— 同一个字段没必要留两条 */
export function dismissConflict(entityId: string, field: string): void {
  const next = state.conflicts.filter((c) => !(c.entityId === entityId && c.field === field));
  if (next.length === state.conflicts.length) return;
  state.conflicts = next;
  persist();
  emit();
}
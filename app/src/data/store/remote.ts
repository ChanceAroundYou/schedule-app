/**
 * remote.ts —— 应用服务器来的变更（增量与快照走同一条路）
 */
import type { Entity, Habit, Project, Task } from '../../domain/types.ts';
import { hydrateTask, hydrateHabit, hydrateProject } from '../../domain/model.ts';
import { state, rawBucket, emit } from './core.ts';
import { persist } from './persist.ts';
import { ensureRepeatOccurrences } from './tasks.ts';

/** 服务器发来的一条字段变更。快照也先摊平成这个形状，走同一条合并路径。 */
export interface RemoteChange {
  entity: Entity;
  entityId: string;
  field: string;
  value: unknown;
  ts: number;
  deviceId: string;
  /** 属于哪个集。服务器一定带；本地摊平快照时从实体上取 */
  calId?: string;
}

/**
 * 把服务器来的字段变更合并进来。
 *
 * 快照和增量走的是**同一条路** —— 快照无非是一批 ts/_dev 齐全的变更而已。
 * 统一的好处是只有一套比较逻辑，不会出现「首屏同步和后续同步结果不一样」。
 *
 * `calId` 不参与 LWW：它是主键，不是字段。有就写上（本地还没有这条时尤其
 * 重要 —— 没有归属就不知道该往哪个集写、也没有写权限）。
 *
 * @returns 远端数据是否真的改变了本地内容
 */
export function applyRemote(changes: RemoteChange[]): boolean {
  let touched = false;
  for (const c of changes) {
    const bucket = rawBucket(c.entity);
    let e = bucket[c.entityId];
    if (!e) e = bucket[c.entityId] = { id: c.entityId, calId: c.calId || '', _ts: {}, _dev: {} };
    if (c.calId) e.calId = c.calId;

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
    for (const j of Object.values(state.projects)) hydrateProject(j);
    persist();
    emit();
  }

  /* 补齐重复任务的未来实例。
   *
   * ⚠️ 2026-10-14：从 `if (touched)` 里挪了出来。原来只在「远端有变更」时才补，
   * 于是「日期翻过去了但没人动任何数据」这种情况永远不补 —— 表现就是用户说的
   * 「每天重复只重复几天就断了」。窗口补齐必须与「有没有变更」无关：
   * 每轮同步都补一次（幂等，已有实例会跳过），这样每次打开 App / 切回前台
   * 都会把窗口推到未来 REPEAT_LOOKAHEAD 次。
   *
   * 注意 commitMany 会往 outbox 里塞 op，所以它必须在 touched 分支**之后** ——
   * 那批 op 由本轮之后的 push 推给服务端，不要混进本次的落地判断里。 */
  ensureRepeatOccurrences();

  return touched;
}

/** 把 { tasks: {id: {…}}, habits: {…} } 形式的快照摊平成一串字段变更 */
export function flattenSnapshot(
  snap: {
    tasks: Record<string, Task>;
    habits: Record<string, Habit>;
    projects?: Record<string, Project>;
  },
): RemoteChange[] {
  const out: RemoteChange[] = [];
  // projects 缺省给空桶：老服务的响应落在新客户端上不该炸（见 types.ts 那段）
  const buckets = [
    ['task', snap.tasks], ['habit', snap.habits], ['project', snap.projects || {}],
  ] as const;
  for (const [entity, bucket] of buckets) {
    for (const e of Object.values(bucket)) {
      const ts = (e._ts || {}) as Record<string, number>;
      const dev = (e._dev || {}) as Record<string, string>;
      for (const field of Object.keys(e)) {
        if (field === 'id' || field === 'calId' || field === '_ts' || field === '_dev') continue;
        out.push({
          entity, entityId: e.id, field, calId: e.calId,
          value: (e as unknown as Record<string, unknown>)[field],
          ts: ts[field] ?? 0, deviceId: dev[field] ?? '',
        });
      }
    }
  }
  return out;
}
/**
 * commit.ts —— 写入通道（本地先写 → 压 outbox）
 *
 * **写权限在写入通道这层把关**，不是靠界面藏按钮 —— 界面那边也会把按钮禁掉，
 * 但这里才是真正的关卡（`moveToCal` 另有一道，因为它不走这条路径）。
 */
import type { Entity, Habit, Op, Project, Task } from '../../domain/types.ts';
import { canWrite } from '../../domain/types.ts';
import { writeFields } from '../../domain/merge.ts';
import { hydrateTask, hydrateHabit, hydrateProject, roleOf, newOpId } from '../../domain/model.ts';
import { deviceId } from '../device.ts';
import { state, calOf, rawBucket, emit } from './core.ts';
import { persist } from './persist.ts';
import { deny } from './deny.ts';

export interface Change {
  entity: Entity;
  id: string;
  fields: Record<string, unknown>;
  /** 只有跨集写入才需要显式指定；一般情况下由实体自身或当前选中的集决定 */
  calId?: string;
}

/**
 * 一批改动用同一个时间戳。同一次用户操作算一个时刻 —— 分开取 Date.now()
 * 会让同一次点击产生的两个字段带上不同 ts，回放和调试时都对不上账。
 *
 * 只读成员在这里被挡下：写入既不落本地也不进 outbox。
 */
export function commitMany(items: Change[]): void {
  const blocked: string[] = [];
  const writable = items.filter((it) => {
    const calId = it.calId || calOf(it.entity, it.id);
    if (calId && canWrite(roleOf(state, calId))) return true;
    if (calId) blocked.push(calId);
    return false;
  });

  // 被挡下的改动必须**说出来**。静默丢弃是最糟的一种：用户点了勾选，界面
  // 毫无反应，他只会以为程序卡了，然后反复点。记一个计数器，由 App 弹一次提示。
  if (blocked.length) deny(blocked);
  if (!writable.length) return;

  const ts = Date.now();
  const dev = deviceId();

  for (const it of writable) {
    const calId = it.calId || calOf(it.entity, it.id);
    const bucket = rawBucket(it.entity);
    let e = bucket[it.id];
    if (!e) e = bucket[it.id] = { id: it.id, calId, _ts: {}, _dev: {} };
    e.calId = calId;   // 主键的一部分，跟着实体走，不是可同步字段
    writeFields(e as never, it.fields, ts, dev);
    if (it.entity === 'task') hydrateTask(e as never);
    else if (it.entity === 'project') hydrateProject(e as never);
    else hydrateHabit(e as never);

    const op: Op = {
      opId: newOpId(), deviceId: dev, ts, calId,
      entity: it.entity, entityId: it.id, fields: it.fields,
    };
    state.outbox.push(op);
  }

  persist();
  emit();
}

/** 单个实体的一次改动 */
export function commit(entity: Entity, id: string, fields: Record<string, unknown>): void {
  commitMany([{ entity, id, fields }]);
}

// re-export 类型，方便调用方一个 import 拿全
export type { Entity, Task, Habit, Project };
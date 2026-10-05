/**
 * merge.ts —— 逐字段 LWW 合并
 *
 * 这条规则必须与服务端 lib/sync.js 里那段 SQL 的 WHERE 子句**逐字一致**：
 *
 *   WHERE excluded.ts > field_state.ts
 *      OR (excluded.ts = field_state.ts AND excluded.device_id > field_state.device_id)
 *
 * 两边不一致的话客户端和服务端会各自算出不同的赢家，永远收敛不了 —— 表现是
 * 「两台设备看到的内容一直不一样，怎么刷新都对不上」。改这里必须同时改那边。
 *
 * device_id 参与比较不是为了公平，是为了**确定性**：时间戳撞车时，
 * 两台设备必须算出同一个答案。
 */

import type { Change, FieldConflict, Op, SyncMeta } from './types.ts';

export function lwwWins(
  incomingTs: number,
  incomingDev: string,
  currentTs: number,
  currentDev: string,
): boolean {
  if (incomingTs > currentTs) return true;
  if (incomingTs < currentTs) return false;
  return incomingDev > currentDev;
}

/**
 * 应用一条来自服务端的字段变更。
 * @returns 是否真的写进去了（false = 本地版本更新，按 LWW 拒绝了对方）
 */
export function mergeChange<T extends SyncMeta>(
  entity: T,
  field: string,
  value: unknown,
  ts: number,
  deviceId: string,
): boolean {
  const curTs = entity._ts[field] ?? -Infinity;
  const curDev = entity._dev[field] ?? '';
  if (!lwwWins(ts, deviceId, curTs, curDev)) return false;
  (entity as unknown as Record<string, unknown>)[field] = value;
  entity._ts[field] = ts;
  entity._dev[field] = deviceId;
  return true;
}

/**
 * 本地写入（用户操作）。**无条件**覆盖，因为本地操作永远是「刚刚发生的」，
 * 时间戳必然最新。写进去的同时记下逐字段时间戳，后面收到别的设备的变更时
 * 才有得比。
 */
export function writeField<T extends SyncMeta>(
  entity: T,
  field: string,
  value: unknown,
  ts: number,
  deviceId: string,
): void {
  (entity as unknown as Record<string, unknown>)[field] = value;
  entity._ts[field] = ts;
  entity._dev[field] = deviceId;
}

/** 一次性写多个字段（一次用户操作 = 一条 op = 一个时间戳） */
export function writeFields<T extends SyncMeta>(
  entity: T,
  fields: Record<string, unknown>,
  ts: number,
  deviceId: string,
): void {
  for (const k of Object.keys(fields)) writeField(entity, k, fields[k], ts, deviceId);
}

/**
 * 挑出「这一轮我推上去的字段，同一次也收到了别的设备的改动」的那些。
 *
 * 判据就是**同一 (entity, entityId, field) 同时出现在两边**，不看谁赢 ——
 * 两个方向用户都得被告知：
 *
 * - 对方赢 → 用户刚打的字**变回去了**（最吓人：他会以为程序坏了）
 * - 我赢   → 对方那一下被盖掉了，对方那台设备上也是静默的
 *
 * 触发条件是「同时」：我这一轮推了它，而这一轮的响应里带着对方的改动。
 * 平时不会误报 —— 先拉到对方的改动、之后再改，对方的改动**不在这一轮的
 * `changes` 里**（游标已经越过它了），那是正常的「接着改」，不是冲突。
 *
 * 纯函数，只在 domain 里，方便单测把各种组合钉死。
 */
export function findConflicts(
  pushed: Pick<Op, 'entity' | 'entityId' | 'fields' | 'ts' | 'deviceId'>[],
  changes: Pick<Change, 'entity' | 'entityId' | 'field' | 'value' | 'ts' | 'deviceId'>[],
  myDeviceId: string,
): FieldConflict[] {
  const out: FieldConflict[] = [];

  for (const op of pushed) {
    if (op.deviceId !== myDeviceId) continue;      // 只关心「我」推的
    for (const c of changes) {
      if (c.deviceId === myDeviceId) continue;     // 自己刚推的那条会回显，不算
      if (c.entity !== op.entity || c.entityId !== op.entityId) continue;
      if (!Object.prototype.hasOwnProperty.call(op.fields, c.field)) continue;

      out.push({
        entity: op.entity,
        entityId: op.entityId,
        field: c.field,
        // 谁赢按同一套比较键算 —— 别在这里另写一套，两边不一致就永远说不清
        winner: lwwWins(c.ts, c.deviceId, op.ts, op.deviceId) ? 'theirs' : 'mine',
        mine: op.fields[c.field],
        theirs: c.value,
        ts: c.ts,
        deviceId: c.deviceId,
      });
    }
  }
  return out;
}

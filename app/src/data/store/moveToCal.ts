/**
 * moveToCal.ts —— 挪集
 *
 * 走的是**自己的**写入路径（不走 commitMany），所以权限判断也要自己挡一道。
 */
import type { Entity, Habit, Task } from '../../domain/types.ts';
import { canWrite } from '../../domain/types.ts';
import { roleOf, newOpId, hydrateTask, hydrateHabit } from '../../domain/model.ts';
import { writeFields } from '../../domain/merge.ts';
import { deviceId } from '../device.ts';
import { state, rawBucket, dataOf } from './core.ts';
import { deny } from './deny.ts';
import { commitMany } from './commit.ts';

/**
 * 把一个实体挪到另一个集。
 *
 * **不是改 calId 一个字段**：calId 是主键的一部分，改了等于换了一条实体。
 * 服务器那边 `field_state` 的主键是 (cal_id, entity, entity_id)，就地改 id
 * 会在旧集留下一份永远删不掉的孤儿（新集那条和它不同主键，谁也盖不住谁）。
 * 所以正确做法是「目标集里新建一条 + 源集里留墓碑」，用户视角是挪过去了，
 * 代价只是 id 变了 —— 他没机会看见。
 */
export function moveToCal(entity: Entity, id: string, targetCal: string): void {
  const src = rawBucket(entity)[id];
  if (!src || src.calId === targetCal) return;
  // 目标集写不进去也要说一声。原来这里是干 `return`，用户点了「移到…」
  // 之后什么都没发生，连权限提示都没有
  if (!canWrite(roleOf(state, targetCal))) { deny([targetCal]); return; }

  const fields = dataOf(src as unknown as Task | Habit);
  // 搬过去的是「活着的那份」：墓碑字段不跟着走
  delete fields.deleted;
  delete fields.deletedAt;
  delete fields.purged;
  delete fields.trashFrom;

  const copyId = newOpId();
  const copy = rawBucket(entity);
  copy[copyId] = { id: copyId, calId: targetCal, _ts: {}, _dev: {} };
  writeFields(copy[copyId] as never, fields, Date.now(), deviceId());
  if (entity === 'task') hydrateTask(copy[copyId] as never);
  else hydrateHabit(copy[copyId] as never);

  commitMany([
    { entity, id: copyId, calId: targetCal, fields },
    { entity, id, calId: String(src.calId), fields: { deleted: true, deletedAt: Date.now(), trashFrom: '移动日程集' } },
  ]);
}
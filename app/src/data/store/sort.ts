/**
 * sort.ts —— 拖动排序与跨日期移动
 *
 * **行为字段是分开的**：任务用 `ord`，打卡用 `order`。这两个不是一回事 ——
 * 任务的 `order` 是「同一天未定时」那组的位次（由日期和时间决定归属），
 * 而 `ord` 才是「用户在任意列表里拖出来的顺序」。混用会让用户拖完下次
 * 渲染又弹回原位，看起来就是「拖不动」。打卡没有这个冲突，直接用 order。
 *
 * 位次离散化（×10）而不是取前后中点 —— 中点做几次就会把浮点精度耗光，
 * 而重排一次列表最多也就写十几条，多出来的这点写入不值得为它引入分数索引。
 * **只写真的变了的那些**，所以常见情况是拖一次只推送一两条。
 */
import type { Entity } from '../../domain/types.ts';
import { orderCmp } from '../../domain/model.ts';
import { state, rawBucket } from './core.ts';
import { commitMany, type Change } from './commit.ts';

/** 把某一列按新的先后顺序写回 */
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
/**
 * tasks.ts —— 任务的写入通道（新建 / 勾选 / 改 / 删 / 垃圾箱）
 *
 * **全部走 `commit()` / `commitMany()`**，所以权限把关（`canWrite`）、被挡提示
 * （`deny()`）、发件箱、冲突记录自动全都有 —— 这里一个都不重复。
 */
import type { Task } from '../../domain/types.ts';
import {
  makeTask, nextOrder, trashedTasks, trashedHabits,
} from '../../domain/model.ts';
import { seriesRootOf, instanceId, repeatNext, repeatAdvance, toRepeat } from '../../domain/repeat.ts';
import type { RepeatRule } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { state, dataOf } from './core.ts';
import { commit, commitMany, type Change } from './commit.ts';

export interface TaskDraft {
  title: string;
  note?: string;
  date?: string | null;
  time?: string | null;
  duration?: number | null;
  repeat?: unknown;
  source?: string | null;
}

export function addTask(d: TaskDraft): string {
  const date = d.date ?? null;
  const t = makeTask({
    calId: state.ui.cal || '',
    title: d.title,
    note: d.note || '',
    date,
    time: d.time ?? null,
    duration: d.duration ?? null,
    repeat: toRepeat(d.repeat, date),
    seriesId: null,
    order: d.time ? null : nextOrder(state, date),
    createdAt: Date.now(),
    source: d.source ?? null,
  });
  // 非重复任务没有系列根；重复任务以自己为根（后续实例的 id 从这里派生）
  if (t.repeat.unit !== 'none') t.seriesId = t.id;

  commitMany([{ entity: 'task', id: t.id, fields: dataOf(t) }]);
  // 新建的重复任务：顺手把未来几次也生成出来（用户 2026-10-14 要求）
  if (t.repeat.unit !== 'none') ensureRepeatOccurrences();
  return t.id;
}

/**
 * 预生成未来几次重复实例。
 *
 * 2026-10-14 从 4 提到 14：窗口太浅的话，用户几天没打开 App（或没开小组件）
 * 就又断档了 —— 补齐逻辑必须能在「很久没运行」之后一次性把窗口推远。
 * 14 次对每天重复 ≈ 两周，足够覆盖绝大多数间隔。
 */
export const REPEAT_LOOKAHEAD = 14;

/**
 * 给所有「重复且未完成」的任务补齐未来 N 次实例（真的写进库）。
 *
 * 背景：App 原本是**完成即派生**（勾掉这一次才产生下一次），所以在「下周三」
 * 看不到这条任务。用户 2026-10-14 选择「预生成若干次」，于是这里按**确定性
 * 实例 id**（`seriesId#日期`）把后续几次建出来 —— id 确定性保证多设备 / 反复
 * 调用都能收敛（已存在就跳过）。
 *
 * 幂等：每次都先查 id 在不在。可以挂在同步之后反复调，不会重复建。
 * 只补**今天及以后**的发生日，不去把过去的历史补出来（那只会污染列表）。
 */
export function ensureRepeatOccurrences(): void {
  const items: Change[] = [];
  const now = Date.now();
  const today = D.today();

  for (const t of Object.values(state.tasks)) {
    if (!t || t.deleted || t.done) continue;
    const root = seriesRootOf(t);
    if (!root) continue;
    // ⚠️ **只处理系列根**（2026-10-14 修）。已生成的实例自己也有 repeat、
    // 也会算出 root —— 一并处理的话，每个实例又往后生成一批，
    // 实测 4 条能膨胀成 8 条、且每调一次多一倍（无界增长）。
    if (t.seriesId && t.seriesId !== t.id) continue;
    const r = t.repeat;
    if (!r || r.unit === 'none') continue;

    // ⚠️ **游标必须从「已存在的最后一个实例」起算，不能从系列根自己的日期起算**
    // （2026-10-14 修，用户报「每天重复只重复几天就断了」）。
    //
    // 原来的写法：`cursor = t.date`（根的原始日期）、`seq = t.repeatSeq || 0`，
    // 于是**每次调用都从同一起点重新推一遍**，生成出来的永远是同样那 4 条。
    // 一旦这 4 条都被消费掉（过了窗口期），再调多少次都不会有新实例 ——
    // 表现就是「设了每天，第 5 天起就没了，App 和小组件上都找不到」。
    //
    // 现在改成：先扫出这个系列**已经存在**的所有实例，取日期最大的那个当游标，
    // 从它继续往后补。于是窗口可以一轮一轮往前滚，越滚越远，且幂等
    // （已存在的 id 会被跳过）。
    const existing: string[] = [];
    /** 已存在的实例里最大的 repeatSeq —— 「按次数结束」靠它判断还能不能继续 */
    let maxSeq = 0;
    for (const o of Object.values(state.tasks)) {
      if (!o || o.deleted) continue;
      if (seriesRootOf(o) !== root) continue;
      if (o.date) existing.push(o.date);
      if ((o.repeatSeq ?? 0) > maxSeq) maxSeq = o.repeatSeq ?? 0;
    }
    existing.sort();

    /* ⚠️ **窗口已满就直接跳过，按缺口补而不是固定补 N 次**（2026-10-14 修）。
     * - 跳过：否则每次调用都再往后推 LOOKAHEAD 次，窗口无限膨胀（每天重复
     *   一个月能攒几百条同一条任务）。
     * - 按缺口：补的数量 = 窗口目标 − 当前未完成数。固定补 N 次的话，
     *   消费掉 1 条就补 14 条、净增 13，窗口反而越滚越大。
     *
     * 只数**未完成且今天及以后**的：已完成的表示「这一次已经消费掉了」，
     * 不该继续占着窗口；过去的实例同理（用户不回头看历史）。 */
    let futureCount = 0;
    for (const o of Object.values(state.tasks)) {
      if (!o || o.deleted || o.done) continue;
      if (seriesRootOf(o) !== root) continue;
      if (o.date && o.date >= today) futureCount++;
    }
    const need = REPEAT_LOOKAHEAD - futureCount;
    if (need <= 0) continue;

    /* 游标取**全部**实例（含已完成）里最远的那天。
     *
     * 试过用「未完成的最远」，结果补不齐：完成掉的那些 id 仍占在
     * `state.tasks` 里，游标又退回到它们之前，推出来的 id 全都撞上已存在
     * 的实例被跳过 —— 实测「完成 1 条 → 只补出 0 条」，缺口永远填不上。
     * 用最远的（含已完成）才能保证每次都往**全新的**日期上走。 */
    let cursor = existing.length ? existing[existing.length - 1] : (t.date || today);
    /* seq 取**已存在的最大 repeatSeq**，不是实例个数（2026-10-14 修）。
     *
     * 用 `existing.length` 看着等价，其实不对：预生成已经把未来几次铺满了，
     * 于是库里躺着 N 条、seq 也就是 N，「按N 次结束」会被预生成的这些占满 ——
     * 用户勾选一次想再要下下一次时，发现次数已经用完，派生不出来
     * （实测 end.count=1 的系列，勾选后 seq 从 0 跳到 2）。
     * repeatSeq 表达的是「这是第几次发生」，语义上才是对的。 */
    let seq = maxSeq;
    // ⚠️ 游标先**推进一步**再生成（2026-10-14 修）。
    // 原来的写法是「拿最后一个已有日期直接生成」，于是第一天就会造出一个
    // 与系列根**同日期**的实例（根是 10-14，实例也是 10-14）—— 同一天出现
    // 两条一模一样的任务。正确语义：根就是「第一次发生」，实例从第二次开始。
    // 推不到下一步（规则已结束）就没什么可补的。
    let advanced = nextOccurrence(r, cursor, seq);
    if (!advanced) continue;
    cursor = advanced;
    seq += 1;

    // 游标可能还停在今天之前（窗口内但今天的实例尚未生成），先推到今天或之后
    if (cursor < today) {
      let reached = false;
      for (let guard = 0; guard < 800; guard++) {
        const nxt = nextOccurrence(r, cursor, seq);
        if (!nxt) break;
        cursor = nxt;
        seq += 1;
        if (nxt >= today) { reached = true; break; }
      }
      if (!reached) continue;
    }

    // 从游标往后补，直到「今天起至少还有 LOOKAHEAD 次」为止。
    // 为什么要看剩余量而不是固定补 N 次：已经攒了 20 条实例时再补 4 条毫无意义，
    // 只有把窗口维持住才是对的。
    let made = 0;
    for (let i = 0; i < need; i++) {
      const id = instanceId(root, cursor);
      if (!state.tasks[id]) {
        const occ = makeTask({
          id, calId: t.calId, title: t.title, note: t.note,
          date: cursor, time: t.time, duration: t.duration,
          repeat: r, repeatSeq: seq, seriesId: root,
          order: null, ord: null, createdAt: now, source: t.source ?? null,
        });
        occ.reminder = t.reminder ?? null;
        state.tasks[id] = occ;
        items.push({ entity: 'task', id, calId: t.calId, fields: dataOf(occ) });
        made++;
      }
      const nxt = nextOccurrence(r, cursor, seq);
      if (!nxt) break;
      cursor = nxt;
      seq += 1;
    }
  }
  if (items.length) commitMany(items);
}

/** base 之后的下一次发生日（含结束条件判断）。seq = 已推进的次数 */
function nextOccurrence(rule: RepeatRule, base: string, seq: number): string | null {
  const next = repeatAdvance(rule, base);
  if (!next) return null;
  const end = rule.end;
  if (end) {
    if (end.type === 'date' && end.date && next > end.date) return null;
    if (end.type === 'count' && seq + 1 > (end.count || 0)) return null;
  }
  return next;
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
  // 改了重复规则 → 重新补齐未来实例（幂等）
  if ('repeat' in fields) ensureRepeatOccurrences();
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

/** 把任务挂到项目上（`null` = 摘下来）。归属**只在详情里改**，拖拽不改它 */
export function setTaskProject(taskId: string, projectId: string | null): void {
  if (!state.tasks[taskId]) return;
  commit('task', taskId, { projectId: projectId || null });
}

/**
 * 泳道列之间的移动。`done` 那一列走 `toggleTask`（**不是**直接写 done 字段）——
 * 重复任务要靠它推进系列，绕过它会让「每週一次」这类任务勾完就不见了。
 */
export function setTaskDoing(taskId: string, doing: boolean): void {
  const t = state.tasks[taskId];
  if (!t) return;
  if (t.done) {
    // 从「已完成」列拖出来：先取消完成，再按目标列决定 doing。
    // toggleTask 自己会 commit，这里的 doing 跟随其后 —— 两条 op、两个字段，
    // 顺序无所谓（LWW 是逐字段的，它们不冲突）。
    toggleTask(taskId);
    if (doing) commit('task', taskId, { doing: true });
    return;
  }
  commit('task', taskId, { doing });
}
/**
 * 回归测试：删除重复任务时的系列语义（用户 2026-10-14 要求）。
 *
 * 用户原话：「当我删除某一个重复的任务的时候，应该弹出来一个弹框问我是
 * 删当天这个任务，还是删除日后所有的重复任务」。
 *
 * 确认后的语义：
 *   · **只删这一次** → 删掉这条，系列规则保留，明天的下一次照常出现
 *   · **从这次起全部** → 删掉系列根+ 从这一天起往后所有实例，
 *     这一天之前已完成的历史保留
 *
 * 本测试盯住最容易出错的两点：
 *   1. 删单次后，窗口补齐**不能把它又造出来**（否则「只删这次」等于没删）
 *   2. 删往后全部后，**不能**又被补齐出一堆未来的（系列已经结束）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => mem.has(k) ? mem.get(k) : null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};

const store = await import('./store.ts');
const D = await import('../domain/date.ts');
const { makeTask } = await import('../domain/model/make.ts');
const { ensureRepeatOccurrences } = await import('./store/tasks.ts');

const CAL = 'cal-1';

function fresh(): void {
  mem.clear();
  store.resetLocal();
  store.setCals([{ id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' }]);
}

function seedDaily(baseDay: string): string {
  const t = makeTask({
    calId: CAL, title: '每天', date: baseDay, time: null,
    repeat: { unit: 'day', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null },
  });
  return store.addTask(t);
}

/** 系列里活着的（未删除）实例，按日期排 */
function alive(rootId: string) {
  return Object.values(store.get().tasks)
    .filter((t) => t.seriesId === rootId && t.id !== rootId && !t.deleted)
    .map((t) => t.date as string)
    .sort();
}

test('只删这一次：删掉后窗口补齐不能把它造回来', () => {
  fresh();
  const base = D.today();
  const root = seedDaily(base);
  const before = alive(root);
  console.log('  删前实例:', before.join(', '));
  const target = before[3];
  assert.ok(target, '应有足够实例可删');

  store.deleteOne(root, target, 'test');
  const afterDelete = alive(root);
  console.log(`  删掉 ${target} 后:`, afterDelete.join(', '));
  assert.ok(!afterDelete.includes(target), '被删的那次不该再出现在活跃实例里');

  // 关键：补齐跑一遍，它不能复活
  ensureRepeatOccurrences();
  const afterRefill = alive(root);
  console.log('  补齐后:', afterRefill.join(', '));
  assert.ok(!afterRefill.includes(target),
    `被删除的 ${target} 被窗口补齐重新生成了 —— 「只删这一次」等于没删`);

  // 但系列还在：明天的下一次应该照常存在
  assert.ok(afterRefill.length > 0, '系列规则应保留，仍应有未来的实例');
});

test('从这次起全部：系列结束，不再补出未来的', () => {
  fresh();
  const base = D.today();
  const root = seedDaily(base);
  const before = alive(root);
  const target = before[2];
  console.log('  删前实例:', before.join(', '));

  store.deleteSeriesFrom(root, target, 'test');

  const after = Object.values(store.get().tasks)
    .filter((t) => t.seriesId === root && !t.deleted && t.id !== root)
    .map((t) => t.date as string).sort();
  console.log(`  从 ${target} 起全删后，剩余活跃实例:`, after.join(', ') || '(无)');
  assert.ok(after.every((d) => d < target), `${target} 及之后的都该被删掉`);

  // 根也要处理：否则系列还在，refillAll/refill 会重新派生
  ensureRepeatOccurrences();
  const afterRefill = Object.values(store.get().tasks)
    .filter((t) => t.seriesId === root && !t.deleted && t.id !== root)
    .map((t) => t.date as string).sort();
  console.log('  补齐后:', afterRefill.join(', ') || '(无)');
  assert.ok(!afterRefill.some((d) => d >= target),
    `系列已从 ${target} 起结束，补齐不该再造出 ${target} 及之后的实例`);
});

test('从这次起全部：过去已完成的保留', () => {
  fresh();
  const base = D.today();
  const root = seedDaily(base);

  // 把前两天的实例标成完成（模拟历史）
  const early = alive(root).slice(0, 2);
  for (const task of Object.values(store.get().tasks)) {
    if (task.seriesId === root && task.date && early.includes(task.date)) task.done = true;
  }
  const all = alive(root);
  const target = all[all.length - 1];
  console.log('  删前:', all.join(', '), ' 目标:', target);

  store.deleteSeriesFrom(root, target, 'test');

  const remain = Object.values(store.get().tasks)
    .filter((t) => t.seriesId === root && !t.deleted && t.id !== root)
    .map((t) => t.date as string).sort();
  console.log('  删后:', remain.join(', '));
  for (const d of early) {
    assert.ok(remain.includes(d), `${d} 是已完成的历史，不该被删`);
  }
});

test('【边界】删「系列根」那一次：只删这次后系列必须继续', () => {
  fresh();
  const base = D.today();
  const root = seedDaily(base);
  console.log('  根:', root, '日期:', store.get().tasks[root].date);
  console.log('  删前实例:', alive(root).join(', '));

  // 删根自己那一天 —— 它就是「第一次发生」
  store.deleteOne(root, base, 'test');
  console.log('  根 deleted =', store.get().tasks[root].deleted);

  ensureRepeatOccurrences();
  const after = alive(root);
  console.log('  补齐后实例:', after.join(', ') || '(无)');

  assert.ok(after.length > 0,
    '删掉系列根那一次后，系列必须继续派生 —— 否则用户选「只删这一次」等于把整个系列删了');
});

test('【边界】勾完成「系列根」那一次后，系列仍要继续补窗口', () => {
  fresh();
  const base = D.today();
  const root = seedDaily(base);

  // 完成第一次发生（根）。旧实现会因为「跳过 done 的根」而彻底停止补齐。
  store.get().tasks[root].done = true;
  ensureRepeatOccurrences();

  const after = alive(root);
  console.log('  完成根后，活跃实例:', after.length, '条，最远', after[after.length - 1]);
  assert.ok(after.length > 0,
    '完成第一次发生不该让整个系列停止 —— 那会让打卡式使用（每天勾一次）在第 14 天后断掉');
});

test('【自愈】repeatUntil 到达后，落在结束日及以后的实例要被清掉', () => {
  fresh();
  const base = D.today();
  const root = seedDaily(base);
  const before = alive(root);
  console.log('  初始实例:', before.join(', '));

  // 模拟「小组件那边结束了系列，标记同步过来」——只落标记，不动实例
  const cut = before[2];
  store.get().tasks[root].repeatUntil = cut;
  console.log('  落下标记 repeatUntil =', cut);

  store.enforceRepeatUntil();

  const after = alive(root);
  console.log('  清理后:', after.join(', ') || '(无)');
  assert.ok(!after.some((d) => d >= cut), `${cut} 及之后的都该被清掉`);
  assert.ok(after.length > 0 && after.every((d) => d < cut), '结束日之前的历史要留');
});

test('【自愈】之后 window 补齐不能再把已结束的系列补回来', () => {
  fresh();
  const base = D.today();
  const root = seedDaily(base);
  const cut = alive(root)[2];
  store.get().tasks[root].repeatUntil = cut;
  store.enforceRepeatUntil();
  const afterSweep = alive(root);

  store.ensureRepeatOccurrences();
  const afterRefill = alive(root);
  console.log(`  标记=${cut} 清理后 ${afterSweep.length} 条，补齐后 ${afterRefill.length} 条`);
  assert.deepEqual(afterRefill, afterSweep, '补齐不该改动已结束系列的任何东西');
});

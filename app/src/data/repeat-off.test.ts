/**
 * 回归测试：把重复任务改成「不重复」时，已经排进日程的那些怎么办
 * （用户 2026-10-17 报：「修改它的重复类型为不重复之后，这个日程表上
 * 已经纳入日程范围的重复任务并没有随之消失」）。
 *
 * 语义：
 *   · keep   → 未来实例变成独立任务留在原处（清掉 repeat 与 seriesId，不再派生）
 *   · delete → 未来实例进回收站，只留这一次 + 过去的历史
 *   · 正在编辑的那一条永远不动；过去的发生也不动
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { RepeatRule } from '../domain/types.ts';

const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};

const store = await import('./store.ts');
const D = await import('../domain/date.ts');
const { makeTask } = await import('../domain/model/make.ts');
const { ensureRepeatOccurrences, dropRepeatTail } = await import('./store/tasks.ts');

const CAL = 'cal-1';
const DAY_REPEAT: RepeatRule = { unit: 'day', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null };

function fresh(): void {
  mem.clear();
  store.resetLocal();
  store.setCals([{ id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' }]);
}

/** 建一条每天重复的系列，返回根 id */
function seedDaily(baseDay: string): string {
  const t = makeTask({ calId: CAL, title: '每天', date: baseDay, time: null, repeat: DAY_REPEAT });
  return store.addTask(t);
}

const all = () => Object.values(store.get().tasks);

function family(root: string) {
  return all()
    .filter((t) => t.seriesId === root || t.id === root)
    .sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? -1 : 1));
}

test('保留：未来实例变成独立任务（清掉重复与系列归属），且不再派生', () => {
  fresh();
  const today = D.today();
  const root = seedDaily(today);
  const before = family(root).filter((t) => !t.deleted && t.id !== root);
  assert.ok(before.length > 5, `前提：应先铺出若干实例，实际 ${before.length}`);

  // 模拟 UI：先把这条任务自己的重复清掉，再处理「已经排好的」
  store.patchTask(root, { repeat: { ...DAY_REPEAT, unit: 'none' } });
  const n = dropRepeatTail(root, today, 'keep');
  assert.equal(n, before.length, `应处置 ${before.length} 条，实际 ${n}`);

  for (const t of before) {
    const cur = store.get().tasks[t.id];
    assert.equal(cur.deleted, undefined, `${t.id} 不该被删`);
    assert.equal(cur.repeat.unit, 'none', `${t.id} 的重复规则应清空（否则它自己还会派生）`);
    assert.equal(cur.seriesId, null, `${t.id} 应脱离系列`);
    assert.equal(cur.date, t.date, `${t.id} 的日期不该变`);
  }

  // 再跑一遍补齐：不该长出新实例（根和实例都不再是重复任务）
  ensureRepeatOccurrences();
  const liveAll = all().filter((t) => !t.deleted);
  assert.equal(liveAll.length, before.length + 1,
    '补齐不该新增实例（根 + 保留的那些）；保留后它们已不是 seriesId 成员，要按总数数');
});

test('删除：未来实例进回收站，但不动这一条和过去的历史', () => {
  fresh();
  const today = D.today();
  const root = seedDaily(today);
  const members = family(root).filter((t) => !t.deleted && t.id !== root);
  // 把前三天标成「过去」比较容易观察：用 fromDate = 今天 + 3
  const cut = D.addDays(today, 3);

  const future = members.filter((t) => (t.date ?? '') >= cut);
  const kept = members.filter((t) => (t.date ?? '') < cut);
  assert.ok(future.length > 0 && kept.length > 0, '前提：两边都要有实例');

  store.patchTask(root, { repeat: { ...DAY_REPEAT, unit: 'none' } });
  const n = dropRepeatTail(root, cut, 'delete');
  assert.equal(n, future.length, `应删 ${future.length} 条，实际 ${n}`);

  for (const t of future) {
    const cur = store.get().tasks[t.id];
    assert.equal(cur.deleted, true, `${t.date} 应被删`);
    assert.equal(cur.trashFrom, '取消重复');
  }
  for (const t of kept) {
    assert.ok(!store.get().tasks[t.id].deleted, `${t.date} 是 cut 之前的，不该删`);
  }
  assert.ok(!store.get().tasks[root].deleted, '系列根（正在编辑的这条）永远不删');

  ensureRepeatOccurrences();
  const live = family(root).filter((t) => !t.deleted);
  assert.equal(live.length, kept.length + 1, '补齐不该把删掉的造回来');
});

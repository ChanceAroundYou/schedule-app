/**
 * 批量管理（2026-10-14）。用户要求：逾期 / 待办箱 / 已完成 三个列表要能
 * 批量完成、批量删除。
 *
 * 入口是列表顶部的「选择」按钮 —— 不是长按。触屏上「按住 480ms」已经被
 * 拖拽排序占用（dnd-kit TouchSensor delay），那三个列表都开着拖拽，
 * 同一个手势不能既拖又选。
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

const CAL = 'cal-1';

function fresh(): void {
  mem.clear();
  store.resetLocal();
  store.setCals([{ id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' }]);
}

function add(title: string, date: string | null, repeat: unknown = null): string {
  return store.addTask(makeTask({
    calId: CAL, title, date, time: null, repeat: repeat as never,
  }));
}

test('选择态：进入 / 勾选 / 取消 / 全选，且用 null 区分「没在多选」', () => {
  fresh();
  const a = add('A', D.today());
  const b = add('B', D.today());

  assert.equal(store.get().ui.sel, null, '默认不在多选');

  store.selStart();
  assert.deepEqual(store.get().ui.sel, [], '进入多选后是空数组，不是 null —— 这个区别是刻意的');

  store.selToggle(a);
  assert.deepEqual(store.get().ui.sel, [a]);
  store.selToggle(b);
  assert.deepEqual(store.get().ui.sel, [a, b]);
  store.selToggle(a);
  assert.deepEqual(store.get().ui.sel, [b], '再点一次要取消选中');

  store.selAll([a, b]);
  const picked = (store.get().ui.sel ?? []).slice().sort();
  assert.deepEqual(picked, [a, b].sort(), '全选');
  store.selAll([a, b]);
  assert.deepEqual(store.get().ui.sel, [], '已全选时再点 = 全不选');

  store.selCancel();
  assert.equal(store.get().ui.sel, null);
});

test('批量完成：一次改多条，且已完成的不重复写', () => {
  fresh();
  const a = add('A', D.today());
  const b = add('B', D.today());
  const c = add('C', D.today());
  store.toggleTask(c);   // C 先完成

  const n = store.batchSetDone([a, b, c], true);
  console.log(`  批量完成 3 条（其中 1 条已完成）→ 实际改动 ${n} 条`);
  assert.equal(n, 2, '已经完成的不该再写一次');
  const ts = store.get().tasks;
  assert.ok(ts[a].done && ts[b].done && ts[c].done);
});

test('批量取消完成：把已完成的还原', () => {
  fresh();
  const a = add('A', D.today());
  const b = add('B', D.today());
  store.toggleTask(a);
  store.toggleTask(b);

  const n = store.batchSetDone([a, b], false);
  assert.equal(n, 2);
  const ts2 = store.get().tasks;
  assert.ok(!ts2[a].done && !ts2[b].done);
});

test('批量完成重复任务：只改状态，不误删系列', () => {
  fresh();
  const root = add('每天', D.today(), { unit: 'day', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null });
  const occIds = Object.values(store.get().tasks)
    .filter((t) => t.seriesId === root && t.id !== root).map((t) => t.id);
  assert.ok(occIds.length > 0, '重复任务应有预生成实例');

  const n = store.batchSetDone([root, ...occIds.slice(0, 2)], true);
  console.log(`  批量完成系列根 + 2 个实例 → 改动 ${n} 条`);
  assert.equal(n, 3);
  // 系列必须还活着（批量完成不等于删系列）
  store.enforceRepeatUntil();
  const alive = Object.values(store.get().tasks)
    .filter((t) => t.seriesId === root && !t.deleted);
  assert.ok(alive.length >= 3, '系列不该因为批量完成而消失');
});

test('批量删除：软删除进回收站，可还原', () => {
  fresh();
  const a = add('A', D.today());
  const b = add('B', D.today());
  const c = add('C', D.today());

  const n = store.batchDelete([a, b]);
  console.log(`  批量删除 2 条 → 实际 ${n} 条`);
  assert.equal(n, 2);
  const ts3 = store.get().tasks;
  assert.ok(ts3[a].deleted && ts3[b].deleted);
  assert.ok(!ts3[c].deleted, '没选中的不能被牵连');

  // 回收站语义：还能还原
  store.restoreTask(a);
  assert.ok(!store.get().tasks[a].deleted, '还原后不该还是删除态');
});

test('批量删除已经删过的：不重复计入', () => {
  fresh();
  const a = add('A', D.today());
  store.deleteTask(a);
  const n = store.batchDelete([a]);
  assert.equal(n, 0, '已经是删除态的不该再算一条');
});

test('批量删除重复实例：只删被选中的那几次，系列继续', () => {
  fresh();
  const root = add('每天', D.today(), { unit: 'day', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null });
  const occIds = Object.values(store.get().tasks)
    .filter((t) => t.seriesId === root && t.id !== root).map((t) => t.id).sort();
  const victims = occIds.slice(0, 3);

  store.batchDelete(victims, '批量删除');
  for (const v of victims) {
    assert.ok(store.get().tasks[v].deleted, `${v} 应被删除`);
  }
  // 补窗口后系列仍在（删的是几次，不是系列）
  store.ensureRepeatOccurrences();
  const alive = Object.values(store.get().tasks)
    .filter((t) => t.seriesId === root && !t.deleted && t.id !== root);
  console.log(`  删 3 次后，活跃实例 ${alive.length} 条，最远 ${alive.map((t) => t.date).sort().pop()}`);
  assert.ok(alive.length > 0, '批量删几次不该把整个系列删掉');
});

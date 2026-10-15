/**
 * 重复任务「预生成未来实例」的专项测试。
 *
 * 单独一个文件是因为它有自己的一套 localStorage 垫片，跟 store.test.ts
 * 互不干扰；出问题时要能一眼看出是「没生成」还是「生成了但日期不对」。
 *
 *   cd app && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

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

const TODAY = D.today();
const CAL = 'cal-1';

function fresh(): void {
  mem.clear();
  store.resetLocal();
  store.setCals([{ id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' }]);
  store.setActiveCal(CAL);
}

function spawnedOf(root: string): { id: string; date: string; done: boolean }[] {
  return Object.values(store.get().tasks)
    .filter((t) => t.seriesId === root && t.id !== root)
    .map((t) => ({ id: t.id, date: t.date as string, done: t.done }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

test('每天重复 → 未来几天都有实例', () => {
  fresh();
  const root = store.addTask({ title: '每天', date: TODAY, repeat: { unit: 'day', n: 1 } });
  const sp = spawnedOf(root);
  console.log(`[每天] today=${TODAY} 生成 ${sp.length} 条:`, sp.map((x) => x.date).join(', '));
  assert.ok(sp.length > 0, '应该预生成未来实例');
  assert.equal(sp[0].date, D.addDays(TODAY, 1), '第一次应落在明天');
});

test('每周三重复 → 下一个周三有实例', () => {
  fresh();
  // 找一个「周三」当基准；不是就顺延到下一个周三再建
  let base = TODAY;
  for (let i = 0; i < 8; i++) {
    if (D.weekdayOf(base) === 3) break;
    base = D.addDays(base, 1);
  }
  const root = store.addTask({
    title: '每周三', date: base, repeat: { unit: 'week', n: 1, weekdays: [3] },
  });
  const sp = spawnedOf(root);
  console.log(`[每周三] base=${base}(周${D.weekdayOf(base)}) 生成 ${sp.length} 条:`, sp.map((x) => x.date).join(', '));
  assert.ok(sp.length > 0, '每周重复也应该预生成');
  assert.equal(sp[0].date, D.addDays(base, 7), '下一个周三');
});

test('工作日重复 → 只落在周一到周五', () => {
  fresh();
  const root = store.addTask({
    title: '工作日', date: TODAY, repeat: { unit: 'week', n: 1, weekdays: [1, 2, 3, 4, 5] },
  });
  const sp = spawnedOf(root);
  console.log(`[工作日] 生成 ${sp.length} 条:`, sp.map((x) => `${x.date}(周${D.weekdayOf(x.date)})`).join(', '));
  assert.ok(sp.length > 0);
  for (const x of sp) {
    const wd = D.weekdayOf(x.date);
    assert.ok(wd >= 1 && wd <= 5, `${x.date} 不该是周末`);
  }
});

test('按次数结束：次数用满就不再生成', () => {
  fresh();
  const root = store.addTask({
    title: '只三次', date: TODAY,
    repeat: { unit: 'day', n: 1, weekdays: [], monthday: 1, end: { type: 'count', count: 3 } },
  });
  const sp = spawnedOf(root);
  console.log(`[按次数3] 生成 ${sp.length} 条:`, sp.map((x) => x.date).join(', '));
  // 口径与 App 的 repeatNext 一致：`(repeatSeq)+1 <= end.count` 才派生，
  // 所以 count=3 时序列是 seq 0(根) 1 2 3 —— 根之外再生成 3 条。
  assert.ok(sp.length <= 3, `count=3 至多再生成 3 条，实际 ${sp.length}`);
});

test('幂等：再调一次不会重复生成', () => {
  fresh();
  const root = store.addTask({ title: '每天', date: TODAY, repeat: { unit: 'day', n: 1 } });
  const first = spawnedOf(root).length;
  store.patchTask(root, { repeat: { unit: 'day', n: 1, weekdays: [], monthday: 1, end: null } });
  const second = spawnedOf(root).length;
  console.log(`[幂等] 第一次 ${first} 条，patch 后 ${second} 条`);
  assert.equal(second, first, '重复调用不应变多');
});
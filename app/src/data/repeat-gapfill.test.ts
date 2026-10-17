/**
 * 回归测试：2026-10-17 用户报的两个重复任务缺陷。
 *
 * ① 「每周五六重复只显示周六」（#105b）：
 *    窗口早在规则还是 [周六] 的时候就铺满了 14 条周六，用户后来补选周五，
 *    `need = 窗口目标 − 现有数` 一直是 0，而按缺口补只会从最远实例**往后**
 *    推 —— 中间的周五永远回不来。修法：按当前规则走一遍「锚点 → 最远实例」，
 *    缺一个洞补一个（create-only，不动已有实例）。
 *
 * ② 「全部删除只删了当天」（#104）：
 *    小组件改实例 repeat 时把家族重新挂到实例 id 上，血脉裂成多层
 *    （seriesId 指向中间层 / 整个缺失）。单路按 seriesId 收集的删除只能
 *    删掉一支主轴，旁支漏网，过两天又被窗口补齐造回来。
 *    修法：seriesRootOf 改成**形状优先**（id 带 # 就以 # 前的为真根），
 *    三端（app / server / widget）同一口径。
 *
 * 本测试盯住：补洞会把周五补出来、缩水会清掉残留、裂开的血脉删得干净、
 * 以及两道不能误伤的保护（手动拖拽过的、已完成的）。
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
const { makeTask } = await import('../domain/model/make.ts');
const { ensureRepeatOccurrences, REPEAT_LOOKAHEAD } = await import('./store/tasks.ts');

const CAL = 'cal-1';

function fresh(): void {
  mem.clear();
  store.resetLocal();
  store.setCals([{ id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' }]);
}

/** 从今天起找下一个周五当锚点（用户的真实场景：周五建的任务） */
function nextFriday(): string {
  let d = D.today();
  for (let i = 0; i < 7; i++) {
    if (D.weekdayOf(d) === 5) return d;
    d = D.addDays(d, 1);
  }
  return d;
}

/** 系列里活着的实例日期（不含根本身） */
function alive(rootId: string): string[] {
  return Object.values(store.get().tasks)
    .filter((t) => t.seriesId === rootId && t.id !== rootId && !t.deleted)
    .map((t) => t.date as string)
    .sort();
}

const WEEK_RULE = { unit: 'week', n: 1, weekdays: [6], monthday: 1, yearMonth: 1, end: null } as const;

test('【#105b】补选周五后，周五必须出现在视图上（按洞补，不是等窗口滚过去）', () => {
  fresh();
  const base = nextFriday();
  const root = store.addTask({ title: '美团领卡', date: base, repeat: WEEK_RULE });

  // 窗口已被旧规则 [周六] 铺满：需要 = 窗口 − 1（根自己占一格）
  const before = alive(root);
  console.log(`  初始窗口（规则 [周六]）: ${before.length} 条，全是周${before.map((d) => D.weekdayOf(d)).join('')}`);
  assert.equal(before.length, REPEAT_LOOKAHEAD - 1, '初始应铺满窗口');
  assert.ok(before.every((d) => D.weekdayOf(d) === 6), '旧规则 [周六] 铺出来的应全是周六');

  // 用户随后补选周五 → [5, 6]
  store.patchTask(root, { repeat: { ...WEEK_RULE, weekdays: [5, 6] } });

  const after = alive(root);
  const fridays = after.filter((d) => D.weekdayOf(d) === 5);
  console.log(`  改规则 [周五、周六] 后: ${after.length} 条，其中周五 ${fridays.length} 条`);
  assert.ok(fridays.length > 0,
    '补选周五后 Friday 必须出现 —— 只按 need 补的话窗口已满、周五永远不来');
  assert.ok(fridays.includes(D.addDays(base, 7)), '第一个周五（锚点+7）必须补出来');
  assert.ok(after.some((d) => D.weekdayOf(d) === 6), '原有的周六要保留');

  // 幂等：再跑一遍不该变多
  ensureRepeatOccurrences();
  assert.deepEqual(alive(root), after, '重复调用不应新增实例');
});

test('【#105b】规则缩水：不再符合的未来实例要被清掉（周五六 → 只要周五）', () => {
  fresh();
  const base = nextFriday();
  const root = store.addTask({ title: '周五六', date: base, repeat: { ...WEEK_RULE, weekdays: [5, 6] } });

  const before = alive(root);
  assert.ok(before.some((d) => D.weekdayOf(d) === 5), '改之前周五应在');
  assert.ok(before.some((d) => D.weekdayOf(d) === 6), '改之前周六应在');

  // 用户取消周六 → 只要周五
  store.patchTask(root, { repeat: { ...WEEK_RULE, weekdays: [5] } });

  const after = alive(root);
  console.log(`  缩水成 [周五] 后剩余: ${after.length} 条`, after.map((d) => `周${D.weekdayOf(d)}`).join(' '));
  assert.ok(after.length > 0, '周五的要保留');
  assert.ok(after.every((d) => D.weekdayOf(d) === 5), '未来的周六残留必须清掉');
  assert.ok(!store.get().tasks[root].deleted, '系列根不能被误删');
  assert.equal(store.get().tasks[root].repeatUntil ?? null, null, '没删系列，不该落下结束标记');
});

test('【#105b】保护：手动拖拽过日期的实例不算规则残留', () => {
  fresh();
  const base = nextFriday();
  const root = store.addTask({ title: '周五六', date: base, repeat: { ...WEEK_RULE, weekdays: [5, 6] } });
  const sats = alive(root).filter((d) => D.weekdayOf(d) === 6);
  assert.ok(sats.length > 0, '应有周六实例');

  // 用户把第一个周六拖到了周日（id 里编码的原发生日不变，date 变了）
  const draggedId = root + '#' + sats[0];
  const dragged = store.get().tasks[draggedId];
  assert.ok(dragged, '应能按派生 id 找到那个周六实例');
  dragged.date = D.addDays(sats[0], 1);

  store.patchTask(root, { repeat: { ...WEEK_RULE, weekdays: [5] } });

  assert.ok(!store.get().tasks[draggedId].deleted,
    '被手动拖拽过日期的实例不能被当残留删掉 —— 那是用户挪的，不是规则变的');
  const after = alive(root);
  assert.ok(after.every((d) => D.weekdayOf(d) === 5 || d === D.addDays(sats[0], 1)),
    '除被拖走的那条，未来的周六都该清掉');
});

test('【#105b】保护：已完成的发生不算规则残留', () => {
  fresh();
  const base = nextFriday();
  const root = store.addTask({ title: '周五六', date: base, repeat: { ...WEEK_RULE, weekdays: [5, 6] } });
  const sats = alive(root).filter((d) => D.weekdayOf(d) === 6);
  const doneSat = store.get().tasks[root + '#' + sats[0]];
  doneSat.done = true;

  store.patchTask(root, { repeat: { ...WEEK_RULE, weekdays: [5] } });

  assert.ok(!store.get().tasks[root + '#' + sats[0]].deleted,
    '已完成的未来发生是用户真做过的，不能当残留删');
});

test('【#104】血脉裂成多层的系列：从这次起全部要连旁支一起删干净', () => {
  fresh();
  const base = D.today();
  const root = store.addTask({ title: '55', date: base, repeat: { unit: 'day', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null } });
  ensureRepeatOccurrences();
  const days = alive(root);
  console.log(`  初始实例 ${days.length} 条:`, days[0], '…', days[days.length - 1]);
  assert.ok(days.length >= 6, '要有足够实例可构造场景');

  const rule = store.get().tasks[root].repeat;
  // 变异①：中间层实例的 seriesId 指向自己（小组件改 repeat 时 re-root 的产物）
  const midId = root + '#' + days[1];
  store.get().tasks[midId].seriesId = midId;
  // 它的子嗣：id 带两层日期段，seriesId 指向中间层
  const grandId = midId + '#' + D.addDays(base, 20);
  store.get().tasks[grandId] = makeTask({
    id: grandId, calId: CAL, title: '55', date: D.addDays(base, 20),
    repeat: rule, seriesId: midId,
  });
  // 变异②：seriesId 整个缺失的实例
  store.get().tasks[root + '#' + days[2]].seriesId = null;

  const cut = days[4];
  store.deleteSeriesFrom(root, cut, 'test');
  console.log(`  从 ${cut} 起全部删除`);
  ensureRepeatOccurrences();

  const future = Object.values(store.get().tasks)
    .filter((t) => !t.deleted && t.date && t.date >= cut);
  console.log(`  删除+补齐后仍活在 ${cut} 及以后的任务:`, future.map((t) => t.id));
  assert.equal(future.length, 0,
    '旁支（中间层子嗣 / 缺 seriesId 的实例）也必须删掉 —— 漏一支就会一直被窗口造回来');
  assert.equal(store.seriesEndOf(root), cut, '结束标记要落在家族真根上');
});

test('【#104】根不在本机（别的设备建的系列）：标记改写到存活成员，同样生效', () => {
  fresh();
  const base = D.today();
  const root = store.addTask({ title: '55', date: base, repeat: { unit: 'day', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null } });
  ensureRepeatOccurrences();
  const days = alive(root);
  assert.ok(days.length >= 4);

  // 模拟「系列根从来没同步到本机」：把根从本地状态里抹掉
  delete store.get().tasks[root];

  const cut = days[2];
  store.deleteSeriesFrom(root, cut, 'test');
  ensureRepeatOccurrences();

  const future = Object.values(store.get().tasks)
    .filter((t) => !t.deleted && t.date && t.date >= cut);
  assert.equal(future.length, 0, '没有根也要能结束系列');
  assert.equal(store.seriesEndOf(root), cut, '要能从存活成员身上认出结束标记');
  // 载体必须是「删除范围之前且还活着」的实例：写在即将被删的成员上虽然
  // 墓碑字段也认，但有能活的载体更稳
  const carrier = Object.values(store.get().tasks)
    .find((t) => !t.deleted && t.seriesId === root);
  assert.ok(carrier && carrier.date! < cut,
    `载体应是结束日之前的历史实例，实际 ${carrier?.date}`);
});

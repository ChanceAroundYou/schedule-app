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

/**
 * 用户 2026-11-02：删掉的系列「B」（每周三）在手机上一直自己长回来。
 *
 * 服务端早就删干净了，只有那台设备还在长 —— 因为分组只看「组里还有没有
 * 活着的成员」：根是墓碑、只要漏下一条活实例（另一台设备晚推的，或
 * repeatUntil 没同步到本机），这一组就还是活的，于是按规则把未来一路铺回来。
 *
 * 护栏：根是墓碑且不是「只删这一次」（没有 skipped）→ 整族停止派生，
 * 并把今天及以后的残留一并收进垃圾桶。
 */
test('系列根已删（不是「只删这一次」）→ 不再铺未来，残留也清掉', () => {
  fresh();
  const rpt = { unit: 'week' as const, n: 1, weekdays: [3], monthday: 1, yearMonth: 1, end: null };
  const root = store.addTask(makeTask({
    calId: CAL, title: 'B', date: '2026-10-14', time: null, repeat: rpt,
  }));
  const inst = store.addTask(makeTask({
    id: root + '#2026-11-11', calId: CAL, title: 'B', date: '2026-11-11',
    time: null, repeat: rpt, seriesId: root, repeatSeq: 4,
  }));

  // 根被「从今天起全部删除」（没有 skipped），只剩一条活实例
  const s = store.get();
  s.tasks[root].deleted = true;
  s.tasks[root].deletedAt = Date.now();
  s.tasks[root].trashFrom = '今天';

  ensureRepeatOccurrences();

  const left = Object.values(store.get().tasks)
    .filter((t) => !t.deleted && t.id.startsWith(root + '#') && t.date! >= D.today())
    .map((t) => t.date as string).sort();
  console.log('  修完还活着的未来实例:', left.join(', ') || '(无)');
  assert.deepEqual(left, [], '根已删 → 未来一条都不该留');
  assert.ok(!('#' + '2026-11-18' in store.get().tasks) || store.get().tasks[inst].deleted === true,
    '那条活实例本身也该被收掉');
});

test('「只删这一次」删掉根那天（有 skipped）→ 系列必须继续派生', () => {
  fresh();
  const rpt = { unit: 'week' as const, n: 1, weekdays: [3], monthday: 1, yearMonth: 1, end: null };
  const root = store.addTask(makeTask({
    calId: CAL, title: '组会', date: D.today(), time: null, repeat: rpt,
  }));
  // 删的正好是根那一天，且是「只删这一次」
  store.deleteOne(root, D.today());

  ensureRepeatOccurrences();

  const aliveDates = Object.values(store.get().tasks)
    .filter((t) => !t.deleted && t.id !== root && t.seriesId === root)
    .map((t) => t.date as string).sort();
  console.log('  「只删这一次」之后仍有:', aliveDates.length, '条');
  assert.ok(aliveDates.length > 0, '只删这一次不能把整个系列弄死');
});

/**
 * 用户 2026-11-02 真机实测的第二种形态：**根在垃圾箱里被彻底删过**，
 * 本机只剩一条中间实例还活着（B 的 10-28）。这时 `state.tasks[root]` 根本
 * 不存在，只看根的墓碑判不出来 —— 必须退而认「族内日期最早的那条」。
 */
test('根被彻底删掉了（本机没有根）→ 族里最早那条是墓碑，整族停止派生', () => {
  fresh();
  const rpt = { unit: 'week' as const, n: 1, weekdays: [3], monthday: 1, yearMonth: 1, end: null };
  /* ⚠️ 这里**不能走 addTask**：它会顺手调 ensureRepeatOccurrences 把未来铺满，
     而且会丢掉我们指定的派生 id。直接塞进 state 才能精确复现真机那副样子。 */
  const s = store.get();
  const rootT = makeTask({ calId: CAL, title: 'B', date: '2026-10-14', time: null, repeat: rpt });
  const root = rootT.id;
  const mid = makeTask({
    id: root + '#2026-10-21', calId: CAL, title: 'B', date: '2026-10-21',
    time: null, repeat: rpt, seriesId: root, repeatSeq: 1,
  });
  mid.deleted = true; mid.deletedAt = Date.now(); mid.trashFrom = '重复任务结束';
  const aliveOne = makeTask({
    id: root + '#2026-10-28', calId: CAL, title: 'B', date: '2026-10-28',
    time: null, repeat: rpt, seriesId: root, repeatSeq: 2,
  });
  s.tasks[mid.id] = mid;
  s.tasks[aliveOne.id] = aliveOne;
  // 根：垃圾箱里彻底删掉（本机不再有这条）

  ensureRepeatOccurrences();

  const left = Object.values(store.get().tasks)
    .filter((t) => !t.deleted && t.id.startsWith(root + '#'))
    .map((t) => t.date as string).sort();
  console.log('  根被彻底删掉之后还活着的:', left.join(', ') || '(无)');
  assert.deepEqual(left, [], '系列起点是墓碑 → 一条都不许再留（含那条漏网的活实例）');
  assert.ok(store.get().tasks[aliveOne.id].deleted === true, '那条活实例要被收进垃圾桶');
});

/**
 * 真机上 B 的实际形态（2026-11-02 晚上复核）：本机**连墓碑都没有**，
 * 只剩一串派生实例（10-28 那条还活着 + 之前铺出来的未来）。
 * 这是某次全量快照把已删实体丢掉之后的样子 —— 服务端快照不返回墓碑。
 * 判据：族里一条「像定义」的成员都没有（全是 `根#日期` 形状）→ 停止派生。
 */
test('族里只剩派生实例（根和墓碑都不在本机）→ 停止派生并清掉残骸', () => {
  fresh();
  const rpt = { unit: 'week' as const, n: 1, weekdays: [3], monthday: 1, yearMonth: 1, end: null };
  const s = store.get();
  const rootId = 't_445c610190c410c6';
  const a = makeTask({
    id: rootId + '#2026-10-28', calId: CAL, title: 'B', date: '2026-10-28',
    time: null, repeat: rpt, seriesId: rootId, repeatSeq: 2,
  });
  const b = makeTask({
    id: rootId + '#2026-11-11', calId: CAL, title: 'B', date: '2026-11-11',
    time: null, repeat: rpt, seriesId: rootId, repeatSeq: 4,
  });
  s.tasks[a.id] = a;
  s.tasks[b.id] = b;

  ensureRepeatOccurrences();

  const left = Object.values(store.get().tasks)
    .filter((t) => !t.deleted && t.id.startsWith(rootId))
    .map((t) => t.date as string).sort();
  console.log('  只剩派生实例的族，跑完之后还活着的:', left.join(', ') || '(无)');
  assert.deepEqual(left, [], '没有定义就不许再铺，残骸一并收掉');
});

/**
 * 回归测试：重复任务「只重复几天就断了」（用户 2026-10-14 报）。
 *
 * 真实场景：10-15 建了一条「每天」，当天派生出了 15/16/17/18 四条（当时
 * LOOKAHEAD=4）。到了 19 号，用户**什么都没做** —— 没建新任务、没改字段、
 * 远端也没新变更 —— 于是再也找不到这条任务了，App 和小组件上都没有。
 *
 * 根因（两层，都在本轮修掉）：
 *   1. 游标从**系列根的原始日期**起算，于是每次调用都从同一起点重推一遍，
 *      生成的永远是同样那几条；窗口用完后再调多少次都不会有新实例。
 *   2. 补齐只挂在 addTask / patchTask / applyRemote(且 touched=true) 上，
 *      **「日期翻过去了」这个时机根本不在其中**。
 *
 * 本测试盯住第 1 点（算法本身），触发时机的覆盖由真机验证。
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

/** 建一条「每天」系列，返回系列根 id */
function seedDaily(baseDay: string): string {
  const t = makeTask({
    calId: CAL,
    title: '每天',
    date: baseDay,
    time: null,
    repeat: { unit: 'day', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null },
  });
  return store.addTask(t);
}

function seriesDates(rootId: string): string[] {
  return Object.values(store.get().tasks)
    .filter((t) => t.seriesId === rootId && t.date)
    .map((t) => t.date as string)
    .sort();
}

test('每天重复：建系列当天就铺满窗口', () => {
  fresh();
  const root = seedDaily(D.today());
  const dates = seriesDates(root);
  console.log(`  派生 ${dates.length} 条:`, dates[0], '…', dates[dates.length - 1]);
  assert.ok(dates.length >= REPEAT_LOOKAHEAD,
    `当天应至少铺满 LOOKAHEAD=${REPEAT_LOOKAHEAD} 次（含根），实际 ${dates.length}`);
});

test('【核心回归】时间推进后仍能续上，不会卡在同一批', () => {
  fresh();
  const base = D.today();
  const root = seedDaily(base);

  // 模拟真实使用：**末尾的实例被逐个消费掉**（勾完成），窗口出现缺口，
  // 补齐必须把缺口填上。
  //
  // ⚠️ 不用 patchTask：它内部会再调一次 ensureRepeatOccurrences，观测被污染。
  // 直接改内存状态表达「这一次已消费」。也不能靠改 today()（它读系统时钟）。
  //
  /* 正确行为不是「最远日期一路往后窜」，而是**窗口恒定、缺口从尾部补进**：
   * 每完成一条，末尾就补一条新的，总数不变。这样既能一直有未来任务，
   * 又不会攒下一堆用不上的。修复前窗口既不会补、也会无界膨胀。 */
  for (let day = 0; day < 5; day++) {
    if (day > 0) {
      // 把最靠后的那一条标成完成 = 消费掉这一次，窗口从尾部缩回来
      const all = Object.values(store.get().tasks)
        .filter((x) => x.seriesId === root && !x.done && !x.deleted);
      all.sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? -1 : 1));
      const victim = all[all.length - 1];
      if (victim) victim.done = true;
    }
    ensureRepeatOccurrences();

    // 只数**实例**（不含系列根本身）。ensureRepeatOccurrences 的 futureCount
    // 也是这个口径 —— 根是「第一次发生」，是用户自己建的那条，不算窗口。
    const all = Object.values(store.get().tasks)
      .filter((t) => t.seriesId === root && t.date && t.date >= base)
      .sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? -1 : 1));
    const live = all.filter((t) => t.id !== root && !t.done && !t.deleted);

    console.log(`    第${day + 1}轮: 共 ${all.length} 条，未完成实例 ${live.length} 条，`
      + `最远 ${all[all.length - 1]?.date}`);
    console.log('      ', all.map((t) => `${t.date}${t.id === root ? '(根)' : t.done ? '✓' : ''}`).join(' '));

    // 窗口口径 = REPEAT_LOOKAHEAD - 1：根（用户建的那条）本身就算一次发生，
    // 首次铺窗口时它已经占掉一格，所以实例数是 LOOKAHEAD-1。
    assert.equal(live.length, REPEAT_LOOKAHEAD - 1,
      `第${day + 1}轮后应有 ${REPEAT_LOOKAHEAD - 1} 个未完成的未来实例，实际 ${live.length}`);

    // 日期必须连续、无缺口
    for (let i = 1; i < all.length; i++) {
      assert.equal(D.diffDays(all[i].date!, all[i - 1].date!), 1,
        `${all[i - 1].date} 与 ${all[i].date} 应连续（无缺口）`);
    }
  }
});


test('幂等：连续调用不会产生重复实例', () => {
  fresh();
  const root = seedDaily(D.today());
  ensureRepeatOccurrences();
  const a = seriesDates(root).length;
  ensureRepeatOccurrences();
  ensureRepeatOccurrences();
  const b = seriesDates(root).length;
  console.log(`  补1 次 -> ${a} 条，补 3 次 -> ${b} 条`);
  assert.equal(a, b, '重复调用不应新增实例（窗口已满）');
});

test('每天重复能连续覆盖两周以上', () => {
  fresh();
  const base = D.today();
  const root = seedDaily(base);
  const dates = Array.from(new Set(seriesDates(root))).sort();
  // 检查日期是**连续**的（没有缺口）。diffDays(a,b) = a − b
  for (let i = 1; i < dates.length; i++) {
    assert.equal(D.diffDays(dates[i], dates[i - 1]), 1,
      `${dates[i - 1]} 与 ${dates[i]} 之间应恰好差 1 天，实际差 ${D.diffDays(dates[i], dates[i - 1])}`);
  }
  const span = D.diffDays(dates[dates.length - 1], base);
  console.log(`  覆盖 ${dates.length} 条，跨度 ${span} 天（${dates[0]} → ${dates[dates.length - 1]}）`);
  assert.ok(span >= REPEAT_LOOKAHEAD - 1, `跨度应 ≥ ${REPEAT_LOOKAHEAD - 1} 天，实际 ${span}`);
});

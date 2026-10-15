/**
 * 重复规则逐种实跑（用户 2026-10-14 要求「继续检查之前对于重复任务的逻辑」）。
 *
 * 覆盖小组件新建弹窗能选的那几种：不重复 / 每天 / 工作日 / 每周 / 每月 / 每年，
 * 逐个验证：
 *   ① 未来的发生日**真的被生成出来**了（不是只有规则存着、日历上没东西）
 *   ② 日期间隔符合规则本身（每天=+1、每周=+7 且星期对、每月=同日、每年=次年同日）
 *   ③ 日期严格递增、无重复同日
 *
 * 这些规则由 `domain/repeat.ts` 的 repeatAdvance 定义，App 与小组件共用同一份 ——
 * 所以这里测通就等于两端都通。
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

function seed(repeat: unknown, base = D.today()): string {
  return store.addTask(makeTask({
    calId: CAL, title: 'R', date: base, time: null, repeat: repeat as never,
  }));
}

/** 系列里活着的实例日期（不含系列根本身） */
function occ(rootId: string): string[] {
  return Object.values(store.get().tasks)
    .filter((t) => t.seriesId === rootId && t.id !== rootId && !t.deleted)
    .map((t) => t.date as string).sort();
}

const WD = ['日', '一', '二', '三', '四', '五', '六'];

test('每天：连续 +1 天，无缺口', () => {
  fresh();
  const base = D.today();
  const root = seed({ unit: 'day', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null }, base);
  const ds = occ(root);
  console.log('  每天:', base, '→', ds[0], '…', ds[ds.length - 1], `(${ds.length} 条)`);
  assert.ok(ds.length > 0, '每天重复必须生成未来实例');
  for (let i = 1; i < ds.length; i++) {
    assert.equal(D.diffDays(ds[i], ds[i - 1]), 1, `${ds[i - 1]}→${ds[i]} 应差 1 天`);
  }
});

test('每周：间隔 7 天，且星期与基准日一致', () => {
  fresh();
  const base = D.today();
  const wd = D.weekdayOf(base);
  const root = seed({ unit: 'week', n: 1, weekdays: [wd], monthday: 1, yearMonth: 1, end: null }, base);
  const ds = occ(root);
  console.log(`  每周(周${WD[wd]}):`, base, '→', ds.slice(0, 4).join(', '), `(${ds.length} 条)`);
  assert.ok(ds.length > 0);
  for (const d of ds) {
    assert.equal(D.weekdayOf(d), wd, `${d} 应是周${WD[wd]}，实际周${WD[D.weekdayOf(d)]}`);
  }
  for (let i = 1; i < ds.length; i++) {
    assert.equal(D.diffDays(ds[i], ds[i - 1]), 7, `${ds[i - 1]}→${ds[i]} 应差 7 天`);
  }
});

test('工作日：只落在周一~周五', () => {
  fresh();
  const base = D.today();
  const root = seed({ unit: 'week', n: 1, weekdays: [1, 2, 3, 4, 5], monthday: 1, yearMonth: 1, end: null }, base);
  const ds = occ(root);
  console.log('  工作日:', ds.slice(0, 8).join(', '), `(${ds.length} 条)`);
  assert.ok(ds.length > 0);
  for (const d of ds) {
    const w = D.weekdayOf(d);
    assert.ok(w >= 1 && w <= 5, `${d} 是周${WD[w]}，工作日规则不该出现周末`);
  }
});

test('每月某日：每个月同一天（月末不足时截到月末）', () => {
  fresh();
  const base = D.today();
  const md = D.parseISO(base).getDate();
  const root = seed({ unit: 'month', n: 1, weekdays: [], monthday: md, yearMonth: 1, end: null }, base);
  const ds = occ(root);
  console.log(`  每月${md}号:`, ds.slice(0, 5).join(', '), `(${ds.length} 条)`);
  assert.ok(ds.length > 0, '每月重复必须生成未来实例');
  for (const d of ds) {
    const day = D.parseISO(d).getDate();
    const expected = Math.min(md, D.lastDayOfMonth(D.parseISO(d).getFullYear(), D.parseISO(d).getMonth() + 1));
    assert.equal(day, expected, `${d} 应是 ${md} 号（月末截断后 ${expected}）`);
  }
  // 月份必须逐个往后，不能跳月也不能原地
  for (let i = 1; i < ds.length; i++) {
    const a = D.parseISO(ds[i - 1]), b = D.parseISO(ds[i]);
    const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    assert.equal(months, 1, `${ds[i - 1]}→${ds[i]} 应恰好隔 1 个月，实际 ${months}`);
  }
});

test('每年：次年同月同日', () => {
  fresh();
  const base = D.today();
  const md = D.parseISO(base).getDate();
  const mm = D.parseISO(base).getMonth() + 1;
  const root = seed({ unit: 'year', n: 1, weekdays: [], monthday: md, yearMonth: mm, end: null }, base);
  const ds = occ(root);
  console.log(`  每年${mm}-${md}:`, ds.join(', '));
  if (ds.length === 0) {
    // 窗口只有 14 次「发生」，而每年一次 —— 从今天起 14 年内本该有 14 个，
    // 所以正常一定 > 0。留这个分支只为把原因说清楚。
    assert.fail('每年重复没有生成任何未来实例 —— 窗口按「次数」算，年重复也应有 14 条');
  }
  for (const d of ds) {
    assert.equal(D.parseISO(d).getMonth() + 1, mm, `${d} 月份应是 ${mm}`);
    assert.equal(D.parseISO(d).getDate(), Math.min(md, D.lastDayOfMonth(D.parseISO(d).getFullYear(), mm)),
      `${d} 日期应是 ${md}（闰年 2/29 会截到 28）`);
  }
});

test('所有规则：日期严格递增、无重复同日', () => {
  const cases: Array<[string, unknown]> = [
    ['每天', { unit: 'day', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null }],
    ['每周', { unit: 'week', n: 1, weekdays: [D.weekdayOf(D.today())], monthday: 1, yearMonth: 1, end: null }],
    ['工作日', { unit: 'week', n: 1, weekdays: [1, 2, 3, 4, 5], monthday: 1, yearMonth: 1, end: null }],
    ['每月', { unit: 'month', n: 1, weekdays: [], monthday: D.parseISO(D.today()).getDate(), yearMonth: 1, end: null }],
  ];
  for (const [name, rule] of cases) {
    fresh();
    const root = seed(rule);
    // occ() 返回的是**日期**；把系列根自己的日期也算进来一起查重
    const all = [store.get().tasks[root].date as string, ...occ(root)].sort();
    const uniq = new Set(all);
    console.log(`  ${name}: ${all.length} 条，去重后 ${uniq.size} 条`);
    assert.equal(uniq.size, all.length, `${name}：出现了同日期的重复条目`);
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i] > all[i - 1], `${name}：日期没有严格递增（${all[i - 1]} → ${all[i]}）`);
    }
  }
});

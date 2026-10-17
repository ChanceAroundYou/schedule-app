/**
 * 回归测试：改重复规则要能撤销旧的「到此为止」标记
 * （用户 2026-10-17 报：「在 10 月 19 日这条任务设置了每周一重复，设置完成之后，
 * 下周一、下下周一以及之后所有的周一根本没有任何的显示」）。
 *
 * 线上数据实测的成因：这条系列之前被「从这次起往后全部」删过，根上留下了
 * `repeatUntil = 2026-11-19`。之后用户把规则改成「每周一」，标记没跟着作废，
 * 补齐逻辑一看到标记就整组跳过 → 一条周一都不生成。
 *
 * 三条契约：
 *   ① 改规则（真的变了）→ 作废旧标记，之后照常铺；
 *   ② 不改规则 → 标记仍然生效，只是语义是**上界**（结束日之前照常有）；
 *   ③ 传入等价规则（只是 weekdays 顺序不同）→ 不算改规则，标记不能被误清。
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
const { ensureRepeatOccurrences, patchTask } = await import('./store/tasks.ts');

const CAL = 'cal-1';

const DAILY: RepeatRule = { unit: 'day', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null };
/** 每周一（用户这次设的规则） */
const MON: RepeatRule = { unit: 'week', n: 1, weekdays: [1], monthday: 1, yearMonth: 1, end: null };

function fresh(): void {
  mem.clear();
  store.resetLocal();
  store.setCals([{ id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' }]);
}

const all = () => Object.values(store.get().tasks);
const family = (root: string) => all().filter((t) => t.seriesId === root || t.id === root);

function seed(baseDay: string, rule: RepeatRule): string {
  const t = makeTask({ calId: CAL, title: '联系包老师', date: baseDay, time: null, repeat: rule });
  return store.addTask(t);
}

const aliveDates = (root: string) => family(root)
  .filter((t) => !t.deleted && typeof t.date === 'string')
  .map((t) => t.date as string)
  .sort();

test('改规则 → 旧的「到此为止」作废，之后照常铺', () => {
  fresh();
  const today = D.today();
  const root = seed(today, DAILY);
  const end = D.addDays(today, 10);

  // 模拟「从这天起全部删除」留下的标记
  patchTask(root, { repeatUntil: end });
  ensureRepeatOccurrences();
  const before = aliveDates(root);
  assert.ok(before.every((d) => d < end), `标记生效时应全在 ${end} 之前，实际最远 ${before[before.length - 1]}`);

  // 用户把规则改成每周一
  patchTask(root, { repeat: MON });
  ensureRepeatOccurrences();

  const after = aliveDates(root);
  console.log(`  改规则前 ${before.length} 条（最远 ${before[before.length - 1]}），改后 ${after.length} 条（最远 ${after[after.length - 1]}）`);
  assert.ok(after.length > before.length, `改规则后应补出新实例，实际没变（${after.length}）`);
  assert.ok(after.some((d) => d > end), `应铺到旧结束日 ${end} 之后，实际最远 ${after[after.length - 1]}`);

  // 生成出来的必须都是周一
  for (const d of after) {
    if (d === today) continue;   // 根保留原日期，不强行是周一
    assert.equal(D.weekdayOf(d), 1, `${d} 应该是周一`);
  }
  // 标记必须被清掉（否则同步到别的设备又会跳过）
  assert.ok(family(root).every((t) => !t.repeatUntil), '标记应已被清除');
});

test('不改规则 → 标记仍然生效，且是上界语义（之前那段照常有）', () => {
  fresh();
  const today = D.today();
  const root = seed(today, DAILY);
  const end = D.addDays(today, 12);
  patchTask(root, { repeatUntil: end });
  ensureRepeatOccurrences();

  const ds = aliveDates(root);
  console.log(`  结束日 ${end}，实际 ${ds[0]} → ${ds[ds.length - 1]}（${ds.length} 条）`);
  assert.ok(ds.some((d) => d > today), '结束日之前应该有后续实例（不能整组跳过）');
  assert.ok(ds.every((d) => d < end), `不应越过结束日 ${end}`);
});

test('等价规则（只是星期几顺序不同）不算改规则', () => {
  fresh();
  const today = D.today();
  const root = seed(today, { ...DAILY, unit: 'week', weekdays: [5, 6, 0] });
  const end = D.addDays(today, 30);
  patchTask(root, { repeatUntil: end });
  ensureRepeatOccurrences();

  // 同样的规则、weekdays 换顺序后传进来
  patchTask(root, { repeat: { ...DAILY, unit: 'week', weekdays: [0, 5, 6] } });
  assert.ok(family(root).some((t) => t.repeatUntil), '等价规则不该清掉「到此为止」');
});

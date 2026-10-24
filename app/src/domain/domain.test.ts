/**
 * domain.test.ts —— 领域层测试（node:test，零依赖）
 *
 *   cd app && npm test
 *
 * 重点用例是最后那一组：**两台设备各自离线推进同一条重复任务**。
 * 旧版这里会派生出两个随机 id 的实例，同步后任务翻倍 —— 本次重构存在的
 * 理由就是为了修掉它。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as D from './date.ts';
import {
  toRepeat, repeatAdvance, repeatNext, emptyRepeat, repeatLast,
  instanceId, seriesRootOf, repeatLabel, parseInstanceId,
} from './repeat.ts';
import { coverWindow, dayTimeline, layoutOverlap, minToPct, pctRange, spanOf, timeRange, timeRangeCompact, windowOf, yToMin, placePanel, dragRange, DRAG_MIN, untimedBlanks, untimedRowPx, CARD_SEAM, FULL_DAY } from './layout.ts';
import { findConflicts, lwwWins, mergeChange, writeFields } from './merge.ts';
import {
  counts, overdueTasks, sortTasks, ordCmp, orderCmp, dayLoad,
  normalizeUi, migrateV3, makeTask, liveTasks, isTrashed, habitStreak,
  quickDefaults, defaultUi, resolveDefaultCal, setDefaultCal,
} from './model.ts';
import type { Change, LocalState, Op, RepeatRule, Task } from './types.ts';

const T = '2026-10-06';   // 固定「今天」，否则用例会随真实日期漂移

function repeat(partial: Partial<RepeatRule>): RepeatRule {
  return { ...emptyRepeat(T), ...partial };
}

function stateWith(tasks: Task[] = [], over: Partial<LocalState> = {}): LocalState {
  return {
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    habits: {},
    projects: {},
    cals: [],
    invites: [],
    cursor: 0,
    outbox: [],
    ui: normalizeUi(undefined),
    lastError: null,
    clockBlocked: [],
    denied: 0,
    deniedCals: [],
    conflicts: [],
    syncing: false,
    ...over,
  };
}

/* ============================== 日期 ============================== */

test('日期基础运算', () => {
  assert.equal(D.addDays('2026-10-06', 1), '2026-10-07');
  assert.equal(D.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(D.addDays('2026-01-01', -1), '2025-12-31');

  // 周一为一周起点
  assert.equal(D.weekStart('2026-10-06'), '2026-10-05');   // 周二 → 周一
  assert.equal(D.weekStart('2026-10-11'), '2026-10-05');   // 周日 → 同一周的周一

  // addMonths 先把日子截到 1 号再进月，1/31 + 1 个月不该滚到 3/3
  assert.equal(D.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(D.addMonths('2026-01-15', 1), '2026-02-15');
  assert.equal(D.addMonths('2026-10-06', 12), '2027-10-06');
});

test('月视图矩阵是 42 天且以周一开头', () => {
  const m = D.monthMatrix('2026-10-06');
  assert.equal(m.length, 42);
  assert.equal(D.weekdayOf(m[0]), 1, '第一格必须是周一');
});

test('月视图行数只含当月某天（10 月是 5 行，不多画 11 月那一整周）', () => {
  const w = D.monthWeeks('2026-10-06');
  assert.equal(w.length, 5);
  assert.equal(w[0][0], '2026-09-28');           // 10/1 是周四，首行前三格是上月
  assert.equal(w[0][3], '2026-10-01');
  assert.equal(w[4][6], '2026-11-01');           // 末行最后一格是下月，但行里有 10 月的天
  const d = D.monthWeeks('2026-11-05');         // 11/1 是周日 → 6 行，这是上限
  assert.equal(d.length, 6);
  assert.ok(D.monthWeeks('2026-02-15').length <= 5, '2 月不该有 6 行');
});

/* ======================= 「找日期」输入框的片段解析 ======================= */

test('找日期：相对说法', () => {
  const p = (s: string) => D.parseDateText(s, T, T);
  assert.equal(p('今天'), T);
  assert.equal(p('明天'), '2026-10-07');
  assert.equal(p('后天'), '2026-10-08');
  assert.equal(p('大后天'), '2026-10-09');
  assert.equal(p('昨天'), '2026-10-05');
  assert.equal(p('前天'), '2026-10-04');
  assert.equal(p('大前天'), '2026-10-03');
  assert.equal(p('3天后'), '2026-10-09');
  assert.equal(p('5天前'), '2026-10-01');
});

test('找日期：裸周几取下一个，带「本 / 这」才允许落在过去', () => {
  // T = 2026-10-06 是周二，本周一是 10-05（已过去）
  const p = (s: string) => D.parseDateText(s, T, T);
  assert.equal(p('周四'), '2026-10-08');
  assert.equal(p('周一'), '2026-10-12', '裸「周一」必须推到下周，不是两天前');
  assert.equal(p('周三'), '2026-10-07');
  assert.equal(p('周二'), T, '就是今天，不该往后推一周');
  assert.equal(p('周7'), '2026-10-11');   // 周日
  assert.equal(p('周1'), '2026-10-12');   // 与普通数字归一
  assert.equal(p('本周一'), '2026-10-05', '说了「本」就按本周算，哪怕是过去');
  assert.equal(p('这周五'), '2026-10-09');
  assert.equal(p('下周三'), '2026-10-14');
  assert.equal(p('下下周 一'), '2026-10-19', '空格要被吃掉');
});

test('找日期：月份偏移与完整日期', () => {
  const p = (s: string) => D.parseDateText(s, T, T);
  assert.equal(p('下个月'), '2026-11-01');
  assert.equal(p('下下个月'), '2026-12-01');
  assert.equal(p('本月'), '2026-10-01');
  assert.equal(p('上个月'), '2026-09-01');

  assert.equal(p('2026-10-15'), '2026-10-15');
  assert.equal(p('2026/10/15'), '2026-10-15');
  assert.equal(p('2026.10.15'), '2026-10-15');
  assert.equal(p('2026年10月15日'), '2026-10-15');
  assert.equal(p('20261015'), '2026-10-15');
  assert.equal(p('2026-10'), '2026-10-01');
  assert.equal(p('202610'), '2026-10-01');
  assert.equal(p('2026'), '2026-01-01', '纯四位数是年份，不能被两位月日那条吃掉');
});

test('找日期：只给月日时年份沿用**面板所在的年份**，超月天数截到月末', () => {
  // 12 月翻到面板显示次年 1 月，这时输入「1月5日」要的是明年
  assert.equal(D.parseDateText('1月5日', '2027-01-15', T), '2027-01-05');
  assert.equal(D.parseDateText('1月5日', '2026-10-15', T), '2026-01-05');
  assert.equal(D.parseDateText('1015', '2026-10-15', T), '2026-10-15');
  assert.equal(D.parseDateText('10', '2026-10-15', T), '2026-10-01');
  assert.equal(D.parseDateText('2月30日', '2026-10-15', T), '2026-02-28', '不该给用户报错');
});

test('找日期：认不出就返回 null（不猜）', () => {
  const p = (s: string) => D.parseDateText(s, T, T);
  assert.equal(p(''), null);
  assert.equal(p('   '), null);
  assert.equal(p('交周报'), null);
  assert.equal(p('13月5日'), null);
  assert.equal(p('0月'), null);
  assert.equal(p('1969'), null, '1970 年之前不接受');
});

/* ============================== 重复 ============================== */

test('重复推进：日 / 周 / 月 / 年', () => {
  assert.equal(repeatAdvance(repeat({ unit: 'day', n: 1 }), '2026-10-06'), '2026-10-07');
  assert.equal(repeatAdvance(repeat({ unit: 'day', n: 3 }), '2026-10-06'), '2026-10-09');

  // 每周一、三、五：从周三出发，下一个是周五
  const mwf = repeat({ unit: 'week', weekdays: [1, 3, 5] });
  assert.equal(repeatAdvance(mwf, '2026-10-07'), '2026-10-09');
  // 从周五出发，跨周到下周一
  assert.equal(repeatAdvance(mwf, '2026-10-09'), '2026-10-12');

  assert.equal(repeatAdvance(repeat({ unit: 'month', monthday: 15 }), '2026-10-06'), '2026-11-15');
  assert.equal(repeatAdvance(repeat({ unit: 'year', n: 1 }), '2026-10-06'), '2027-10-06');
});

test('重复推进：每月 31 号在 2 月被截到月末，但 monthday 不变', () => {
  const r = repeat({ unit: 'month', monthday: 31 });
  assert.equal(repeatAdvance(r, '2026-01-31'), '2026-02-28');
  assert.equal(r.monthday, 31, 'monthday 不能被推进过程改掉');
  assert.equal(repeatAdvance(r, '2026-03-31'), '2026-04-30');
});

test('repeatNext 会一路补到今天（含）之后，不会每勾一次就造一个过去的实例', () => {
  // 一段跨度远大于旧版那个 800 次 guard 的历史：2020-01-01 到今天约 2470 天。
  // 旧实现在第 800 步就断了，返回 2022-03-12 —— 一个过去的日期。
  const daily = makeTask({ id: 'a', title: '每天', date: '2020-01-01', repeat: repeat({ unit: 'day' }) });
  const next = repeatNext(daily, '2020-01-01');
  assert.ok(next !== null, '不该因为跨度大就放弃');
  assert.ok(next! >= D.today(), `补到的那天必须不早于今天，实际 ${next}`);

  const weekly = makeTask({ id: 'b', title: '每周', date: '2020-01-01', repeat: repeat({ unit: 'week' }) });
  const wn = repeatNext(weekly, '2020-01-01');
  assert.ok(wn !== null && wn! >= D.today(), `每周重复同样要补齐，实际 ${wn}`);

  const monthly = makeTask({ id: 'c', title: '每月', date: '2020-01-01', repeat: repeat({ unit: 'month', monthday: 1 }) });
  const mn = repeatNext(monthly, '2020-01-01');
  assert.ok(mn !== null && mn! >= D.today(), `每月重复同样要补齐，实际 ${mn}`);
});

test('repeatNext 的边界：今天发生的那次算数，不会跳过今天', () => {
  const t = makeTask({ id: 'b', title: 'y', date: D.today(), repeat: repeat({ unit: 'day' }) });
  assert.equal(repeatNext(t, D.today()), D.addDays(D.today(), 1), '从今天出发，下一次是明天');

  const y = makeTask({ id: 'c', title: 'z', date: D.today(), repeat: repeat({ unit: 'day' }) });
  assert.equal(
    repeatNext(y, D.addDays(D.today(), -1)), D.today(),
    '昨天那次没勾，今天这一次必须落在今天，不能被推走',
  );
});

test('repeatNext 尊重结束条件', () => {
  // 日期一律相对 `today` 算。`repeatNext` 内部会一路补到**今天**，所以这里
  // 写死日期就是一颗定时炸弹：原先写死 2026-10-06 → 2026-10-08，2026-10-09
  // 零点一过，`repeatNext(t, '2026-10-07')` 先被推到 10-09、再被结束日期挡成
  // null，断言当场红 —— 而代码一个字没改。
  const t0 = D.today();
  const byDate = makeTask({
    id: 'a', title: 'x', date: t0,
    repeat: { ...repeat({ unit: 'day' }), end: { type: 'date', date: D.addDays(t0, 2) } },
  });
  assert.equal(repeatNext(byDate, D.addDays(t0, 1)), D.addDays(t0, 2));
  assert.equal(repeatNext(byDate, D.addDays(t0, 2)), null, '超出结束日期就没了');

  const byCount = makeTask({
    id: 'b', title: 'y', date: '2099-01-01',
    repeat: { ...repeat({ unit: 'day' }), end: { type: 'count', count: 3 } },
    repeatSeq: 0,
  });
  assert.ok(repeatNext(byCount, '2099-01-01'));
  byCount.repeatSeq = 3;
  assert.equal(repeatNext(byCount, '2099-01-01'), null, '次数用满就没了');
});

test('旧的字符串型 repeat 能升级成对象', () => {
  assert.equal(toRepeat('weekly', '2026-10-06').unit, 'week');
  assert.deepEqual(toRepeat('weekly', '2026-10-06').weekdays, [2]);
  assert.equal(toRepeat(null, '2026-10-06').unit, 'none');
  assert.equal(toRepeat({ unit: 'day', n: 0 }, T).n, 1, 'n 至少是 1');
});

test('重复文案', () => {
  assert.equal(repeatLabel(repeat({ unit: 'day', n: 1 })), '每天');
  assert.equal(repeatLabel(repeat({ unit: 'day', n: 2 })), '每 2 天');
  assert.equal(repeatLabel(repeat({ unit: 'week', weekdays: [1, 3] })), '每周一、三');
  assert.equal(repeatLabel(repeat({ unit: 'none' })), '');
});

/* ==================== 派生 id：本次重构的死穴 ==================== */

test('两台设备各自离线推进同一条重复任务，算出的实例 id 必须相同', () => {
  const root = 'series-uuid-0001';
  const occurrence = '2026-10-07';

  // 设备 A 和 B 各自跑一遍，互不知情
  const idA = instanceId(root, occurrence);
  const idB = instanceId(root, occurrence);

  assert.equal(idA, idB, '派生 id 必须确定性 —— 这是「任务不翻倍」的全部依据');
  assert.equal(idA, 'series-uuid-0001#2026-10-07', '形式可读，调试时能肉眼对账');

  // 反面对照：随机 id 会得到两个不同的结果，也就是旧版的行为
  const randomA = 'a3f2c1d4-0000-4000-8000-000000000001';
  const randomB = 'b7e9f2a6-0000-4000-8000-000000000002';
  assert.notEqual(randomA, randomB, '随机 id 必然分叉 —— 这就是要避免的');
});

test('系列根一旦生成就不变：实例的系列根指向最初那条任务', () => {
  const root = makeTask({ id: 'root-1', title: '早会', date: '2026-10-06', repeat: repeat({ unit: 'day' }) });
  assert.equal(seriesRootOf(root), 'root-1');

  const inst = makeTask({ id: instanceId('root-1', '2026-10-07'), title: '早会', seriesId: 'root-1', repeat: repeat({ unit: 'day' }) });
  assert.equal(seriesRootOf(inst), 'root-1', '实例的系列根是 root-1，不是它自己');

  const plain = makeTask({ id: 'p1', title: '买菜' });
  assert.equal(seriesRootOf(plain), null, '非重复任务没有系列根');
});

test('派生的实例 id 能被反解回系列与发生日期', () => {
  const id = instanceId('root-1', '2026-10-07');
  assert.deepEqual(parseInstanceId(id), { seriesId: 'root-1', date: '2026-10-07' });
  assert.equal(parseInstanceId('a-plain-uuid'), null);
});

/* ==================== LWW：客户端与服务端必须同一条规则 ==================== */

test('LWW：更新的时间戳赢；时间戳相同则 deviceId 大的赢', () => {
  assert.equal(lwwWins(200, 'aaa', 100, 'zzz'), true, '时间戳更大就赢，跟 deviceId 无关');
  assert.equal(lwwWins(100, 'zzz', 200, 'aaa'), false);

  assert.equal(lwwWins(100, 'bbb', 100, 'aaa'), true);
  assert.equal(lwwWins(100, 'aaa', 100, 'bbb'), false);

  // 同样两个值，谁先到都一样 —— 这是收敛的前提
  const fold = (order: [number, string][]) => {
    let ts = -Infinity; let dev = '';
    for (const [t, d] of order) if (lwwWins(t, d, ts, dev)) { ts = t; dev = d; }
    return dev;
  };
  assert.equal(
    fold([[100, 'aaa'], [100, 'bbb']]),
    fold([[100, 'bbb'], [100, 'aaa']]),
    '到达顺序不影响最终赢家',
  );
});

test('合并时不覆盖本地更新的字段', () => {
  const t = makeTask({ id: 'x', title: '本地标题' });
  writeFields(t, { title: '本地标题' }, 1000, 'devLocal');

  // 对方的改动更旧 → 拒绝
  assert.equal(mergeChange(t, 'title', '对方标题', 900, 'devRemote'), false);
  assert.equal(t.title, '本地标题');

  // 对方的改动更新 → 接受
  assert.equal(mergeChange(t, 'title', '对方标题', 1100, 'devRemote'), true);
  assert.equal(t.title, '对方标题');
  assert.equal(t._ts.title, 1100);
});

test('合并是按字段的：一方改标题、另一方改日期，两个都留住', () => {
  const t = makeTask({ id: 'x', title: '会议', date: '2026-10-06' });
  writeFields(t, { title: '会议', date: '2026-10-06' }, 1000, 'devA');

  mergeChange(t, 'date', '2026-10-08', 1100, 'devB');   // 桌面改期
  mergeChange(t, 'title', '周会', 1050, 'devA');        // 手机改标题

  assert.equal(t.title, '周会', '标题该保住');
  assert.equal(t.date, '2026-10-08', '日期该保住');
});

/* ============================== 摆放 ============================== */

test('重叠分列：不重叠的任务各占满整行', () => {
  const placed = layoutOverlap([
    { item: 'a', start: 9 * 60, end: 10 * 60 },
    { item: 'b', start: 11 * 60, end: 12 * 60 },
    { item: 'c', start: 13 * 60, end: 14 * 60 },
  ]);
  assert.ok(placed.every((p) => p.cols === 1), '不重叠就不该被压窄');
  assert.ok(placed.every((p) => p.col === 0));
});

test('重叠分列：只有真正重叠的那一簇分列', () => {
  const placed = layoutOverlap([
    { item: 'a', start: 9 * 60, end: 10 * 60 },
    { item: 'b', start: 9 * 60 + 30, end: 10 * 60 + 30 },   // 与 a 重叠
    { item: 'c', start: 15 * 60, end: 16 * 60 },             // 独处
  ]);
  const byItem = Object.fromEntries(placed.map((p) => [p.item, p]));
  assert.equal(byItem.a.cols, 2);
  assert.equal(byItem.b.cols, 2);
  assert.notEqual(byItem.a.col, byItem.b.col, '重叠的两个必须分到不同列');
  assert.equal(byItem.c.cols, 1, '后面独处的任务不该被前面的重叠拖成半宽');
  assert.equal(byItem.c.col, 0);
});

test('重叠分列：三件互相重叠时分三列', () => {
  const placed = layoutOverlap([
    { item: 'a', start: 540, end: 660 },
    { item: 'b', start: 550, end: 670 },
    { item: 'c', start: 560, end: 680 },
  ]);
  assert.ok(placed.every((p) => p.cols === 3));
  assert.deepEqual(placed.map((p) => p.col).sort(), [0, 1, 2]);
});

test('重叠分列：首尾相接不算重叠', () => {
  const placed = layoutOverlap([
    { item: 'a', start: 540, end: 600 },
    { item: 'b', start: 600, end: 660 },
  ]);
  assert.ok(placed.every((p) => p.cols === 1));
});

test('时间段文案，跨零点标次日', () => {
  assert.equal(timeRange(9 * 60 + 30, 60), '09:30 – 10:30');
  assert.equal(timeRange(23 * 60 + 30, 60), '23:30 – 次日 00:30');
});

test('同一份时间的紧凑写法：卡片里用，值不变、只少空格和破折号两侧', () => {
  assert.equal(timeRangeCompact(9 * 60 + 30, 60), '09:30–10:30');
  assert.equal(timeRangeCompact(23 * 60 + 30, 60), '23:30–次日00:30');
  /* 卡片文案的宽度预算全靠这两处（窄屏周视图净宽 54px，完整写法要 67px）：
     紧凑写法 = 完整写法去掉破折号两侧的空格、「次日」后面的空格 */
  assert.ok(timeRangeCompact(540, 120).length < timeRange(540, 120).length);
  assert.deepEqual(
    timeRangeCompact(540, 120).split('–'),
    timeRange(540, 120).split(' – '),
  );
  /* 时长为空（没设过时长的任务）仍按 0 长度算结束点，不产生 NaN */
  assert.equal(timeRangeCompact(540, 0), '09:00–09:00');
  /* 跨零点与完整写法同一规则：越过 24:00 标「次日」，不是夹回 23:59 */
  assert.equal(timeRangeCompact(23 * 60 + 30, 120), '23:30–次日01:30');
});

test('方向键微调上下沿：底边只改时长，上沿固定底边', () => {
  // 底边往下 = 变长
  assert.deepEqual(D.nudgeEdge('09:00', 60, 'bottom', 1), { duration: 75 });
  // 时长下限 15，再往下按不动
  assert.deepEqual(D.nudgeEdge('09:00', 15, 'bottom', -1), { duration: 15 });

  // 上沿往上 = 开始提前、总长变长，**底边 10:00 不动**
  assert.deepEqual(D.nudgeEdge('09:00', 60, 'top', -1), { time: '08:45', duration: 75 });
  // 上沿往下 = 开始推迟、总长变短
  assert.deepEqual(D.nudgeEdge('09:00', 60, 'top', 1), { time: '09:15', duration: 45 });
  // 上沿不能越过底边（最少留 15 分钟），也不能早于 0:00
  assert.deepEqual(D.nudgeEdge('09:00', 15, 'top', 1), { time: '09:00', duration: 15 });
  assert.deepEqual(D.nudgeEdge('00:05', 60, 'top', -1), { time: '00:00', duration: 65 });

  // 跨过整点也要对
  assert.deepEqual(D.nudgeEdge('09:50', 60, 'top', 1), { time: '10:05', duration: 45 });
});

/* ============================== 查询口径 ============================== */

test('逾期与今天互不重叠，同一个任务不会被数两次', () => {
  const t = D.today();
  const s = stateWith([
    makeTask({ id: 'a', title: '今天', date: t }),
    makeTask({ id: 'b', title: '逾期', date: D.addDays(t, -1) }),
    makeTask({ id: 'c', title: '未来', date: D.addDays(t, 1) }),
    makeTask({ id: 'd', title: '待办箱', date: null }),
    makeTask({ id: 'e', title: '已完成逾期', date: D.addDays(t, -2), done: true }),
  ]);
  const c = counts(s);
  assert.equal(c.today, 1, '今天只数今天');
  assert.equal(c.overdue, 1, '已完成的逾期任务不算逾期');
  assert.equal(c.inbox, 1);
  assert.equal(overdueTasks(s).length, c.overdue, '列表与徽标必须同源');
});

test('墓碑不进任何正常列表，只进垃圾箱', () => {
  const s = stateWith([
    makeTask({ id: 'live', title: '活着', date: D.today() }),
    makeTask({ id: 'gone', title: '删了', date: D.today(), deleted: true, deletedAt: 1 }),
    makeTask({ id: 'purged', title: '彻底删了', date: D.today(), deleted: true, purged: true, deletedAt: 1 }),
  ]);
  const ids = liveTasks(s).map((x) => x.id);
  assert.deepEqual(ids, ['live']);
  assert.equal(counts(s).trash, 1, '彻底删除的不再出现在垃圾箱');
  assert.ok(isTrashed(s.tasks.gone));
  assert.ok(!isTrashed(s.tasks.purged));
});

test('排序：有时间的在前按时间，未定时的按手动位次', () => {
  const list = [
    makeTask({ id: 'u2', title: '未定时2', date: T, order: 2 }),
    makeTask({ id: 't14', title: '两点', date: T, time: '14:00' }),
    makeTask({ id: 'u1', title: '未定时1', date: T, order: 1 }),
    makeTask({ id: 't09', title: '九点', date: T, time: '09:00' }),
  ];
  assert.deepEqual(sortTasks(list).map((x) => x.id), ['t09', 't14', 'u1', 'u2']);
});

test('排序：用户拖过的（ord 有值）优先，没拖过的按默认口径接在后面', () => {
  const a = makeTask({ id: 'a', title: 'a', date: T, ord: 2 });
  const b = makeTask({ id: 'b', title: 'b', date: T, ord: 0 });
  const c = makeTask({ id: 'c', title: 'c', date: T, ord: null });

  const sorted = [a, b, c].sort(ordCmp(orderCmp));
  assert.deepEqual(sorted.map((x) => x.id), ['b', 'a', 'c']);
});

test('打卡连续天数：今天没打则从昨天起算', () => {
  const t = D.today();
  const h = { id: 'h', calId: '', title: 'x', order: 0, createdAt: 0, _ts: {}, _dev: {},
    log: { [t]: true as const, [D.addDays(t, -1)]: true as const, [D.addDays(t, -2)]: true as const } };
  assert.equal(habitStreak(h), 3);

  const h2 = { ...h, log: { [D.addDays(t, -1)]: true as const, [D.addDays(t, -2)]: true as const } };
  assert.equal(habitStreak(h2), 2, '今天还没打，但昨天打了，连续数继续');

  const h3 = { ...h, log: {} };
  assert.equal(habitStreak(h3), 0);
});

test('某一天的负载只算没完成、有时间的任务', () => {
  const s = stateWith([
    makeTask({ id: 'a', title: 'a', date: T, time: '09:00', duration: 60 }),
    makeTask({ id: 'b', title: 'b', date: T, time: '11:00', duration: 30 }),
    makeTask({ id: 'c', title: 'c', date: T, time: null }),
    makeTask({ id: 'd', title: 'd', date: T, time: '13:00', duration: 60, done: true }),
  ]);
  assert.deepEqual(dayLoad(s, T), { mins: 90, count: 3 });
});

test('侧栏顺序：区分「从未设置」与「用户有意清空」', () => {
  assert.deepEqual(normalizeUi(undefined).navBottom, ['trash'], '没设置过 → 给默认');
  assert.deepEqual(
    normalizeUi({ navBottom: [] }).navBottom, [],
    '空数组是用户把垃圾箱拖出底部后的合法状态，不能又塞回去',
  );
  assert.equal(normalizeUi({ nav: 'notes' }).nav, 'today', '已删除的模块要兜回今天');
});

/* ================= 侧栏多选（ui.cals 的迁移） ================= */

test('多选集合：老数据从当前集起步，不会一进界面日程页就空着', () => {
  // 老 localStorage 里没有 cals 这个键 —— 落成 [] 的话 useScopedState 会
  // 返回空 state，老用户看到的是「我所有的任务都没了」
  assert.deepEqual(normalizeUi({ cal: 'a' }).cals, ['a'], '从 ui.cal 起步');
  assert.deepEqual(normalizeUi(undefined).cals, [], '连当前集都没有 → 空（还没连服务器）');

  // 认得的值原样保留，别替用户重排或去重成别的样子
  assert.deepEqual(normalizeUi({ cal: 'a', cals: ['b', 'a'] }).cals, ['b', 'a'],
    '已经勾着的原样保留，顺序也不动');
  // 坏值打回默认
  assert.deepEqual(normalizeUi({ cals: 'a' as unknown as string[] }).cals, [], '非数组 → 空');
  assert.deepEqual(normalizeUi({ cals: ['a', 7 as unknown as string] }).cals, ['a'],
    '塞了非字符串的丢掉那一个');
});

/* ================= 日视图时间窗 ================= */

test('时间窗：默认值是整天，写坏的值打回整天而不是猜一个', () => {
  assert.deepEqual(windowOf(normalizeUi(undefined)), { from: 0, to: 1440 },
    '没设置过 → 整天，一小时都不藏');

  for (const bad of [
    { dayFrom: '早' as unknown as number, dayTo: 23 },
    { dayFrom: 7, dayTo: NaN },
    { dayFrom: -5, dayTo: 999 },
  ]) {
    assert.deepEqual(windowOf(normalizeUi(bad)), { from: 0, to: 1440 },
      `写坏的值要打回整天：${JSON.stringify(bad)}`);
  }
});

test('时间窗：合法值原样保留，且至少留一个小时', () => {
  assert.deepEqual(windowOf(normalizeUi({ dayFrom: 7, dayTo: 23 })), { from: 420, to: 1380 });

  // 用户把两头收到只剩半小时 —— 撑开成 1 小时，而不是画出一条看不见的时间轴
  const tiny = windowOf(normalizeUi({ dayFrom: 10, dayTo: 10 }));
  assert.equal(spanOf(tiny), 60, '收得太窄要撑到下限');

  // 夜里 23 点起、到 24 点 —— 正好一小时，合法
  assert.deepEqual(windowOf(normalizeUi({ dayFrom: 23, dayTo: 24 })), { from: 1380, to: 1440 });

  // 反向的窗（23 → 5）不认，但也不打回整天：把 to 顶到 from + 下限，
  // 用户至少得到一个**能看**的时间窗，而不是「设置被忽略了」
  assert.deepEqual(windowOf(normalizeUi({ dayFrom: 23, dayTo: 5 })), { from: 1380, to: 1440 },
    '反向的窗撑成 from 之后的那一小时');
});

test('coverWindow：任务跑到窗外，窗口自动往外让', () => {
  const set = { from: 480, to: 1200 };   // 设置的 08:00 – 20:00

  // 任务都在窗内 → 窗口分毫不动（这是常态，不该被随便改写）
  assert.deepEqual(coverWindow(set, [{ start: 540, end: 600 }]), set, '窗内任务不动窗');

  // 下端有任务（07:10 开始）→ 往外让到 07:00
  assert.deepEqual(coverWindow(set, [{ start: 430, end: 500 }]), { from: 420, to: 1200 });
  // 上端有任务（23:30 结束）→ 让到 24:00
  assert.deepEqual(coverWindow(set, [{ start: 1200, end: 1410 }]), { from: 480, to: 1440 });

  // 两头都有 → 两头都让
  assert.deepEqual(
    coverWindow(set, [{ start: 300, end: 360 }, { start: 1300, end: 1360 }]),
    { from: 300, to: 1380 });

  // 跨零点（23:00 + 120 分 = 1500）→ 下端夹回 24:00，不能让出一天之外
  assert.deepEqual(coverWindow(set, [{ start: 1380, end: 1500 }]), { from: 480, to: 1440 });

  // 荒数据不炸：NaN / 负数 / start > end 都跳过或夹回合法范围
  assert.deepEqual(coverWindow(set, [{ start: NaN, end: 100 }]), set, 'NaN 跳过');
  assert.deepEqual(coverWindow(set, [{ start: -60, end: 100 }]), { from: 0, to: 1200 });

  // 让完仍保住最小窗宽
  const thin = { from: 600, to: 660 };
  assert.equal(coverWindow(thin, [{ start: 600, end: 700 }]).to - coverWindow(thin, [{ start: 600, end: 700 }]).from >= 60, true);
});

test('时间窗：纵坐标 ⇄ 分钟 互为逆运算', () => {
  const win = { from: 420, to: 1380 };   // 07:00 – 23:00
  const boxH = 960;
  assert.equal(spanOf(win), 960, '16 小时铺满 960px → 每小时 60px');

  // 正中 = 15:00
  assert.equal(yToMin(boxH / 2, boxH, win), 900);
  // 顶端 = 07:00
  assert.equal(yToMin(0, boxH, win), 420);
  // 底端收在**最后一档起点**（22:45），不是 23:00 —— 23:00 起的那条在窗里
  // 没有 15 分钟的时长可画，放到窗外就成了看不见的孤儿
  assert.equal(yToMin(boxH, boxH, win), 1365);

  // 拖到窗外要被夹回窗内，不能落到 03:00 去
  assert.equal(yToMin(-500, boxH, win), 420);
  assert.equal(yToMin(99999, boxH, win), 1365);

  // 高度为 0（还没量到 / 已卸载）不能除出 NaN
  assert.equal(yToMin(100, 0, win), 420);
});

test('时间窗：窗外的事件整条不画（minToPct 返回 null）', () => {
  const win = { from: 420, to: 1380 };
  assert.equal(minToPct(420, win), 0, '窗的第一分钟贴着顶');
  assert.equal(minToPct(1380, win), 100, '窗的最后一分钟贴着底');

  // 夜里的两条：整条不画，而不是画在顶上冒充 07:00
  assert.equal(minToPct(60, win), null, '01:00 在窗外');
  assert.equal(minToPct(1439, win), null, '23:59 在窗外');

  assert.equal(minToPct(900, win), (900 - 420) / 960 * 100, '15:00 落在正中');
});

test('时间窗：跨过窗沿的按窗沿截断，不整条抹掉', () => {
  const win = { from: 480, to: 720 };   // 08:00 – 12:00

  // 07:00–09:00 在窗里还露着一小时 —— 整条消失等于「明明有事却看不见」
  const straddles = pctRange(420, 540, win);
  assert.deepEqual(straddles, { top: 0, height: 60 / 240 * 100 },
    '贴着窗顶截断，露出 08:00–09:00 那一小时');

  // 完全在窗外（两头顶不到窗）才整条不画
  assert.equal(pctRange(0, 300, win), null, '00:00–05:00 完全在窗外');
  assert.equal(pctRange(900, 1000, win), null, '15:00 之后完全在窗外');

  // 正好卡在窗沿上：高度为 0，不该画成一个空壳
  assert.equal(pctRange(300, 480, win), null, '07:00–08:00 结束在窗顶，画出来是空的');
});

test('拖拽拉时间段：起止成对，且不小于 30 分钟', () => {
  const win = { from: 420, to: 1380 };   // 07:00 – 23:00

  // 手抖了一下（两点重合）：不能冒出一条 0 分钟的日程
  assert.deepEqual(dragRange(600, 600, win), { start: 600, end: 630 },
    '原地按下 / 拉不够 → 兜底 30 分钟');
  assert.deepEqual(dragRange(600, 615, win), { start: 600, end: 630 },
    '只拉了 15 分钟也顶到 30 分钟');

  // 正常下拉
  assert.deepEqual(dragRange(600, 645, win), { start: 600, end: 645 }, '10:00 → 10:45');

  // 向上拉 = 把开始时间往前推，终点是按下那一刻
  assert.deepEqual(dragRange(600, 540, win), { start: 540, end: 600 }, '往上拉 1 小时 → 09:00–10:00');
  assert.deepEqual(dragRange(600, 585, win), { start: 570, end: 600 },
    '往上只拉了 15 分钟 → 顶成 09:30–10:00');

  // 贴窗沿：起落在窗 YAML 内，不会被推到窗外去
  assert.deepEqual(dragRange(1365, 1365, win), { start: 1350, end: 1380 },
    '贴着窗底（23:00）按下 → 收成 22:30–23:00');
  assert.deepEqual(dragRange(420, 420, win), { start: 420, end: 450 },
    '贴着窗顶（07:00）按下 → 07:00–07:30');

  // 传进来的两点可能已经跑出窗（拖出了时间轴），收完之后必须仍是窗内的一段
  const odd = dragRange(60, 1440, win);
  assert.ok(odd.end - odd.start >= DRAG_MIN, '拉到窗外也保证最短时长');
  assert.ok(odd.start >= win.from && odd.end <= win.to, '拉到窗外也保证仍在窗内');
});

test('navHidden：藏起来是显式黑名单，不会被 navOrder 的补全逻辑吃掉', () => {  // 关键区别：navOrder 会把缺的键**补回来**，所以「从 navOrder 里删掉」表达不了
  // 「用户不要它」—— 刷新一次它就自己回来了。navHidden 才表达得了。
  const hidden = normalizeUi({ navHidden: ['projects', 'ai'] });
  assert.deepEqual(hidden.navHidden, ['projects', 'ai']);
  assert.ok(hidden.navOrder.includes('projects'),
    '被藏的项仍在 navOrder 里 —— 藏是渲染时过滤，不是从顺序里删');

  // 一个都没藏是合法状态，不能写成「空则给默认」
  assert.deepEqual(normalizeUi(undefined).navHidden, [], '没设置过 → 一个都没藏');
  assert.deepEqual(normalizeUi({ navHidden: [] }).navHidden, []);

  // 认不出的键滤掉。**「不在 navOrder 里的键」这一种构造不出来** ——
  // 补全逻辑在过滤之前跑，normalizeUi 出来的 navOrder 永远含全部 CUSTOMIZABLE，
  // 所以 navHidden 里也不可能出现顺序外的键。这条断言钉的是「只认 CUSTOMIZABLE」。
  assert.deepEqual(normalizeUi({ navHidden: ['nope', 'settings'] as string[] }).navHidden, [],
    '设置不进功能区，也藏不了');
  assert.deepEqual(normalizeUi({ navHidden: ['trash', 'projects'] }).navHidden, ['trash', 'projects'],
    '垃圾箱也能藏（它同样在 CUSTOMIZABLE 里）');
});

test('外观三轴：auto 是合法值，不是「没选」', () => {
  // 写成 `theme !== 'dark' ? 'light'` 的话，用户选的「跟随系统」每次刷新被打回常亮，
  // 而且是静默的 —— 这一条就是把它钉住
  assert.equal(normalizeUi({ theme: 'auto' }).theme, 'auto');
  assert.equal(normalizeUi({ theme: 'dark' }).theme, 'dark');
  assert.equal(normalizeUi({ theme: 'light' }).theme, 'light');
  assert.equal(normalizeUi({ theme: 'sepia' as never }).theme, 'light', '认不出的值兜回常亮');
});

test('外观三轴：缺省与认不出的值', () => {
  const d = normalizeUi(undefined);
  assert.equal(d.accent, 'jade');
  assert.equal(d.style, 'soft', 'soft 是空块 = 与旧版逐像素相同，所以它必须是默认');

  assert.equal(normalizeUi({ accent: 'clay' }).accent, 'clay');
  assert.equal(normalizeUi({ style: 'notion' }).style, 'notion');
  assert.equal(normalizeUi({ accent: 'chartreuse' as never }).accent, 'jade');
  assert.equal(normalizeUi({ style: 'brutalist' as never }).style, 'soft');
});

test('底栏 tabs：子集 + 顺序跟 navOrder 走 + 空了就回落', () => {
  // 缺省
  assert.deepEqual(normalizeUi(undefined).tabs, ['inbox', 'today', 'overdue', 'calendar']);

  // 只收 CUSTOMIZABLE 里的键 —— 设置不进底栏（它在「更多」里固定有一格）
  const mixed = normalizeUi({ tabs: ['habits', 'settings', 'inbox'] as string[] });
  assert.deepEqual(mixed.tabs, ['inbox', 'habits'], '认不出的键被滤掉');
  assert.ok(!mixed.tabs.includes('settings'), '设置不进底栏');

  // 顺序取自 navOrder，不保留盘上自己的顺序
  const reordered = normalizeUi({
    navOrder: ['done', 'inbox', 'today'],
    tabs: ['inbox', 'done'],
  });
  assert.deepEqual(reordered.tabs, ['done', 'inbox'], '按 navOrder 排');

  // 一次操作里过滤后为空 → 回落默认。这里空栏没有合法解释，与 navBottom 不同
  assert.deepEqual(normalizeUi({ tabs: [] }).tabs, ['inbox', 'today', 'overdue', 'calendar']);
  assert.deepEqual(normalizeUi({ tabs: ['nope'] as string[] }).tabs,
    ['inbox', 'today', 'overdue', 'calendar']);

  // 超过上限的砍掉 —— UI 挡不住手改 localStorage
  const many = normalizeUi({ tabs: ['inbox', 'today', 'overdue', 'calendar', 'habits'] });
  assert.deepEqual(many.tabs, ['inbox', 'today', 'overdue', 'calendar']);
});

/* ============================== 快速添加的默认值 ============================== */

test('快速添加默认值：待办箱无日期无时间，其余给今天', () => {
  const T = '2026-10-06';
  assert.deepEqual(quickDefaults({ nav: 'inbox' }, T), { date: null, time: null },
    '待办箱丢进去的就是「还没定哪天做」的事');
  assert.deepEqual(quickDefaults({ nav: 'today' }, T), { date: T, time: null });
  assert.deepEqual(quickDefaults({ nav: 'overdue' }, T), { date: T, time: null });
  assert.deepEqual(quickDefaults({ nav: 'habits' }, T), { date: T, time: null });
  assert.deepEqual(quickDefaults({ nav: 'done' }, T), { date: T, time: null });
  assert.deepEqual(quickDefaults({ nav: 'projects' }, T), { date: T, time: null });
});

test('快速添加默认值：日程页落在当前看的那天（cursor 是今天就是今天）', () => {
  const T = '2026-10-06';
  // cursor 是今天 → 今天
  assert.deepEqual(quickDefaults({ nav: 'calendar', cursor: T }, T), { date: T, time: null });
  // cursor 是别的那天 → 那天（日 / 周 /月视图都一样，默认落在光标那天）
  assert.deepEqual(quickDefaults({ nav: 'calendar', cursor: '2026-10-20' }, T),
    { date: '2026-10-20', time: null });
  assert.deepEqual(quickDefaults({ nav: 'calendar', cursor: '2026-11-03', view: 'week' }, T),
    { date: '2026-11-03', time: null });
  assert.deepEqual(quickDefaults({ nav: 'calendar', cursor: '2026-12-01', view: 'month' }, T),
    { date: '2026-12-01', time: null });
});

/* ============================== 横条上那个小按钮的日期写法 ============================== */

test('fmtSlashMD：月/日，不补零 —— 它要挤进按钮里两行中的一行', () => {
  // 「10月7日」在快速添加那个小按钮里会把按钮撑胖，所以另有一个最省的写法
  assert.equal(D.fmtSlashMD('2026-10-07'), '10/7');
  assert.equal(D.fmtSlashMD('2026-01-05'), '1/5');
  assert.equal(D.fmtSlashMD('2026-12-31'), '12/31');
});

/* ============================== 迁移 ============================== */

test('v3 → v4：补 seriesId、补墓碑、丢弃已删除的模块', () => {
  const r = migrateV3({
    version: 3,
    tasks: [
      { id: 't1', title: '每天的事', date: '2026-10-06', repeat: 'daily', createdAt: 1000 },
      { id: 't2', title: '一次性', date: '2026-10-07', repeat: null, createdAt: 2000 },
    ],
    trash: [
      { id: 'x1', kind: 'task', payload: { id: 't9', title: '删掉的' }, from: '今天', deletedAt: 5000 },
      { id: 'x2', kind: 'note', payload: { id: 'n1' }, deletedAt: 5000 },
    ],
    habits: [{ id: 'h1', title: '学英语', order: 0, log: { '2026-10-06': true }, createdAt: 3000 }],
    ui: { nav: 'today', theme: 'dark' },
  });

  const byId = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
  assert.equal(byId.t1.repeat.unit, 'day', '字符串型 repeat 要升级成对象');
  assert.equal(byId.t1.seriesId, 't1', '重复任务以自己为系列根');
  assert.equal(byId.t2.seriesId, null, '非重复任务没有系列根');

  assert.equal(byId.t9.deleted, true, '旧 trash 要变成墓碑');
  assert.equal(byId.t9.deletedAt, 5000);
  assert.equal(byId.t9.title, '删掉的', '墓碑要带着原内容，垃圾箱里才看得见');

  assert.equal(r.habits.length, 1);
  assert.equal(r.ui.theme, 'dark');
  assert.ok(r.ignored >= 1, '备忘录那条应被计入忽略');
});

test('v3 → v4 的实体带空的 _ts/_dev，等 store 建 op 时统一填', () => {
  const r = migrateV3({ tasks: [{ id: 't1', title: 'x', date: null }] });
  assert.deepEqual(r.tasks[0]._ts, {});
  assert.deepEqual(r.tasks[0]._dev, {});
});

/* ============================== 冲突提示 ============================== */

/** 造一条「我这一轮推上去的 op」 */
const op = (fields: Record<string, unknown>, over: Partial<Op> = {}): Op => ({
  opId: 'o1', deviceId: 'me', ts: 1000, calId: 'c1', entity: 'task', entityId: 't1',
  fields, ...over,
});
/** 造一条「这一轮响应里带回来的别人的改动」 */
const chg = (field: string, value: unknown, over: Partial<Change> = {}): Change => ({
  entity: 'task', entityId: 't1', field, value, ts: 2000, deviceId: 'other', ...over,
});

test('同一字段两边都改过才算冲突，方向两个都报', () => {
  // 对方更新 → 对方赢
  const lose = findConflicts([op({ title: '我的' })], [chg('title', '对方的', { ts: 2000 })], 'me');
  assert.equal(lose.length, 1);
  assert.equal(lose[0].winner, 'theirs');
  assert.equal(lose[0].mine, '我的');
  assert.equal(lose[0].theirs, '对方的');

  // 对方更旧（比如他那台时钟慢）→ 我赢，但一样要报：他那一下被盖掉了
  const win = findConflicts([op({ title: '我的' })], [chg('title', '对方的', { ts: 500 })], 'me');
  assert.equal(win.length, 1);
  assert.equal(win[0].winner, 'mine');
});

test('改的不是同一个字段、不是同一条、以及自己刚推的回显，都不算冲突', () => {
  assert.deepEqual(findConflicts([op({ title: 'x' })], [chg('note', 'y')], 'me'), [],
    '我改标题、对方改备注，两个改动都留得住，没什么好提示的');
  assert.deepEqual(
    findConflicts([op({ title: 'x' })], [chg('title', 'y', { entityId: 't2' })], 'me'), [],
    '不同的实体');
  assert.deepEqual(
    findConflicts([op({ title: 'x' })], [chg('title', 'x', { deviceId: 'me', ts: 3000 })], 'me'), [],
    '自己刚推上去的那条会原样回显，不能当成别人改的');
});

test('一条 op 带了几个字段，就逐个字段各判一次', () => {
  const r = findConflicts(
    [op({ title: '我的标题', time: '09:00' })],
    [chg('title', '对方的标题'), chg('time', '10:00')],
    'me',
  );
  assert.deepEqual(r.map((c) => c.field).sort(), ['time', 'title']);
});

test('resolveDefaultCal：默认日程集是一个显式字段，改名不会让它失效', () => {
  // 三步回落，各锁一条
  const cals = [
    { id: 'a', name: '工作', ownerId: 'u1', createdAt: 1, role: 'owner' as const },
    { id: 'b', name: '我的日程', ownerId: 'u2', createdAt: 2, role: 'viewer' as const },
  ];

  // ① 选过的就是它，**名字叫什么都算**
  assert.equal(resolveDefaultCal({ defaultCal: 'b' }, cals), 'b',
    '选过的那个哪怕是个只读的集、名字还正好叫「我的日程」，也是默认');
  assert.equal(resolveDefaultCal({ defaultCal: 'a' }, [
    { ...cals[0], name: '改过的名字' }, cals[1],
  ]), 'a', '改过名之后仍然是默认 —— 以前 `name === \'我的日程\'` 这里就断了');

  // ② 选过的那个已经不在了（被踢 / 被删 / 我退出了）→ 退到**第一个自己建的**
  assert.equal(resolveDefaultCal({ defaultCal: 'gone' }, cals), 'a',
    '不该退到列表第一个：b 是别人建的，我只读，把别人的集当默认没意义');
  assert.equal(resolveDefaultCal({ defaultCal: null }, cals), 'a', '没选过 → 第一个自己建的');

  // ③ 一个自己建的都没有 → 列表第一个；一个集都没有 → null
  assert.equal(resolveDefaultCal({ defaultCal: null }, [cals[1]]), 'b',
    '只有别人的集时就用那一个，不要硬造默认');
  assert.equal(resolveDefaultCal({ defaultCal: null }, []), null, '一个集都没有');

  // 关键回归：**别人建一个叫「我的日程」的集**，按名字比会认错
  assert.equal(resolveDefaultCal({ defaultCal: null }, [
    { id: 'b', name: '我的日程', ownerId: 'u2', createdAt: 2, role: 'viewer' as const },
    cals[0],
  ]), 'a', '「我的日程」是个普通名字，不是标记；真正的默认是第一个自己建的集');
});

test('normalizeUi：defaultCal 缺省 / 空串都归一成 null，老用户那份不会被打回', () => {
  assert.equal(defaultUi().defaultCal, null, '新装：没选过');
  assert.equal(normalizeUi(undefined).defaultCal, null);
  assert.equal(normalizeUi({}).defaultCal, null);
  // 老版本没这个字段 → raw 里是 undefined，铺开 defaultUi 之后是 null
  assert.equal(normalizeUi({ nav: 'today' }).defaultCal, null);
  // 空串 = 「显式没选」，跟 null 一回事（否则星标那一栏永远点不亮）
  assert.equal(normalizeUi({ defaultCal: '' }).defaultCal, null);
  assert.equal(normalizeUi({ defaultCal: 'cal-1' }).defaultCal, 'cal-1');
  // 类型不对的（盘上被人手改过）也归零，别让它漏到 resolveDefaultCal
  assert.equal(normalizeUi({ defaultCal: 7 as unknown as string }).defaultCal, null);
});

test('setDefaultCal：空串与 null 同义，不会写出「有个默认是空串」', () => {
  const ui = defaultUi();
  setDefaultCal(ui, 'cal-1');
  assert.equal(ui.defaultCal, 'cal-1');
  setDefaultCal(ui, '   ');
  assert.equal(ui.defaultCal, null, '纯空白 = 没选');
  setDefaultCal(ui, 'cal-2');
  setDefaultCal(ui, null);
  assert.equal(ui.defaultCal, null);
  assert.equal(defaultUi().defaultCal, null, 'defaultUi() 返回的是新对象，不会被上一个改脏');
});

/* =============== 浮层锚定定位（placePanel）===============
   四份逐字相同的算式（DatePicker / TimePicker / WhenPop / useDrawer 的
   「重复」浮层）收敛到这里，先锁住行为再接回去。 */

test('placePanel：下方放得下就贴下沿（+6），左对齐 anchor', () => {
  assert.deepEqual(
    placePanel({
      anchor: { top: 100, bottom: 130, left: 40 },
      size: { w: 200, h: 150 }, viewport: { w: 1200, h: 800 },
    }),
    { top: 136, left: 40 });
});

test('placePanel：下方放不下 → 翻到 anchor 上方（top-高度-6）', () => {
  assert.deepEqual(
    placePanel({
      anchor: { top: 700, bottom: 730, left: 40 },
      size: { w: 200, h: 150 }, viewport: { w: 1200, h: 800 },
    }),
    { top: 544, left: 40 });
});

test('placePanel：右缘超出 → 往左收，贴到视口右边留 8px', () => {
  assert.deepEqual(
    placePanel({
      anchor: { top: 100, bottom: 130, left: 1100 },
      size: { w: 200, h: 150 }, viewport: { w: 1200, h: 800 },
    }),
    { top: 136, left: 992 });
});

test('placePanel：上下都塞不下（比视口还高）→ 上方钳到 8px，不飞出视口', () => {
  assert.deepEqual(
    placePanel({
      anchor: { top: 20, bottom: 780, left: 40 },
      size: { w: 200, h: 700 }, viewport: { w: 1200, h: 800 },
    }),
    { top: 8, left: 40 });
});

test('repeatLast：不结束 → null', () => {
  const task = makeTask({ id: 'a', title: 'x', date: T, repeat: repeat({ unit: 'day' }) });
  assert.equal(repeatLast(task, T), null);
});

test('repeatLast（2026-10-12）：按日期结束 → 最后一天不晚于结束日期', () => {
  const task = makeTask({
    id: 'a', title: 'x', date: T,
    repeat: { ...repeat({ unit: 'day' }), end: { type: 'date', date: '2027-03-15' } },
  });
  const last = repeatLast(task, T);
  assert.ok(last !== null, '设了结束日期就该有最后一次');
  assert.ok(last <= '2027-03-15', `最后一次不能晚于结束日期，实际 ${last}`);
  assert.equal(D.addDays(last!, 1) > '2027-03-15', true, '再往后走一步就该超出结束日期');
});

test('repeatLast（2026-10-12）：按次数结束 → 第 N 次发生', () => {
  const task = makeTask({
    id: 'a', title: 'x', date: T,
    repeat: { ...repeat({ unit: 'day' }), end: { type: 'count', count: 3 } },
  });
  assert.equal(repeatLast(task, T), '2026-10-08');
});

test('repeatLast（2026-10-12）：count=1 → 就是第一次', () => {
  const task = makeTask({
    id: 'a', title: 'x', date: T,
    repeat: { ...repeat({ unit: 'day' }), end: { type: 'count', count: 1 } },
  });
  assert.equal(repeatLast(task, T), T);
});

test('fmtSmart（2026-10-12）：今年不写年份，跨年写年份', () => {
  const y = new Date().getFullYear();
  const thisYear = `${y}-07-15`;
  const nextYear = `${y + 1}-07-15`;
  assert.equal(D.fmtSmart(thisYear), '7月15日', '今年不该出现年份');
  assert.equal(D.fmtSmart(nextYear), `${y + 1}年7月15日`, '跨年必须带年份');
});

/* =============== 未定时空白新建位（untimedBlanks，P0-2）===============
   日/周共用：永远多留一整行可点空白。空天返回 0 ——
   日视图空区由 zone-empty 文案占位，周视图 WunCell 另行给 1 格。 */

test('untimedBlanks：空天 0 格，日周调用方各自决定空态怎么画', () => {
  assert.equal(untimedBlanks(0, 3), 0);
  assert.equal(untimedBlanks(0, 1), 0);
});

test('untimedBlanks：凑满「当前行 + 一整行」', () => {
  // 日视图桌面 3 列：1 张卡 → 当前行剩 2 格 + 一整行 3 格 = 5
  assert.equal(untimedBlanks(1, 3), 5);
  // 4 张卡 → 当前行剩 2 格 + 一整行 3 格 = 5
  assert.equal(untimedBlanks(4, 3), 5);
  // 整行满 3 张 → 再留一整行 3 格
  assert.equal(untimedBlanks(3, 3), 3);
  // 周视图单列：2 张卡 → 当前行剩 0？不，ceil(2/1)=2 行满 → 再留 1 行 = 1
  assert.equal(untimedBlanks(2, 1), 1);
  assert.equal(untimedBlanks(1, 1), 1);
});

/* =============== 未定时行高 = 这一屏上的「一小时」（untimedRowPx，三问题统一）===============
   定时卡高由**时间槽**定（`calc(百分比 − 1.5px)`），未定时卡以前由**行高**定
   （行高 16 + padding 1×2 + 边框 1×2 = 20px）—— 两套公式让 1 小时卡与未定时卡
   永远对不齐（2026-10-24 窄屏实测 22.28 vs 20，圆角 / padding 跟着各长各的）。
   挂到同一个「一小时」单位上，两张卡的高与圆角（都按自身高的 30%）自动处处一致。

   ⚠️ 「一小时」一律**按整天摊开**算，不跟着时间窗收窄放大（见下面那条窄窗用例）：
   时间窗可以收到 3 小时，按窗算会把未定时行撑成 188px，未定时区把日面板撑穿
   （2026-10-24 browser-smoke 抓到：定时卡被压成 12px、拖出面板）。 */

test('untimedRowPx：等于这一屏上按整天摊开的 1 小时卡高（含 1.5px 缝）', () => {
  // 窄屏实测口径：容器 570.8px → 一小时 23.78px，卡高 22.28px
  assert.ok(Math.abs(untimedRowPx(570.8, 1440) - 22.28) < 0.02,
    `570.8 容器应给 22.28，实得 ${untimedRowPx(570.8, 1440)}`);
  // 桌面实测口径：673.8px 容器 → 26.57
  assert.ok(Math.abs(untimedRowPx(673.8, 1440) - 26.57) < 0.02,
    `673.8 容器应给 26.57，实得 ${untimedRowPx(673.8, 1440)}`);
});

test('untimedRowPx：与 1 小时定时卡的高度同源（pctRange 换算对得上）', () => {
  const w = FULL_DAY;
  const tlH = 673.8;
  const box = pctRange(600, 660, w);
  assert.ok(box !== null, '10:00–11:00 在整天窗口内该有盒子');
  const timedH = (box!.height / 100) * tlH - CARD_SEAM;
  assert.ok(Math.abs(untimedRowPx(tlH, spanOf(w)) - timedH) < 0.01,
    `未定时行高 ${untimedRowPx(tlH, spanOf(w))} 应等于 1h 定时卡高 ${timedH}`);
});

test('untimedRowPx：时间窗收窄不许把未定时行撑大（撑大会把日面板捅穿）', () => {
  const wide = untimedRowPx(620, 1440);
  const narrowWin = untimedRowPx(620, 180);   // 08:00–11:00：窗里的一小时 = 206px
  assert.equal(narrowWin, wide,
    `180 分钟窗口的行高必须和整天口径一致（${narrowWin} vs ${wide}）`);
  assert.ok(narrowWin < 30, `行高该留在正常一档，实得 ${narrowWin}`);
});

test('untimedRowPx：容器还没量到 / 窗口非法 → 0（调用方回落 CSS 默认 --row）', () => {
  assert.equal(untimedRowPx(0, 1440), 0);
  assert.equal(untimedRowPx(-5, 1440), 0);
  assert.equal(untimedRowPx(600, 0), 0);
  assert.equal(untimedRowPx(600, 30), 0);
  assert.equal(untimedRowPx(Number.NaN, 1440), 0);
});

/* =============== 当天定时事件摆放（dayTimeline，P0-3）===============
   DayView 45-58 ≡ WeekView dayEvents 那两份逐字代码收口到这里。
   未定时（time=null）的过滤掉；默认时长 60 分钟（durOf(null)）。 */

test('dayTimeline：只收有时间的，未定时过滤掉', () => {
  const tasks = [
    makeTask({ id: 'a', title: '定时', date: T, time: '09:00', duration: 60 }),
    makeTask({ id: 'b', title: '未定时', date: T }),
  ];
  const placed = dayTimeline(tasks);
  assert.equal(placed.length, 1);
  assert.equal(placed[0].item.id, 'a');
  assert.equal(placed[0].start, 540);
  assert.equal(placed[0].end, 600);
});

test('dayTimeline：重叠分列与 layoutOverlap 一致', () => {
  const tasks = [
    makeTask({ id: 'a', title: '甲', date: T, time: '09:00', duration: 120 }),
    makeTask({ id: 'b', title: '乙', date: T, time: '09:30', duration: 60 }),
    makeTask({ id: 'c', title: '丙', date: T, time: '14:00', duration: 30 }),
  ];
  const placed = dayTimeline(tasks);
  assert.equal(placed.length, 3);
  const byId = Object.fromEntries(placed.map((p) => [p.item.id, p]));
  // 甲乙重叠 → 同一簇 cols=2；丙独立 → cols=1
  assert.equal(byId.a.cols, 2);
  assert.equal(byId.b.cols, 2);
  assert.equal(byId.c.cols, 1);
  assert.notEqual(byId.a.col, byId.b.col);
});

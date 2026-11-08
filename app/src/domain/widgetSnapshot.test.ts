/**
 * widgetSnapshot.test.ts —— 小组件快照测试
 *
 * 这份快照是**小组件唯一的数据来源**，格式错一次的表现是「桌面上一片空白」
 * 或者「箭头切周后日期对不上」，所以这里把范围、过滤、排序都钉住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as D from './date.ts';
import { buildWidgetSnapshot, serializeWidgetSnapshot, widgetRange, WIDGET_WEEKS } from './widgetSnapshot.ts';
import { makeTask, makeHabit, normalizeUi } from './model.ts';
import type { Habit, LocalState, Task } from './types.ts';

const T = '2026-10-06';   // 周二

/** T 对应的本地固定时刻（中午 12:00，避开时区边界）。node:test 的 mock.timers
 *  用它把系统 Date 钉在 T，让 serializeWidgetSnapshot 默认路径里的 D.today()
 *  恒等于 T —— 日期稳定、又不绕开真实 serializer。 */
const T_NOW = D.parseISO(T).getTime() + 12 * 60 * 60 * 1000;

function state(tasks: Task[] = [], habits: Record<string, Habit> = {}): LocalState {
  return {
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    habits,
    projects: {},
    cals: [],
    invites: [],
    cursor: 0,
    outbox: [],
    ui: normalizeUi(undefined),
    lastError: null,
  } as unknown as LocalState;
}

test('覆盖范围：本周前后各 4 周，按周一对齐', () => {
  const r = widgetRange(T);
  assert.equal(r.from, '2026-09-07');   // 10-05 往前 28 天
  assert.equal(r.to, '2026-11-08');     // 10-05 往后 28 天 + 6
  assert.equal(D.weekdayOf(r.from), 1, '起点必须是周一');
  assert.equal(D.weekdayOf(r.to), 0, '终点必须是周日');
  // 一共 9 周（前后各 4 + 本周）
  assert.equal((D.diffDays(r.to, r.from) + 1) / 7, WIDGET_WEEKS * 2 + 1);
});

test('窗口外的任务不进快照', () => {
  const s = state([
    makeTask({ title: '窗口内', date: T }),
    makeTask({ title: '太早', date: '2026-09-06' }),      // from 前一天
    makeTask({ title: '太晚', date: '2026-11-09' }),      // to 后一天
    makeTask({ title: '无日期', date: null }),             // 待办箱
  ]);
  const snap = buildWidgetSnapshot(s, T);
  assert.deepEqual(snap.tasks.map((t) => t.title), ['窗口内']);
});

test('垃圾箱与彻底删除的不进快照', () => {
  const s = state([
    makeTask({ title: '正常', date: T }),
    makeTask({ title: '在垃圾箱', date: T, deleted: true }),
    makeTask({ title: '彻底删了', date: T, purged: true }),
  ]);
  assert.deepEqual(buildWidgetSnapshot(s, T).tasks.map((t) => t.title), ['正常']);
});

test('同一天：定时任务按时间升序，未定时的排最后', () => {
  const s = state([
    makeTask({ title: '下午', date: T, time: '15:00' }),
    makeTask({ title: '早上', date: T, time: '08:30' }),
    makeTask({ title: '未定时', date: T, time: null }),
    makeTask({ title: '中午', date: T, time: '12:00' }),
  ]);
  const snap = buildWidgetSnapshot(s, T);
  assert.deepEqual(snap.tasks.map((t) => t.title), ['早上', '中午', '下午', '未定时']);
  assert.equal(snap.tasks[3].time, null);
});

test('不同天：按日期升序，时间只在天内起作用', () => {
  const s = state([
    makeTask({ title: '周三晚', date: D.addDays(T, 1), time: '22:00' }),
    makeTask({ title: '周二早', date: T, time: '06:00' }),
    makeTask({ title: '周三早', date: D.addDays(T, 1), time: '06:00' }),
  ]);
  const snap = buildWidgetSnapshot(s, T);
  assert.deepEqual(snap.tasks.map((t) => t.title), ['周二早', '周三早', '周三晚']);
});

test('打卡：done 看今天，streak 按今天/昨天起算', () => {
  const log: Record<string, true> = {
    [T]: true, '2026-10-05': true, '2026-10-04': true, '2026-09-30': true,
  };
  const habit = { ...makeHabit('学英语', 0, 'c1'), log };
  const snap = buildWidgetSnapshot(state([], { h1: habit }), T);
  assert.deepEqual(snap.habits, [{
    id: habit.id, calId: 'c1', title: '学英语', done: true, streak: 3,
    // 整张表必须原样带上（2026-10-26：缺了它小组件上打完卡会弹回浅色）
    log,
    // 分组归属（2026-11-03）：没分组 → null = 未分类
    grp: null,
  }]);
});

test('分组进快照：groups 按 order 排、grp 用 groupOfHabit 的裁决（悬空算未分类）', () => {
  const s = state([], { h1: makeHabit('学英语', 0, 'c1') });
  s.habitGroups = {
    g2: { id: 'g2', name: '运动', order: 10, calId: 'c1', createdAt: 1 } as never,
    g1: { id: 'g1', name: '工作学习', order: 0, calId: 'c1', createdAt: 1 } as never,
    // 悬空引用：h1 指向已删除的分类 → 必须裁决成未分类，不能画出幽灵组
    gone: { id: 'gone', name: '已删', order: 20, calId: 'c1', deleted: true, deletedAt: 2 } as never,
  };
  s.habits.h1.groupId = 'gone';
  const snap = buildWidgetSnapshot(s, T);
  // liveGroups 已剔墓碑，且按 order 升序
  assert.deepEqual(snap.groups.map((g) => g.name), ['工作学习', '运动']);
  // 悬空 groupId → 未分类（null）
  assert.equal(snap.habits[0].grp, null);
  // 归到活组
  s.habits.h1.groupId = 'g2';
  assert.equal(buildWidgetSnapshot(s, T).habits[0].grp, 'g2');
});

test('打卡记录整张表进快照 —— 缺了它小组件「点完又弹回浅色」', () => {
  // 用户在桌面点了 10-07 的卡（不是今天），原生按 log[选中日] 取色。
  // 只带 done 的话：那一格永远浅色，而且下次 App 推快照会把历史抹平。
  const log: Record<string, true> = { [T]: true, '2026-10-07': true };
  const habit = { ...makeHabit('学英语', 0, 'c1'), log };
  const raw = JSON.parse(serializeWidgetSnapshot(state([], { h1: habit })));
  assert.deepEqual(raw.habits[0].log, log, '序列化后 log 必须还在');
  assert.equal(buildWidgetSnapshot(state([], { h1: habit }), T).habits[0].done, true,
    'done 仍按基准日算，保持兼容');
});

test('习惯排序：order 升序 + id 兜底，缺 order 排最后（与服务端逐字一致）', () => {
  // 两边的排序口径以前不一致（JS 缺 order 排最后、服务端排最前），同一批
  // 习惯换一条数据来源就整体换位置 —— 用户看到「打完卡格子自己换了位置」。
  // 这里把契约钉死：order 升序，同 order 用 id 字典序，缺 order 视作最大。
  const mk = (title: string, order: number | undefined, id: string) => {
    const h = { ...makeHabit(title, order ?? 0, 'c1'), id };
    if (order === undefined) delete (h as { order?: number }).order;
    return h;
  };
  const s2 = state([], {
    h3: mk('无order', undefined, 'h3'),
    h1: mk('第二个', 2, 'h1'),
    h2: mk('并列A', 1, 'h2'),   // 与下一条 order 相同 → 按 id 字典序（h2 < h4）
    h4: mk('并列B', 1, 'h4'),
  });
  const got = buildWidgetSnapshot(s2, T).habits.map((h) => h.title);
  assert.deepEqual(got, ['并列A', '并列B', '第二个', '无order']);
});

test('没有打卡记录的打卡，log 是空对象而不是缺字段', () => {
  const habit = makeHabit('学英语', 0, 'c1');
  const snap = buildWidgetSnapshot(state([], { h1: habit }), T);
  assert.deepEqual(snap.habits[0].log, {}, '缺字段等于「老服务端」，原生要能区分');
});

test('每条都带 calId，快照带 today —— 原生直连写服务器缺了这两样就写不进去', (ctx) => {
  // 这条是给 B 方案兜底的。原生的 WidgetApi 发 op 时要 calId 去查权限，
  // 服务端那边只做 `if (!calId) continue`（不报错），所以缺了的表现是
  // 「桌面点了半天，服务器没变」—— 静默失败，最难查。
  // ① 固定基准日 T 的窗口功能继续单独钉住：today 必须是传入的那个基准日。
  const fixed = makeTask({ title: '交房租', date: T, calId: 'c1', time: '09:00' });
  const snap = buildWidgetSnapshot(state([fixed], { h1: makeHabit('学英语', 0, 'c2') }), T);
  assert.equal(snap.today, T, 'today 必须是传入的那个基准日');
  assert.equal(snap.tasks[0].calId, 'c1');
  assert.equal(snap.habits[0].calId, 'c2');

  /* ② 必须真的调用 serializeWidgetSnapshot(s)（默认按 D.today() 取窗口）。
     用 node:test 的 mock.timers 把系统 Date 钉在基准日 T 的本地中午：默认路径的
     D.today() 恒等于 T，样本任务 date 也固定为 T，于是序列化输出与真实运行日无关，
     又不绕开 serializer（上一版改按固定 T 显式 JSON.stringify 会把这条覆盖率丢掉）。 */
  ctx.mock.timers.enable({ apis: ['Date'], now: T_NOW });
  try {
    assert.equal(D.today(), T, 'mock 生效：默认窗口的今天必须是 T');
    const task = makeTask({ title: '交房租', date: T, calId: 'c1', time: '09:00' });
    const s = state([task], { h1: makeHabit('学英语', 0, 'c2') });
    const raw = JSON.parse(serializeWidgetSnapshot(s));
    assert.equal(raw.today, T, 'serializer 默认窗口的 today 必须是 T');
    assert.equal(raw.tasks.length, 1, '真实序列化输出里必须真有这 1 条任务');
    assert.equal(raw.tasks[0].calId, 'c1', '真实序列化输出里 calId 必须还在');
    assert.equal(raw.tasks[0].id, task.id);
    assert.equal(raw.tasks[0].note, '', '真实序列化输出里 note 必须是空串');
    assert.equal(raw.habits[0].calId, 'c2');
  } finally {
    ctx.mock.timers.reset();   // mock 只影响本测试，测试结束前显式恢复
  }
});

test('打卡：今天还没打但昨天打过，streak 仍从昨天起算且 done=false', () => {
  const log: Record<string, true> = { '2026-10-05': true, '2026-10-04': true };
  const habit = { ...makeHabit('学英语', 0, 'c1'), log };
  const snap = buildWidgetSnapshot(state([], { h1: habit }), T);
  assert.equal(snap.habits[0].done, false);
  assert.equal(snap.habits[0].streak, 2);
});

test('打卡：断了两天以上，streak 归零', () => {
  const log: Record<string, true> = { '2026-10-03': true };
  const habit = { ...makeHabit('学英语', 0, 'c1'), log };
  assert.equal(buildWidgetSnapshot(state([], { h1: habit }), T).habits[0].streak, 0);
});

test('打卡按 order 排序，剔掉已删除的', () => {
  const habits = {
    b: makeHabit('第二', 1, 'c1'),
    a: makeHabit('第一', 0, 'c1'),
    gone: { ...makeHabit('删了', 2, 'c1'), deleted: true },
  };
  assert.deepEqual(
    buildWidgetSnapshot(state([], habits), T).habits.map((h) => h.title),
    ['第一', '第二'],
  );
});

test('快照带版本号与生成时刻', () => {
  const snap = buildWidgetSnapshot(state(), T);
  assert.equal(snap.v, 1);
  assert.equal(typeof snap.at, 'number');
  assert.equal(snap.from, '2026-09-07');
  assert.equal(snap.to, '2026-11-08');
});

test('详细内容随任务一起发给小组件 —— 桌面靠它在标题下多出一行', (ctx) => {
  // 固定基准日 T 的窗口功能继续验证（与 serializer 默认路径分开）。
  const t = makeTask({ title: '交房租', date: T, time: '09:00', calId: 'c1' });
  t.note = '房东说转账备注里要写门牌号，别写昵称';
  const snap = buildWidgetSnapshot(state([t]), T);
  assert.equal(snap.tasks[0].note, '房东说转账备注里要写门牌号，别写昵称');

  /* 原生侧 `WTask` 对这个键做的是 `optString`（没有就 ""），所以序列化出去的
     那一份必须**真的是空串**，不能是 undefined —— 后者会被 JSON.stringify
     整个丢掉，虽然结果一样是「读不到」，但那是靠巧合通过，换了写法就断。
     这两条断言都走真实 serializeWidgetSnapshot(s)：同上一测试，用 mock.timers
     把系统 Date 钉在 T，样本任务 date 固定为 T，默认窗口必然包含它，
     与真实运行日无关，也不绕开 serializer 覆盖率。 */
  ctx.mock.timers.enable({ apis: ['Date'], now: T_NOW });
  try {
    assert.equal(D.today(), T, 'mock 生效：默认窗口的今天必须是 T');
    const withNote = makeTask({ title: '交房租', date: T, time: '09:00', calId: 'c1' });
    withNote.note = '房东说转账备注里要写门牌号，别写昵称';
    const raw = JSON.parse(serializeWidgetSnapshot(state([withNote])));
    assert.equal(raw.today, T, 'serializer 默认窗口的 today 必须是 T');
    assert.equal(raw.tasks.length, 1, '真实序列化输出里必须真有这 1 条任务');
    assert.equal(raw.tasks[0].id, withNote.id);
    assert.equal(raw.tasks[0].calId, 'c1');
    assert.equal(raw.tasks[0].note, '房东说转账备注里要写门牌号，别写昵称',
      '真实序列化输出里 note 必须是 plain() 后的纯文本');

    const bare = makeTask({ title: '买牛奶', date: T, calId: 'c1' });
    const bareRaw = JSON.parse(serializeWidgetSnapshot(state([bare])));
    assert.equal(bareRaw.tasks.length, 1, '真实序列化输出里必须真有这 1 条任务');
    assert.equal(bareRaw.tasks[0].note, '', '没有详细内容时必须是空串');
  } finally {
    ctx.mock.timers.reset();   // mock 只影响本测试，测试结束前显式恢复
  }
});

test('每条任务都带 id —— 小组件要靠它勾选 / 改期', () => {
  const t = makeTask({ title: '带 id', date: T, time: '09:00' });
  const snap = buildWidgetSnapshot(state([t]), T);
  assert.equal(snap.tasks[0].id, t.id);
  assert.equal(snap.tasks[0].title, '带 id');
  assert.equal(snap.tasks[0].time, '09:00');
  assert.equal(snap.tasks[0].done, false);
});

/**
 * widgetSnapshot.test.ts —— 小组件快照测试
 *
 * 这份快照是**小组件唯一的数据来源**，格式错一次的表现是「桌面上一片空白」
 * 或者「箭头切周后日期对不上」，所以这里把范围、过滤、排序都钉住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as D from './date.ts';
import { buildWidgetSnapshot, widgetRange, WIDGET_WEEKS } from './widgetSnapshot.ts';
import { makeTask, makeHabit, normalizeUi } from './model.ts';
import type { Habit, LocalState, Task } from './types.ts';

const T = '2026-10-06';   // 周二

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
    id: habit.id, title: '学英语', done: true, streak: 3,
  }]);
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

test('每条任务都带 id —— 小组件要靠它勾选 / 改期', () => {
  const t = makeTask({ title: '带 id', date: T, time: '09:00' });
  const snap = buildWidgetSnapshot(state([t]), T);
  assert.equal(snap.tasks[0].id, t.id);
  assert.equal(snap.tasks[0].title, '带 id');
  assert.equal(snap.tasks[0].time, '09:00');
  assert.equal(snap.tasks[0].done, false);
});

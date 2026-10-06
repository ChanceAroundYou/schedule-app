/**
 * store.test.ts —— 本地状态与写入通道
 *
 * 重点是**勾选重复任务时的派生**：这是最容易悄悄坏掉、坏了又不容易发现的
 * 一段。派生 id 一旦退回随机数，两台设备离线各勾一次就会同步出两条任务，
 * 而单机测试完全看不出来。
 *
 *   cd app && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * localStorage 垫片。
 *
 * 必须在**调用** store 之前装好 —— 但 ESM 的 import 会被提升到模块顶部，
 * 所以这里改成动态 import。store.ts / device.ts 都只在函数体里碰
 * localStorage，模块求值阶段不会用到，因此这个顺序是安全的。
 */
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
const { counts, liveTasks } = await import('../domain/model.ts');

const TODAY = D.today();

/** 测试里用的那个日程集。**每个用例都必须先有一个可写的集** ——
 *  写入通道会检查权限，一个集都没有时改动会被挡下（这正是它该做的），
 *  于是所有断言都会莫名其妙地失败。 */
const CAL = 'cal-1';

function fresh(): void {
  mem.clear();
  store.resetLocal();
  store.setCals([{ id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' }]);
  store.setActiveCal(CAL);
}

/** 加一条任务，返回它的 id */
function add(title: string, over: Record<string, unknown> = {}): string {
  return store.addTask({ title, date: TODAY, ...over });
}

/* ==================== 勾选重复任务时的派生 ==================== */

test('勾选一条重复任务会派出下一次，id 由 seriesId 与发生日派生', () => {
  fresh();
  const root = add('早会', { time: '09:00', repeat: { unit: 'day' } });

  assert.equal(store.get().tasks[root].seriesId, root, '重复任务以自己为系列根');

  store.toggleTask(root);

  const nextDate = D.addDays(TODAY, 1);
  const nextId = root + '#' + nextDate;
  const next = store.get().tasks[nextId];

  assert.ok(next, '应该派生出 ' + nextId + '，实际有：' + Object.keys(store.get().tasks).join(', '));
  assert.equal(next.date, nextDate);
  assert.equal(next.seriesId, root, '实例的系列根指向最初那条，不是它自己');
  assert.equal(next.done, false);
  assert.equal(next.repeatSeq, 1, '推进次数要 +1，end.type=count 靠它');
  assert.equal(next.title, '早会', '标题跟着系列走');
  assert.equal(next.time, '09:00', '时间也要继承');
  assert.equal(store.get().tasks[root].done, true, '完成的那一条留在原日期上，不抹掉');
});

test('同一条重复任务反复勾选，不会重复派生同一个发生日', () => {
  fresh();
  const root = add('早会', { repeat: { unit: 'day' } });

  store.toggleTask(root);
  const after1 = Object.keys(store.get().tasks).length;

  store.toggleTask(root);            // 取消勾选
  store.toggleTask(root);            // 再勾上 —— 下一次的实例已经存在了
  assert.equal(
    Object.keys(store.get().tasks).length, after1,
    '第二次勾上不该再派生一条（派生 id 相同，是同一实体）',
  );
});

test('重复任务链会一直往前推进', () => {
  fresh();
  const root = add('早会', { repeat: { unit: 'day' } });

  store.toggleTask(root);
  const day1 = root + '#' + D.addDays(TODAY, 1);
  store.toggleTask(day1);
  const day2 = root + '#' + D.addDays(TODAY, 2);

  assert.ok(store.get().tasks[day2], '第二天勾完要派生出第三天');
  assert.equal(store.get().tasks[day2].repeatSeq, 2);
});

test('非重复任务勾选后不派生任何东西', () => {
  fresh();
  const id = add('买菜');
  store.toggleTask(id);
  assert.equal(Object.keys(store.get().tasks).length, 1);
});

test('派生的实例带着一条可推送的 op，且带上日期字段', () => {
  fresh();
  const root = add('早会', { repeat: { unit: 'day' } });
  store.toggleTask(root);

  const nextId = root + '#' + D.addDays(TODAY, 1);
  const op = store.get().outbox.find((o) => o.entityId === nextId);
  assert.ok(op, '派生的实例必须进 outbox，否则推不到服务器');
  assert.equal(op.entity, 'task');
  assert.equal(op.fields.date, D.addDays(TODAY, 1));
  assert.equal(op.fields.seriesId, root);
  assert.ok(op.opId && op.deviceId && op.ts, 'op 要带幂等键、设备标识和时间戳');
});

/* ==================== 远端变更的合并 ==================== */

test('远端只给一个字段时补全其余字段，查询不会崩', () => {
  fresh();
  const { applyRemote } = store;

  // 服务器可能只发来「标题变了」这一条 —— 本地之前完全不知道这个实体
  applyRemote([
    { entity: 'task', entityId: 't1', field: 'title', value: '远端来的', ts: 1000, deviceId: 'devB' },
  ]);

  const t = store.get().tasks.t1;
  assert.ok(t);
  // 这几个查询都会摸 t.title / t.date / t.repeat.unit，缺一个就抛
  assert.equal(t.title, '远端来的');
  assert.equal(t.date, null);
  assert.equal(t.repeat.unit, 'none');
  assert.doesNotThrow(() => counts(store.get()));
  assert.equal(liveTasks(store.get()).length, 1);
});

test('合并遵守 LWW：旧的变更不动本地，新的覆盖', () => {
  fresh();
  const { applyRemote } = store;
  const c = (ts: number, value: string) =>
    ({ entity: 'task' as const, entityId: 't1', field: 'title', value, ts, deviceId: 'devA' });

  applyRemote([c(2000, '新')]);
  assert.equal(store.get().tasks.t1.title, '新');

  applyRemote([c(1000, '旧')]);
  assert.equal(store.get().tasks.t1.title, '新', '更旧的变更必须被拒绝');

  applyRemote([c(3000, '更新')]);
  assert.equal(store.get().tasks.t1.title, '更新');
});

test('快照摊平后走同一条合并路径', () => {
  fresh();
  const snap = {
    tasks: {
      s1: Object.assign(
        // 服务器发来的实体就是「字段 + 逐字段 ts/_dev」这个形状
        { id: 's1', title: '快照任务', date: TODAY, done: false },
        { _ts: { title: 500, date: 500, done: 500 }, _dev: { title: 'devZ', date: 'devZ', done: 'devZ' } },
      ),
    },
    habits: {},
  };

  const changes = store.flattenSnapshot(snap as never);
  assert.equal(changes.length, 3, 'id / _ts / _dev 不该被当成数据字段');
  assert.ok(changes.every((c) => c.ts === 500 && c.deviceId === 'devZ'));

  store.applyRemote(changes);
  assert.equal(store.get().tasks.s1.title, '快照任务');
  assert.doesNotThrow(() => counts(store.get()));
});

/* ==================== 拖拽排序 ==================== */

test('重排只写位次真的变了的那些，且从 0 起按 10 递进', () => {
  fresh();
  const a = add('a');
  const b = add('b');
  const c = add('c');

  store.reorder('task', [c, a, b]);

  const t = store.get().tasks;
  assert.equal(t[c].ord, 0);
  assert.equal(t[a].ord, 10);
  assert.equal(t[b].ord, 20);

  const before = store.get().outbox.length;
  store.reorder('task', [c, a, b]);      // 再排一次同样的顺序
  assert.equal(store.get().outbox.length, before, '顺序没变就不该产生新的 op');
});

/* ==================== 删除与垃圾箱 ==================== */

test('删除留墓碑而不是抹掉，并进垃圾箱', () => {
  fresh();
  const id = add('要删的');
  store.deleteTask(id, '今天');

  const t = store.get().tasks[id];
  assert.ok(t, '实体本身还在 —— 抹掉就没法同步给别的设备了');
  assert.equal(t.deleted, true);
  assert.equal(t.trashFrom, '今天');
  assert.equal(counts(store.get()).today, 0, '墓碑不进今天列表');
  assert.equal(counts(store.get()).trash, 1);

  store.restoreTask(id);
  assert.equal(counts(store.get()).today, 1, '还原后回到原位');
});

test('清空垃圾箱用 purged 标记，同样是字段写入', () => {
  fresh();
  const id = add('要删的');
  store.deleteTask(id);
  store.emptyTrash();

  assert.equal(store.get().tasks[id].purged, true);
  assert.equal(counts(store.get()).trash, 0, '彻底移除的不再出现在垃圾箱');
  const op = store.get().outbox.find((o) => o.entityId === id && 'purged' in o.fields);
  assert.ok(op, 'purged 也要推给服务器，否则别的设备还留着它');
});

/* ==================== 打卡 ==================== */

test('打卡是同一天一次的状态切换，不是自增', () => {
  fresh();
  const h = store.addHabit('学英语');

  store.toggleHabit(h);
  assert.equal(store.get().habits[h].log[TODAY], true);
  assert.equal(counts(store.get()).habits, 0, '已打卡就不再计入「今天还剩几项」');

  store.toggleHabit(h);
  assert.equal(store.get().habits[h].log[TODAY], undefined, '再点一次是取消');
  assert.equal(counts(store.get()).habits, 1);
});

/* ==================== 日程集与权限 ==================== */

test('新任务落在当前选中的集里', () => {
  fresh();
  const id = add('买菜');
  assert.equal(store.get().tasks[id].calId, CAL);
  assert.equal(store.get().outbox[0].calId, CAL, 'op 要带 calId，服务器靠它查权限');
});

test('只读成员写了也不落地，并且记下被挡的次数', () => {
  fresh();
  const id = add('买菜');
  const before = store.get().outbox.length;

  // 被降成只读（或本来就是只读）
  store.setCals([{ id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'viewer' }]);

  store.patchTask(id, { title: '改不动' });
  assert.equal(store.get().tasks[id].title, '买菜', '没有写权限就不该改动');
  assert.equal(store.get().outbox.length, before, '也不该产生 op');
  assert.equal(store.get().denied, 1, '被挡下必须计数，界面才能提示用户');
});

test('被挡下时记下的是**那个集**，不是当前选中的集', () => {
  fresh();
  // 今天 / 逾期 / 待办箱是跨集的，「在别的页面勾别的集的任务」是常规用法 ——
  // 提示要是只说「这个日程集你只有查看权限」，用户会以为是眼前这个集出了问题
  store.setCals([
    { id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' },
    { id: 'cal-2', name: '全家', ownerId: 'u2', createdAt: 0, role: 'editor' },
  ]);
  store.setActiveCal('cal-2');
  const theirs = add('全家的事');

  // 对方把权限降成只读；本机仍然停在 CAL（模拟用户在「今天」页面）
  store.setCals([
    { id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' },
    { id: 'cal-2', name: '全家', ownerId: 'u2', createdAt: 0, role: 'viewer' },
  ]);
  store.setActiveCal(CAL);

  store.patchTask(theirs, { title: '改不动' });

  assert.equal(store.get().denied, 1);
  assert.deepEqual(store.get().deniedCals, ['cal-2'],
    '要说清是「全家」被挡的，不是当前选中的「我的日程」');
});

test('移到没有写权限的集也要报出来（原来这里是静默 return）', () => {
  fresh();
  store.setCals([
    { id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' },
    { id: 'cal-2', name: '全家', ownerId: 'u2', createdAt: 0, role: 'viewer' },
  ]);
  const mine = add('买菜');

  store.moveToCal('task', mine, 'cal-2');

  assert.equal(store.get().tasks[mine].calId, CAL, '写不进去就该留在原处');
  assert.equal(store.get().denied, 1, '静默失败是最糟的：用户只会以为程序卡了');
  assert.deepEqual(store.get().deniedCals, ['cal-2']);
});

test('一批里挡下了两个集，两个都记下来', () => {
  fresh();
  store.setCals([
    { id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' },
    { id: 'cal-2', name: '全家', ownerId: 'u2', createdAt: 0, role: 'editor' },
    { id: 'cal-3', name: '公司', ownerId: 'u2', createdAt: 0, role: 'editor' },
  ]);
  store.setActiveCal('cal-2');
  const a = add('A');
  store.setActiveCal('cal-3');
  const b = add('B');

  // 两个集都变成只读（「今天」页面把两边的任务一起勾了，就是这种一次提交）
  store.setCals([
    { id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' },
    { id: 'cal-2', name: '全家', ownerId: 'u2', createdAt: 0, role: 'viewer' },
    { id: 'cal-3', name: '公司', ownerId: 'u2', createdAt: 0, role: 'viewer' },
  ]);

  store.commitMany([
    { entity: 'task', id: a, fields: { title: 'A2' } },
    { entity: 'task', id: b, fields: { title: 'B2' } },
  ]);

  assert.equal(store.get().denied, 1, '一次操作只提示一次，别弹两条');
  assert.deepEqual(store.get().deniedCals, ['cal-2', 'cal-3']);
});

/* ==================== 冲突提示 ==================== */

/** 造一条别人改的、和我这一轮撞在同一个字段上的改动 */
function conflictFor(id: string, field: string, mine: unknown, theirs: unknown) {
  return {
    entity: 'task' as const, entityId: id, field,
    winner: 'theirs' as const, mine, theirs, ts: 2000, deviceId: 'devB',
  };
}

test('同一个字段再来一条就顶掉旧的，不会攒成一片', () => {
  fresh();
  const id = add('撞车的');

  store.addConflicts([conflictFor(id, 'title', '我的', '第一次')]);
  store.addConflicts([conflictFor(id, 'title', '我的', '第二次')]);

  const list = store.get().conflicts;
  assert.equal(list.length, 1, '同一 (实体, 字段) 只留一条');
  assert.equal(list[0].theirs, '第二次', '留的是新的那条');

  // 不同字段是两回事，都留着
  store.addConflicts([conflictFor(id, 'note', '我的备注', '对方的')]);
  assert.equal(store.get().conflicts.length, 2);
});

test('实体已经不在本地了（被移出集 / 彻底删掉），记录跟着丢', () => {
  fresh();
  const id = add('要没的');
  store.addConflicts([conflictFor(id, 'title', 'a', 'b')]);
  assert.equal(store.get().conflicts.length, 1);

  store.deleteTask(id);
  store.emptyTrash();          // purged —— 哪儿都看不见了
  store.addConflicts([conflictFor('another-id', 'title', 'a', 'b')]);

  assert.equal(store.get().conflicts.length, 1, 'purged 的那条被丢掉，只剩新加的');
  assert.equal(store.get().conflicts[0].entityId, 'another-id');
});

test('「知道了」按 (实体, 字段) 清，别人的记录不动', () => {
  fresh();
  const a = add('甲');
  const b = add('乙');
  store.addConflicts([
    conflictFor(a, 'title', 'a1', 'a2'),
    conflictFor(a, 'note', 'n1', 'n2'),
    conflictFor(b, 'title', 'b1', 'b2'),
  ]);

  // 点了「知道了」的那一条要落盘 —— 刷新之后不能再冒出来
  const saved = store.get().conflicts.length;
  store.dismissConflict(a, 'title');

  assert.equal(store.get().conflicts.length, saved - 1);
  assert.ok(!store.get().conflicts.some((c) => c.entityId === a && c.field === 'title'));
  assert.ok(store.get().conflicts.some((c) => c.entityId === b && c.field === 'title'), '别的实体不受影响');
  assert.ok(store.get().conflicts.some((c) => c.entityId === a && c.field === 'note'), '同一实体的别的字段不受影响');
});

test('切集只影响当前集，另一个集的任务原样留着', () => {
  fresh();
  const mine = add('我的事');

  store.setCals([
    { id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' },
    { id: 'cal-2', name: '家里的', ownerId: 'u2', createdAt: 0, role: 'editor' },
  ]);
  store.setActiveCal('cal-2');
  const theirs = add('家事');
  assert.equal(store.get().tasks[theirs].calId, 'cal-2');

  // 切回第一个集，两边都还在（过滤发生在上层，store 里是全量）
  store.setActiveCal(CAL);
  assert.ok(store.get().tasks[mine]);
  assert.ok(store.get().tasks[theirs]);
});

test('被移出的集连同它的实体一起清掉，别的集不受影响', () => {
  fresh();
  store.setCals([
    { id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' },
    { id: 'cal-2', name: '家里的', ownerId: 'u2', createdAt: 0, role: 'editor' },
  ]);
  store.setActiveCal('cal-2');
  const theirs = add('家事');
  store.setActiveCal(CAL);
  const mine = add('我的事');

  store.setCals([{ id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' }]);

  assert.equal(store.get().tasks[theirs], undefined, '退出的集不该再占着本地空间');
  assert.ok(store.get().tasks[mine]);
  assert.equal(store.get().ui.cal, CAL, '选中的集失效时要自动落到还存在的那个');
});

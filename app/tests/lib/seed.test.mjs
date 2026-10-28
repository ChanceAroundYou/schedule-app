/**
 * seed.test.mjs —— 探针公共层里「纯」的那几样
 *
 * 为什么这一份测试值得存在：抽 `seed.mjs` 的动机就是**字段表只有一份**。
 * 在此之前 `card-geometry` 和 `browser-cards` 各自维护一份 fields 字面量，
 * 一份带 `repeatSeq`、一份不带 —— 哪天服务端加字段，只有一个探针会红。
 * 下面第一条断言锁的就是这张表；后面锁的是「seriesId 怎么来」「日期从哪来」
 * 「op 是不是逐字段拆的」这几条容易在两处拷贝之间漂移的东西。
 *
 * 不测的部分：注册 / 邀请 / 真推 /api/sync 要真后端，那部分由探针自己跑
 * （`node tests/card-geometry.mjs` 一开头就真开一个临时后端 + 两个账户 + 一份邀请，
 * 走的是同一批 helper），这里只用假 fetch 验请求形状与被拒时的反应。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isoDate, repeatNone, repeatWeek, taskFields, taskOps, apiCall, pushTasks, registerUser,
} from './seed.mjs';

/** 服务端认的任务字段（逐字段 LWW 的落点）。改这张表 = 服务端与探针要一起改。 */
const FIELDS = ['title', 'date', 'time', 'duration', 'done', 'doneAt',
  'repeat', 'seriesId', 'repeatSeq', 'reminder', 'note'];

test('字段表只有一份：taskFields 出的键就是服务端认的那 11 个', () => {
  const f = taskFields({ id: 't1', title: '买牛奶' }, '2026-10-28');
  assert.deepEqual(Object.keys(f), FIELDS);
  // 缺的东西一律补成「明确的空」，不能留 undefined（undefined 到了 JSON 里字段就消失）
  assert.equal(f.time, null);
  assert.equal(f.duration, null);
  assert.equal(f.done, false);
  assert.equal(f.note, '');
  assert.equal(f.reminder, null);
});

test('不重复的任务 seriesId 必须是 null，重复的必须落在自己的 id 上', () => {
  const plain = taskFields({ id: 't1', title: '买牛奶' }, '2026-10-28');
  assert.equal(plain.repeat.unit, 'none');
  assert.equal(plain.seriesId, null);

  const weekly = taskFields({ id: 't2', title: '每周复盘', repeat: repeatWeek() }, '2026-10-28');
  assert.equal(weekly.repeat.unit, 'week');
  // 实例 id 是 `${根}#${发生日}`，根没了重复实例就派生不出来（AGENTS 的不变量）
  assert.equal(weekly.seriesId, 't2');
});

test('日期：默认用传进来的那天，row 自己带日期才覆盖它', () => {
  assert.equal(taskFields({ id: 't1', title: 'a' }, '2026-10-28').date, '2026-10-28');
  assert.equal(taskFields({ id: 't1', title: 'a', date: '2026-11-02' }, '2026-10-28').date, '2026-11-02');
});

test('isoDate 给的是 YYYY-MM-DD，偏移按天走（探针不许自己拼 getMonth）', () => {
  const today = isoDate();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  const back = isoDate(-7);
  const days = (Date.parse(today) - Date.parse(back)) / 86400000;
  assert.ok(Number.isInteger(days), '差的是整天，不是 6.96 天那种');
  assert.equal(days, 7);
});

test('taskOps 逐字段拆 op：一条任务 11 条，每条都带 calId / deviceId / 实体 id', () => {
  const rows = [
    { id: 't1', title: '买牛奶', time: '09:00', duration: 30 },
    { id: 't2', title: '每周复盘', repeat: repeatWeek() },
  ];
  const ops = taskOps({ rows, calId: 'cal-1', deviceId: 'probe', date: '2026-10-28', ts: 1000 });

  assert.equal(ops.length, rows.length * FIELDS.length);
  const perRow = new Map();
  for (const op of ops) {
    assert.equal(op.entity, 'task');
    assert.equal(op.calId, 'cal-1');
    assert.equal(op.deviceId, 'probe');
    assert.equal(op.ts, 1000);
    // 一条 op 只管一个字段（逐字段 LWW），不是一整条任务
    assert.deepEqual(Object.keys(op.fields), [op.opId.split('-').pop()]);
    perRow.set(op.entityId, (perRow.get(op.entityId) || []).concat(Object.keys(op.fields)));
  }
  // 拼回去必须正好是那张字段表：少一个字段的任务是「半新半旧」的，探针量到的就不是新样式
  for (const [id, fields] of perRow) assert.deepEqual(fields, FIELDS, id + ' 的字段不全');
});

test('opPrefix 换得掉（两个探针共用一个数据库时不撞号）', () => {
  const rows = [{ id: 't1', title: 'a' }];
  const a = taskOps({ rows, calId: 'c', deviceId: 'd', date: '2026-10-28' });
  const b = taskOps({ rows, calId: 'c', deviceId: 'd', date: '2026-10-28', opPrefix: 'opfx' });
  assert.equal(a[0].opId, 'op-t1-title');
  assert.equal(b[0].opId, 'opfx-t1-title');
});

test('工厂给的是新对象：在一条种子改重复规则不会串到另一条', () => {
  const rows = [{ id: 't1', title: 'a', repeat: repeatNone() }, { id: 't2', title: 'b', repeat: repeatNone() }];
  rows[0].repeat.unit = 'week';
  assert.equal(rows[1].repeat.unit, 'none');
  assert.notEqual(rows[0].repeat, rows[1].repeat);
});

test('taskOps 不改传入的 rows（工厂只读）', () => {
  const rows = [{ id: 't1', title: 'a' }];
  const before = JSON.parse(JSON.stringify(rows));
  taskOps({ rows, calId: 'c', deviceId: 'd', date: '2026-10-28' });
  assert.deepEqual(rows, before);
});

/* ── 请求形状：假 fetch，不真开后端 ── */

function fakeFetch(record, reply) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    record.push({ url, init });
    return { status: reply.status, json: async () => reply.body };
  };
  return () => { globalThis.fetch = prev; };
}

test('apiCall 带 token 就加 Authorization，带 body 就加 Content-Type 并 JSON 化', async () => {
  const seen = [];
  const restore = fakeFetch(seen, { status: 200, body: { ok: true } });
  try {
    const r = await apiCall(25999, 'POST', '/sync', { body: { cursor: 1 }, token: 'tk-1' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    // 调用方只写 '/sync'，`/api` 前缀由 apiCall 加（一处定义，探针里不许各自拼）
    assert.equal(seen[0].url, 'http://127.0.0.1:25999/api/sync');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.headers.Authorization, 'Bearer tk-1');
    assert.equal(seen[0].init.headers['Content-Type'], 'application/json');
    assert.equal(seen[0].init.body, JSON.stringify({ cursor: 1 }));
  } finally { restore(); }
});

test('GET 不带 body 时不发 Content-Type，也不发 body', async () => {
  const seen = [];
  const restore = fakeFetch(seen, { status: 200, body: { cals: [{ id: 'c1' }] } });
  try {
    await apiCall(25999, 'GET', '/me', { token: 'tk-1' });
    assert.equal(seen[0].init.body, undefined);
    assert.equal(seen[0].init.headers['Content-Type'], undefined);
  } finally { restore(); }
});

test('pushTasks 把 rows 拆成 op 一次推上去，cursor 照传', async () => {
  const seen = [];
  const restore = fakeFetch(seen, { status: 200, body: { applied: new Array(22).fill({}), rejected: [] } });
  try {
    const r = await pushTasks(25999, {
      token: 'tk-1', calId: 'cal-1', deviceId: 'probe', date: '2026-10-28',
      rows: [{ id: 't1', title: 'a' }, { id: 't2', title: 'b' }],
    });
    assert.equal(r.applied, 22);
    assert.equal(r.ops, 22);
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.cursor, 1);
    assert.equal(body.ops.length, 22);
    assert.equal(body.ops[0].calId, 'cal-1');
  } finally { restore(); }
});

test('有 op 被服务端拒 → 当场抛，不让探针拿着半套数据往下量', async () => {
  const restore = fakeFetch([], {
    status: 200, body: { applied: [{}], rejected: [{ opId: 'op-t1-title', reason: '权限' }] },
  });
  try {
    await assert.rejects(
      () => pushTasks(25999, { token: 'tk-1', calId: 'cal-1', deviceId: 'probe', rows: [{ id: 't1', title: 'a' }] }),
      /有 op 被拒/,
    );
  } finally { restore(); }
});

test('注册 / 推任务的返回不像成功时抛错，而不是回一个 undefined 让调用点自己猜', async () => {
  const restore = fakeFetch([], { status: 409, body: { error: '用户名已存在' } });
  try {
    await assert.rejects(() => registerFails(), /注册失败/);
  } finally { restore(); }
});

async function registerFails() {
  const { registerUser } = await import('./seed.mjs');
  return registerUser(25999, { name: '撞名的', password: 'pw-123456' });
}

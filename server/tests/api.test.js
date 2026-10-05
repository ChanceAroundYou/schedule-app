/**
 * api.test.js —— 后端接口测试（node:test，零依赖）
 *
 *   cd server && npm test
 *
 * 重点不在「接口能通」，而在三件会**损坏数据**的事：
 *   1. 同一条 op 重放 → 不能生效两次
 *   2. 同一字段并发写 → 两台设备必须算出同一个赢家（否则永远收敛不了）
 *   3. 两台设备各自离线勾选同一条重复任务 → 派生出的实例 id 必须相同 → 合并成一条
 *
 * 第 3 条是本次重构最硬的骨头：旧版 repeatAdvance 用随机 id 建实例，
 * 两台设备各自建一个，同步后任务直接翻倍。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-test-'));
process.env.SCHEDULE_DATA_DIR = TMP;

const db = require('../lib/db');
db.open(TMP);
const { createServer } = require('../server');

let server = null;
let base = '';
let adminToken = '';

test.before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* -------------------------------------------------------------- 小工具 */

async function api(method, p, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** 推一批 op，cursor 传 1 表示「只拉增量、不要快照」 */
function push(ops, cursor = 1) {
  return api('POST', '/api/sync', { token: adminToken, body: { cursor, ops } });
}

/** 时间戳基准。用例里的 ts 都是相对它的偏移，写成 1000/2000 比一堆 17xxxxxxxxxxx 好读。 */
const NOW = Date.now();
const HOUR = 3600 * 1000;

function op(entityId, fields, ts, deviceId, entity = 'task') {
  return { opId: `op-${entityId}-${ts}-${deviceId}-${Object.keys(fields).join('_')}`, deviceId, ts: NOW + ts, entity, entityId, fields };
}

/** 取当前服务端全量状态 */
async function snapshot() {
  const r = await api('POST', '/api/sync', { token: adminToken, body: { cursor: 0, ops: [] } });
  assert.strictEqual(r.status, 200, '快照请求失败: ' + JSON.stringify(r.body));
  return r.body.snapshot;
}

/* ---------------------------------------------------------------- 基础 */

test('健康检查与初始状态', async () => {
  const h = await api('GET', '/api/health');
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.body.ok, true);

  const s = await api('GET', '/api/auth/state');
  assert.strictEqual(s.body.hasUsers, false, '全新的库不应该有账户');
});

test('未登录访问受保护接口一律 401', async () => {
  for (const [m, p] of [['GET', '/api/users'], ['POST', '/api/sync']]) {
    const r = await api(m, p, { body: m === 'POST' ? {} : undefined });
    assert.strictEqual(r.status, 401, `${m} ${p} 应该 401`);
  }
  const bad = await api('POST', '/api/sync', { token: 'not.a.token', body: {} });
  assert.strictEqual(bad.status, 401);
});

test('首个注册者成为管理员，之后自助注册被拒', async () => {
  const weak = await api('POST', '/api/auth/register', { body: { name: 'a', password: '123456' } });
  assert.strictEqual(weak.status, 400, '全数字密码应被拒');

  const r = await api('POST', '/api/auth/register', { body: { name: '爸爸', password: 'family-pass-1' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.user.isAdmin, true, '首个注册者应是管理员');
  adminToken = r.body.token;

  const again = await api('POST', '/api/auth/register', { body: { name: '陌生人', password: 'another-pass' } });
  assert.strictEqual(again.status, 403, '已有账户后不允许开放注册');
});

test('登录：密码错 401，密码对拿 token', async () => {
  const bad = await api('POST', '/api/auth/login', { body: { name: '爸爸', password: 'wrong' } });
  assert.strictEqual(bad.status, 401);
  const nothere = await api('POST', '/api/auth/login', { body: { name: '查无此人', password: 'whatever' } });
  assert.strictEqual(nothere.status, 401);

  const ok = await api('POST', '/api/auth/login', { body: { name: '爸爸', password: 'family-pass-1' } });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.body.token.split('.').length === 3, 'token 应该是 JWT 三段式');
});

test('管理员可建账户，非管理员不行', async () => {
  const made = await api('POST', '/api/users', { token: adminToken, body: { name: '妈妈', password: 'mom-pass-1' } });
  assert.strictEqual(made.status, 200);
  assert.strictEqual(made.body.user.isAdmin, false);

  const dup = await api('POST', '/api/users', { token: adminToken, body: { name: '妈妈', password: 'whatever-1' } });
  assert.strictEqual(dup.status, 409, '重名应冲突');

  const login = await api('POST', '/api/auth/login', { body: { name: '妈妈', password: 'mom-pass-1' } });
  const asUser = await api('POST', '/api/users', { token: login.body.token, body: { name: '小号', password: 'x-pass-1' } });
  assert.strictEqual(asUser.status, 403, '非管理员不能建账户');
});

test('登出后旧 token 立刻失效', async () => {
  const login = await api('POST', '/api/auth/login', { body: { name: '妈妈', password: 'mom-pass-1' } });
  const t = login.body.token;
  assert.strictEqual((await api('GET', '/api/users', { token: t })).status, 403, '（非管理员是 403 说明 token 有效）');

  const out = await api('POST', '/api/auth/logout', { token: t });
  assert.strictEqual(out.status, 200);

  const after = await api('GET', '/api/users', { token: t });
  assert.strictEqual(after.status, 401, '登出后必须 401，而不是 403');
});

/* ------------------------------------------------------------ 同步语义 */

test('cursor=0 拿快照，cursor>0 只拿增量', async () => {
  await push([op('t1', { title: '买菜', date: '2026-10-06' }, 1000, 'devA')]);

  const snap = await snapshot();
  assert.deepStrictEqual(Object.keys(snap.tasks), ['t1']);
  assert.strictEqual(snap.tasks.t1.title, '买菜');
  assert.ok(snap.tasks.t1._ts.title, '快照要带每字段的写入时间戳，客户端才能继续做 LWW');

  const full = await api('POST', '/api/sync', { token: adminToken, body: { cursor: 0, ops: [] } });
  const cur = full.body.cursor;

  await push([op('t1', { note: '顺路取快递' }, 2000, 'devA')]);
  const delta = await api('POST', '/api/sync', { token: adminToken, body: { cursor: cur, ops: [] } });
  assert.ok(delta.body.changes.length >= 1, '应该只有新改动');
  assert.ok(!delta.body.changes.some((c) => c.field === 'title'), '旧改动不该重放');
  assert.ok(delta.body.changes.some((c) => c.field === 'note' && c.value === '顺路取快递'));
});

test('同一条 op 重放不会生效两次', async () => {
  const one = op('t2', { title: '交房租' }, 3000, 'devA');
  const first = await push([one]);
  assert.deepStrictEqual(first.body.applied, [one.opId]);

  const before = db.maxSeq(db.findUserByName('爸爸').id);
  const again = await push([one]);
  const after = db.maxSeq(db.findUserByName('爸爸').id);

  assert.deepStrictEqual(again.body.applied, [one.opId], '重放也要回 applied，客户端才能清发件箱');
  assert.strictEqual(after, before, '重放不得追加任何变更流水');
});

test('并发写同一字段：更新的时间戳赢', async () => {
  await push([op('t3', { title: '旧标题' }, 4000, 'devA')]);
  await push([op('t3', { title: '新标题' }, 5000, 'devB')]);
  const snap = await snapshot();
  assert.strictEqual(snap.tasks.t3.title, '新标题');

  // 乱序到达：先送新的、再送旧的，结果必须一样
  await push([op('t4', { title: '新' }, 7000, 'devA')]);
  await push([op('t4', { title: '旧' }, 6000, 'devB')]);
  const snap2 = await snapshot();
  assert.strictEqual(snap2.tasks.t4.title, '新', '迟到的旧改动不能覆盖新值');
});

test('时间戳相同：deviceId 大的赢，且与到达顺序无关', async () => {
  const TS = 9000;
  await push([op('t5', { title: '来自 aaa' }, TS, 'aaa')]);
  await push([op('t5', { title: '来自 bbb' }, TS, 'bbb')]);
  let snap = await snapshot();
  assert.strictEqual(snap.tasks.t5.title, '来自 bbb', 'bbb > aaa');

  // 反过来送一遍，结果必须相同 —— 这是「两台设备算出同一个赢家」的前提
  await push([op('t6', { title: '来自 bbb' }, TS, 'bbb')]);
  await push([op('t6', { title: '来自 aaa' }, TS, 'aaa')]);
  snap = await snapshot();
  assert.strictEqual(snap.tasks.t6.title, '来自 bbb', '平局裁决必须与到达顺序无关');
});

test('不同字段各自裁决，互不覆盖', async () => {
  await push([op('t7', { title: '会议', date: '2026-10-06' }, 10000, 'devA')]);
  await push([op('t7', { date: '2026-10-08' }, 11000, 'devB')]);   // 桌面改期
  await push([op('t7', { title: '周会' }, 10500, 'devA')]);        // 手机改标题（时间戳更早）

  const snap = await snapshot();
  assert.strictEqual(snap.tasks.t7.title, '周会', '标题该保住');
  assert.strictEqual(snap.tasks.t7.date, '2026-10-08', '日期该保住');
});

/* -------------------------------------------------- 重复实例：本次重构的死穴 */

test('两台设备各自离线勾选同一条重复任务 → 派生实例合并成一条，不翻倍', async () => {
  const SERIES = 'series-abc';
  const OCCURRENCE = '2026-10-07';
  // 客户端用 `${seriesId}#${occurrenceDate}` 派生 id，两台设备算出来一模一样
  const instanceId = `${SERIES}#${OCCURRENCE}`;

  await push([op(instanceId, { title: '团队早会', date: OCCURRENCE, time: '09:30' }, 20000, 'devA')]);
  await push([op(instanceId, { title: '团队早会', date: OCCURRENCE, time: '09:30' }, 19999, 'devB')]);

  const snap = await snapshot();
  const matched = Object.keys(snap.tasks).filter((id) => id === instanceId);
  assert.strictEqual(matched.length, 1, `派生实例必须只有一条，实际 ${matched.length} 条`);
  assert.strictEqual(snap.tasks[instanceId].title, '团队早会');

  // 反面对照：如果 id 是随机的，就会是两条 —— 这正是旧版的行为
  await push([op('random-x1', { title: '团队早会', date: OCCURRENCE }, 20000, 'devA')]);
  await push([op('random-x2', { title: '团队早会', date: OCCURRENCE }, 20000, 'devB')]);
  const snap2 = await snapshot();
  const dup = Object.keys(snap2.tasks).filter((id) => id.startsWith('random-'));
  assert.strictEqual(dup.length, 2, '随机 id 会翻倍 —— 这就是要避免的');
});

test('打卡的 log 是按日期的稀疏映射，整字段覆盖即可', async () => {
  await push([op('h1', { title: '学英语' }, 30000, 'devA', 'habit')]);
  await push([op('h1', { log: { '2026-10-06': true } }, 31000, 'devA', 'habit')]);
  await push([op('h1', { log: { '2026-10-06': true, '2026-10-07': true } }, 32000, 'devA', 'habit')]);

  const snap = await snapshot();
  assert.deepStrictEqual(snap.habits.h1.log, { '2026-10-06': true, '2026-10-07': true });
});

test('删除是墓碑字段，不是物理删除', async () => {
  await push([op('t8', { title: '待删' }, 40000, 'devA')]);
  await push([op('t8', { deleted: true, deletedAt: 41000 }, 41000, 'devA')]);

  const snap = await snapshot();
  assert.ok(!snap.tasks.t8, '墓碑不该出现在快照里');

  // 墓碑仍然在 field_state 里 —— 否则别的设备永远不知道要删
  const uid = db.findUserByName('爸爸').id;
  const rows = db.allFields(uid).filter((r) => r.entity_id === 't8' && r.field === 'deleted');
  assert.strictEqual(rows.length, 1, '墓碑必须留库供其他设备拉取');
  assert.strictEqual(rows[0].value, 'true');
});

/* ------------------------------------------------------------ 信任边界 */

test('非法 op 被逐条拒绝，不拖垮整批', async () => {
  const good = op('t9', { title: '合法' }, 60000, 'devA');
  const bads = [
    { opId: 'b1', deviceId: 'd', ts: NOW, entity: 'user', entityId: 'x', fields: { a: 1 } },
    { opId: 'b2', deviceId: 'd', ts: NOW, entity: 'task', entityId: '有 空格', fields: { a: 1 } },
    { opId: 'b3', deviceId: 'd', ts: NOW, entity: 'task', entityId: 'x', fields: {} },
    { opId: 'b4', deviceId: 'd', ts: 'now', entity: 'task', entityId: 'x', fields: { a: 1 } },
    { opId: 'b5', deviceId: 'd', ts: NOW, entity: 'task', entityId: 'x', fields: { '1abc': 1 } },
    { nope: true },
  ];
  const r = await push([good, ...bads]);

  assert.deepStrictEqual(r.body.applied, [good.opId], '只有合法的那条被接受');
  assert.strictEqual(r.body.rejected.length, bads.length, '坏的一条都不能漏');
  assert.ok(r.body.rejected.every((x) => x.code === 'bad_request'),
    '这些是结构性错误，必须是 bad_request（客户端丢掉），不能混淆成可重试的 clock');

  const snap = await snapshot();
  assert.strictEqual(snap.tasks.t9.title, '合法', '合法 op 必须照常落库');
});

test('请求体不是合法 JSON 时返回 400 而不是崩', async () => {
  const res = await fetch(base + '/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
    body: '{ 这不是 json',
  });
  assert.strictEqual(res.status, 400);
});

test('不存在的接口返回 404', async () => {
  assert.strictEqual((await api('GET', '/api/nope')).status, 404);
});

test('设备时钟偏差超 24 小时的 op 被退回，并标明 code=clock', async () => {
  // 不挡的话，一台时钟设为 2027 的设备会永久赢下所有 LWW —— 那是损坏，不是抖动。
  // 退回而不是钳制：钳制值取决于「收到请求的那一刻」，重放会钳出不同结果，幂等当场破掉。
  const future = 365 * 24 * HOUR;   // 相对 NOW 偏一年
  const r = await push([op('t10', { title: '来自未来' }, future, 'devA')]);

  assert.deepStrictEqual(r.body.applied, [], '坏时钟的 op 不得落库');
  assert.strictEqual(r.body.rejected.length, 1);
  assert.strictEqual(r.body.rejected[0].code, 'clock',
    '必须是 clock 而不是 bad_request —— 客户端据此决定「留着重试」还是「丢掉并报错」');

  const snap = await snapshot();
  assert.ok(!snap.tasks.t10, '坏时钟的写入不得落库');

  // 时钟修好后，同一条改动能正常推上来（所以客户端不该丢掉它）
  const fixed = { ...op('t10', { title: '来自未来' }, 0, 'devA'), opId: 'op-fixed-clock' };
  const r2 = await push([fixed]);
  assert.deepStrictEqual(r2.body.applied, ['op-fixed-clock'], '校准后应能成功');
  assert.strictEqual((await snapshot()).tasks.t10.title, '来自未来');
});

test('一条时钟异常的 op 不拖垮同批的其他改动', async () => {
  const bad = op('t12', { title: '坏时钟' }, 365 * 24 * HOUR, 'devA');
  const good = op('t13', { title: '正常' }, 0, 'devB');

  const r = await push([bad, good]);
  assert.deepStrictEqual(r.body.applied, [good.opId]);
  assert.strictEqual(r.body.rejected[0].code, 'clock');

  const snap = await snapshot();
  assert.strictEqual(snap.tasks.t13.title, '正常');
  assert.ok(!snap.tasks.t12);
});

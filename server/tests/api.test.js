/**
 * api.test.js —— 后端接口测试（node:test，零依赖）
 *
 *   node --test server/tests/api.test.js
 *
 * 重点不在「接口能通」，而在几件会**损坏数据或越权**的事：
 *   1. 同一条 op 重放 → 不能生效两次
 *   2. 同一字段并发写 → 两台设备必须算出同一个赢家（否则永远收敛不了）
 *   3. 两台设备各自离线勾选同一条重复任务 → 派生出的实例 id 必须相同 → 合并成一条
 *   4. 只读成员写不进去、非成员既看不到也写不进、最后一个创建者不能被降级
 *   5. 中途加入一个集，必须能拿到它**已有**的内容（游标是全局的，增量拉不到）
 *
 * 第 3 条是上一轮重构最硬的骨头：旧版用随机 id 建实例，两台设备各建一个，
 * 同步后任务直接翻倍。
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

/** 主线账户。node:test 里顶层用例按声明顺序串行跑，所以后面的用例可以依赖它们 */
let dad = null;   // { name, token, userId, calId, cals }
let mom = null;
let CAL = '';     // dad 的默认集，op() 默认往这里写

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

/** 注册并回读身份。新账户一定会带一个默认日程集。 */
async function registerUser(name, password) {
  const r = await api('POST', '/api/auth/register', { body: { name, password } });
  assert.strictEqual(r.status, 200, `注册 ${name} 失败: ${JSON.stringify(r.body)}`);
  const me = await api('GET', '/api/me', { token: r.body.token });
  assert.strictEqual(me.status, 200);
  return {
    name,
    token: r.body.token,
    userId: r.body.user.id,
    cals: me.body.cals,
    calId: me.body.cals[0].id,
  };
}

/** 推一批 op，cursor 传 1 表示「只拉增量、不要快照」 */
function push(ops, cursor = 1, token = dad.token) {
  return api('POST', '/api/sync', { token, body: { cursor, ops } });
}

/** 时间戳基准。用例里的 ts 都是相对它的偏移，写成 1000/2000 比一堆 17xxxxxxxxxxx 好读。 */
const NOW = Date.now();
const HOUR = 3600 * 1000;

function op(entityId, fields, ts, deviceId, entity = 'task', calId = CAL) {
  return {
    opId: `op-${entityId}-${ts}-${deviceId}-${Object.keys(fields).join('_')}`,
    deviceId, ts: NOW + ts, entity, entityId, fields, calId,
  };
}

/** 取当前用户看到的全量状态 */
async function snapshot(token = dad.token) {
  const r = await api('POST', '/api/sync', { token, body: { cursor: 0, ops: [] } });
  assert.strictEqual(r.status, 200, '快照请求失败: ' + JSON.stringify(r.body));
  return r.body.snapshot;
}

/** 当前用户可见的全部日程集 id（给直接查库的断言用） */
function calsOf(userId) {
  return db.calendarIdsFor(userId);
}

/* ---------------------------------------------------------------- 基础 */

test('健康检查', async () => {
  const h = await api('GET', '/api/health');
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.body.ok, true);
});

test('未登录访问受保护接口一律 401', async () => {
  for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/cals'], ['POST', '/api/sync']]) {
    const r = await api(m, p, { body: m === 'POST' ? {} : undefined });
    assert.strictEqual(r.status, 401, `${m} ${p} 应该 401`);
  }
  const bad = await api('POST', '/api/sync', { token: 'not.a.token', body: {} });
  assert.strictEqual(bad.status, 401);
});

test('开放注册：人人可注册，各自自动拿到一个默认日程集', async () => {
  const weak = await api('POST', '/api/auth/register', { body: { name: 'a', password: '123456' } });
  assert.strictEqual(weak.status, 400, '全数字密码应被拒');

  dad = await registerUser('爸爸', 'family-pass-1');
  CAL = dad.calId;
  assert.strictEqual(dad.cals.length, 1, '注册即有一个集 —— 否则进去就是白屏');
  assert.strictEqual(dad.cals[0].name, '我的日程');
  assert.strictEqual(dad.cals[0].role, 'owner');
  assert.strictEqual(dad.cals[0].ownerId, dad.userId);

  // 关键：第二个注册者不必等谁批准，也不该继承任何管理员身份
  mom = await registerUser('妈妈', 'mom-pass-1');
  assert.notStrictEqual(mom.calId, dad.calId, '两个人的默认集必须是两个');
  assert.strictEqual(mom.cals.length, 1);

  const dup = await api('POST', '/api/auth/register', { body: { name: '爸爸', password: 'whatever-1' } });
  assert.strictEqual(dup.status, 409, '重名应冲突');
});

test('登录：密码错 401，密码对拿 token', async () => {
  const bad = await api('POST', '/api/auth/login', { body: { name: '爸爸', password: 'wrong' } });
  assert.strictEqual(bad.status, 401);
  const nothere = await api('POST', '/api/auth/login', { body: { name: '查无此人', password: 'whatever' } });
  assert.strictEqual(nothere.status, 401, '用户不存在也不能泄露出来');

  const ok = await api('POST', '/api/auth/login', { body: { name: '爸爸', password: 'family-pass-1' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.token.split('.').length, 3, 'token 应该是 JWT 三段式');
  assert.strictEqual(ok.body.user.isAdmin, undefined, '没有管理员这回事了');
});

test('登出后旧 token 立刻失效', async () => {
  const login = await api('POST', '/api/auth/login', { body: { name: '妈妈', password: 'mom-pass-1' } });
  const t = login.body.token;
  assert.strictEqual((await api('GET', '/api/me', { token: t })).status, 200);

  assert.strictEqual((await api('POST', '/api/auth/logout', { token: t })).status, 200);
  assert.strictEqual((await api('GET', '/api/me', { token: t })).status, 401, '登出后必须 401');
});

/* ------------------------------------------------------- 日程集与权限 */

test('邀请必须对方接受才生效', async () => {
  const made = await api('POST', `/api/cals/${dad.calId}/invites`, {
    token: dad.token, body: { name: '妈妈', role: 'editor' },
  });
  assert.strictEqual(made.status, 200, JSON.stringify(made.body));

  // 还没接受 —— 她的集列表里不该出现
  let mine = await api('GET', '/api/cals', { token: mom.token });
  assert.strictEqual(mine.body.cals.length, 1, '接受了才算数');

  const inbox = await api('GET', '/api/invites', { token: mom.token });
  assert.strictEqual(inbox.body.invites.length, 1);
  const inv = inbox.body.invites[0];
  assert.strictEqual(inv.calName, '我的日程');
  assert.strictEqual(inv.fromName, '爸爸', '要能看出是谁邀请的');
  assert.strictEqual(inv.role, 'editor');

  // 别人替她点接受不行
  assert.strictEqual((await api('POST', `/api/invites/${inv.id}/accept`, { token: dad.token })).status, 403);

  const acc = await api('POST', `/api/invites/${inv.id}/accept`, { token: mom.token });
  assert.strictEqual(acc.status, 200);
  mine = await api('GET', '/api/cals', { token: mom.token });
  assert.strictEqual(mine.body.cals.length, 2);
  assert.strictEqual(mine.body.cals.find((c) => c.id === dad.calId).role, 'editor');

  // 处理过的邀请不能再用
  assert.strictEqual((await api('POST', `/api/invites/${inv.id}/accept`, { token: mom.token })).status, 409);
});

test('中途加入一个集，快照里能看到它已有的内容', async () => {
  // 游标是全局单调的，妈妈此刻的游标早就越过这个集历史的变更了 ——
  // 光靠增量永远拉不到，必须靠快照兜住
  const w = await push([op('shared-1', { title: '家里的任务' }, 2000, 'devA')]);
  assert.deepStrictEqual(w.body.rejected, []);

  const snap = await snapshot(mom.token);
  assert.strictEqual(snap.tasks['shared-1'].title, '家里的任务');
  assert.strictEqual(snap.tasks['shared-1'].calId, dad.calId, '快照要标明每条属于哪个集');
});

test('可编辑成员能往里写，写进去的内容创建者也看得到', async () => {
  const mine = op('mom-1', { title: '妈妈加的' }, 3000, 'devM');
  const w = await push([mine], 1, mom.token);
  assert.deepStrictEqual(w.body.rejected, []);
  assert.deepStrictEqual(w.body.applied, [mine.opId]);

  const snap = await snapshot();
  assert.strictEqual(snap.tasks['mom-1'].title, '妈妈加的');
});

test('改权限：只读成员写不进去，但仍能读到全部内容', async () => {
  const set = await api('PATCH', `/api/cals/${dad.calId}/members/${mom.userId}`, {
    token: dad.token, body: { role: 'viewer' },
  });
  assert.strictEqual(set.status, 200);

  const w = await push([op('mom-2', { title: '不该写进去' }, 4000, 'devM')], 1, mom.token);
  assert.deepStrictEqual(w.body.applied, []);
  assert.strictEqual(w.body.rejected.length, 1);
  assert.strictEqual(w.body.rejected[0].code, 'forbidden',
    '必须是 forbidden —— 客户端据此丢掉并提示，不该留着无限重试');

  assert.ok(!(await snapshot()).tasks['mom-2'], '只读成员的写入不得落库');
  const snap = await snapshot(mom.token);
  assert.strictEqual(snap.tasks['shared-1'].title, '家里的任务', '只读仍然读得到');
});

test('非成员既看不到也写不进，且不区分「不存在」与「不归你」', async () => {
  const outsider = await registerUser('小雪', 'snow-pass-1');

  const mine = await api('GET', '/api/cals', { token: outsider.token });
  assert.strictEqual(mine.body.cals.some((c) => c.id === dad.calId), false);

  const snap = await snapshot(outsider.token);
  assert.ok(!snap.tasks['shared-1'], '看不到别人的集的内容');

  const w = await push([op('x-1', { title: '闯入' }, 5000, 'devX', 'task', dad.calId)], 1, outsider.token);
  assert.strictEqual(w.body.rejected[0].code, 'forbidden');

  // 与「这个集根本不存在」返回同一个码，扫 id 也问不出别人有哪些集
  const ghost = await push([op('x-2', { title: '闯入' }, 5000, 'devX', 'task', 'no-such-cal')], 1, outsider.token);
  assert.strictEqual(ghost.body.rejected[0].code, 'forbidden');
});

test('最后一个创建者不能降级、不能退出', async () => {
  const down = await api('PATCH', `/api/cals/${dad.calId}/members/${dad.userId}`, {
    token: dad.token, body: { role: 'editor' },
  });
  assert.strictEqual(down.status, 400, '降级了就没人是创建者了');

  const leave = await api('POST', `/api/cals/${dad.calId}/leave`, { token: dad.token });
  assert.strictEqual(leave.status, 400);

  // 先把别人提成创建者，自己就能降级了
  assert.strictEqual((await api('PATCH', `/api/cals/${dad.calId}/members/${mom.userId}`, {
    token: dad.token, body: { role: 'owner' },
  })).status, 200);
  assert.strictEqual((await api('PATCH', `/api/cals/${dad.calId}/members/${dad.userId}`, {
    token: dad.token, body: { role: 'editor' },
  })).status, 200, '两个创建者时可以降级');

  // 复原，免得影响后面的用例
  assert.strictEqual((await api('PATCH', `/api/cals/${dad.calId}/members/${mom.userId}`, {
    token: dad.token, body: { role: 'editor' },
  })).status, 403, '降完自己就不再是创建者，管不了成员了');
  assert.strictEqual((await api('PATCH', `/api/cals/${dad.calId}/members/${dad.userId}`, {
    token: mom.token, body: { role: 'owner' },
  })).status, 200, '那就由妈妈把自己提回来');
  assert.strictEqual((await api('PATCH', `/api/cals/${dad.calId}/members/${dad.userId}`, {
    token: dad.token, body: { role: 'owner' },
  })).status, 200);
});

test('邀请的边界：不能邀自己、不能邀不存在的人、不能邀already在集里的人', async () => {
  const self = await api('POST', `/api/cals/${dad.calId}/invites`, {
    token: dad.token, body: { name: '爸爸', role: 'editor' },
  });
  assert.strictEqual(self.status, 400);

  const ghost = await api('POST', `/api/cals/${dad.calId}/invites`, {
    token: dad.token, body: { name: '查无此人', role: 'editor' },
  });
  assert.strictEqual(ghost.status, 404);

  const dup = await api('POST', `/api/cals/${dad.calId}/invites`, {
    token: dad.token, body: { name: '妈妈', role: 'editor' },
  });
  assert.strictEqual(dup.status, 409, '已经是成员了');

  const badRole = await api('POST', `/api/cals/${dad.calId}/invites`, {
    token: dad.token, body: { name: '小雪', role: 'king' },
  });
  assert.strictEqual(badRole.status, 400);
});

test('邀请可以撤回，撤回后对方就看不到了', async () => {
  const made = await api('POST', `/api/cals/${dad.calId}/invites`, {
    token: dad.token, body: { name: '小雪', role: 'viewer' },
  });
  assert.strictEqual(made.status, 200);
  const id = made.body.invite.id;
  assert.strictEqual((await api('GET', '/api/invites', { token: dad.token })).body.invites.length, 0,
    '「发给我的」不该包含自己发出去的');

  const sent = await api('GET', `/api/cals/${dad.calId}/invites`, { token: dad.token });
  assert.strictEqual(sent.body.invites.length, 1, '发出去的要能查到自己发过什么');
  assert.strictEqual(sent.body.invites[0].toName, '小雪');

  assert.strictEqual((await api('DELETE', `/api/invites/${id}`, { token: dad.token })).status, 200);
  assert.strictEqual((await api('GET', '/api/invites', { token: null })).status, 401);
});

test('踢人：被踢的立刻失去这个集，自己原来的默认集还在', async () => {
  assert.strictEqual((await api('DELETE', `/api/cals/${dad.calId}/members/${mom.userId}`, {
    token: dad.token,
  })).status, 200);

  const mine = await api('GET', '/api/cals', { token: mom.token });
  assert.strictEqual(mine.body.cals.some((c) => c.id === dad.calId), false);
  assert.strictEqual(mine.body.cals.length, 1, '不变量 1：每个人始终至少有一个集');
  assert.ok(!(await snapshot(mom.token)).tasks['shared-1'], '被踢之后就读不到了');
});

test('删掉自己唯一那个集之后，会自动补一个默认集', async () => {
  const solo = await registerUser('临时', 'temp-pass-1');
  assert.strictEqual((await api('DELETE', `/api/cals/${solo.calId}`, { token: solo.token })).status, 200);

  const mine = await api('GET', '/api/cals', { token: solo.token });
  assert.strictEqual(mine.body.cals.length, 1, '删光了会自动补一个，不变量 1');
  assert.notStrictEqual(mine.body.cals[0].id, solo.calId);

  // 非创建者删不掉
  const other = await registerUser('路人', 'passer-pass-1');
  assert.strictEqual((await api('DELETE', `/api/cals/${solo.cals[0].id}`, { token: other.token })).status, 404);
});

test('成员名单带上角色，创建者看得到，非成员看不到', async () => {
  const r = await api('GET', `/api/cals/${dad.calId}/members`, { token: dad.token });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.members.map((m) => [m.name, m.role]), [['爸爸', 'owner']]);
  assert.strictEqual(r.body.myRole, 'owner');

  const outsider = await registerUser('外人', 'outside-pass-1');
  assert.strictEqual((await api('GET', `/api/cals/${dad.calId}/members`, { token: outsider.token })).status, 404);
});

test('改名：创建者能改，可编辑成员不能', async () => {
  const made = await api('POST', '/api/cals', { token: dad.token, body: { name: '全家日程' } });
  assert.strictEqual(made.status, 200);
  const calId = made.body.cal.id;
  assert.strictEqual(made.body.cal.role, 'owner');

  const invite = await api('POST', `/api/cals/${calId}/invites`, {
    token: dad.token, body: { name: '妈妈', role: 'editor' },
  });
  const invId = invite.body.invite.id;
  await api('POST', `/api/invites/${invId}/accept`, { token: mom.token });

  assert.strictEqual((await api('PATCH', `/api/cals/${calId}`, {
    token: dad.token, body: { name: '改名成' },
  })).status, 200);
  assert.strictEqual((await api('PATCH', `/api/cals/${calId}`, {
    token: mom.token, body: { name: '我说了算' },
  })).status, 403, '可编辑成员管不了集本身');

  const empty = await api('POST', '/api/cals', { token: dad.token, body: { name: '   ' } });
  assert.strictEqual(empty.body.cal.name, '我的日程', '名字留空就给默认名');
});

/* ------------------------------------------------------------ 同步语义 */

test('cursor=0 拿快照，cursor>0 只拿增量', async () => {
  await push([op('t1', { title: '买菜', date: '2026-10-06' }, 10000, 'devA')]);

  const snap = await snapshot();
  assert.strictEqual(snap.tasks.t1.title, '买菜');
  assert.ok(snap.tasks.t1._ts.title, '快照要带每字段的写入时间戳，客户端才能继续做 LWW');

  const full = await api('POST', '/api/sync', { token: dad.token, body: { cursor: 0, ops: [] } });
  const cur = full.body.cursor;

  await push([op('t1', { note: '顺路取快递' }, 11000, 'devA')]);
  const delta = await api('POST', '/api/sync', { token: dad.token, body: { cursor: cur, ops: [] } });
  assert.ok(delta.body.changes.length >= 1, '应该只有新改动');
  assert.ok(!delta.body.changes.some((c) => c.field === 'title'), '旧改动不该重放');
  assert.ok(delta.body.changes.some((c) => c.field === 'note' && c.value === '顺路取快递'));

  // 每条变更都要能说出自己是哪个集的（客户端据此归位）
  assert.ok(delta.body.changes.every((c) => c.calId === dad.calId));
});

test('同步响应每次都带回我的集与待处理邀请（轮询顺带发现变化）', async () => {
  const r = await api('POST', '/api/sync', { token: dad.token, body: { cursor: 1, ops: [] } });
  assert.ok(Array.isArray(r.body.cals) && r.body.cals.length >= 1);
  assert.ok(Array.isArray(r.body.invites));
});

test('同一条 op 重放不会生效两次', async () => {
  const one = op('t2', { title: '交房租' }, 12000, 'devA');
  const first = await push([one]);
  assert.deepStrictEqual(first.body.applied, [one.opId]);

  const before = db.maxSeq();
  const again = await push([one]);
  const after = db.maxSeq();

  assert.deepStrictEqual(again.body.applied, [one.opId], '重放也要回 applied，客户端才能清发件箱');
  assert.strictEqual(after, before, '重放不得追加任何变更流水');
});

test('并发写同一字段：更新的时间戳赢', async () => {
  await push([op('t3', { title: '旧标题' }, 13000, 'devA')]);
  await push([op('t3', { title: '新标题' }, 14000, 'devB')]);
  assert.strictEqual((await snapshot()).tasks.t3.title, '新标题');

  // 乱序到达：先送新的、再送旧的，结果必须一样
  await push([op('t4', { title: '新' }, 16000, 'devA')]);
  await push([op('t4', { title: '旧' }, 15000, 'devB')]);
  assert.strictEqual((await snapshot()).tasks.t4.title, '新', '迟到的旧改动不能覆盖新值');
});

test('时间戳相同：deviceId 大的赢，且与到达顺序无关', async () => {
  const TS = 17000;
  await push([op('t5', { title: '来自 aaa' }, TS, 'aaa')]);
  await push([op('t5', { title: '来自 bbb' }, TS, 'bbb')]);
  assert.strictEqual((await snapshot()).tasks.t5.title, '来自 bbb', 'bbb > aaa');

  // 反过来送一遍，结果必须相同 —— 这是「两台设备算出同一个赢家」的前提
  await push([op('t6', { title: '来自 bbb' }, TS, 'bbb')]);
  await push([op('t6', { title: '来自 aaa' }, TS, 'aaa')]);
  assert.strictEqual((await snapshot()).tasks.t6.title, '来自 bbb', '平局裁决必须与到达顺序无关');
});

test('不同字段各自裁决，互不覆盖', async () => {
  await push([op('t7', { title: '会议', date: '2026-10-06' }, 18000, 'devA')]);
  await push([op('t7', { date: '2026-10-08' }, 19000, 'devB')]);   // 桌面改期
  await push([op('t7', { title: '周会' }, 18500, 'devA')]);        // 手机改标题（时间戳更早）

  const snap = await snapshot();
  assert.strictEqual(snap.tasks.t7.title, '周会', '标题该保住');
  assert.strictEqual(snap.tasks.t7.date, '2026-10-08', '日期该保住');
});

/* -------------------------------------------------- 重复实例：上轮重构的死穴 */

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

  assert.ok(!(await snapshot()).tasks.t8, '墓碑不该出现在快照里');

  // 墓碑仍然在 field_state 里 —— 否则别的设备永远不知道要删
  const rows = db.allFields(calsOf(dad.userId))
    .filter((r) => r.entity_id === 't8' && r.field === 'deleted');
  assert.strictEqual(rows.length, 1, '墓碑必须留库供其他设备拉取');
  assert.strictEqual(rows[0].value, 'true');
});

/* ------------------------------------------------------------ 信任边界 */

test('非法 op 被逐条拒绝，不拖垮整批', async () => {
  const good = op('t9', { title: '合法' }, 60000, 'devA');
  const bads = [
    { opId: 'b1', deviceId: 'd', ts: NOW, calId: CAL, entity: 'user', entityId: 'x', fields: { a: 1 } },
    { opId: 'b2', deviceId: 'd', ts: NOW, calId: CAL, entity: 'task', entityId: '有 空格', fields: { a: 1 } },
    { opId: 'b3', deviceId: 'd', ts: NOW, calId: CAL, entity: 'task', entityId: 'x', fields: {} },
    { opId: 'b4', deviceId: 'd', ts: 'now', calId: CAL, entity: 'task', entityId: 'x', fields: { a: 1 } },
    { opId: 'b5', deviceId: 'd', ts: NOW, calId: CAL, entity: 'task', entityId: 'x', fields: { '1abc': 1 } },
    { opId: 'b6', deviceId: 'd', ts: NOW, entity: 'task', entityId: 'x', fields: { a: 1 } },   // 缺 calId
    { nope: true },   // 连对象形状都不对
  ];
  const r = await push([good, ...bads]);

  assert.deepStrictEqual(r.body.applied, [good.opId], '只有合法的那条被接受');
  assert.strictEqual(r.body.rejected.length, bads.length, '坏的一条都不能漏');
  assert.ok(r.body.rejected.every((x) => x.code === 'bad_request'),
    '这些是结构性错误，必须是 bad_request（客户端丢掉），不能混淆成可重试的 clock');

  assert.strictEqual((await snapshot()).tasks.t9.title, '合法', '合法 op 必须照常落库');
});

test('请求体不是合法 JSON 时返回 400 而不是崩', async () => {
  const res = await fetch(base + '/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + dad.token },
    body: '{ 这不是 json',
  });
  assert.strictEqual(res.status, 400);
});

test('不存在的接口返回 404', async () => {
  assert.strictEqual((await api('GET', '/api/nope')).status, 404);
  assert.strictEqual((await api('GET', '/api/cals/x/y/z')).status, 404);
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

  assert.ok(!(await snapshot()).tasks.t10, '坏时钟的写入不得落库');

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

/* ================================================================ 项目 */

test('项目实体走的是和任务同一条通道：推上去、拉得回、快照里有', async () => {
  const p = op('proj-1', { name: '星星包', status: 'active', next: '排期' }, 20000, 'devA', 'project');
  const r = await push([p]);
  assert.deepStrictEqual(r.body.applied, [p.opId], 'project 不该被 ENTITIES 挡下');

  const snap = await snapshot();
  assert.ok(snap.projects, '快照必须带上 projects 这一桶');
  assert.strictEqual(snap.projects['proj-1'].name, '星星包');
  assert.strictEqual(snap.projects['proj-1'].status, 'active');
  assert.strictEqual(snap.projects['proj-1'].calId, CAL, '每条都要带 calId，客户端据此归位');

  // 增量这一路也要认得它 —— 否则第二台设备永远看不到别人改的项目
  const cur = await api('POST', '/api/sync', { token: dad.token, body: { cursor: 0, ops: [] } });
  const delta = await api('POST', '/api/sync', {
    token: dad.token,
    body: { cursor: cur.body.cursor, ops: [op('proj-1', { next: '已排期' }, 21000, 'devA', 'project')] },
  });
  const ch = delta.body.changes.find((c) => c.entity === 'project' && c.field === 'next');
  assert.ok(ch, 'project 的增量必须能拉到');
  assert.strictEqual(ch.value, '已排期');
});

test('项目墓碑不进快照，但仍然留库供别的设备拉', async () => {
  await push([op('proj-2', { name: '要删的' }, 22000, 'devA', 'project')]);
  await push([op('proj-2', { deleted: true, deletedAt: 23000 }, 23000, 'devA', 'project')]);

  assert.ok(!(await snapshot()).projects['proj-2'], '墓碑不该出现在快照里');

  const rows = db.allFields(calsOf(dad.userId))
    .filter((r) => r.entity === 'project' && r.entity_id === 'proj-2' && r.field === 'deleted');
  assert.strictEqual(rows.length, 1, '墓碑必须留库');
});

test('写 project 也要过权限：非成员推不进去', async () => {
  // 把关点只有 applyOps 一处，所以这里证的是「project 没绕过它」。
  // 用 mom：她这时已经被踢出 CAL 了，推任何东西都该被挡。
  const sneaky = op('proj-1', { name: '偷改的' }, 24000, 'devMom', 'project', CAL);
  const r = await push([sneaky], 1, mom.token);
  assert.ok(!r.body.applied.includes(sneaky.opId), '非成员不该写进去');
  assert.strictEqual(r.body.rejected[0].code, 'forbidden');

  const after = (await snapshot(dad.token)).projects;
  assert.strictEqual(after['proj-1'].name, '星星包', 'dad 的项目名字不能被 mom 改掉');
});

test('认不出的实体仍然被拒 —— 加了 project 不等于放开了口子', async () => {
  const bad = op('x', { a: 1 }, 25000, 'devA', 'projectX');
  const r = await push([bad]);
  assert.strictEqual(r.body.rejected[0].code, 'bad_request');
  assert.strictEqual(r.body.applied.length, 0);
});

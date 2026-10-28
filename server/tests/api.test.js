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
/** 后面「成员目录」那几条用例要复用一个**带昵称**的账户，见昵称那条 */
let nick = null;

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

/**
 * **本地**的 yyyy-MM-dd。
 *
 * ⚠️ 别用 `new Date().toISOString().slice(0, 10)` —— 那是 **UTC** 日期。
 * 服务端的「今天」（serverToday / widgetView 的 today）用的是**本地**日期，
 * 于是每天本地 00:00–08:00（UTC+8 就是 00:00–08:00）这段时间里，
 * 两者会差一天，这条断言每天早上都红一次。踩过一次。
 */
function localDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

/**
 * `HEAD` 走的是 GET 那条路由（2026-10-28 补）。
 *
 * 原先只按 `req.method` 精确匹配，`HEAD /api/health` 掉进 404「接口不存在」。
 * 而排障用的 `curl -I`（DEPLOY.md 的验证段）、监控探活、以及反代做 HEAD 预取时
 * 发的全是 HEAD —— 于是「后端好好的」被读成「后端没起」，排查方向整个偏掉。
 *
 * 三条规矩一起锁：头与 GET 一致、body 为空、**鉴权不许因为换了方法就绕过**。
 */
test('HEAD 走 GET 的路由：头一致、body 为空、鉴权不绕过', async () => {
  const head = await fetch(base + '/api/health', { method: 'HEAD' });
  assert.strictEqual(head.status, 200);
  assert.strictEqual(await head.text(), '', 'HEAD 不该带正文');
  assert.match(head.headers.get('content-type') || '', /application\/json/);
  assert.strictEqual(head.headers.get('cache-control'), 'no-store');

  assert.strictEqual((await fetch(base + '/api/nope', { method: 'HEAD' })).status, 404);
  assert.strictEqual(
    (await fetch(base + '/api/me', { method: 'HEAD' })).status, 401,
    'HEAD 不能绕开登录',
  );
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

test('路由层先挡：名字 / 权限的类型、长度、控制字符', async () => {
  assert.strictEqual((await api('POST', '/api/cals', { token: dad.token, body: { name: 42 } })).status, 400, '名字不是文字');
  assert.strictEqual((await api('POST', '/api/cals', { token: dad.token, body: { name: 'a'.repeat(41) } })).status, 400, '名字超长');
  assert.strictEqual((await api('POST', '/api/cals', { token: dad.token, body: { name: '坏\n名字' } })).status, 400, '名字含控制字符');
  assert.strictEqual((await api('PATCH', `/api/cals/${dad.calId}`, { token: dad.token, body: { name: null } })).status, 400, '改名不给名字');
  assert.strictEqual((await api('PATCH', `/api/cals/${dad.calId}/members/${mom.userId}`, { token: dad.token, body: { role: 1 } })).status, 400, '权限不是文字');
  assert.strictEqual((await api('POST', `/api/cals/${dad.calId}/invites`, { token: dad.token, body: { name: 7, role: 'editor' } })).status, 400, '用户名不是文字');
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

/**
 * 「这个地址有，只是不吃这个方法」必须是 **405**，不是 404（2026-10-28 补）。
 *
 * 原先一律 404，于是「路径写对、方法写错」与「路径根本不存在」长得一模一样：
 * 客户端照着 404 去查路由表，而真正该改的是那个动词。路由表里已经有别的动词
 * 挂在这个地址上（`GET` / `POST` 都在），判据是现成的，没理由不用。
 */
test('地址在、方法不对 → 405 而不是 404', async () => {
  const r = await api('PUT', '/api/cals');
  assert.strictEqual(r.status, 405, `PUT /api/cals 应该 405，实得 ${r.status}`);
  // 真正不存在的那个地址仍然是 404，别把两件事混成一个
  assert.strictEqual((await api('PUT', '/api/nope')).status, 404);
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

/* ------------------------------------------------------------ AI 配置 */

const SECRET_KEY = 'sk-must-never-come-back-1234567890';

test('没配过时读回默认值，且不带 apiKey', async () => {
  const r = await api('GET', '/api/ai/settings', { token: dad.token });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.baseUrl, '要有默认 Base URL，开箱能用');
  assert.ok(r.body.model, '要有默认模型');
  assert.strictEqual(r.body.hasKey, false, '没配过就是没有 key');
  assert.ok(!('apiKey' in r.body), '读接口里不该有 apiKey 这个字段');
});

test('存了 key 之后读回来只有 hasKey —— 明文永远不出服务器', async () => {
  const put = await api('PUT', '/api/ai/settings', {
    token: dad.token, body: { apiKey: SECRET_KEY },
  });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.body.hasKey, true);
  assert.ok(!('apiKey' in put.body), '写的回包里也不该有 apiKey');
  assert.ok(!JSON.stringify(put.body).includes(SECRET_KEY), '回包里出现了 key 本身');

  const get = await api('GET', '/api/ai/settings', { token: dad.token });
  assert.strictEqual(get.body.hasKey, true);
  assert.ok(!('apiKey' in get.body));
  assert.ok(!JSON.stringify(get.body).includes(SECRET_KEY),
    '读接口把 key 明文发回浏览器了 —— 这条挂了说明有人为了「回填表单方便」加回了这个字段');
});

test('只改模型名不会把 key 抹掉（apiKey 省略 = 保留）', async () => {
  await api('PUT', '/api/ai/settings', { token: dad.token, body: { apiKey: SECRET_KEY } });
  const r = await api('PUT', '/api/ai/settings', { token: dad.token, body: { model: 'another-model' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.model, 'another-model');
  assert.strictEqual(r.body.hasKey, true, '没传 apiKey 就该保持原值');

  // 反过来：传空串才是清空
  const cleared = await api('PUT', '/api/ai/settings', { token: dad.token, body: { apiKey: '' } });
  assert.strictEqual(cleared.body.hasKey, false, '空串要能把 key 清掉');
});

test('Base URL 与模型名的校验', async () => {
  const cases = [
    [{ baseUrl: '' }, '空 Base URL'],
    [{ baseUrl: 'not a url' }, '不是网址'],
    [{ baseUrl: 'file:///etc/passwd' }, '非 http(s) 协议'],
    [{ baseUrl: 'ftp://example.com' }, 'ftp'],
    [{ baseUrl: 'http://169.254.169.254/latest/meta-data/' }, '云元数据地址'],
    [{ model: '   ' }, '空模型名'],
  ];
  for (const [body, what] of cases) {
    const r = await api('PUT', '/api/ai/settings', { token: dad.token, body });
    assert.strictEqual(r.status, 400, `${what} 应该被拒，实际 ${r.status}`);
    assert.ok(r.body.error, `${what} 要给出原因`);
  }

  const ok = await api('PUT', '/api/ai/settings', {
    token: dad.token, body: { baseUrl: 'http://127.0.0.1:25001/v1', model: 'claude-sonnet-5.5' },
  });
  assert.strictEqual(ok.status, 200, '本机网关地址必须放行 —— 它就是默认值');
});

test('配置跟着账号走：别人看不到我的 key', async () => {
  const mineBefore = await api('GET', '/api/ai/settings', { token: dad.token });
  const theirs = await api('GET', '/api/ai/settings', { token: mom.token });

  assert.strictEqual(theirs.status, 200);
  assert.strictEqual(theirs.body.hasKey, false, '另一个账号不该继承我的 key');
  assert.ok(!('apiKey' in theirs.body));

  // 我写我的，不能影响他
  await api('PUT', '/api/ai/settings', {
    token: dad.token, body: { model: 'dad-only-model', apiKey: SECRET_KEY },
  });
  const theirsAfter = await api('GET', '/api/ai/settings', { token: mom.token });
  assert.notStrictEqual(theirsAfter.body.model, 'dad-only-model', '配置串到别的账号去了');

  const mineAfter = await api('GET', '/api/ai/settings', { token: dad.token });
  assert.strictEqual(mineAfter.body.model, 'dad-only-model', '自己的改动要留住');
  assert.ok(mineBefore.body.model !== 'dad-only-model');
});

test('没登录读写配置一律 401', async () => {
  assert.strictEqual((await api('GET', '/api/ai/settings')).status, 401);
  assert.strictEqual(
    (await api('PUT', '/api/ai/settings', { body: { model: 'x' } })).status, 401,
  );
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

/* ============ 日程集颜色 · 昵称 · 成员目录 · 任务来源（2026-10-28） ============
 *
 * 这四件其实是一件事的四半：**这条是谁建的、在哪个颜色的集里、那个人叫什么**。
 * 前后端各占一半，所以这里一半用例在打接口、一半在核对两边的名单。
 *
 * 放在「改口令」之前是有原因的：那几条用例会把 dad / mom 注册时签的票全部作废
 * （那正是它要证的事），而这一段要用票；登录又有按 IP 的限流，前面那些用例已经
 * 把配额用得差不多了。所以这一段一律用 `dad.token` / `mom.token`，不再登录。
 */

/** 颜色标签名单。**前端那份在 `app/src/domain/types/Cal.ts`**，两边必须同一批 */
const COLOR_KEYS = ['jade', 'azure', 'clay', 'plum', 'gold', 'slate', 'rose', 'teal'];

/** 建一个 dad 的集、把 mom 拉成可编辑成员，返回 calId（来源那几条都要两个人同一个集） */
async function sharedCal(name) {
  const made = await api('POST', '/api/cals', { token: dad.token, body: { name } });
  assert.strictEqual(made.status, 200, JSON.stringify(made.body));
  const calId = made.body.cal.id;

  const inv = await api('POST', `/api/cals/${calId}/invites`, {
    token: dad.token, body: { name: mom.name, role: 'editor' },
  });
  assert.strictEqual(inv.status, 200, JSON.stringify(inv.body));
  const mine = await api('GET', '/api/invites', { token: mom.token });
  assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
  const invite = mine.body.invites.find((i) => i.calId === calId);
  assert.ok(invite, `mom 没收到「${name}」的邀请：` + JSON.stringify(mine.body));
  const acc = await api('POST', `/api/invites/${invite.id}/accept`, { token: mom.token });
  assert.strictEqual(acc.status, 200, JSON.stringify(acc.body));
  return calId;
}

test('日程集颜色：新建就有默认色，owner 改得动，列表与同步都带回', async () => {
  const made = await api('POST', '/api/cals', { token: dad.token, body: { name: '颜色试验集' } });
  assert.strictEqual(made.status, 200, JSON.stringify(made.body));
  assert.strictEqual(made.body.cal.color, 'jade', '新建的集必须有色可画，不能是个空字段');

  const put = await api('PATCH', `/api/cals/${made.body.cal.id}`, {
    token: dad.token, body: { color: 'plum' },
  });
  assert.strictEqual(put.status, 200, JSON.stringify(put.body));

  const list = await api('GET', '/api/cals', { token: dad.token });
  assert.strictEqual(list.body.cals.find((c) => c.id === made.body.cal.id).color, 'plum');

  const sync = await api('POST', '/api/sync', { token: dad.token, body: { cursor: 1, ops: [] } });
  assert.strictEqual(sync.body.cals.find((c) => c.id === made.body.cal.id).color, 'plum',
    '轮询也要带回颜色 —— 否则别的设备改了颜色，这边要等刷新才看得到');
});

test('日程集颜色：可编辑成员改不动；名单外的值 400 并且不改库', async () => {
  const calId = await sharedCal('颜色权限集');

  const editor = await api('PATCH', `/api/cals/${calId}`, { token: mom.token, body: { color: 'gold' } });
  assert.strictEqual(editor.status, 403, '颜色属于「改集」，可编辑成员管不了集本身');

  /* 名单外的一律挡：颜色是**标签**不是自由文本，它最终会被写进 `data-*` 属性 */
  for (const bad of ['不存在的颜色', '', 'jade" onmouseover="x', 12, null]) {
    const r = await api('PATCH', `/api/cals/${calId}`, { token: dad.token, body: { color: bad } });
    assert.strictEqual(r.status, 400, `color=${JSON.stringify(bad)} 必须被挡住`);
  }
  const after = await api('GET', '/api/cals', { token: dad.token });
  assert.strictEqual(after.body.cals.find((c) => c.id === calId).color, 'jade', '被拒的请求不能改库');
});

test('日程集颜色：服务端那份名单和前端那份是同一批', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../app/src/domain/types/Cal.ts'), 'utf8');
  const m = src.match(/CAL_COLORS[^=\n]*=\s*\[([^\]]*)\]/);
  assert.ok(m, '前端那份 CAL_COLORS 找不到了（改名了？那这条断言要跟着改）');
  const client = m[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepStrictEqual(client, COLOR_KEYS);
  assert.deepStrictEqual(require('../lib/calendars').CAL_COLORS, COLOR_KEYS);
});

test('昵称：设置、上限、取消都回落到用户名', async () => {
  const set = await api('PATCH', '/api/me', { token: mom.token, body: { nickname: '阿包' } });
  assert.strictEqual(set.status, 200, JSON.stringify(set.body));
  assert.strictEqual(set.body.user.nickname, '阿包');
  assert.strictEqual(set.body.user.name, mom.name, '用户名还在 —— 昵称是**优先显示**，不是替换登录名');

  const me = await api('GET', '/api/me', { token: mom.token });
  assert.strictEqual(me.body.user.nickname, '阿包', '启动那一次请求就要带回昵称');

  const over = await api('PATCH', '/api/me', { token: mom.token, body: { nickname: '字'.repeat(21) } });
  assert.strictEqual(over.status, 400, '昵称要有上限：一行长文本会把列表撑破');
  assert.strictEqual((await api('GET', '/api/me', { token: mom.token })).body.user.nickname, '阿包',
    '被拒的请求不能改库');

  const blank = await api('PATCH', '/api/me', { token: dad.token, body: { nickname: '   ' } });
  assert.strictEqual(blank.status, 200);
  assert.strictEqual(blank.body.user.nickname, null, '全空白等于没有，不是存一串空格');

  const cleared = await api('PATCH', '/api/me', { token: dad.token, body: { nickname: null } });
  assert.strictEqual(cleared.status, 200);
  assert.strictEqual(cleared.body.user.nickname, null, '取消昵称 = 回到用户名，不是报错');
});

test('成员目录：/api/sync 与 /api/me 都带「我这些集里都有谁」，不含没共享集的人', async () => {
  await sharedCal('目录试验集');

  const sync = await api('POST', '/api/sync', { token: dad.token, body: { cursor: 1, ops: [] } });
  const dir = sync.body.users;
  assert.ok(dir, '/api/sync 必须带成员目录 —— 没有它，来源标记只能显示「?」');
  assert.deepStrictEqual(dir[mom.userId], { name: mom.name, nickname: '阿包' });
  assert.ok(dir[dad.userId], '自己也要在目录里（判「是不是我建的」要用它）');

  const meDir = await api('GET', '/api/me', { token: dad.token });
  assert.ok(meDir.body.users[mom.userId], '/api/me 也带一份 —— 启动那次请求就该能认出别人');

  /* 小雪（前面注册的那只）没和 dad 共享任何集 → 不进目录。
     目录不是全站用户名表，只暴露「和我同一个集的人」。直接查库拿 id，
     不绕登录（登录有按 IP 的限流，这段用例不该去挤它）。 */
  const snow = db.findUserByName('小雪');
  assert.ok(snow, '前面那条用例注册的小雪应该在库里');
  assert.strictEqual(dir[snow.id], undefined, '没共享集的人不进目录');
});

/* -------------------------------------------------------- 任务来源 createdBy */

/**
 * 「非自己添加」只能由服务器判定：op 里的 `deviceId` 只到设备、不到用户，
 * 客户端自报的 id 更不能信。所以 `createdBy` 由路由层验过票的那个 userId 写。
 */
test('来源：谁建的任务落谁的 id；客户端自报的 createdBy 不算数', async () => {
  const calId = await sharedCal('来源试验集');

  const byMom = await push([
    op('t-src-mom', { title: 'mom 建的', date: localDay() }, 900001, 'dev-mom', 'task', calId),
  ], 1, mom.token);
  assert.strictEqual(byMom.status, 200, JSON.stringify(byMom.body));

  const byDad = await push([
    op('t-src-dad', { title: 'dad 建的', date: localDay() }, 900002, 'dev-dad', 'task', calId),
    op('t-src-fake', { title: '冒充的', date: localDay(), createdBy: mom.userId }, 900003, 'dev-dad', 'task', calId),
  ], 1, dad.token);
  assert.strictEqual(byDad.status, 200, JSON.stringify(byDad.body));

  const snap = await snapshot(dad.token);
  assert.strictEqual(snap.tasks['t-src-mom'].createdBy, mom.userId, '别人建的必须认得出是别人');
  assert.strictEqual(snap.tasks['t-src-dad'].createdBy, dad.userId);
  assert.strictEqual(snap.tasks['t-src-fake'].createdBy, dad.userId,
    'op 里自报的 createdBy 不能盖掉服务器判出来的那个 —— 否则任何人都能冒充别人');

  const hers = await snapshot(mom.token);
  assert.strictEqual(hers.tasks['t-src-dad'].createdBy, dad.userId, '两边看到的是同一件事');
});

test('来源：改标题 / 改期都不会把创建者改成动手的那个人', async () => {
  const calId = await sharedCal('来源改名集');
  const t = 't-src-rename';
  await push([op(t, { title: 'dad 建的', date: localDay() }, 900010, 'dev-dad', 'task', calId)], 1, dad.token);
  await push([op(t, { title: 'mom 改的名' }, 900011, 'dev-mom', 'task', calId)], 1, mom.token);
  await push([op(t, { date: localDay(1) }, 900012, 'dev-mom', 'task', calId)], 1, mom.token);

  const snap = await snapshot(dad.token);
  assert.strictEqual(snap.tasks[t].title, 'mom 改的名', '改名本身要生效');
  assert.strictEqual(snap.tasks[t].createdBy, dad.userId,
    '只有「第一次被建出来」那条算创建；否则改一次名就把创建者改成自己了');
});

test('来源：AI 落库记成 ai，不是某个人的 id（它不该被标成「别人」）', async () => {
  const calId = await sharedCal('来源 AI 集');
  const r = await push([op('t-src-ai', { title: 'AI 建的', date: localDay() }, 900020, 'ai', 'task', calId)], 1, dad.token);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual((await snapshot(dad.token)).tasks['t-src-ai'].createdBy, 'ai');
});

test('来源：只改日期不补来源 —— 上线前建的老任务缺这个字段，前端因此不画而不是猜', async () => {
  const calId = await sharedCal('来源老任务集');
  const t = 't-src-old';
  await push([op(t, { date: localDay() }, 900030, 'dev-dad', 'task', calId)], 1, dad.token);
  const snap = await snapshot(dad.token);
  assert.ok(snap.tasks[t], '任务本身要在');
  assert.strictEqual(snap.tasks[t].createdBy, undefined,
    '判不出是谁建的就别写猜测值：缺字段是诚实的，猜值是错的');
});

/* ============================================================ 改口令 */

/** 拿一只属于某个账户的票（每次都要现拿 —— 改口令会把旧的全部作废） */
async function loginAs(name, password) {
  const r = await api('POST', '/api/auth/login', { body: { name, password } });
  assert.strictEqual(r.status, 200, `登录 ${name} 失败: ${JSON.stringify(r.body)}`);
  return r.body.token;
}

/**
 * 改口令的三条不变量，一条都不能少：
 *   1. **截止时间之前签出去的票全部作废** —— 这是改口令最主要的目的
 *   2. **用户不会被踢出去** —— 响应里带回一只新 token，客户端换上就继续
 *   3. 没改成的时候**什么都不动**（旧票照旧有效，口令照旧是旧的）
 *
 * 这几条**复用 dad / mom**，不注册新账户 —— 注册限速是每 IP 每小时 10 次，
 * 每个用例新开一个号会在几条之后撞上 429（实测踩过）。
 * 票也是**每条现拿**：改口令会作废同一个人名下所有旧票，拿上一条留下的
 * token 当输入会莫名其妙地先 401。
 */
test('改口令：改动之前签的票全废，新 token 换上，新口令能登录', async () => {
  const t0 = await loginAs('妈妈', 'mom-pass-1');
  const t1 = await loginAs('妈妈', 'mom-pass-1');   // 「另一台设备」
  assert.strictEqual((await api('GET', '/api/me', { token: t1 })).status, 200, '改之前两台都是好的');

  const r = await api('POST', '/api/auth/password', {
    token: t0, body: { oldPassword: 'mom-pass-1', newPassword: 'brand-new-99' },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.ok, true);
  assert.ok(r.body.token && r.body.token !== t0, '响应里要带一只新 token');

  // 1. 截止时间之前签的票（含请求里用的那一只）全部作废
  assert.strictEqual((await api('GET', '/api/me', { token: t0 })).status, 401,
    '改动之前签的票必须全部作废 —— 被偷走的那只就在里面');
  assert.strictEqual((await api('GET', '/api/me', { token: t1 })).status, 401,
    '另一台设备的旧票更是要废掉');

  // 2. 换上的那只继续能用 —— 用户感知不到这次替换
  assert.strictEqual((await api('GET', '/api/me', { token: r.body.token })).status, 200,
    '换上新 token 之后照常用，不重新登录、不被打断');

  // 新口令能登录，旧口令不行
  assert.strictEqual((await api('GET', '/api/me', { token: await loginAs('妈妈', 'brand-new-99') })).status, 200);
  assert.strictEqual((await api('POST', '/api/auth/login', { body: { name: '妈妈', password: 'mom-pass-1' } })).status, 401);
});

test('改口令：比请求所用那张票更晚签的票也一并作废（按时刻切，不是按 iat）', async () => {
  // 先登一次，再用**它之后**签的另一张票去改口令 —— 要证的正是
  // 「晚签的那些也会被作废」。拿 iat 当截止时间的话，这一条会漏过去。
  const earlier = await loginAs('爸爸', 'family-pass-1');
  const token = await loginAs('爸爸', 'family-pass-1');
  const later = await loginAs('爸爸', 'family-pass-1');

  await api('POST', '/api/auth/password', {
    token, body: { oldPassword: 'family-pass-1', newPassword: 'dad-new-2026' },
  });

  assert.strictEqual((await api('GET', '/api/me', { token: earlier })).status, 401);
  assert.strictEqual((await api('GET', '/api/me', { token: later })).status, 401,
    '比请求所用那张票更晚签的也要作废');
  assert.strictEqual((await api('GET', '/api/me', { token })).status, 401);
});

test('改口令：旧密码不对时不改，旧票照旧有效', async () => {
  const t = await loginAs('妈妈', 'brand-new-99');
  const r = await api('POST', '/api/auth/password', {
    token: t, body: { oldPassword: '猜错了', newPassword: 'sneaky-1234' },
  });
  assert.strictEqual(r.status, 401);

  // 什么都不能动：票还是那只，口令还是旧的
  assert.strictEqual((await api('GET', '/api/me', { token: t })).status, 200);
  assert.strictEqual((await api('POST', '/api/auth/login', { body: { name: '妈妈', password: 'brand-new-99' } })).status, 200);
  assert.strictEqual((await api('POST', '/api/auth/login', { body: { name: '妈妈', password: 'sneaky-1234' } })).status, 401);
});

test('改口令：新口令不合规时返回 400，口令不变', async () => {
  const t = await loginAs('爸爸', 'dad-new-2026');
  const short = await api('POST', '/api/auth/password', {
    token: t, body: { oldPassword: 'dad-new-2026', newPassword: '123' },
  });
  assert.strictEqual(short.status, 400);
  assert.strictEqual(short.body.error, '密码至少 6 位');

  // 「全是数字」那一条也走 passwordProblem，别在这里另写一套规则
  const digits = await api('POST', '/api/auth/password', {
    token: t, body: { oldPassword: 'dad-new-2026', newPassword: '123456' },
  });
  assert.strictEqual(digits.status, 400);
  assert.ok(digits.body.error.includes('数字'), digits.body.error);

  // 校验不通过就在改之前挡下 —— 口令一个字都不能被改掉
  assert.strictEqual((await api('POST', '/api/auth/login', { body: { name: '爸爸', password: 'dad-new-2026' } })).status, 200);
});

test('改口令接口要登录：没带票进不来', async () => {
  const r = await api('POST', '/api/auth/password', {
    body: { oldPassword: 'x', newPassword: 'y-y-y-y-y' },
  });
  assert.strictEqual(r.status, 401);
});

/* -------------------------------------------------- 桌面小组件接口 */

// ⚠️ 注册有每 IP 每小时 10 次的限流（routes/auth.js:38），这个文件里前面已经
// 用掉大半配额。所以下面**尽量复用 dad**，只为一个只读成员的用例新开一个账户。
// 新加用例时先数一下这里注册了几次。

test('小组件 bootstrap：未登录进不来，登录后返回快照形状', async () => {
  assert.strictEqual((await api('GET', '/api/widget/bootstrap')).status, 401);

  // ⚠️ 前面「改口令」那几个用例把 dad 的票作废了（改口令会让之前签发的全部失效）。
  // 这里重新登录拿一张新的，否则后面全是 401。口令是那个用例改后的值。
  const relogin = await api('POST', '/api/auth/login', {
    body: { name: '爸爸', password: 'dad-new-2026' },
  });
  assert.strictEqual(relogin.status, 200, JSON.stringify(relogin.body));
  dad.token = relogin.body.token;

  const todayIso = localDay();
  const far = localDay(60);
  await push([
    op('wt-in', { title: '窗口内的事', date: todayIso, time: '09:00', done: false }, 0, 'd1'),
    op('wt-out', { title: '窗口外的事', date: far, time: null }, 0, 'd1'),
  ], 1);

  const r = await api('GET', '/api/widget/bootstrap', { token: dad.token });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.today, todayIso);
  assert.strictEqual(r.body.defaultCalId, CAL);
  const titles = r.body.tasks.map((t) => t.title);
  assert.ok(titles.includes('窗口内的事'), '窗口内的任务应该在');
  assert.ok(!titles.includes('窗口外的事'), '窗口外的任务不该出现');
  // 形状必须跟 App 写的快照一致，否则原生侧两套解析器会对不上
  const t = r.body.tasks.find((x) => x.title === '窗口内的事');
  assert.strictEqual(t.calId, CAL, '任务必须带 calId —— 写操作要用');
  assert.strictEqual(t.dur, 0);
  assert.strictEqual(t.done, false);
});

test('小组件 op：勾完成真的落库，@new 由服务端发 id', async () => {
  const todayIso = localDay();
  await push([
    op('wt-t1', { title: '待勾的事', date: todayIso, time: '10:00', done: false }, 0, 'd1'),
  ], 1);

  const r = await api('POST', '/api/widget/op', {
    token: dad.token,
    body: {
      deviceId: 'widget-test',
      ops: [
        { entity: 'task', entityId: 'wt-t1', calId: CAL, fields: { done: true, doneAt: Date.now() } },
        { entity: 'task', entityId: '@new', calId: CAL, fields: { title: '桌面新建', date: todayIso, time: null, done: false, doneAt: null } },
      ],
    },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.applied, 2);

  const snap = await snapshot();
  assert.strictEqual(snap.tasks['wt-t1'].done, true, '勾完成必须真的写进库');
  const made = r.body.tasks.find((t) => t.title === '桌面新建');
  assert.ok(made, '新建的任务必须在回读里');
  assert.ok(/^t_[0-9a-f]{16}$/.test(made.id), 'id 该是服务端发的那个: ' + made.id);
  assert.ok(snap.tasks[made.id], '新建的那条也得在库里');
});

test('小组件 op：只读成员写不进去（权限没被绕开）', async () => {
  // 最关键的一条：这个接口自己**不做**权限判断，全靠 applyOps。
  // 哪天有人图省事在这里直接写库，这条会红。
  const viewer = await registerUser('小组件观群员', 'widget-viewer-1');
  const todayIso = localDay();
  await push([
    op('wt-v1', { title: '群主的任务', date: todayIso, time: '08:00', done: false }, 0, 'd1'),
  ], 1);

  const made = await api('POST', `/api/cals/${CAL}/invites`, {
    token: dad.token, body: { name: viewer.name, role: 'viewer' },
  });
  assert.strictEqual(made.status, 200, JSON.stringify(made.body));
  const inbox = await api('GET', '/api/invites', { token: viewer.token });
  assert.strictEqual(inbox.body.invites.length, 1, JSON.stringify(inbox.body));
  assert.strictEqual((await api('POST', `/api/invites/${inbox.body.invites[0].id}/accept`, {
    token: viewer.token,
  })).status, 200);

  const r = await api('POST', '/api/widget/op', {
    token: viewer.token,
    body: {
      deviceId: 'widget-test',
      ops: [{ entity: 'task', entityId: 'wt-v1', calId: CAL, fields: { done: true } }],
    },
  });
  assert.strictEqual(r.status, 200, '接口本身不报错 —— 拒绝逐条 op 体现');
  assert.strictEqual(r.body.applied, 0, '只读成员一条都不该生效');
  assert.ok(r.body.rejected.length > 0 && r.body.rejected[0].code === 'forbidden',
    '拒绝原因必须是 forbidden: ' + JSON.stringify(r.body.rejected));

  const snap = await snapshot(viewer.token);
  assert.strictEqual(snap.tasks['wt-v1'].done, false, '库里必须还是没完成');
});

test('小组件 op：空 ops / 超量都挡住', async () => {
  assert.strictEqual((await api('POST', '/api/widget/op', {
    token: dad.token, body: { deviceId: 'x', ops: [] },
  })).status, 400);
  const many = [];
  for (let i = 0; i < 51; i++) {
    many.push({ entity: 'task', entityId: '@new', calId: CAL, fields: { title: 't' + i } });
  }
  assert.strictEqual((await api('POST', '/api/widget/op', {
    token: dad.token, body: { deviceId: 'x', ops: many },
  })).status, 400);
});

/* ---------------------------------------------------- repeatUntil 的级联清理 */

/**
 * 「从这次起往后全部」的服务端兜底（2026-10-14 实机发现的问题）。
 *
 * 场景：小组件发起删除时，它手里只有「上次同步时的快照」，而 App 那边还在
 * 滚预生成窗口、会补出更远的实例。发起端删不干净，于是残留。
 *
 * 现在客户端只落一个 `repeatUntil` 标记，由服务端把该系列结束日及以后的
 * 实例全部标记删除 —— 所有端通过普通增量同步收敛。
 */
test('落下 repeatUntil 后，服务端把该系列结束日及以后的实例全部删掉', async () => {
  const SERIES = 'series-cascade';
  const DATES = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19'];

  await push([op(SERIES, { title: '每天跑步', date: DATES[0], seriesId: null }, 40000, 'devA')]);
  for (const d of DATES.slice(1)) {
    await push([op(`${SERIES}#${d}`, {
      title: '每天跑步', date: d, seriesId: SERIES,
    }, 40100, 'devA')]);
  }

  const before = await snapshot();
  assert.ok(before.tasks[`${SERIES}#${DATES[4]}`], '前提：最后一次实例先得存在');

  // 用户在 10-17 那一次上选「从这次起往后全部」
  await push([op(SERIES, { repeatUntil: '2026-10-17' }, 41000, 'devA')]);

  const after = await snapshot();
  console.log('  级联后:',
    '根(10-15):' + (after.tasks[SERIES] ? '在' : '删'),
    DATES.slice(1).map((d) => `${d}:${after.tasks[`${SERIES}#${d}`] ? '在' : '删'}`).join(' '));

  // 结束日**及以后**的实例必须都没了（墓碑不进快照 → 表现为「不在快照里」）
  for (const d of ['2026-10-17', '2026-10-18', '2026-10-19']) {
    assert.ok(!after.tasks[`${SERIES}#${d}`], `${d} 在结束日及以后，必须被级联删掉`);
  }
  // 结束日**之前**的照旧（含系列根本不是实例，不能被牵连）
  assert.ok(after.tasks[`${SERIES}#2026-10-16`], '10-16 在结束日之前，不该被动');
  assert.ok(after.tasks[SERIES], '系列根（10-15）早于结束日，不该被删');
  assert.strictEqual(after.tasks[SERIES].repeatUntil, '2026-10-17', '标记本身要留在根上');
});

test('级联是幂等的：重复落同一个 repeatUntil 不会出错', async () => {
  const SERIES = 'series-cascade-2';
  await push([op(SERIES, { title: '喝水', date: '2026-10-15' }, 42000, 'devA')]);
  await push([op(`${SERIES}#2026-10-16`, { title: '喝水', date: '2026-10-16', seriesId: SERIES }, 42010, 'devA')]);

  await push([op(SERIES, { repeatUntil: '2026-10-16' }, 42020, 'devA')]);
  const first = await snapshot();
  await push([op(SERIES, { repeatUntil: '2026-10-16' }, 42030, 'devA')]);
  const second = await snapshot();

  assert.ok(!first.tasks[`${SERIES}#2026-10-16`], '第一次就该删掉');
  assert.ok(!second.tasks[`${SERIES}#2026-10-16`], '再落一次仍是删除态，不该复活');
});

test('repeatUntil 为 null（撤销标记）时不误删任何实例', async () => {
  const SERIES = 'series-cascade-3';
  await push([op(SERIES, { title: '读书', date: '2026-10-15' }, 43000, 'devA')]);
  await push([op(`${SERIES}#2026-10-16`, { title: '读书', date: '2026-10-16', seriesId: SERIES }, 43010, 'devA')]);

  await push([op(SERIES, { repeatUntil: null }, 43020, 'devA')]);

  const snap = await snapshot();
  assert.ok(snap.tasks[`${SERIES}#2026-10-16`], 'null 只是「没设结束日」，不该删东西');
});

/**
 * 2026-10-17 用户报「全部删除只删了当天」。
 *
 * 实测服务端数据里，被小组件改乱了血脉的系列有三种形态：
 *   ① 中间层实例的 seriesId 指向自己（id 带一层日期段）；
 *   ② 子嗣 id 带两层日期段、seriesId 指向中间层；
 *   ③ seriesId 整个缺失。
 * 只按 seriesId 字段单路收集 → 旁支漏网 → 客户端的窗口补齐又把它们造回来。
 * 修法：形状路（id 以 `真根#` 开头即家族成员）+ 真根解析。
 */
test('血脉裂成多层的系列：级联删除要连旁支一起删', async () => {
  const SERIES = 'series-cascade-split';
  const D1 = '2026-10-15', D2 = '2026-10-16', D3 = '2026-10-17', D4 = '2026-10-18';

  await push([op(SERIES, { title: '55', date: D1, seriesId: null }, 44000, 'devA')]);
  await push([op(`${SERIES}#${D2}`, { title: '55', date: D2, seriesId: SERIES }, 44010, 'devA')]);
  // 变异①：中间层实例 seriesId 指向自己
  await push([op(`${SERIES}#${D3}`, { title: '55', date: D3, seriesId: `${SERIES}#${D3}` }, 44020, 'devA')]);
  // 变异②：子嗣带两层日期段，seriesId 指向中间层（单路收集永远漏它）
  await push([op(`${SERIES}#${D3}#${D4}`, { title: '55', date: D4, seriesId: `${SERIES}#${D3}` }, 44030, 'devA')]);
  // 变异③：seriesId 整个缺失
  await push([op(`${SERIES}#2026-10-19`, { title: '55', date: '2026-10-19', seriesId: null }, 44040, 'devA')]);

  const before = await snapshot();
  assert.ok(before.tasks[`${SERIES}#${D3}#${D4}`], '前提：旁支实例先得存在');

  // 用户在 10-17 那一次上选「从这次起往后全部」
  await push([op(SERIES, { repeatUntil: D3 }, 44050, 'devA')]);

  const after = await snapshot();
  assert.ok(!after.tasks[`${SERIES}#${D3}`], '结束日当天的实例要删');
  assert.ok(!after.tasks[`${SERIES}#${D4}`], '正常实例要删');
  assert.ok(!after.tasks[`${SERIES}#${D3}#${D4}`], '两层日期段的旁支也必须删');
  assert.ok(!after.tasks[`${SERIES}#2026-10-19`], '缺 seriesId 的旁支也必须删');
  assert.ok(after.tasks[`${SERIES}#${D2}`], '结束日之前的历史要留');
  assert.ok(after.tasks[SERIES], '系列根早于结束日，要留');
});

test('标记落在旁支成员上（根不在发起端本机）：按真根级联', async () => {
  const SERIES = 'series-cascade-carrier';
  await push([op(SERIES, { title: '喝水', date: '2026-10-15' }, 45000, 'devA')]);
  await push([op(`${SERIES}#2026-10-16`, { title: '喝水', date: '2026-10-16', seriesId: SERIES }, 45010, 'devA')]);
  await push([op(`${SERIES}#2026-10-17`, { title: '喝水', date: '2026-10-17', seriesId: SERIES }, 45020, 'devA')]);

  // 标记写在 10-16 那个成员身上（客户端在根不在本机时改写到存活成员）
  await push([op(`${SERIES}#2026-10-16`, { repeatUntil: '2026-10-17' }, 45030, 'devA')]);

  const after = await snapshot();
  assert.ok(!after.tasks[`${SERIES}#2026-10-17`], '真根仍是 SERIES，10-17 该被删');
  assert.ok(after.tasks[`${SERIES}#2026-10-16`], '载体在结束日之前，是故意留给它的，要留');
  assert.ok(after.tasks[SERIES], '系列根本身不受影响（还没到结束日）');
});

/* ------------------------------------------------------- 桌面计数器（v5） */

/**
 * 计数器最关键的一条：**并发 +1 不能丢**。
 * 这是它没走 applyOps（整值替换）的唯一理由，所以必须有测试钉住，
 * 否则哪天有人「顺手统一到 sync 通道」，症状是用户点了很多下、数字只长一两格。
 */
test('计数器：默认两个、原子自增、手输改值、夹在 0..上限', async () => {
  const relogin = await api('POST', '/api/auth/login', {
    body: { name: '爸爸', password: 'dad-new-2026' },
  });
  assert.strictEqual(relogin.status, 200, JSON.stringify(relogin.body));
  const token = relogin.body.token;

  // 未登录进不来
  assert.strictEqual((await api('POST', '/api/widget/counter', { body: { id: 'naonao', delta: 1 } })).status, 401);

  // bootstrap 自带两个计数器，初值 0
  const boot = await api('GET', '/api/widget/bootstrap', { token });
  assert.strictEqual(boot.status, 200);
  const names = boot.body.counters.map((c) => c.name);
  assert.deepStrictEqual(names, ['naonao', 'Kutai'], '默认顺序：naonao 在上');
  assert.strictEqual(boot.body.counters[0].value, 0);

  // 单次自增
  const one = await api('POST', '/api/widget/counter', { token, body: { id: 'naonao', delta: 1 } });
  assert.strictEqual(one.status, 200, JSON.stringify(one.body));
  assert.strictEqual(one.body.counter.value, 1);

  // 并发 20 次 +1 —— 整值替换的写法在这里会丢到个位数
  await Promise.all(Array.from({ length: 20 }, () => api('POST', '/api/widget/counter', {
    token, body: { id: 'naonao', delta: 1 },
  })));
  const afterBurst = await api('GET', '/api/widget/bootstrap', { token });
  assert.strictEqual(
    afterBurst.body.counters.find((c) => c.id === 'naonao').value, 21,
    '20 次并发 +1 必须一次不丢',
  );

  // 一次加几百
  const bulk = await api('POST', '/api/widget/counter', { token, body: { id: 'kutai', delta: 300 } });
  assert.strictEqual(bulk.body.counter.value, 300);

  // 手输直接改
  const set = await api('POST', '/api/widget/counter', { token, body: { id: 'kutai', value: 7 } });
  assert.strictEqual(set.body.counter.value, 7);

  // 减到负数要夹回 0
  const neg = await api('POST', '/api/widget/counter', { token, body: { id: 'kutai', delta: -100 } });
  assert.strictEqual(neg.body.counter.value, 0, '计数不能是负数');

  // 不认识的 id 不悄悄建一条
  assert.strictEqual(
    (await api('POST', '/api/widget/counter', { token, body: { id: 'nope', delta: 1 } })).status, 404,
  );
  // 两个参数都不给
  assert.strictEqual(
    (await api('POST', '/api/widget/counter', { token, body: { id: 'naonao' } })).status, 400,
  );

  // 归属是账号：另一个账号看到的还是自己的 0
  const other = await registerUser('计数器隔离', 'ctr-iso-2026');
  const theirs = await api('GET', '/api/widget/bootstrap', { token: other.token });
  assert.strictEqual(theirs.body.counters.find((c) => c.id === 'naonao').value, 0, '不能串号');
});

/**
 * 每天自动 +6（v6）。这块的坑全在「补几天」和「补几次」上：
 *   · 服务器是 UTC，用本地日期会在早上 8 点才换日 → 必须按北京时间算；
 *   · 两台设备同时打开 → 只能补一次，不能各补一次；
 *   · 同一天反复刷新 → 不能每刷新一次就加 6。
 * 直接改库里的 last_credit_date 来模拟「隔了 N 天」，不靠等真实时间。
 */
test('计数器：每天 0 点按天数补、同一天只补一次、可关掉', async () => {
  // 复用上一个用例建的账号：注册有 IP 限流（一小时），测试里不能一路新注册
  const login = await api('POST', '/api/auth/login', {
    body: { name: '计数器隔离', password: 'ctr-iso-2026' },
  });
  assert.strictEqual(login.status, 200, JSON.stringify(login.body));
  const me = await api('GET', '/api/me', { token: login.body.token });
  const u = { token: login.body.token, userId: me.body.user.id };
  const t = () => api('GET', '/api/widget/bootstrap', { token: u.token });
  const val = async (id) => (await t()).body.counters.find((c) => c.id === id).value;

  // 新账号：从今天起算，不追历史
  const boot = await t();
  assert.strictEqual(boot.body.counters[0].value, 0, '第一次读不该凭空多出 6');
  assert.strictEqual(boot.body.counters[0].dailyIncrement, 6, '默认每天 6');

  // 模拟「三天没读」：把上次结算日往前拨 3 天
  const back = (n) => new Date(Date.now() + 8 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
  db.run('UPDATE counters SET last_credit_date = ? WHERE user_id = ? AND id = ?', back(3), u.userId, 'naonao');
  assert.strictEqual(await val('naonao'), 18, '隔 3 天补 18（不是只补 6）');

  // 同一天再读两次：不能每读一次就加 6
  assert.strictEqual(await val('naonao'), 18);
  assert.strictEqual(await val('naonao'), 18);

  // 手动设值不破坏「今天已结算」：设成 5 之后再看还是 5
  await api('POST', '/api/widget/counter', { token: u.token, body: { id: 'naonao', value: 5 } });
  assert.strictEqual(await val('naonao'), 5, '手输之后当天不该被再补一次');

  // 归零同样是当天生效，第二天照样加
  await api('POST', '/api/widget/counter', { token: u.token, body: { id: 'naonao', value: 0 } });
  db.run('UPDATE counters SET last_credit_date = ? WHERE user_id = ? AND id = ?', back(1), u.userId, 'naonao');
  assert.strictEqual(await val('naonao'), 6, '归零之后第二天照样 +6');

  // 关掉自动增加 → 隔几天都不动
  const off = await api('POST', '/api/widget/counter', { token: u.token, body: { id: 'kutai', dailyIncrement: 0 } });
  assert.strictEqual(off.body.counter.dailyIncrement, 0);
  db.run('UPDATE counters SET last_credit_date = ? WHERE user_id = ? AND id = ?', back(5), u.userId, 'kutai');
  assert.strictEqual(await val('kutai'), 0, '每日增量为 0 就不该补');

  // 增量可以改成别的值（比如 8）
  await api('POST', '/api/widget/counter', { token: u.token, body: { id: 'kutai', dailyIncrement: 8 } });
  db.run('UPDATE counters SET last_credit_date = ? WHERE user_id = ? AND id = ?', back(2), u.userId, 'kutai');
  assert.strictEqual(await val('kutai'), 16, '改成 8 之后隔 2 天 = 16');

  // 并发读只补一次：两个请求同时发现「欠了 2 天」
  db.run('UPDATE counters SET last_credit_date = ?, value = 0 WHERE user_id = ? AND id = ?', back(2), u.userId, 'naonao');
  await Promise.all([t(), t(), t(), t()]);
  assert.strictEqual(await val('naonao'), 12, '4 个并发读只能补一次');

  // 改名 + id 不变（桌面组件按 id 找记录，换 id 等于数字归零）
  const rn = await api('POST', '/api/widget/counter', { token: u.token, body: { id: 'naonao', name: '喝水' } });
  assert.strictEqual(rn.body.counter.id, 'naonao');
  assert.strictEqual(rn.body.counter.name, '喝水');
  assert.strictEqual(rn.body.counter.value, 12, '改名不动数字');

  // 空白名要挡住（否则卡片上是个空格，用户以为坏了）
  assert.strictEqual(
    (await api('POST', '/api/widget/counter', { token: u.token, body: { id: 'naonao', name: '   ' } })).status, 400,
  );
});

/* ------------------------------------------------------------------
 * 详细内容里的图片（2026-10-26）
 *
 * 这条通路是全新的、也是**公开可读**的（`<img>` 带不了 Bearer 头），
 * 所以这里重点验三件「一旦错了就是安全事故或数据损坏」的事：
 *   1. 只收位图，且回来的是同一份字节（不能变形、不能变成 0 字节）；
 *   2. 文件名非法（`../` 之类）必须 404，不能真的去读别的文件；
 *   3. 写进去要登录，读不要 —— 读要登录的话网页上的图会全部裂掉。
 * ------------------------------------------------------------------ */

/* 1×1 透明 PNG，够小了但也真是一张合法图片 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(buf, type, token) {
  const headers = { 'Content-Type': type };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + '/api/media', { method: 'POST', headers, body: buf });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('图片：上传 → 读回 → 字节完全一致', async () => {
  const up = await upload(PNG_1PX, 'image/png', dad.token);
  assert.strictEqual(up.status, 200);
  assert.match(up.body.url, /^\/api\/media\/[a-f0-9]{64}\.png$/, '文件名是内容哈希 + 扩展名');

  /* 读的时候**不带 token**：这正是不加鉴权的原因，顺便把这条约束钉住 */
  const got = await fetch(base + up.body.url);
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.headers.get('content-type'), 'image/png');
  assert.match(got.headers.get('cache-control'), /immutable/, '内容哈希名可以永久缓存');
  const back = Buffer.from(await got.arrayBuffer());
  assert.strictEqual(back.length, PNG_1PX.length);
  assert.deepStrictEqual(back, PNG_1PX, '字节不能变');
});

test('图片：同一张图传两次只存一份', async () => {
  const a = await upload(PNG_1PX, 'image/png', dad.token);
  const b = await upload(PNG_1PX, 'image/png', dad.token);
  assert.strictEqual(a.body.url, b.body.url, '内容一样 → 名字一样 → 不重复占地方');
});

test('图片：写要登录，读不要', async () => {
  assert.strictEqual((await upload(PNG_1PX, 'image/png', null)).status, 401, '没登录不能往服务器塞文件');
});

test('图片：只收位图（不收 svg，它能带脚本）', async () => {
  const r = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', dad.token);
  assert.strictEqual(r.status, 415);
  const t = await upload(Buffer.from('hello'), 'text/plain', dad.token);
  assert.strictEqual(t.status, 415);
});

test('图片：空内容挡住', async () => {
  const r = await upload(Buffer.alloc(0), 'image/png', dad.token);
  assert.strictEqual(r.status, 400);
});

test('图片：文件名非法 / 不存在都是 404，且不会读到别的文件', async () => {
  /* 路径穿越：编码过的 `../` 在路由匹配阶段会被 decode，落到参数里是 `../secret.key`。
     文件名白名单不认它，必须 404 —— 不能去读 data 目录里的密钥。 */
  const bad = [
    '/api/media/..%2Fsecret.key',
    '/api/media/secret.key',
    '/api/media/' + 'a'.repeat(64) + '.png',   // 合法格式但从没上传过
  ];
  for (const p of bad) {
    const r = await fetch(base + p);
    assert.strictEqual(r.status, 404, p + ' 必须 404');
  }
});

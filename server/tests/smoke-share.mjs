/**
 * smoke-share.mjs —— 端到端演练「两个人共用一个日程集」
 *
 * 这不是单元测试，是一条**真的走网络**的路径：起服务器 → 两个人注册 →
 * A 建集 → A 邀请 B → B 接受 → B 写一条任务 → A 同步能不能看到 →
 * 把 B 降成只读 → B 再写一条应该被服务器拒 → A 把 B 移出 → B 同步发现集没了。
 *
 * 单元测试只测了各段逻辑，这一条测的是**它们串起来是不是真的通**。
 *
 *   node server/tests/smoke-share.mjs
 *
 * 退出码非 0 = 有问题。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 25699;
const BASE = `http://127.0.0.1:${PORT}/api`;

const dataDir = mkdtempSync(path.join(tmpdir(), 'sched-smoke-'));
let failures = 0;

function ok(cond, what) {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what); }
}

async function call(method, p, body, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const post = (p, b, t) => call('POST', p, b, t);
const get = (p, t) => call('GET', p, undefined, t);
const patch = (p, b, t) => call('PATCH', p, b, t);
const del = (p, t) => call('DELETE', p, undefined, t);

function op(calId, id, fields, ts, dev, entity = 'task') {
  return { opId: crypto.randomUUID(), deviceId: dev, ts, calId, entity, entityId: id, fields };
}

const child = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
  env: { ...process.env, PORT: String(PORT), SCHEDULE_DATA_DIR: dataDir, MAX_USERS: '50' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
child.stdout.on('data', () => {});

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return true;
    } catch (_) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

try {
  if (!await waitUp()) throw new Error('服务器没起来');

  console.log('\n一、两个平等用户注册');
  const a = await post('/auth/register', { name: '妈妈', password: 'pw123456' });
  const b = await post('/auth/register', { name: '爸爸', password: 'pw123456' });
  ok(a.status === 200 && !!a.body.token, 'A 注册成功');
  ok(b.status === 200 && !!b.body.token, 'B 注册成功');
  ok(a.body.user.id !== b.body.user.id, '两个人是两个账号');
  ok(!('isAdmin' in a.body.user), '用户对象里没有 isAdmin 之类的管理员字段');

  const TA = a.body.token;
  const TB = b.body.token;

  console.log('\n二、各自有一个自己的集');
  const meA = await get('/me', TA);
  const meB = await get('/me', TB);
  ok(meA.body.cals.length === 1 && meA.body.cals[0].role === 'owner', 'A 有且只有一个自己的集');
  ok(meB.body.cals[0].id !== meA.body.cals[0].id, '两个集是分开的');
  const calA = meA.body.cals[0].id;

  console.log('\n三、发邀请 → 接受');
  const dup = await post(`/cals/${calA}/invites`, { name: '查无此人', role: 'editor' }, TA);
  ok(dup.status === 404, '邀请不存在的用户名 → 404');
  const self = await post(`/cals/${calA}/invites`, { name: '妈妈', role: 'editor' }, TA);
  ok(self.status === 400, '邀请自己 → 400');

  const inv = await post(`/cals/${calA}/invites`, { name: '爸爸', role: 'editor' }, TA);
  ok(inv.status === 200, 'A 邀请 B 成功');

  const inbox = await get('/invites', TB);
  ok(inbox.body.invites.length === 1, 'B 的收件箱里有 1 条邀请');
  ok(inbox.body.invites[0].fromName === '妈妈', '邀请里带着邀请人名字');
  const invId = inbox.body.invites[0].id;

  const foreign = await post(`/invites/${invId}/accept`, {}, (await post('/auth/register', { name: '路人', password: 'pw123456' })).body.token);
  ok(foreign.status === 403, '别人替 B 接受 → 403');

  const acc = await post(`/invites/${invId}/accept`, {}, TB);
  ok(acc.status === 200, 'B 接受成功');
  const meB2 = await get('/me', TB);
  ok(meB2.body.cals.length === 2, 'B 现在有两个集');
  ok(meB2.body.cals.find((c) => c.id === calA)?.role === 'editor', 'B 在 A 的集里是可编辑');
  ok((await get('/invites', TB)).body.invites.length === 0, '接受后收件箱清空');

  console.log('\n四、B 写进 A 的集，A 同步能看到');
  // 先让 A 自己也写一条：`cursor: 0` 在协议里表示「给我一份全量快照」，
  // 空账号的游标会一直是 0，那样永远走快照分支，测不到增量那条路
  await post('/sync', {
    cursor: 0, deviceId: 'devA',
    ops: [op(calA, 'mine-1', { title: '自己的事', date: '2026-10-07' }, Date.now(), 'devA')],
  }, TA);
  const cursorA = (await post('/sync', { cursor: 0, deviceId: 'devA', ops: [] }, TA)).body.cursor;
  ok(cursorA > 0, 'A 的游标推到了非零水位');

  const w = await post('/sync', {
    cursor: 0, deviceId: 'devB',
    ops: [op(calA, 'shared-1', { title: '买牛奶', date: '2026-10-07' }, Date.now(), 'devB')],
  }, TB);
  ok(w.body.applied.length === 1 && w.body.rejected.length === 0, 'B 的写入被接受');

  const pullA = await post('/sync', { cursor: cursorA, deviceId: 'devA', ops: [] }, TA);
  ok(!pullA.body.snapshot, '带着游标拉，走的是增量而不是全量');
  ok((pullA.body.changes || []).some((c) => c.entityId === 'shared-1' && c.calId === calA),
    'A 拉增量能看到 B 写的那条，且带着 calId');
  ok((pullA.body.changes || []).every((c) => c.calId !== meB.body.cals[0].id),
    '看不到和自己无关的集里的变更');

  console.log('\n五、降成只读之后就不能写了');
  await patch(`/cals/${calA}/members/${b.body.user.id}`, { role: 'viewer' }, TA);
  const ro = await post('/sync', {
    cursor: 0, deviceId: 'devB',
    ops: [op(calA, 'shared-1', { title: '偷改' }, Date.now(), 'devB')],
  }, TB);
  ok(ro.body.rejected.length === 1 && ro.body.rejected[0].code === 'forbidden',
    '只读成员写入被服务器拒，且是 forbidden（终态，客户端会丢掉不再重试）');

  console.log('\n六、移出之后，B 的集列表里就没有它了');
  await del(`/cals/${calA}/members/${b.body.user.id}`, TA);
  const meB3 = await get('/me', TB);
  ok(meB3.body.cals.length === 1, 'B 回到只剩自己的集');
  const afterKick = await post('/sync', {
    cursor: 0, deviceId: 'devB',
    ops: [op(calA, 'shared-1', { title: '再改' }, Date.now(), 'devB')],
  }, TB);
  ok(afterKick.body.rejected[0]?.code === 'forbidden', '被移出后写入被拒');

  console.log('\n七、A 还能看到 B 写的内容（不会被一起删掉）');
  const snapA = await post('/sync', { cursor: 0, deviceId: 'devA', ops: [] }, TA);
  ok(snapA.body.snapshot?.tasks?.['shared-1']?.title === '买牛奶', '快照里那条任务还在');

  console.log('\n八、最后一个 owner 不能被降级 / 移出');
  const demote = await patch(`/cals/${calA}/members/${a.body.user.id}`, { role: 'viewer' }, TA);
  ok(demote.status >= 400, '唯一的 owner 降级被拒（' + demote.status + '）');

  console.log('\n八·二、项目也是同一个集里共享的：建、读、挂任务、删');
  // 项目走的是和任务同一条同步通道（同一个 ENTITIES 集合、同一份 field_state），
  // 所以「两个人共用一个集」这件事对它**不额外要求**任何东西 ——
  // 这一节要证的正是「确实没有漏掉什么」。
  //
  // 放在这里而不是第四节后面，是为了不打断「降只读 → 移出」那条链；
  // 代价是 B 此刻已经被移出 calA，得先请回来再往下测。
  const reInv = await post(`/cals/${calA}/invites`, { name: '爸爸', role: 'editor' }, TA);
  ok(reInv.status === 200, '把 B 重新请回 calA');
  const reAcc = await post(`/invites/${(await get('/invites', TB)).body.invites[0].id}/accept`, {}, TB);
  ok(reAcc.status === 200, 'B 重新接受');
  const now = Date.now();
  const projA = op(calA, 'proj-a', { name: 'A 的项目', status: 'active' }, now, 'devA', 'project');
  const projB = op(calA, 'proj-b', { name: 'B 的项目', status: 'waiting' }, now + 1000, 'devB', 'project');
  ok((await post('/sync', { cursor: 0, deviceId: 'devA', ops: [projA] }, TA)).body.applied.length === 1,
    'A 在共享集里建了项目');
  ok((await post('/sync', { cursor: 0, deviceId: 'devB', ops: [projB] }, TB)).body.applied.length === 1,
    'B 也在同一个集里建了项目');

  const snapB = await post('/sync', { cursor: 0, deviceId: 'devB', ops: [] }, TB);
  const projectsB = snapB.body.snapshot?.projects || {};
  ok(projectsB['proj-a']?.name === 'A 的项目', 'B 看得到 A 建的项目');
  ok(projectsB['proj-a']?.status === 'active', '项目的 status 也是逐字段同步的');
  ok(projectsB['proj-b']?.name === 'B 的项目', 'B 也看得到自己那个');

  // B 往 A 的项目上挂一条任务 —— 归属是一个**可同步字段**，所以跨设备一样带得过去
  const attach = op(calA, 'for-a-project', { title: '替 A 干的', projectId: 'proj-a' }, now + 2000, 'devB');
  await post('/sync', { cursor: 0, deviceId: 'devB', ops: [attach] }, TB);
  const snapA2 = await post('/sync', { cursor: 0, deviceId: 'devA', ops: [] }, TA);
  ok(snapA2.body.snapshot?.tasks?.['for-a-project']?.projectId === 'proj-a',
    'A 看得到「这条任务挂在 proj-a 上」');

  // B 删掉自己那个项目，A 的项目不受影响 —— 墓碑也走同一条通道
  await post('/sync', {
    cursor: 0, deviceId: 'devB',
    ops: [op(calA, 'proj-b', { deleted: true, deletedAt: now + 3000 }, now + 3000, 'devB', 'project')],
  }, TB);
  const snapA3 = await post('/sync', { cursor: 0, deviceId: 'devA', ops: [] }, TA);
  const projectsA3 = snapA3.body.snapshot?.projects || {};
  ok(!projectsA3['proj-b'], 'B 删掉之后，A 的快照里也没有它了（墓碑不进快照）');
  ok(projectsA3['proj-a']?.name === 'A 的项目', 'A 自己那个一个字都没被动过');

  console.log('\n九、退出登录后 token 失效');
  await post('/auth/logout', {}, TB);
  ok((await get('/me', TB)).status === 401, '退出后 /me 返回 401');
} catch (e) {
  failures++;
  console.error('\n演练中断：', e);
} finally {
  child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} 项不对\n` : '\n✓ 全通过\n');
process.exit(failures ? 1 : 0);

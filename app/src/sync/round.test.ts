/**
 * round.test.ts —— 推 + 拉一轮里那些「少做一步就出事」的步骤
 *
 * `round()` 只有三十行，但每一行都在守一件事：
 *   请求体只带游标 / 设备号 / 前 500 条 op —— 分批是因为服务端一次最多收 2000
 *   **服务器确认了（applied）才清发件箱** —— 照「发出去了」清的话，断网那次就真丢了
 *   集 / 邀请 / 成员每次都落进本地 —— 轮询顺带发现「有人邀请我」「我被移出了某个集」
 *   快照与增量走**同一条**合并路径，但冲突判定**只认增量**（拿快照判必然误报成一片）
 *   被时钟挡着时不许把那条提示顺手清掉
 *
 *   cd app && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeFetch, freshStore, idleSync, CAL } from './testenv.ts';

const store = await import('../data/store.ts');
const { round } = await import('./round.ts');
const { deviceId } = await import('../data/device.ts');
const { OPS_PER_CALL } = await import('./constants.ts');
const { makeTask } = await import('../domain/model/make.ts');

/** 往发件箱压 n 条改动（任务本来就在本地，op 只是它的影子） */
function seed(n: number): string[] {
  store.commitMany(Array.from({ length: n }, (_, i) => ({
    entity: 'task' as const, id: `t${i}`, calId: CAL,
    fields: { title: `任务 ${i}`, date: null },
  })));
  return store.get().outbox.map((o) => o.opId);
}

/** 跑一轮，顺带把请求记录带回来 */
async function oneRound(
  respond: (index: number) => Record<string, unknown> | undefined,
  forceSnapshot = false,
): Promise<{ progressed: boolean; truncated: boolean; calls: ReturnType<typeof fakeFetch>['calls'] }> {
  const f = fakeFetch((_c, i) => respond(i));
  try {
    const r = await round(forceSnapshot);
    return { ...r, calls: f.calls };
  } finally { f.restore(); }
}

test('请求体只带三样：游标、设备号、发件箱的前 500 条（顺序就是推送顺序）', async () => {
  freshStore();
  const ids = seed(OPS_PER_CALL + 100);
  const { calls } = await oneRound(() => idleSync(7));

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/sync$/);
  const body = calls[0].body as { cursor: number; deviceId: string; ops: { opId: string }[] };
  assert.equal(body.cursor, 0, '没同步过就是 0');
  assert.equal(body.deviceId, deviceId(), '设备号必须带上：LWW 平局靠它，而且它得跟 op 里那个一致');
  assert.equal(body.ops.length, OPS_PER_CALL, '一批只发这么多，剩下的留给下一轮');
  assert.deepEqual(body.ops.map((o) => o.opId), ids.slice(0, OPS_PER_CALL),
    '按发件箱顺序发：早的改动先落地，界面才不会先看到新改动');
});

test('forceSnapshot → 游标归零（刚加入一个集，它已有的内容全在旧游标后面）', async () => {
  freshStore();
  store.setCursor(4242);
  const { calls } = await oneRound(() => idleSync(10), true);
  assert.equal((calls[0].body as { cursor: number }).cursor, 0,
    '增量拉不到那个集的历史，只能重新要一份全量');
  assert.equal(store.get().cursor, 10, '拉完就把游标推到新水位，别下轮又从头扫');
});

test('服务器确认收到（applied）才清发件箱 —— 照「发出去了」清就会真丢', async () => {
  freshStore();
  const ids = seed(3);
  await oneRound(() => ({ ...idleSync(1), applied: [ids[0]] }));
  const left = store.get().outbox.map((o) => o.opId);
  assert.deepEqual(left, [ids[1], ids[2]],
    '只清被确认的那一条；其余留着等下一次（服务器部分接受 / 半途断网都是这个情形）');
});

test('集、邀请、成员每次都落进本地 —— 轮询顺带发现「有人邀请我」「我被移出了某个集」', async () => {
  freshStore();
  await oneRound(() => ({
    ...idleSync(1),
    cals: [
      { id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' },
      { id: 'cal-2', name: '家里', ownerId: 'u2', createdAt: 0, role: 'editor' },
    ],
    invites: [{ id: 'inv-1', calId: 'cal-3', inviterId: 'u2', inviteeName: '星星', role: 'editor', createdAt: 0 }],
    users: { u2: { name: 'nian', nickname: '念念' } },
  }));
  assert.equal(store.get().cals.length, 2, '被拉进新集要当场看得见，不能等下一次同步');
  assert.equal(store.get().invites.length, 1);
  assert.equal(store.get().users.u2?.nickname, '念念', '来源 tag 叫得出别人的名字靠这一桶');
});

test('增量那一路：别人的字段变更合并进来（逐字段 LWW）', async () => {
  freshStore();
  const id = store.addTask(makeTask({ calId: CAL, title: '我自己的标题', date: null }));
  await oneRound(() => ({
    ...idleSync(1),
    changes: [
      { entity: 'task', entityId: id, calId: CAL, field: 'title', value: '别人改的', ts: Date.now() + 1000, deviceId: 'other-dev' },
      { entity: 'task', entityId: id, calId: CAL, field: 'note', value: '别人的备注', ts: Date.now() + 1000, deviceId: 'other-dev' },
    ],
  }));
  assert.equal(store.get().tasks[id]?.title, '别人改的');
  assert.equal(store.get().tasks[id]?.note, '别人的备注');
});

test('快照那一路落地：同一条合并路径，不是「首屏一套、后续一套」', async () => {
  freshStore();
  const id = 'remote-1';
  await oneRound(() => ({
    cursor: 5, applied: [], rejected: [],
    snapshot: { tasks: { [id]: makeTask({ id, calId: CAL, title: '集里已有的任务', date: '2026-10-28' }) }, habits: {} },
  }));
  assert.equal(store.get().tasks[id]?.title, '集里已有的任务');
  assert.equal(store.get().tasks[id]?.calId, CAL, 'calId 是主键的一部分，快照里也得写上');
});

test('冲突提示只认增量那一路：拿快照判会把整集历史误报成「同时改过」', async () => {
  freshStore();
  /* 我这一轮推了一条改标题的 op —— 两条路都用同一批 op，
     这样「以后有人把快照也拿去判」会立刻红。 */
  const id = store.addTask(makeTask({ calId: CAL, title: '旧标题', date: null }));
  store.patchTask(id, { title: '我改的标题' });
  const mine = store.get().outbox[0];

  const snapTask = makeTask({ id, calId: CAL, title: '集里的旧标题', date: null });
  await oneRound(() => ({
    cursor: 5, applied: [mine.opId], rejected: [],
    snapshot: { tasks: { [id]: snapTask }, habits: {} },
  }));
  assert.deepEqual(store.get().conflicts, [],
    '快照是「我刚加入这个集，把历史整份拉下来」，里面那些改动跟「同时」不是一回事');

  await oneRound(() => ({
    cursor: 6, applied: [], rejected: [],
    changes: [{ entity: 'task', entityId: id, calId: CAL, field: 'title', value: '同时有别人在改', ts: Date.now() + 1000, deviceId: 'other-dev' }],
  }));
  const c = store.get().conflicts;
  assert.equal(c.length, 1, '同一轮里我推的字段也收到别人的改动 → 抽屉里那条只读提示要有内容');
  assert.equal(c[0].field, 'title');
  assert.equal(c[0].winner, 'theirs', '谁赢按服务端那套比较键算，不另写一套');
});

test('自己刚推的那条回显不算冲突（否则每次同步都给自己记一笔）', async () => {
  freshStore();
  const id = store.addTask(makeTask({ calId: CAL, title: '旧标题', date: null }));
  store.patchTask(id, { title: '我改的标题' });
  const mine = store.get().outbox[0];
  await oneRound(() => ({
    cursor: 6, applied: [mine.opId], rejected: [],
    changes: [{ entity: 'task', entityId: id, calId: CAL, field: 'title', value: '我改的标题', ts: mine.ts, deviceId: mine.deviceId }],
  }));
  assert.deepEqual(store.get().conflicts, []);
});

test('被时钟挡住时，那条「本机时间不准」不许被下一轮顺手清掉', async () => {
  freshStore();
  const ids = seed(1);
  await oneRound(() => ({
    ...idleSync(1),
    rejected: [{ opId: ids[0], code: 'clock', reason: '设备时钟偏差超过 24 小时' }],
  }));
  assert.match(store.get().lastError ?? '', /本机时间不准/);

  await oneRound(() => idleSync(2));
  assert.match(store.get().lastError ?? '', /本机时间不准/,
    '时间没校准之前，每轮末尾那句「清空错误」都得让路，不然提示只在第一轮闪一下');
});

test('没有时钟阻塞时，上一轮留下的错误该清掉（红条不该赖在界面上）', async () => {
  freshStore();
  store.setError('上一轮的旧错误');
  await oneRound(() => idleSync(1));
  assert.equal(store.get().lastError, null);
});

test('「这一轮有没有推进」三件事都算：发件箱变短、收到新变更、都没有', async () => {
  freshStore();
  const ids = seed(2);

  let r = await oneRound(() => ({ ...idleSync(1), applied: ids }), false);
  assert.equal(r.progressed, true, 'op 被确认走了 → 有推进');

  freshStore();
  r = await oneRound(() => ({
    ...idleSync(1),
    changes: [{ entity: 'task', entityId: 'x1', calId: CAL, field: 'title', value: '别人的改动', ts: 1, deviceId: 'other-dev' }],
  }), false);
  assert.equal(r.progressed, true, '我什么都没推、但拉到了新变更 → 也算推进（syncNow 靠它决定要不要再来一轮）');

  freshStore();
  r = await oneRound(() => idleSync(1), false);
  assert.equal(r.progressed, false, '既没推走什么也没拉到 → 别空转（syncNow 就此收工）');
});

/**
 * `truncated` 要**照原样递出去**：服务端一次最多回吐 MAX_PULL 条（`server/lib/sync.js`），
 * 回满就标 truncated、并把游标停在最后一批的最后一条。
 * 这一路一旦在 `round` 这里被丢掉，`syncNow` 就看不出「还有下文」——
 * 剩下的变更要等到下一次触发，而界面上看不出少了东西。
 */
test('服务端标了 truncated 就递出去（没标就是 false）', async () => {
  freshStore();
  const r1 = await oneRound(() => ({ ...idleSync(1), changes: [], truncated: true }), false);
  assert.equal(r1.truncated, true, '「这批没给完」是服务端说的，客户端不许把它抹掉');

  freshStore();
  const r2 = await oneRound(() => idleSync(1), false);
  assert.equal(r2.truncated, false, '没标就是「拉完了」（不许凭空挂着下文）');
});

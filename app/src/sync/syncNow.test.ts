/**
 * syncNow.test.ts —— 引擎的调度那一半：什么时候该发、什么时候不该发
 *
 * `round()` 管一轮里的事，`syncNow()` 管「要不要来这一轮」。这一层的规矩全是
 * 关于**代价与不空转**的：
 *   没登录 / 正在拖动 → 一个请求都不发
 *   并发调用 → 单飞（别打出两条请求）
 *   发现不认识的集 → 下一轮改成要全量快照
 *   推不动了（被时钟挡住）→ 就此收工，别把 MAX_ROUNDS 跑满
 *   服务端标了 truncated（还有下文没拉完）→ 同一趟接着拉；用完 MAX_ROUNDS 还没拉完
 *     就记进 `hasPullBacklog()`，让兜底轮询接着拉（见 lifecycle.test.ts）
 *   出错了 → 给用户一句话，并且把「正在同步」那个转圈停下（finally）
 *   真断网 → 说「当前离线，改动先存在本机」，不是「连不上服务器」
 *
 *   cd app && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeFetch, freshStore, idleSync, signIn, signOut, setOnline, CAL } from './testenv.ts';

const store = await import('../data/store.ts');
const { getToken } = await import('../data/api.ts');
const { setDragging } = await import('../ui/dragState.ts');
const { syncNow, hasPullBacklog } = await import('./syncNow.ts');
const { MAX_ROUNDS, OPS_PER_CALL } = await import('./constants.ts');

const NEW_CAL = 'cal-2';

function seed(n: number): string[] {
  store.commitMany(Array.from({ length: n }, (_, i) => ({
    entity: 'task' as const, id: `t${i}`, calId: CAL,
    fields: { title: `任务 ${i}`, date: null },
  })));
  return store.get().outbox.map((o) => o.opId);
}

/** 跑一次 syncNow，带回请求记录；顺带把拖动标志复位 */
async function runOnce(
  respond: (index: number) => Record<string, unknown> | undefined,
): Promise<ReturnType<typeof fakeFetch>['calls']> {
  const f = fakeFetch((_c, i) => respond(i));
  try {
    await syncNow();
    return f.calls;
  } finally {
    f.restore();
    setDragging(false);
  }
}

test('没登录就一个请求都不发（离线启动时界面照常用，不该刷一堆 401）', async () => {
  freshStore();
  signOut();
  seed(3);
  const calls = await runOnce(() => idleSync(1));
  assert.deepEqual(calls, [], '没有 token 时连试都不试');
  assert.equal(store.get().outbox.length, 3, '改动还留在发件箱里，登录后自然推上去');
});

test('拖动期间不拉：远端变更一落地整棵树重建，用户会看到「拖到一半弹回原位」', async () => {
  freshStore();
  signIn();
  seed(2);
  setDragging(true);
  const calls = await runOnce(() => idleSync(1));
  assert.deepEqual(calls, []);
  assert.equal(store.get().syncing, false, '连「正在同步」都不该亮 —— 这一轮压根没开始');
  assert.equal(store.get().outbox.length, 2, '跳过这一轮没有代价：发件箱还在，下轮自然补上');
});

test('并发调用只发一趟（轮询、快捷添加、焦点事件可能同一刻都来叫）', async () => {
  freshStore();
  signIn();
  seed(2);
  const f = fakeFetch(() => idleSync(1));
  try {
    await Promise.all([syncNow(), syncNow(), syncNow()]);
  } finally { f.restore(); }
  assert.equal(f.calls.length, 1, '第二、第三次调用直接返回，不打第二条请求');
});

test('发现不认识的集 → 下一轮改成要全量快照（增量拉不到那个集已有的内容）', async () => {
  freshStore();
  signIn();
  const ids = seed(1);
  const calls = await runOnce((i) => ({
    cursor: i === 0 ? 10 : 20,
    applied: i === 0 ? ids : [],
    rejected: [],
    /* 第一轮服务器告诉我：我还被拉进了 cal-2 —— 它已有的内容全在旧游标后面 */
    cals: [
      { id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' },
      { id: NEW_CAL, name: '家里', ownerId: 'u2', createdAt: 0, role: 'editor' },
    ],
  }));
  assert.equal(calls.length, 2, '发件箱空了也要再来一轮，就为那个新集');
  assert.equal((calls[1].body as { cursor: number }).cursor, 0, '第二轮游标归零 = 要一份全量');
});

test('那个新集只全量一次：第二轮之后 known 已经收着它，不会连着要两次快照', async () => {
  freshStore();
  signIn();
  seed(1);
  const cals = [
    { id: CAL, name: '我的日程', ownerId: 'u1', createdAt: 0, role: 'owner' },
    { id: NEW_CAL, name: '家里', ownerId: 'u2', createdAt: 0, role: 'editor' },
  ];
  const calls = await runOnce((i) => i === 2 ? idleSync(30) : {
    cursor: (i + 1) * 10,
    applied: [],
    rejected: [],
    cals,
    /* 每轮都带回同样的集：第二轮起它已经不是「不认识的集」了。
       顺带一条别人的变更，让这一轮算「有推进」，第三轮才会真的发生。 */
    ...(i >= 1 ? { changes: [{ entity: 'task', entityId: 'x1', calId: CAL, field: 'title', value: '别人的改动', ts: i, deviceId: 'other-dev' }] } : {}),
  });
  assert.equal(calls.length, 3);
  assert.equal((calls[0].body as { cursor: number }).cursor, 0, '第一轮是普通增量（本机游标本来就是 0）');
  assert.equal((calls[1].body as { cursor: number }).cursor, 0, '第二轮是因为「发现新集」才归零');
  assert.equal((calls[2].body as { cursor: number }).cursor, 20, '第三轮回到增量：每轮都全量就是每次都白发一整份');
});

test('被时钟挡住时不空转：一轮就收工，不会把 ' + MAX_ROUNDS + ' 轮跑满', async () => {
  freshStore();
  signIn();
  const ids = seed(1);
  const calls = await runOnce(() => ({
    ...idleSync(1),
    applied: [],
    rejected: [{ opId: ids[0], code: 'clock', reason: '设备时钟偏差超过 24 小时' }],
  }));
  assert.equal(calls.length, 1, 'op 一条都没走、也没新变更 → 再来七轮也一样，别白跑');
  assert.equal(store.get().outbox.length, 1, '但改动必须留着（见 rejected.test.ts）');
  assert.match(store.get().lastError ?? '', /本机时间不准/);
});

test('发件箱比一批大就接着推，直到清空', async () => {
  freshStore();
  signIn();
  const ids = seed(OPS_PER_CALL + 100);
  const calls = await runOnce((i) => ({
    cursor: i + 1,
    applied: i === 0 ? ids.slice(0, OPS_PER_CALL) : ids.slice(OPS_PER_CALL),
    rejected: [],
  }));
  assert.equal(calls.length, 2, '第一轮发 500、第二轮发剩下的 100');
  assert.equal(store.get().outbox.length, 0);
});

test('每轮都有新变更、op 又推不动时最多跑 ' + MAX_ROUNDS + ' 轮（防「推不完就一直推」卡住界面）', async () => {
  freshStore();
  signIn();
  seed(1);
  const calls = await runOnce((i) => ({
    cursor: i + 1,
    applied: [],
    rejected: [],
    changes: [{ entity: 'task', entityId: 'x' + i, calId: CAL, field: 'title', value: '别人一直在改', ts: i + 1, deviceId: 'other-dev' }],
  }));
  assert.equal(calls.length, MAX_ROUNDS);
  assert.equal(store.get().cursor, MAX_ROUNDS, '每一轮游标都在往前走（拉到了东西，只是推不出去）');
});

/**
 * 服务端一次最多回吐 `MAX_PULL` 条变更（`server/lib/sync.js`），回满就标 `truncated`
 * 并把游标停在最后一批的最后一条。下面三条测的是同一件事：
 * **「拉那一侧还没完」不许被「推那一侧没事」掩盖掉** —— 本机没有待推的改动时，
 * 老的收工判据（outbox 空了）第一轮就成立，剩下的下文要等下一次触发，
 * 而界面上看不出少了那批任务。
 */
test('服务端说「这批没给完」就接着拉：本机一条要推的都没有也照样转满 ' + MAX_ROUNDS + ' 轮', async () => {
  freshStore();
  signIn();
  const calls = await runOnce((i) => ({
    cursor: (i + 1) * 5000,
    applied: [],
    rejected: [],
    truncated: true,
    changes: [{ entity: 'task', entityId: 'x' + i, calId: CAL, field: 'title', value: '别人一直在改', ts: i + 1, deviceId: 'other-dev' }],
  }));

  assert.equal(calls.length, MAX_ROUNDS, '发件箱本来就是空的 —— 只有 truncated 能让循环接着转');
  assert.deepEqual(
    calls.map((c) => (c.body as { cursor: number }).cursor),
    Array.from({ length: MAX_ROUNDS }, (_, i) => i * 5000),
    '每一轮都从上一批的最后一条接着往下要，不许从头再扫同一批',
  );
  assert.equal(hasPullBacklog(), true, '跑满轮数还挂着 truncated = 真没拉完，得有人记得这件事');
});

test('拉到「给完了」那一轮就收工，backlog 落回 false（不许凭空挂着下文）', async () => {
  freshStore();
  signIn();
  const calls = await runOnce((i) => i === 0
    ? { cursor: 5000, applied: [], rejected: [], truncated: true, changes: [{ entity: 'task', entityId: 'x0', calId: CAL, field: 'title', value: '别人的改动', ts: 1, deviceId: 'other-dev' }] }
    : idleSync(5001));
  assert.equal(calls.length, 2, '下文拉完就停，不必把 ' + MAX_ROUNDS + ' 轮跑满');
  assert.equal(hasPullBacklog(), false, '服务端没再标 truncated → 这条得熄灭，否则轮询永远白拉');
});

test('中途出错（401）时不许挂着「还有下文」：那种情况该停，不该每 15 秒撞一次 401', async () => {
  freshStore();
  signIn();
  seed(1);
  await runOnce((i) => i === 0
    ? { cursor: 5000, applied: [], rejected: [], truncated: true, changes: [{ entity: 'task', entityId: 'x0', calId: CAL, field: 'title', value: '别人的改动', ts: 1, deviceId: 'other-dev' }] }
    : { __status: 401, error: 'Unauthorized' });
  assert.equal(hasPullBacklog(), false, '出错那一趟留下的 truncated 不能算数（重新登录自然会拉）');
});

test('401：说「登录已过期」，并且把 token 清掉（免得后面每个请求都白跑一趟）', async () => {
  freshStore();
  signIn();
  seed(1);
  await runOnce(() => ({ __status: 401, error: 'Unauthorized' }));
  assert.equal(store.get().lastError, '登录已过期，请重新登录');
  assert.equal(getToken(), null, 'token 失效就地清掉，这是 request.ts 的责任');
  assert.equal(store.get().syncing, false, '失败也得把转圈停下（finally）');
});

test('请求根本没发出去（真断网）：给用户一句话，转圈照样停下', async () => {
  freshStore();
  signIn();
  seed(1);
  await runOnce(() => ({ __throw: 'Failed to fetch' }));
  assert.equal(store.get().lastError, '连不上服务器');
  assert.equal(store.get().syncing, false);
  assert.equal(store.get().outbox.length, 1, '断网期间改动不丢');
});

/**
 * 同一句失败，两种说法。上面那条用的是 Node 的默认情形（`navigator.onLine` 读不到，
 * 也就是「不知道」）—— 这里补的是浏览器明确报告离线的那两种布尔。
 * 用户要知道的区别是「东西安全地攒在本机、联网自动同步」还是「得去查服务器」。
 */
test('浏览器说「离线」时说「当前离线，改动先存在本机」；说「在线」时不许这么说', async () => {
  freshStore();
  signIn();
  seed(1);
  let restore = setOnline(false);
  try {
    await runOnce(() => ({ __throw: 'Failed to fetch' }));
  } finally {
    restore();   // 恢复得排在 await 之后：syncNow 里判离线的是那次 fetch，不是这句断言
  }
  assert.equal(store.get().lastError, '当前离线，改动先存在本机，联网后会自动同步');
  assert.equal(store.get().outbox.length, 1, '这句话承诺的就是「改动还在」，所以改动真得还在');

  freshStore();
  signIn();
  seed(1);
  restore = setOnline(true);
  try {
    await runOnce(() => ({ __throw: 'Failed to fetch' }));
  } finally {
    restore();
  }
  assert.equal(store.get().lastError, '连不上服务器', '有网却够不着服务器 ≠ 离线，别让人去等联网');
});

test('跑成功也要把「正在同步」落回 false（顶栏那个转圈只认 state.syncing）', async () => {
  freshStore();
  signIn();
  const ids = seed(1);
  let sawSyncing = false;
  const unsub = store.subscribe(() => { if (store.get().syncing) sawSyncing = true; });
  try {
    await runOnce(() => ({ ...idleSync(1), applied: ids }));
  } finally { unsub(); }
  assert.equal(sawSyncing, true, '中途确实亮过（不然这条测的是空转）');
  assert.equal(store.get().syncing, false, '结束时必须熄灭');
});

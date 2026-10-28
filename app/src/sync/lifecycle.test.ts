/**
 * lifecycle.test.ts —— 什么时候叫同步、叫几次
 *
 * 这文件测的不是 `syncNow`（那是 syncNow.test.ts），是**触发它的那些东西**：
 *   本地改动 → 攒 1.2 秒再推（连续勾几条任务只发一次请求）
 *   15 秒的兜底轮询 → 只在发件箱非空、或上一趟被服务端截断（还有下文没拉完）时才真的发请求
 *     （开着 App 空转不该刷服务器，但「远端还挂着下文」本身就该接着拉）
 *   断网重连 / 窗口聚焦 / 切回前台 → 各补一次
 *   页面藏起来时不补拉
 *   关页面前 flushPersist（攒着还没落盘的写入不能跟着页面一起没了）
 *   stop() 之后订阅、定时器、事件监听都得干净退出（重复 start 不能叠加）
 *
 * 定时器在这里是伪造的 —— 不然每条用例都要真等 1.2 秒 / 15 秒。
 *
 *   cd app && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeFetch, freshStore, signIn, CAL } from './testenv.ts';

const store = await import('../data/store.ts');
const { start, stop } = await import('./lifecycle.ts');
const { syncNow, hasPullBacklog } = await import('./syncNow.ts');
const { PUSH_DEBOUNCE_MS, POLL_MS } = await import('./constants.ts');
const { KEY } = await import('../data/store/core.ts');

/* ============================ 伪造的浏览器与定时器 ============================ */

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realSetImmediate = globalThis.setImmediate;

interface Timer { id: number; kind: 'timeout' | 'interval'; ms: number; fn: () => void; cleared: boolean }
let timers: Timer[] = [];
let timerId = 0;

/** 事件监听表：断言「注册了哪些、stop 之后还剩哪些」全靠它。
 *  key 带上是谁家的（`window:online` / `document:visibilitychange`）——
 *  两家的 `addEventListener` 都只把类型传进来，不带上前缀就会串成同一格。 */
const listeners = new Map<string, Set<() => void>>();

function addL(key: string, fn: () => void): void {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key)!.add(fn);
}
function removeL(key: string, fn: () => void): void {
  listeners.get(key)?.delete(fn);
}
function countListeners(prefix: string): number {
  let n = 0;
  for (const [k, set] of listeners) if (k.startsWith(prefix)) n += set.size;
  return n;
}

(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (type: string, fn: () => void) => addL('window:' + type, fn),
  removeEventListener: (type: string, fn: () => void) => removeL('window:' + type, fn),
};
const doc = {
  visibilityState: 'visible',
  addEventListener: (type: string, fn: () => void) => addL('document:' + type, fn),
  removeEventListener: (type: string, fn: () => void) => removeL('document:' + type, fn),
};
(globalThis as unknown as { document: typeof doc }).document = doc;

globalThis.setTimeout = ((fn: () => void, ms?: number) => {
  const t = { id: ++timerId, kind: 'timeout' as const, ms: ms ?? 0, fn, cleared: false };
  timers.push(t);
  return t.id;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((id: number) => {
  const t = timers.find((x) => x.id === id);
  if (t) t.cleared = true;
}) as unknown as typeof clearTimeout;
globalThis.setInterval = ((fn: () => void, ms?: number) => {
  const t = { id: ++timerId, kind: 'interval' as const, ms: ms ?? 0, fn, cleared: false };
  timers.push(t);
  return t.id;
}) as unknown as typeof setInterval;
globalThis.clearInterval = ((id: number) => {
  const t = timers.find((x) => x.id === id);
  if (t) t.cleared = true;
}) as unknown as typeof clearInterval;

/** 排着的定时器（没被 clear 的），按种类看 */
const pending = (kind: Timer['kind'], ms?: number): Timer[] =>
  timers.filter((t) => !t.cleared && t.kind === kind && (ms === undefined || t.ms === ms));

/** 只看「攒批推送」那一档。`store.persist()` 自己也有一个 250ms 的落盘定时器，
 *  不分档就会把它算进「排了几个推送定时器」里（这一版第一次跑就是这么错的）。 */
const pushTimers = (): Timer[] => pending('timeout', PUSH_DEBOUNCE_MS);

/** 到点了：把这些定时器的回调跑一遍（不删 timeout，跟真浏览器一样由它自己清） */
async function fireTimers(kind: Timer['kind'], ms?: number): Promise<void> {
  for (const t of pending(kind, ms)) t.fn();
  await flushAsync();
}

/** lifecycle 里那些触发都是 `void syncNow()`，不等回来；给假 fetch 一点时间落地 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => realSetImmediate(r));
}

async function fireEvent(target: 'window' | 'document', type: string): Promise<void> {
  const key = target + ':' + type;
  for (const fn of [...(listeners.get(key) ?? [])]) fn();
  await flushAsync();
}

test.afterEach(() => { stop(); timers = []; listeners.clear(); doc.visibilityState = 'visible'; });
test.after(() => {
  stop();
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

/* ============================ 用例 ============================ */

test('本地改动攒 1.2 秒再推：连续勾几条任务只发一次请求', async () => {
  freshStore(); signIn();
  const f = fakeFetch(() => ({ cursor: 1, applied: store.get().outbox.map((o) => o.opId), rejected: [] }));
  try {
    start();
    for (let i = 0; i < 3; i++) {
      store.commitMany([{ entity: 'task', id: `t${i}`, calId: CAL, fields: { title: `任务 ${i}`, date: null } }]);
    }
    assert.equal(pushTimers().length, 1, '三次改动只排一个定时器（pushTimer 已经在了就别再排）');
    assert.equal(pushTimers()[0].ms, PUSH_DEBOUNCE_MS, '攒的就是常量那一档，不是随手写的数字');
    assert.equal(f.calls.length, 0, '还在攒着，暂时一个请求都不发');

    await fireTimers('timeout', PUSH_DEBOUNCE_MS);
    assert.equal(f.calls.length, 1, '三笔改动合成一次请求');
    assert.equal((f.calls[0].body as { ops: unknown[] }).ops.length, 3);
  } finally { f.restore(); }
});

test('没进发件箱的改动不排推送（改界面设置不该叫来一次同步）', async () => {
  freshStore(); signIn();
  const f = fakeFetch(() => ({ cursor: 1, applied: [], rejected: [] }));
  try {
    start();
    store.setUi({ theme: 'dark' } as never);
    store.setError('随便一条提示');
    assert.deepEqual(pushTimers(), [], 'outbox 是空的，推什么呢');
  } finally { f.restore(); }
});

test('兜底轮询只在发件箱非空时才真的发请求（开着 App 空转不该刷服务器）', async () => {
  freshStore(); signIn();
  const f = fakeFetch(() => ({ cursor: 1, applied: store.get().outbox.map((o) => o.opId), rejected: [] }));
  try {
    start();
    const poll = pending('interval');
    assert.equal(poll.length, 1);
    assert.equal(poll[0].ms, POLL_MS);

    await fireTimers('interval');
    assert.equal(f.calls.length, 0, '发件箱空着 → 这一趟跳过');

    store.commitMany([{ entity: 'task', id: 't0', calId: CAL, fields: { title: '改动', date: null } }]);
    pushTimers().forEach((t) => { t.cleared = true; });
    await fireTimers('interval');
    assert.equal(f.calls.length, 1, '有攒着的改动才去推（推完就清，下一趟又跳过）');
  } finally { f.restore(); }
});

/**
 * 上一趟被服务端截断（一次最多回吐 `MAX_PULL` 条变更）而本机压根没有待推的改动。
 * 那种情况下这条轮询是**唯一还会接着拉的通道**：本地没改动 → 攒批定时器不会响；
 * 界面无操作 → focus / online 事件也不会来。少这一句就等于远端压着的下文永远拉不到，
 * 而界面上看不出少了东西。
 */
test('上一趟没拉完时，兜底轮询即使发件箱空着也照发（拉完就落回不发）', async () => {
  freshStore(); signIn();

  /* 先造出「还有下文」：让服务端每轮都回 truncated，syncNow 跑满轮数也拉不完。
     走一趟真的把状态造出来，而不是去拨那个模块级标志 —— 后者私有，而且拨开就等于
     默认「syncNow 会把它设对」这一条没测。 */
  const trap = fakeFetch((_c, i) => ({ cursor: (i + 1) * 5000, applied: [], rejected: [], truncated: true }));
  try { await syncNow(); } finally { trap.restore(); }
  assert.equal(hasPullBacklog(), true, '前提：这一趟确实没拉完');
  assert.equal(store.get().outbox.length, 0, '前提：本机也没有待推的改动（上一条测的就是这一种）');
  const watermark = store.get().cursor;

  const f = fakeFetch(() => ({ cursor: watermark + 1, applied: [], rejected: [] }));
  try {
    start();
    await fireTimers('interval');
    assert.equal(f.calls.length, 1, '发件箱空着也发 —— 有下文没拉完本身就值得发一次');
    assert.equal((f.calls[0].body as { cursor: number }).cursor, watermark, '接着上一趟的水位往下拉，不是从头再来');
    assert.equal(store.get().cursor, watermark + 1, '这一趟真拉到了（不是只发了个请求）');
    assert.equal(hasPullBacklog(), false, '服务端没再标 truncated → 熄灭');

    await fireTimers('interval');
    assert.equal(f.calls.length, 1, '落回之后又回到「空着就不发」，不许从此每 15 秒空转');
  } finally { f.restore(); }
});

test('断网重连、窗口聚焦、切回前台各补一次（不用等 15 秒轮询）', async () => {
  freshStore(); signIn();
  store.commitMany([{ entity: 'task', id: 't0', calId: CAL, fields: { title: '改动', date: null } }]);
  const f = fakeFetch(() => ({ cursor: 1, applied: ['nope'], rejected: [] }));
  try {
    start();
    assert.ok(countListeners('window:') >= 3, 'online / focus / pagehide 都挂了');
    assert.ok(countListeners('document:visibilitychange') === 1);

    for (const type of ['online', 'focus', 'visibilitychange']) {
      await fireEvent(type === 'visibilitychange' ? 'document' : 'window', type);
    }
    assert.equal(f.calls.length, 3, '三个触发各发一趟（它们彼此间隔够久，单飞挡不住）');
  } finally { f.restore(); }
});

test('页面藏在后台时不补拉（省电也省流量，回到前台那一下自然会拉）', async () => {
  freshStore(); signIn();
  store.commitMany([{ entity: 'task', id: 't0', calId: CAL, fields: { title: '改动', date: null } }]);
  const f = fakeFetch(() => ({ cursor: 1, applied: ['nope'], rejected: [] }));
  try {
    start();
    doc.visibilityState = 'hidden';
    await fireEvent('document', 'visibilitychange');
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('关页面前把攒着还没落盘的写入存下去', async () => {
  freshStore(); signIn();
  const f = fakeFetch(() => ({ cursor: 1, applied: [], rejected: [] }));
  try {
    start();
    store.commitMany([{ entity: 'task', id: 't0', calId: CAL, fields: { title: '刚打的字', date: null } }]);
    assert.equal(localStorage.getItem(KEY), null,
      'persist 自己攒 250ms 才写盘 —— 此刻还没落盘（正因为这样 pagehide 那一脚才重要）');
    await fireEvent('window', 'pagehide');
    const raw = localStorage.getItem(KEY);
    assert.ok(raw, 'pagehide 是同步的，flushPersist 来得及');
    assert.ok(JSON.parse(raw!).tasks.t0, '刚打的那条确实在里面');
  } finally { f.restore(); }
});

test('stop() 之后：定时器清掉、订阅取消、事件摘干净（重复 start 也不叠加）', async () => {
  freshStore(); signIn();
  const f = fakeFetch(() => ({ cursor: 1, applied: [], rejected: [] }));
  try {
    start(); start();          // 界面重载 / 重新登录会再 start 一次
    assert.equal(pending('interval').length, 1, 'start 第一件事是 stop：不会攒出两个轮询');
    assert.equal(countListeners('window:online'), 1, '同理不会挂两份监听');

    stop();
    assert.deepEqual(pending('interval'), [], '轮询得停，否则登出之后还在刷服务器');
    assert.equal(countListeners('window:online'), 0);
    assert.equal(countListeners('document:visibilitychange'), 0);

    store.commitMany([{ entity: 'task', id: 't0', calId: CAL, fields: { title: '改动', date: null } }]);
    assert.deepEqual(pushTimers(), [], '订阅也断了');
    await fireEvent('window', 'online');
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

/* 那几个常量之间的大小关系（攒批窗口 < 轮询、批量 < 服务端上限）写在
   constants.test.ts —— 那里是它们的产地，重复守一遍迟早漂移。 */

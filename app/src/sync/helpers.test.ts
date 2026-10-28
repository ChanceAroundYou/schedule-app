/**
 * helpers.test.ts —— 同步引擎给用户的那句话怎么说
 *
 * 这一小块看着只是「文案」，其实决定用户下一步做什么：
 *   「登录已过期」→ 去重登；429 之类 → 把服务器给的话原样递出去；
 *   断网 → 该说的是「东西还在本机，联网后自动补传」。原先一条覆盖都没有，
 *   改措辞、改分支全靠肉眼 —— 结果真有一支悄悄失效了（见下面那条用例的注释）。
 *
 * 最阴的一条是 `navigator.onLine`：**纯 Node 里全局 navigator 存在但只有
 * userAgent**，`onLine` 是 undefined → falsy → 每个用例都会走「离线」那一支，
 * 于是「在线时该说什么」永远测不到。所以下面每个用例都显式装上它。
 *
 *   cd app && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* localStorage 垫片在 testenv 里（同步层六个测试共用一份）；
   这一句只为它的副作用（装好 localStorage，顺序见 testenv.ts 头注释）。 */
import './testenv.ts';

const store = await import('../data/store.ts');
const { ApiError } = await import('../data/api.ts');
const { describe, setSyncing } = await import('./helpers.ts');

/** 装一个可控的 navigator 跑一段，跑完恢复原样（用例之间不许互相影响） */
function withOnline(onLine: boolean, fn: () => void): void {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine }, configurable: true, writable: true,
  });
  try { fn(); } finally {
    if (prev) Object.defineProperty(globalThis, 'navigator', prev);
    else delete (globalThis as Record<string, unknown>).navigator;
  }
}

test('401 说「登录已过期」，不摆服务器那句英文', () => {
  withOnline(true, () => {
    assert.equal(describe(new ApiError(401, 'Unauthorized')), '登录已过期，请重新登录');
  });
});

test('其它状态码把服务器给的话原样递出去（那里有「操作太频繁」这类人话）', () => {
  withOnline(true, () => {
    assert.equal(describe(new ApiError(429, '操作太频繁，稍后再试')), '操作太频繁，稍后再试');
  });
});

/**
 * 断网时用户看到的其实是 `request.ts` 自己写的那句「连不上服务器」。
 *
 * ⚠️ 这一条是写测试时才现形的：下面 `describe` 里那句「当前离线，改动先存在本机…」
 * 在**同步这条路上进不去** —— 断网时 fetch 抛的 TypeError 已经被
 * `data/api/request.ts` 接住、换成 `ApiError(0, '连不上服务器')`，于是
 * `describe` 第一支就命中、直接返回那句英文味的 message，`navigator.onLine`
 * 那一支永远轮不到（全项目 `describe` 只有 `syncNow.ts` 一个调用点）。
 * 该给用户哪句是产品判断（「连不上服务器」 vs 「东西还在本机、联网后自动补传」），
 * 所以这里**锁现状不锁愿望**：现状写清楚，改不改由人定。
 * （下面那条 TypeError 的用例锁的是「分支本身还活着」：非 ApiError 的错仍会说那句。）
 */
test('断网时说的是 request.ts 那句「连不上服务器」（不是 helpers 里那句「当前离线…」）', () => {
  withOnline(false, () => {
    assert.equal(describe(new ApiError(0, '连不上服务器')), '连不上服务器');
  });
});

test('同一句不取决于 navigator.onLine（请求真没发出去，浏览器说在线也不算在线）', () => {
  withOnline(true, () => {
    assert.equal(describe(new ApiError(0, '连不上服务器')), '连不上服务器');
  });
});

test('fetch 自己抛的那种 TypeError：离线时说「东西还在本机」', () => {
  withOnline(false, () => {
    assert.equal(
      describe(new TypeError('Failed to fetch')),
      '当前离线，改动先存在本机，联网后会自动同步',
    );
  });
});

/** 反着锁一条：navigator 说在线时不许谎报离线，否则「服务器真坏了」也被说成断网 */
test('navigator 说在线时普通错误用自己的 message，不走离线那一支', () => {
  withOnline(true, () => {
    assert.equal(describe(new TypeError('Failed to fetch')), 'Failed to fetch');
  });
});

test('非 ApiError 的普通错误用它自己的 message', () => {
  withOnline(true, () => {
    assert.equal(describe(new Error('本地存储写不下')), '本地存储写不下');
  });
});

test('连「不是 Error」的那种抛法也要有话说（不能给用户一个 undefined）', () => {
  withOnline(true, () => {
    assert.equal(describe(undefined), '同步失败');
    assert.equal(describe('boom'), '同步失败');
  });
});

test('setSyncing 落到 state.syncing（顶栏那个转圈图标只认它）', () => {
  store.resetLocal();
  setSyncing(true);
  assert.equal(store.get().syncing, true);
  setSyncing(false);
  assert.equal(store.get().syncing, false);
});

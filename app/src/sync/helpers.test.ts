/**
 * helpers.test.ts —— 同步引擎给用户的那句话怎么说
 *
 * 这一小块看着只是「文案」，其实决定用户下一步做什么：
 *   「登录已过期」→ 去重登；429 之类 → 把服务器给的话原样递出去；
 *   断网 → 该说的是「东西还在本机，联网后自动补传」。原先一条覆盖都没有，
 *   改措辞、改分支全靠肉眼 —— 结果真有一支悄悄失效了（见下面那条用例的注释）。
 *
 * 最阴的一条是 `navigator.onLine`：**纯 Node 里全局 navigator 只有 userAgent**，
 * `onLine` 是 undefined。判据写的是 `onLine === false`（「浏览器明确说离线」），
 * 所以「断网时该说什么」这一档在 Node 里默认走不到 —— 下面每条都用 testenv 的
 * `withOnline` 显式装上它，不装就等于没测。
 *
 *   cd app && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* 同步层共用的垫片：装 localStorage、装 navigator.onLine（顺序见 testenv.ts 头注释） */
import { withOnline } from './testenv.ts';

const store = await import('../data/store.ts');
const { ApiError } = await import('../data/api.ts');
const { describe, setSyncing } = await import('./helpers.ts');

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
 * 断网要说「东西还在本机」，有网但连不上要说「连不上服务器」—— 两句话差的是
 * 「该等网络」还是「该查服务器」。
 *
 * 2026-10-28 修的就是这一条：`data/api/request.ts` 把 fetch 抛的 TypeError 归一成
 * `ApiError(0, '连不上服务器')`，而 `describe` 原先第一支直接 `return e.message` ——
 * 于是「当前离线，改动先存在本机…」那句在**同步这条路上进不去**（全项目 `describe`
 * 只有 `syncNow.ts` 一个调用点），断网时用户看到的也是「连不上服务器」。
 * 现在按 `e.offline` + `navigator.onLine === false` 分两档。
 */
test('断网（`navigator.onLine === false`）时说「当前离线，改动先存在本机，联网后会自动同步」', () => {
  withOnline(false, () => {
    assert.equal(
      describe(new ApiError(0, '连不上服务器')),
      '当前离线，改动先存在本机，联网后会自动同步',
    );
  });
});

test('有网但服务器不响应（`onLine === true`）说「连不上服务器」，不许谎报断网', () => {
  withOnline(true, () => {
    assert.equal(describe(new ApiError(0, '连不上服务器')), '连不上服务器');
  });
});

/** 判的是「浏览器明确说离线」，不是「没读到值」：Node 的 navigator 不带 onLine */
test('读不到 `navigator.onLine` 时不判成离线', () => {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  assert.equal(nav?.onLine, undefined, '前提：Node 的 navigator 压根没有 onLine');
  assert.equal(describe(new ApiError(0, '连不上服务器')), '连不上服务器');
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

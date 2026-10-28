/**
 * helpers.ts —— 同步引擎辅助函数
 */

import { ApiError } from '../data/api.ts';
import * as store from '../data/store.ts';

function setSyncing(v: boolean): void {
  store.setSyncing(v);
}

/**
 * 「离线」判的是**浏览器明确知道离线**（`onLine === false`），不是「没读到这个值」。
 * Node（跑这些单测的那边）的 `navigator` 压根没有 `onLine`，写成 `!navigator.onLine`
 * 会把「不知道」当成「离线」，于是每条网络失败的用例都说成断网 —— 那是假的。
 * 浏览器 / WebView 里这个值一定是布尔，严格判不损失什么。
 */
function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function describe(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return '登录已过期，请重新登录';
    /* `status === 0`（`ApiError.offline`）是**网络层失败** —— `request.ts` 把 fetch 抛的
       TypeError 归一成这一档，它自己带的那句是「连不上服务器」。措辞在这一处定，
       不在 `request.ts` 定：那儿只知道「够不着服务器」，不知道是「本机没网」还是
       「有网但服务器不响应」，而用户要知道的正是这个区别（前者东西安全地攒在本机，
       后者是要去查服务器）。
       2026-10-28 之前这里先 `return e.message`，离线那一支在同步这条路上**根本进不去** ——
       断网时用户看到的也是「连不上服务器」。 */
    if (e.offline && isOffline()) {
      return '当前离线，改动先存在本机，联网后会自动同步';
    }
    return e.message;
  }
  // 没走 `request.ts` 的 fetch 失败（直接调 fetch 的那种）照旧兜住：
  // 把 `Failed to fetch` 这句英文原样摆给用户没有意义 —— 他要的是「东西还在不在」
  if (isOffline()) {
    return '当前离线，改动先存在本机，联网后会自动同步';
  }
  return e instanceof Error ? e.message : '同步失败';
}

export { setSyncing, describe };

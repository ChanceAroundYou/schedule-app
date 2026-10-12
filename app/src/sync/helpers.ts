/**
 * helpers.ts —— 同步引擎辅助函数
 */

import { ApiError } from '../data/api.ts';
import * as store from '../data/store.ts';

function setSyncing(v: boolean): void {
  store.setSyncing(v);
}

function describe(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return '登录已过期，请重新登录';
    return e.message;
  }
  // 断网时 fetch 抛的是 TypeError('Failed to fetch')。把这句英文原样摆给用户
  // 没有意义 —— 他要知道的是「东西还在不在」
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return '当前离线，改动先存在本机，联网后会自动同步';
  }
  return e instanceof Error ? e.message : '同步失败';
}

export { setSyncing, describe };

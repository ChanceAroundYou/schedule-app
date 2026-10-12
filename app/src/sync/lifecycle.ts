/**
 * lifecycle.ts —— 同步引擎生命周期
 */

import * as store from '../data/store.ts';
import { syncNow } from './syncNow.ts';
import { PUSH_DEBOUNCE_MS, POLL_MS } from './constants.ts';

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsubStore: (() => void) | null = null;

export function start(): void {
  stop();

  // 本地一有改动就攒 1.2 秒再推 —— 连续勾几条任务只发一次请求
  unsubStore = store.subscribe(() => {
    if (!store.get().outbox.length || pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void syncNow();
    }, PUSH_DEBOUNCE_MS);
  });

  pollTimer = setInterval(() => {
    if (store.get().outbox.length) void syncNow();
  }, POLL_MS);

  // 断网重连、切回前台都立刻补一次
  window.addEventListener('online', onWake);
  window.addEventListener('focus', onWake);
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('pagehide', onHide);
}

export function stop(): void {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (unsubStore) { unsubStore(); unsubStore = null; }
  window.removeEventListener('online', onWake);
  window.removeEventListener('focus', onWake);
  document.removeEventListener('visibilitychange', onWake);
  window.removeEventListener('pagehide', onHide);
}

function onWake(): void {
  if (document.visibilityState && document.visibilityState !== 'visible') return;
  void syncNow();
}

/** 关页面前把攒着还没落盘的写入存下去（同步的，来得及） */
function onHide(): void {
  store.flushPersist();
}

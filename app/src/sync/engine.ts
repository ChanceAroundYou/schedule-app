/**
 * engine.ts —— 同步引擎：把本地 outbox 推上去，把远端变更拉下来
 *
 * 一次 `POST /api/sync` 同时干两件事（推 + 拉），因为服务器**先落盘再取数**：
 * 返回的快照/增量已经包含本批 op 合并之后的结果。分开两次请求会拿到一个
 * 慢半拍的快照，客户端再把它合并回来就把自己的写入盖掉了。
 *
 * 没有 WebSocket / SSE。日程数据的实时性要求是「换台设备能看到」而不是
 * 「毫秒级同步」，轮询 + 焦点触发足够了，还省掉了长连接在移动网络下的
 * 重连地狱。真需要实时再加，schema 不用动。
 */

import { api, ApiError, getToken } from '../data/api.ts';
import * as store from '../data/store.ts';
import { deviceId } from '../data/device.ts';
import { readLegacy } from '../data/legacy.ts';
import { isDragging } from '../ui/dragState.ts';
import type { Rejected } from '../domain/types.ts';

/** 服务端 MAX_OPS 是 2000，留出余量分批 */
const OPS_PER_CALL = 500;
/** 一轮同步最多几个来回。防的是「推不完就一直推」把界面卡住 */
const MAX_ROUNDS = 8;
/** 本地改动后攒一会儿再推，连续操作只发一次 */
const PUSH_DEBOUNCE_MS = 1200;
/** 兜底轮询：只在 outbox 非空时才真的发请求 */
const POLL_MS = 15000;

let running = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsubStore: (() => void) | null = null;

function setSyncing(v: boolean): void {
  store.setSyncing(v);
}

function describe(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return '登录已过期，请重新登录';
    return e.message;
  }
  return e instanceof Error ? e.message : '同步失败';
}

/**
 * 处理被服务器退回的 op。
 *
 * 两种退回要分开对待，混在一起就会出问题：
 *   bad_request —— 这条 op 本身坏了，重试多少次都一样，**丢掉**，否则它会
 *                  永远堵在 outbox 最前面，后面的改动一条都推不上去
 *   clock       —— 只是本机时间不对，**留着**。丢掉就等于用户那几次操作
 *                  凭空消失；留着他校准完时间自然能推上来。
 */
function handleRejected(rejected: Rejected[]): void {
  if (!rejected.length) {
    if (store.get().clockBlocked.length) store.setClockBlocked([]);
    return;
  }

  const bad: string[] = [];
  const clock: string[] = [];
  for (const r of rejected) (r.code === 'clock' ? clock : bad).push(r.opId);

  store.ackOps(bad);
  store.setClockBlocked(clock);
  if (clock.length) {
    store.setError('本机时间不准，' + clock.length + ' 条改动等时间校准后会自动补传');
  }
}

/**
 * 推 + 拉一轮。
 *
 * @returns 这一轮有没有推进（outbox 变短了，或者游标前进了）
 */
async function round(): Promise<boolean> {
  const s = store.get();
  const ops = s.outbox.slice(0, OPS_PER_CALL);
  const before = s.outbox.length;

  const res = await api.sync({ cursor: s.cursor, deviceId: deviceId(), ops });

  if (res.rejected && res.rejected.length) handleRejected(res.rejected);

  store.ackOps(res.applied || []);

  // 快照与增量走同一条合并路径，见 store.applyRemote 的注释
  if (res.snapshot) store.applyRemote(store.flattenSnapshot(res.snapshot));
  else if (res.changes && res.changes.length) store.applyRemote(res.changes);

  store.setCursor(Number(res.cursor) || 0);
  if (!store.get().clockBlocked.length) store.setError(null);

  return store.get().outbox.length < before || (res.changes || []).length > 0;
}

/** 立刻同步一次。并发调用会直接返回，不会打出两条请求。 */
export async function syncNow(): Promise<void> {
  if (running || !getToken()) return;

  /* 拖动期间不拉。远端变更落地 → React 重绘 → 让位用的 transform 和占位洞
     全部重建，用户看到的是「拖到一半整个列表弹回原位」。
     拖动只有几秒，跳过这一轮没有代价：outbox 还在，下一个轮询或下一次
     本地改动自然会把它推上去。 */
  if (isDragging()) return;

  running = true;
  setSyncing(true);

  try {
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const progressed = await round();
      if (!store.get().outbox.length) break;
      if (!progressed) break;      // 推不动了（多半是被 clock 挡住），别空转
    }
  } catch (e) {
    store.setError(describe(e));
  } finally {
    running = false;
    setSyncing(false);
  }
}

/**
 * 登录之后调一次。
 *
 * 首次导入的判断放在**同步完成之后**：先看服务器账号里有没有东西，
 * 空账号才把本机的旧数据搬上去。否则在第二台浏览器上登录时，
 * 会把本地残留的演示数据倒进一个已经有内容的账号里。
 */
export async function bootstrap(): Promise<void> {
  await syncNow();

  const s = store.get();
  if (Object.keys(s.tasks).length || Object.keys(s.habits).length) return;

  const legacy = readLegacy();
  if (!legacy) return;

  store.loadMigrated(legacy.tasks, legacy.habits);
  await syncNow();
}

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

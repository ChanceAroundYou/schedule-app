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

import { api, ApiError, getToken, setCachedUser } from '../data/api.ts';
import * as store from '../data/store.ts';
import { deviceId } from '../data/device.ts';
import { readLegacy } from '../data/legacy.ts';
import { isDragging } from '../ui/dragState.ts';
import { findConflicts } from '../domain/merge.ts';
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
  // 断网时 fetch 抛的是 TypeError('Failed to fetch')。把这句英文原样摆给用户
  // 没有意义 —— 他要知道的是「东西还在不在」
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return '当前离线，改动先存在本机，联网后会自动同步';
  }
  return e instanceof Error ? e.message : '同步失败';
}

/**
 * 处理被服务器退回的 op。
 *
 * 三种退回要分开对待，混在一起就会出问题：
 *   bad_request —— 这条 op 本身坏了，重试多少次都一样，**丢掉**，否则它会
 *                  永远堵在 outbox 最前面，后面的改动一条都推不上去
 *   forbidden   —— 没有这个集的写权限（只读成员，或已被移出）。同样是终态，
 *                  丢掉并提示。留着的话，万一哪天被重新授权，一条几个月前的
 *                  改动会突然生效
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
  let denied = 0;
  for (const r of rejected) {
    if (r.code === 'clock') clock.push(r.opId);
    else { bad.push(r.opId); if (r.code === 'forbidden') denied++; }
  }

  store.ackOps(bad);
  store.setClockBlocked(clock);
  if (clock.length) {
    store.setError('本机时间不准，' + clock.length + ' 条改动等时间校准后会自动补传');
  } else if (denied) {
    store.setError('有 ' + denied + ' 条改动没有权限写入，已跳过');
  }
}

/**
 * 推 + 拉一轮。
 *
 * @returns 这一轮有没有推进（outbox 变短了，或者游标前进了）
 */
async function round(forceSnapshot: boolean): Promise<boolean> {
  const s = store.get();
  const ops = s.outbox.slice(0, OPS_PER_CALL);
  const before = s.outbox.length;

  const res = await api.sync({
    cursor: forceSnapshot ? 0 : s.cursor,
    deviceId: deviceId(),
    ops,
  });

  if (res.rejected && res.rejected.length) handleRejected(res.rejected);

  store.ackOps(res.applied || []);

  // 集与邀请每次都带回来，轮询顺带发现「有人邀请我」「我被移出了某个集」
  store.setCals(res.cals);
  store.setInvites(res.invites);

  // 快照与增量走同一条合并路径，见 store.applyRemote 的注释
  if (res.snapshot) store.applyRemote(store.flattenSnapshot(res.snapshot));
  else if (res.changes && res.changes.length) store.applyRemote(res.changes);

  /* 「同一次里我推的字段，也收到了别人的改动」= 两边都改过，LWW 已经判完了。
     记下来，抽屉里那条提示才有东西可显示。**只认增量这一路**：快照是
     「我刚加入这个集，把历史整份拉下来」，里面那些改动跟「同时」不是一回事，
     拿它判必然误报成一片。 */
  if (res.changes && res.changes.length) {
    store.addConflicts(findConflicts(ops, res.changes, deviceId()));
  }

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
    // 本地已知的集。哪一轮发现自己不认识某个集，就得改要一次全量快照 ——
    // 游标是全局单调的，加入一个集时游标早就越过它历史的那些变更了，
    // 光靠增量永远拉不到这个集已有的内容。
    const known = new Set(store.getCals().map((c) => c.id));
    let forceSnapshot = false;

    for (let i = 0; i < MAX_ROUNDS; i++) {
      const progressed = await round(forceSnapshot);
      forceSnapshot = false;

      const now = store.getCals();
      if (now.some((c) => !known.has(c.id))) {
        forceSnapshot = true;
        for (const c of now) known.add(c.id);
      }

      if (!store.get().outbox.length && !forceSnapshot) break;
      if (!progressed && !forceSnapshot) break;   // 推不动了（多半是被 clock 挡住），别空转
    }
  } catch (e) {
    store.setError(describe(e));
  } finally {
    running = false;
    setSyncing(false);
  }
}

/**
 * 重新问一次「我是谁、我有哪些集、谁邀请了我」。
 *
 * 成员关系变了之后（建集 / 接受邀请 / 被移出 / 退出）调它。**不能靠同步
 * 响应里的 cals 兜底**：那条路径要等下一次同步才走，而用户刚点了「接受」
 * 就指望界面里出现新集，中间会有一段空白。
 */
export async function refreshMeta(): Promise<void> {
  const me = await api.me();
  setCachedUser(me.user);
  store.setCals(me.cals);
  store.setInvites(me.invites);
}

/**
 * 登录之后调一次。
 *
 * 先问一次 `/api/me`：拿权威的用户名、集列表和待处理邀请。登录页缓存的
 * 用户对象可能是上一个版本写的，而**一个集都没有时界面是空白的** ——
 * 那一步不能等同步跑完。
 *
 * 首次导入的判断放在**同步完成之后**：先看服务器账号里有没有东西，
 * 空账号才把本机的旧数据搬上去。否则在第二台浏览器上登录时，
 * 会把本地残留的演示数据倒进一个已经有内容的账号里。
 */
export async function bootstrap(): Promise<void> {
  try {
    await refreshMeta();
  } catch (e) {
    // 连不上就继续走同步那条路 —— 它会再报一次，且本地缓存还能用
    if (e instanceof ApiError && e.status === 401) throw e;
  }

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

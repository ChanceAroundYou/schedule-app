/**
 * syncNow.ts —— 立刻同步一次
 */

import { getToken } from '../data/api.ts';
import * as store from '../data/store.ts';
import { isDragging } from '../ui/dragState.ts';
import { round } from './round.ts';
import { setSyncing, describe } from './helpers.ts';
import { MAX_ROUNDS } from './constants.ts';

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

/** 模块内部状态：是否正在同步 */
let running = false;

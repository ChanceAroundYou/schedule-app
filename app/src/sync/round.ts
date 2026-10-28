/**
 * round.ts —— 推 + 拉一轮
 */

import { api } from '../data/api.ts';
import * as store from '../data/store.ts';
import { deviceId } from '../data/device.ts';
import { findConflicts } from '../domain/merge.ts';
import { handleRejected } from './rejected.ts';
import { OPS_PER_CALL } from './constants.ts';

/**
 * 推 + 拉一轮的结果。
 *
 * `truncated` 是**拉那一侧**的信号：服务端单次最多回吐 `MAX_PULL` 条变更
 * （`server/lib/sync.js`），回满就说「还有下文」。它把游标停在**这一批的最后一条**
 * （这是对的，不然中间那段永远拉不到），但得有人接着拉 —— 见 `syncNow.ts`。
 */
interface RoundResult {
  /** 这一轮有没有推进（outbox 变短了，或者拉到了东西） */
  progressed: boolean;
  /** 服务端明说了「这批没给完」，下文还挂着 */
  truncated: boolean;
}

async function round(forceSnapshot: boolean): Promise<RoundResult> {
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
  store.setUsers(res.users);

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

  return {
    progressed: store.get().outbox.length < before || (res.changes || []).length > 0,
    truncated: res.truncated === true,
  };
}

export { round };
export type { RoundResult };

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
    let truncated = false;
    pullBacklog = false;

    for (let i = 0; i < MAX_ROUNDS; i++) {
      const r = await round(forceSnapshot);
      truncated = r.truncated;
      forceSnapshot = false;

      const now = store.getCals();
      if (now.some((c) => !known.has(c.id))) {
        forceSnapshot = true;
        for (const c of now) known.add(c.id);
      }

      /* 两条「收工」都要让位于 `truncated`：服务端明说了这批没给完，
         这时候「outbox 空了」「推不动了」都只说明**推**那头没事，
         **拉**那头还挂着下文（停在这儿就等于把剩下的留到下一次触发）。 */
      if (truncated) continue;
      if (!store.get().outbox.length && !forceSnapshot) break;
      if (!r.progressed && !forceSnapshot) break;   // 推不动了（多半是被 clock 挡住），别空转
    }

    // 用完 MAX_ROUNDS 还挂着 truncated = 真没拉完，交给兜底轮询接着拉。
    // 中途抛错（401 之类）走的是下面那个 catch，这里留 false —— 那种情况该停，
    // 不该每 15 秒重试一次。
    pullBacklog = truncated;
  } catch (e) {
    store.setError(describe(e));
  } finally {
    running = false;
    setSyncing(false);
  }
}

/** 模块内部状态：是否正在同步 */
let running = false;

/**
 * 上一趟**没拉完的下文**。
 *
 * 服务端一次最多回吐 `MAX_PULL` 条变更（`server/lib/sync.js`），回满就标
 * `truncated` 并把游标停在最后一批的最后一条。客户端这里原先只认「outbox 空了就收工」，
 * 于是：本机没有待推的改动、而远端压着上万条没拉 → 这一趟拉 5000 条就停，
 * 剩下的要等下一次触发（本地改一条东西 / focus / online 事件）。
 * 更糟的是**它自己看不出内容少了** —— 界面上一切正常，只是少了那批任务。
 *
 * 现在：`truncated` 让循环继续转（仍受 `MAX_ROUNDS` 约束），转完还挂着就把
 * 这件事记在这里，兜底轮询据此**即使 outbox 空也照样发**（见 `lifecycle.ts`）。
 * 不持久化：重载后 `refreshMeta` 本来就要拉一趟，游标还在，接着往下走就是。
 */
let pullBacklog = false;

/** 有没有「已知还没拉完」的下文（给兜底轮询判要不要发请求） */
export function hasPullBacklog(): boolean { return pullBacklog; }

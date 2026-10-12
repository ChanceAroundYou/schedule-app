/**
 * rejected.ts —— 处理被服务器退回的 op
 */

import type { Rejected } from '../domain/types.ts';
import * as store from '../data/store.ts';

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

export { handleRejected };

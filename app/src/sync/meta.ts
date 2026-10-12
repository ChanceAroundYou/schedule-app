/**
 * meta.ts —— 元数据刷新与启动引导
 */

import { api, ApiError, setCachedUser } from '../data/api.ts';
import * as store from '../data/store.ts';
import { readLegacy } from '../data/legacy.ts';
import { syncNow } from './syncNow.ts';

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
  if (Object.keys(s.tasks).length || Object.keys(s.habits).length
      || Object.keys(s.projects).length) return;

  const legacy = readLegacy();
  if (!legacy) return;

  store.loadMigrated(legacy.tasks, legacy.habits);
  await syncNow();
}

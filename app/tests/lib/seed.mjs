/**
 * seed.mjs —— 探针造数据的公共层
 *
 * 为什么要有这一份：探针要盯的是**版面和行为**，可每张卡背后都要先有数据。
 * 造数据那套动作（开账户 → 拿到默认集 → 把字段拆成逐字段 op → POST /api/sync →
 * 必要时再开第二个账户、真邀请、真接受）以前在 `card-geometry` 和 `browser-cards`
 * 里各写一遍，而且写在**注入浏览器的模板字符串**里 —— 同一件事两份、每份都得
 * 自己算今天、自己拼 fields。两份的害处不是难看，是**改一处不会同步另一处**：
 * 字段表少一个（比如 repeatSeq），一个探针红、另一个静悄悄。
 *
 * ⚠️ 这一层全在 **Node 侧**跑（直接 `fetch` 后端），不在浏览器里跑：
 * 浏览器里跑的代价是「代码以字符串形态存在」—— 注释里不能出现反引号（会把外层
 * 模板当场截断、后半截漏到 Node 里跑，踩过）、没有类型、改起来只能靠肉眼对花括号。
 * 造数据不需要浏览器，只有「让浏览器带着这个账户起来」那一步需要（`loginInPage`）。
 *
 * 边界：这里只管**环境准备**，不管被测行为。
 * 凡是要在界面上走一遍的流程（browser-smoke 第七节：邀请怎么在界面里被接住），
 * 不要把 helper 塞进去 —— 那条流程本身就是被测对象，用 helper 跳过去等于把考点跳了。
 */

import { evalJs } from './cdp.mjs';

/** 后端 API 小工具（Node 侧，返回 status + 解析过的 body） */
export async function apiCall(apiPort, method, p, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${apiPort}/api${p}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** 重复规则的两档工厂。**每次给新对象**：调用方常在 row 上就地改字段，
 *  共享一个对象会让一处改动串到别的种子上。 */
export const repeatNone = () => ({ unit: 'none', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null });
export const repeatWeek = () => ({ unit: 'week', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null });

/** 今天（或偏移 N 天）的 `YYYY-MM-DD`。**日期只在这一处算**（探针不许自己拼 p2/getMonth）。
 *  用本地日而不是 UTC：视图按本地日分天，用 UTC 会在跨界的那台机器上把种子放到昨天。 */
export function isoDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p2 = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

/** 一条任务落库要的**完整字段表**（只这一处定义）。缺一个字段 = 那条任务半新半旧。 */
export function taskFields(row, date) {
  const repeat = row.repeat || repeatNone();
  return {
    title: row.title,
    date: row.date || date,
    time: row.time ?? null,
    duration: row.duration ?? null,
    done: row.done ?? false,
    doneAt: row.doneAt ?? null,
    repeat,
    // 重复任务要有 seriesId（实例 id 派生要靠它），不重复的必须是 null
    seriesId: repeat.unit === 'none' ? null : (row.seriesId || row.id),
    repeatSeq: row.repeatSeq ?? 0,
    reminder: row.reminder ?? null,
    note: row.note ?? '',
  };
}

/** 逐字段 op：一个字段一条（LWW 是逐字段的，服务端也按字段落）。
 *  opId 默认 `op-<任务 id>-<字段>`，要换前缀传 `opPrefix`（不同探针共用数据库时不撞号）。 */
export function taskOps({ rows, calId, deviceId, date, opPrefix = 'op', ts = Date.now() }) {
  const ops = [];
  for (const row of rows) {
    const fields = taskFields(row, date);
    for (const f of Object.keys(fields)) {
      ops.push({
        opId: opPrefix + '-' + row.id + '-' + f, deviceId, ts,
        entity: 'task', entityId: row.id, calId, fields: { [f]: fields[f] },
      });
    }
  }
  return ops;
}

/** 开一个账户（每个账户服务端会自动给一个默认集） */
export async function registerUser(apiPort, { name, password }) {
  const r = await apiCall(apiPort, 'POST', '/auth/register', { body: { name, password } });
  if (r.status !== 200 || !r.body || !r.body.token) {
    throw new Error('注册失败（' + name + '）：' + JSON.stringify(r));
  }
  return { token: r.body.token, user: r.body.user };
}

/** 这个账户的第一个集（= 它的默认集） */
export async function firstCal(apiPort, token) {
  const r = await apiCall(apiPort, 'GET', '/me', { token });
  const cal = r.body && (r.body.cals || [])[0];
  if (!cal) throw new Error('拿不到默认日程集：' + JSON.stringify(r));
  return cal;
}

/** 把 A 请进 B 的集（两段式：B 发邀请 → A 接受）。返回 A 新进去的那个集。 */
export async function inviteAndAccept(apiPort, { calId, name, role = 'editor', ownerToken, joinerToken }) {
  const inv = await apiCall(apiPort, 'POST', `/cals/${calId}/invites`, { body: { name, role }, token: ownerToken });
  if (inv.status !== 200 || !inv.body || !inv.body.invite) throw new Error('邀请失败：' + JSON.stringify(inv));
  const acc = await apiCall(apiPort, 'POST', `/invites/${inv.body.invite.id}/accept`, { body: {}, token: joinerToken });
  if (acc.status !== 200) throw new Error('接受邀请失败：' + JSON.stringify(acc));
  return { invite: inv.body.invite, accepted: acc.body };
}

/** 造任务：把 rows 拆成 op 推给 /api/sync。返回落库字段数与被拒的 op。 */
export async function pushTasks(apiPort, { token, calId, rows, deviceId, date = isoDate(), opPrefix = 'op', cursor = 1 }) {
  const ops = taskOps({ rows, calId, deviceId, date, opPrefix });
  const r = await apiCall(apiPort, 'POST', '/sync', { body: { cursor, ops }, token });
  if (r.status !== 200) throw new Error('推任务失败：' + JSON.stringify(r));
  const applied = (r.body && r.body.applied) || [];
  const rejected = (r.body && r.body.rejected) || [];
  if (rejected.length) throw new Error('有 op 被拒：' + JSON.stringify(rejected));
  return { applied: applied.length, ops: ops.length, date, calId };
}

/** 让浏览器带着这个账户起来（等价于登录成功后 localStorage 的状态）。
 *  为什么不点界面上的登录表单：探针要盯的不是登录流程（那条由 browser-smoke 覆盖），
 *  少一步就少一处会坏的地方。写完之后**必须再导航一次**，应用才会在启动时读到它。 */
export async function loginInPage(page, { token, user }) {
  await evalJs(page, `
    localStorage.setItem('schedule-app-token', ${JSON.stringify(token)});
    localStorage.setItem('schedule-app-user', JSON.stringify(${JSON.stringify(user)}));
    return localStorage.getItem('schedule-app-token') !== null;
  `);
}

/** 催同步引擎拉一趟：它平时 15 秒一轮，窗口重获焦点时立刻跑。不催就得干等。 */
export async function nudgeSync(page) {
  await evalJs(page, `window.dispatchEvent(new Event('focus')); return true;`);
}

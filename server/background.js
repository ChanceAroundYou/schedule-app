/**
 * background.js —— 两个后台定时器
 *
 * 都在 `main()` 里 `unref()`：它们不拖住进程退出（`Ctrl-C` 能立刻关掉后端），
 * 也不参与任何请求。**它们不属于任何一条请求**，所以单独一个文件 ——
 * 把 60 行的定时器混在 server.js 里，读者会以为「关停时会等它跑完」。
 *
 * 一、清理撤销表（每 6 小时）
 *    登出和改口令会往 `revoked_jti` 塞记录，不清就会一直长。查得太勤没意义
 *    —— 这些票最长也就活 TOKEN_TTL_MS 那么久。
 *
 * 二、晚间汇报（每分钟扫一次）
 *    到点了就生成，**只在服务器上跑，不阻塞任何请求**。判据有三条，缺一不可：
 *      1. 用户开了 eveningReport，且当前时刻正好等于他设的那一分钟；
 *      2. 他今天在集里动过手（`changes` 表里有今天的行）—— 一天没用过就别汇报；
 *      3. 今天还没生成过（「每日汇报」那个会话的 updated_at 不是今天）。
 */
'use strict';

const db = require('./lib/db');
const ai = require('./lib/ai');

/** 清理过期 / 过期太久的撤销记录 */
function startRevokePruner() {
  db.pruneRevoked();
  const timer = setInterval(() => {
    try { db.pruneRevoked(); } catch (_) { /* 下次再说 */ }
  }, 6 * 3600 * 1000);
  timer.unref();
}

/** 今天这个用户在集里动过手没有（变了任何一行的字段都算） */
function touchedToday(calIds) {
  const placeholders = calIds.map(() => '?').join(',');
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const row = db.get(
    `SELECT COUNT(*) AS n FROM changes WHERE cal_id IN (${placeholders}) AND ts > ?`,
    ...calIds, startOfToday.getTime(),
  );
  return Boolean(row && Number(row.n));
}

/** 「每日汇报」这个会话今天是不是已经生成过了 */
function reportedToday(userId, now) {
  const session = db.listAiSessions(userId, 50).find((s) => s.title === '每日汇报');
  if (!session) return false;
  const updated = new Date(Number(session.updated_at));
  return updated.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

function startEveningReport() {
  const timer = setInterval(() => {
    try {
      const now = new Date();
      const cur = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      for (const u of db.all('SELECT id FROM users')) {
        // 注意别把变量叫 auth：那是 lib/auth，遮住了以后想在里面加一行就找不到它了
        const az = db.getAuthorizations(u.id);
        if (!az.eveningReportEnabled) continue;
        if (az.eveningReportTime !== cur) continue;

        const calIds = db.calendarIdsFor(u.id);
        if (!calIds.length) continue;
        if (!touchedToday(calIds)) continue;
        if (reportedToday(u.id, now)) continue;

        // 生成汇报（在后台跑，不阻塞）
        ai.load().then((mod) => {
          mod.runEveningReport(u.id).catch((e) => {
            console.error('[ai] 晚间汇报失败', e && e.message ? e.message : e);
          });
        }).catch(() => { /* 依赖没装，跳过 */ });
      }
    } catch (e) {
      console.error('[ai] 晚间汇报检查失败', e && e.message ? e.message : e);
    }
  }, 60 * 1000);
  timer.unref();
}

module.exports = { startRevokePruner, startEveningReport };
/**
 * routes/sync.js —— 同步那一个接口
 *
 * `POST /api/sync` **一次调用同时推和拉**。整个后端最能体现「服务器是权威」
 * 的地方就这一段，所以它自己一个文件、注释也写得最细 —— 改之前先读完。
 *
 * 两句话的顺序不能反，也不需要加锁：
 *   ① `sync.applyOps` 先**落盘**再取数。快照必须反映「本批 op 合并之后」的真值，
 *      否则客户端会拿一个慢半拍的快照把自己的写入盖回去。
 *   ② 游标 > 0 走增量；**游标为 0 走全量快照**。这个分支不是优化，是
 *      「新加入一个集时它的历史变更全在游标后面，光靠增量永远拉不到」，
 *      客户端是靠这个全量把它补齐的（见 app/src/sync/syncNow.ts 的 known 判断）。
 *
 * 「先落盘再取数」之间没有 await，Node 又是单线程，所以不存在「写完快照、
 * 游标却跳到写入之后」的缝隙。**哪天在这里加一个 await，这条论证就作废了。 */
'use strict';

const db = require('../lib/db');
const sync = require('../lib/sync');
const calendars = require('../lib/calendars');
const invites = require('../lib/invites');

module.exports = {

  'POST /api/sync': (ctx, me) => {
    const userId = me.user.id;
    const body = ctx.body || {};
    const cursorIn = Number(body.cursor || 0);

    const { applied, rejected } = sync.applyOps(userId, body.ops);

    let state;
    if (cursorIn > 0) {
      const p = sync.pull(userId, cursorIn);
      state = { cursor: p.cursor, changes: p.changes, truncated: p.truncated };
    } else {
      state = { cursor: db.maxSeq(), snapshot: sync.snapshot(userId) };
    }

    // cals / invites 每次同步都带回来：轮询顺带发现「有人邀请我」和
    // 「我被拉进了一个新集」，不用刷新页面
    return {
      status: 200,
      body: {
        ...state, applied, rejected,
        cals: calendars.listMine(userId),
        invites: invites.listFor(userId),
      },
    };
  },

};
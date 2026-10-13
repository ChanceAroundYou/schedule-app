/**
 * ai/confirm.js —— 提案的落库点（**AI 唯一真正写数据的地方**）
 *
 * 模型说的每一句「我帮你排好了」都不算数，直到用户在这里点了确认。
 * 所以这个文件是该功能里权限最要害的一处，三条规矩：
 *
 * 1. **只信 id，不信参数。** 请求里只有 `{ ids }`；要写什么一律**按 id
 *    从库里把当时存的那份提案读回来**。信客户端回传的 args 等于把权限判断
 *    交给了浏览器 —— 前端能改的东西，攻击者也能改。
 *
 * 2. **写之前重查一次权限。** 提案生成到确认之间可能隔了几分钟，用户可能
 *    已经被降级成 viewer、或者被移出了那个集。生成时查过一遍不算 ——
 *    那是那一刻的事实。判断只走 `db.roleOf` + `calendars.canWrite`
 *    这两个既有入口，别在这里自己比字符串。
 *
 * 3. **写还是走 `sync.applyOps`。** 它是全项目唯一的服务端写入闸门，
 *    里面那层 `canWrite` 是第二道兜底。AI 绕过去就是「只读成员能被 AI 写穿」。
 *    deviceId 固定 `'ai'`：AI 的改动因此会带 `_dev === 'ai'` 出现在客户端上，
 *    也会正常参与逐字段 LWW 的冲突判定 —— 它确实就是另一个写入者。
 *
 * 这里是 CJS、直接 require，不走 `ai/index.js` 那条惰性 import：确认是纯数据库
 * 操作，一条都不碰 pi。放在那边的话，「依赖没装好」会连带把确认弄坏 ——
 * 而依赖没装好时用户最需要的恰恰是把已经排好的改动确认掉。
 */
'use strict';

const { randomUUID } = require('node:crypto');

const db = require('../db');
const sync = require('../sync');
const calendars = require('../calendars');

/** 一次最多确认几条。卡片是一次一批画出来的，给足；但也别让人一次点出几百条 op */
const MAX_IDS = 50;

/**
 * 严格递增的时间戳。
 *
 * 同一毫秒里的两条 op，LWW 的比较键 `(ts, deviceId)` 会**完全一样** ——
 * 后一条判不离胜负，直接白写。用户连点两次确认、或者一次确认里既有 create
 * 又有 update，都可能撞上。这个时间戳不需要准，只需要**比上一条大**。
 *
 * 起点仍然是 `Date.now()`（不是自己数的数），因为 `sync.validateOp` 会拒掉
 * 与服务器时间差 24 小时以上的 op —— 从 0 开始数会被当成时钟坏了。
 */
let lastTs = 0;
function nextTs() {
  lastTs = Math.max(Date.now(), lastTs + 1);
  return lastTs;
}

/**
 * 确认一批提案。
 *
 * 逐条独立处理，不放在一个大事务里：一条失败不该把已经确认成功的那几条
 * 一起回滚 —— 用户点的是「确认」，不是「全部成功或者全不做」。
 *
 * @param {string} userId
 * @param {string[]} ids 提案 id（= 模型那次工具调用的 toolCallId）
 * @returns {{status:number, body:object}}
 */
function confirm(userId, ids) {
  const list = (Array.isArray(ids) ? ids : [])
    .filter((id) => typeof id === 'string' && id)
    .slice(0, MAX_IDS);
  if (!list.length) return { status: 400, body: { error: '要确认哪几条？' } };

  const done = [];
  const failed = [];

  for (const id of list) {
    const row = db.findAiProposal(userId, id);
    if (!row) {
      // 已经确认过、或者那个对话被删了。不是错误，说清楚就行
      failed.push({ id, reason: '这条提案已经不在了（可能已经确认过）' });
      continue;
    }

    let p;
    try {
      p = JSON.parse(row.proposal);
    } catch (_) {
      failed.push({ id, reason: '这条提案存坏了' });
      continue;
    }
    if (!p || typeof p !== 'object' || !p.calId || !p.entityId || !p.fields) {
      failed.push({ id, reason: '这条提案不完整' });
      continue;
    }

    // —— 第 2 条规矩：重查权限 ——
    const role = db.roleOf(p.calId, userId);
    if (!calendars.canWrite(role)) {
      failed.push({ id, reason: `「${p.calName || p.calId}」你现在没有修改权限` });
      continue;
    }

    const op = {
      opId: randomUUID(),
      deviceId: 'ai',
      ts: nextTs(),
      calId: String(p.calId),
      entity: p.entity === 'habit' ? 'habit' : 'task',
      entityId: String(p.entityId),
      fields: p.fields,
    };

    let res;
    try {
      res = sync.applyOps(userId, [op]);
    } catch (e) {
      // 只记 message 不记堆栈：同 router.js，堆栈可能带着库文件路径
      console.error('[ai/confirm]', e && e.message ? e.message : e);
      failed.push({ id, reason: '写入失败' });
      continue;
    }

    if (!res.applied.includes(op.opId)) {
      const why = (res.rejected[0] && res.rejected[0].reason) || '写不进去';
      failed.push({ id, reason: why });
      continue;
    }

    // 确认掉的卡片要从库里划掉，否则刷新一次它又回来了 ——
    // 用户会以为没生效，再点一次
    dropProposal(row, userId, id);
    done.push({
      id,
      kind: p.kind,
      calId: op.calId,
      entityId: op.entityId,
      title: p.title || '',
    });
  }

  return { status: 200, body: { done, failed } };
}

/**
 * 把这条提案从它所在消息的 `proposals` 数组里去掉。
 *
 * 数组空了就整列置 null（`ai/sessions.js` 把 null 读成「这条消息没有待确认的提案」）。
 * 同一条消息里有两条提案、用户只点了其中一条时，另一条必须原样留着。
 */
function dropProposal(row, userId, proposalId) {
  let arr;
  try {
    arr = JSON.parse(row.message_proposals);
  } catch (_) {
    return;
  }
  if (!Array.isArray(arr)) return;

  const left = arr.filter((x) => !x || x.id !== proposalId);
  db.setAiMessageProposals(row.message_id, userId, left.length ? JSON.stringify(left) : null);
}

module.exports = { confirm, MAX_IDS };

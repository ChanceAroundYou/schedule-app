/**
 * flow.js —— 每日流程的读写（v9 加的表）
 *
 * 一份「个人私有的顺序表」：`doc='template'` 是常用模板，
 * `doc='YYYY-MM-DD'` 是当天清单。整份存 JSON，见 schema.js 的 FLOW_TABLES
 * 注释（为什么不拆成逐字段实体）。
 *
 * ## 并发口径：整文档最后写入者胜 + rev
 *
 * 同一个人的两台设备同时改同一天，没有字段级合并的意义（顺序是一个整体）。
 * 所以这里不做字段合并，只给每次写入 `rev = 旧 rev + 1`，并把最新 rev 返回：
 *
 *   · 客户端拿 `baseRev` 比对，能看出「我这份落后了」；
 *   · 落后时仍然接受这次写入 —— 用户刚在屏幕上改完的东西，不能因为另一台
 *     设备晚几秒前也改过就整份丢掉。这跟日程任务那边「逐字段 LWW」不同，
 *     原因也写在 schema.js：这是个人私有文档，冲突面只有自己。
 *
 * ## 上限
 *
 * body 最多 64KB、一天最多 200 项 —— 挡住「手滑把整本书粘进来」，
 * 也保证 45 天窗口一次拉回来不会变成几 MB。
 */
'use strict';

const { run, get, all } = require('./connection.js');

/** 一天最多多少项。超过就是数据出问题了，不是正常使用 */
const MAX_ITEMS = 200;

/** 单份文档的最大字节数（JSON 文本） */
const MAX_BODY = 64 * 1024;

/**
 * 合法 doc 名：'template' 或 YYYY-MM-DD。
 * 直接拼进主键，所以必须在这里挡住任意字符串（防止一条记录叫 'template ' 之类）。
 */
function isDocName(doc) {
  if (typeof doc !== 'string') return false;
  if (doc === 'template') return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(doc);
}

function parseBody(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && Array.isArray(v.items) ? v : { items: [] };
  } catch (_) {
    return { items: [] };
  }
}

function shape(row) {
  if (!row) return null;
  return { rev: Number(row.rev), items: parseBody(row.body).items, updatedAt: Number(row.updated_at) };
}

/** 读一份文档。没有就返回 null（「没生成过」和「生成过但清空了」是两件事） */
function getDoc(userId, doc) {
  if (!isDocName(doc)) return null;
  const row = get('SELECT rev, body, updated_at FROM flow_docs WHERE user_id = ? AND doc = ?', String(userId), doc);
  return shape(row);
}

/**
 * 读一段日期区间的当天清单（不含 template）。
 *
 * 一次取回而不是按天发请求：翻日期条时来回请求会让「换一天」明显变慢。
 */
function listDocs(userId, from, to) {
  const rows = all(
    'SELECT doc, rev, body, updated_at FROM flow_docs WHERE user_id = ? AND doc <> ? AND doc >= ? AND doc <= ?',
    String(userId), 'template', String(from), String(to),
  );
  const out = {};
  for (const r of rows) out[r.doc] = shape(r);
  return out;
}

/**
 * 写一份文档。
 *
 * @param {string} doc
 * @param {{items: unknown[]}} body
 * @param {number|null} baseRev 客户端手上那份的 rev（诊断用，不用于拒绝写入）
 * @returns {{rev:number, items:unknown[], updatedAt:number, stale:boolean}|null}
 */
function putDoc(userId, doc, body, baseRev) {
  if (!isDocName(doc)) return null;
  const items = Array.isArray(body && body.items) ? body.items.slice(0, MAX_ITEMS) : [];
  const json = JSON.stringify({ items });
  if (json.length > MAX_BODY) return null;

  const uid = String(userId);
  const prev = get('SELECT rev FROM flow_docs WHERE user_id = ? AND doc = ?', uid, doc);
  const prevRev = prev ? Number(prev.rev) : 0;
  const rev = prevRev + 1;
  const now = Date.now();
  const stale = typeof baseRev === 'number' && Number.isFinite(baseRev) && baseRev !== prevRev;

  run(
    `INSERT INTO flow_docs (user_id, doc, rev, body, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, doc) DO UPDATE SET rev = excluded.rev, body = excluded.body, updated_at = excluded.updated_at`,
    uid, doc, rev, json, now,
  );
  return { rev, items, updatedAt: now, stale };
}

module.exports = { MAX_ITEMS, MAX_BODY, isDocName, getDoc, listDocs, putDoc };

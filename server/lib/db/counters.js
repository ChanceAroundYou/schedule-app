/**
 * counters.js —— 桌面计数器的读写（v5 加的表）
 *
 * ## 为什么单独一张表，而不是塞进 field_state 的通用实体
 *
 * 同步层是**逐字段整值替换**。计数器的写入语义却是「在当前值上加 N」。
 * 用整值替换来写，两台设备同时点 +1 时后写的那条会把前一条抹掉 ——
 * 加两次只长 1，而且没有任何报错，用户只会觉得「手机点的不算数」。
 * 所以这里给一条 `value = value + ?` 的原子自增语句，由数据库保证并发正确。
 *
 * 归属是 user_id 而不是 cal_id：计数器是「我自己的数字」，不共享、不参与
 * 邀请与角色那套权限。同一账号换手机、重装 App，数字照样跟着走。
 *
 * id 是固定的（naonao / kutai），name 可改。改名**不能**换 id ——
 * 桌面小组件按 id 找记录，换了 id 就等于指向一条空记录，数字归零。
 */
'use strict';

const { run, get, all } = require('./connection.js');

/**
 * 默认的两个计数器。**只在用户第一次碰它们时落库**（ensureDefaults），
 * 不做「注册时批量初始化」—— 老账号没有这两个 id 也得能用。
 */
const DEFAULTS = [
  { id: 'naonao', name: 'naonao' },
  { id: 'kutai', name: 'Kutai' },
];

/** 数值上下限。上限是为了别让桌面那块小地方显示成天文数字，不是业务规则。 */
const MIN_VALUE = 0;
const MAX_VALUE = 999999;

const isDefaultId = (id) => DEFAULTS.some((d) => d.id === id);

/** 确保两个默认计数器存在。INSERT OR IGNORE：已存在就不动（绝不覆盖用户的值）。 */
function ensureDefaults(userId) {
  const now = Date.now();
  for (const d of DEFAULTS) {
    run(
      'INSERT OR IGNORE INTO counters (user_id, id, name, value, updated_at) VALUES (?,?,?,?,?)',
      String(userId), d.id, d.name, 0, now,
    );
  }
}

/** 我全部的计数器，按默认顺序（naonao 在上、kutai 在下）。 */
function listCounters(userId) {
  ensureDefaults(userId);
  const rows = all('SELECT id, name, value, updated_at FROM counters WHERE user_id = ?', String(userId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = [];
  // 先按默认顺序，再补上以后可能新增的自定义计数器（按名字排）
  for (const d of DEFAULTS) {
    const r = byId.get(d.id);
    if (r) out.push({ id: r.id, name: r.name, value: Number(r.value) });
    byId.delete(d.id);
  }
  for (const r of [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    out.push({ id: r.id, name: r.name, value: Number(r.value) });
  }
  return out;
}

function getCounter(userId, id) {
  ensureDefaults(userId);
  const r = get('SELECT id, name, value FROM counters WHERE user_id = ? AND id = ?', String(userId), String(id));
  return r ? { id: r.id, name: r.name, value: Number(r.value) } : null;
}

/**
 * 加 delta（可为负）。**一条语句完成读-改-写**，不用先查再写 ——
 * 分成两步就会出现「两个请求都读到 5，都写 6」的经典丢更新。
 *
 * @returns {{id, name, value}|null} 写入后的最新值；id 不认识时返回 null
 */
function addCounter(userId, id, delta) {
  ensureDefaults(userId);
  const cur = getCounter(userId, id);
  if (!cur) return null;
  const n = Math.round(Number(delta));
  if (!Number.isFinite(n) || n === 0) return cur;

  run(
    `UPDATE counters
        SET value = MAX(?, MIN(?, value + ?)),
            updated_at = ?
      WHERE user_id = ? AND id = ?`,
    MIN_VALUE, MAX_VALUE, n, Date.now(), String(userId), String(id),
  );
  return getCounter(userId, id);
}

/**
 * 直接设成某个值（用户点数字手输 300）。
 * 同样夹在 [MIN_VALUE, MAX_VALUE] 里 —— 负数和七位数都不该出现在桌面上。
 */
function setCounter(userId, id, value) {
  ensureDefaults(userId);
  const cur = getCounter(userId, id);
  if (!cur) return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return cur;

  run(
    'UPDATE counters SET value = MAX(?, MIN(?, ?)), updated_at = ? WHERE user_id = ? AND id = ?',
    MIN_VALUE, MAX_VALUE, n, Date.now(), String(userId), String(id),
  );
  return getCounter(userId, id);
}

/** 改名。id 不动。 */
function renameCounter(userId, id, name) {
  ensureDefaults(userId);
  const clean = String(name == null ? '' : name).trim().slice(0, 24);
  if (!clean) return null;
  run(
    'UPDATE counters SET name = ?, updated_at = ? WHERE user_id = ? AND id = ?',
    clean, Date.now(), String(userId), String(id),
  );
  return getCounter(userId, id);
}

module.exports = {
  DEFAULTS, MIN_VALUE, MAX_VALUE, isDefaultId,
  ensureDefaults, listCounters, getCounter, addCounter, setCounter, renameCounter,
};

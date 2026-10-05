/**
 * ratelimit.js —— 内存里的固定窗口计数限流
 *
 * 只挡暴力枚举：登录按「用户名 + 来源 IP」限、注册与邀请按来源 IP 限。
 * 不是防御 DDoS（那要在 nginx 层做），是让「一秒钟试一千个密码」这件事
 * 从秒级变成天级。
 *
 * 来源 IP 取 X-Real-IP：nginx 用 $remote_addr 覆盖写它，而后端只监听
 * 127.0.0.1，只有 nginx 能连上来 —— 所以这个头是可信的，客户端伪造不了。
 * 直接读 req.socket.remoteAddress 的话所有人都是 127.0.0.1，限流等于没有。
 *
 * 进程内存，重启即清空。单进程部署下够用；将来多进程要换成共享存储。
 */
'use strict';

/** @type {Map<string, {n: number, reset: number}>} */
const buckets = new Map();

const MAX_KEYS = 20000;   // 防止被刷出无限多的 key 把内存吃满

function prune(now) {
  for (const [k, v] of buckets) {
    if (v.reset <= now) buckets.delete(k);
  }
}

/**
 * 记一次并判断是否超限。
 *
 * @returns {{ok: true} | {ok: false, retryAfter: number}}  retryAfter 单位秒
 *
 * 固定窗口（不是滑动窗口）：边界上最多放过 2×limit。登录尝试这个量级无所谓，
 * 省掉滑动窗口那份环形数组。
 */
function hit(key, limit, windowMs) {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) prune(now);

  let b = buckets.get(key);
  if (!b || b.reset <= now) {
    b = { n: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.n += 1;
  if (b.n > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.reset - now) / 1000)) };
  }
  return { ok: true };
}

/** 成功之后把计数清掉——否则正常用户攒够失败次数也会被锁 */
function clear(key) {
  buckets.delete(key);
}

/** 从请求头取来源 IP。见文件头：X-Real-IP 由本机 nginx 覆盖写。 */
function clientIp(req) {
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real.slice(0, 64);
  return String((req.socket && req.socket.remoteAddress) || 'unknown');
}

/** 两个键都记一次，任一超限就挡下（同时防「换用户名试」和「换密码试」） */
function hitBoth(keys, limit, windowMs) {
  const results = keys.map((k) => hit(k, limit, windowMs));
  const blocked = results.find((r) => !r.ok);
  return blocked || { ok: true };
}

module.exports = { hit, clear, hitBoth, clientIp };

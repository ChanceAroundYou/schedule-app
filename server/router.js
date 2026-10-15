/**
 * router.js —— 路由匹配与那个 http 回调
 *
 * 拆出来是因为它跟「有哪些接口」是**两件事**：接口表在 routes/，这里只管
 * 「把这一行 `METHOD /api/xxx` 变成一条能跑的规则」。加接口不用碰这个文件。
 *
 * 三条顺序敏感的地方，改之前先看：
 *   1. 末尾斜杠先抹掉（`/api/sync/` 与 `/api/sync` 等价）；
 *   2. **静态段排在参数段前面** —— 将来出现 `GET /api/cals/:calId` 与
 *      `GET /api/cals/mine` 这种组合时，靠这个顺序静态的那个先被匹配到；
 *   3. `{ raw: true }` 的处理器**必须立刻返回** —— 再去 send() 就是写第二遍头，
 *      Node 抛 ERR_HTTP_HEADERS_SENT，而那时流已经发出去了，用户只看到对话断在半截。
 */
'use strict';

const http = require('node:http');

const { handlers } = require('./routes');
const { send, readBody, currentUser, applyCors, preflight } = require('./http');

/** 把 '/api/cals/:calId/members' 编译成正则 + 参数名。静态段要转义。 */
function compile(pattern) {
  const names = [];
  const body = pattern.split('/').map((seg) => {
    if (seg.startsWith(':')) {
      names.push(seg.slice(1));
      return '([^/]+)';
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { rx: new RegExp(`^${body}$`), names };
}

const PUBLIC = new Set(['GET /api/health', 'POST /api/auth/register', 'POST /api/auth/login']);

const ROUTES = Object.keys(handlers).map((key) => {
  const at = key.indexOf(' ');
  return {
    key,
    method: key.slice(0, at),
    ...compile(key.slice(at + 1)),
    needsAuth: !PUBLIC.has(key),
    isParam: key.includes('/:'),
  };
}).sort((a, b) => Number(a.isParam) - Number(b.isParam));

function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.rx.exec(pathname);
    if (!m) continue;
    const params = {};
    for (let i = 0; i < r.names.length; i += 1) {
      try {
        params[r.names[i]] = decodeURIComponent(m[i + 1]);
      } catch (_) {
        return null;   // 百分号编码坏了，当作没匹配上
      }
    }
    return { ...r, params };
  }
  return null;
}

/** 正文要读的只有 POST / PUT / PATCH —— GET / DELETE 的 body 一律不看 */
const HAS_BODY = new Set(['POST', 'PUT', 'PATCH']);

function createServer() {
  return http.createServer(async (req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) {
      return send(res, 400, { error: '请求地址非法' });
    }

    // 规范化：末尾斜杠统一去掉
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

    // CORS 要在**任何响应之前**处理：预检不进路由，正常请求先记下来源，
    // 让后面的 send() 把头带上
    if (preflight(req, res)) return undefined;
    applyCors(req, res);

    const route = matchRoute(req.method, pathname);
    if (!route) return send(res, 404, { error: '接口不存在' });

    let me = null;
    if (route.needsAuth) {
      me = currentUser(req);
      if (!me) return send(res, 401, { error: '登录状态已失效，请重新登录' });
    }

    let body = {};
    if (HAS_BODY.has(req.method)) {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        return send(res, e.status || 400, { error: e.message || '读取请求体失败' });
      }
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch (_) {
          return send(res, 400, { error: '请求体不是合法 JSON' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return send(res, 400, { error: '请求体必须是 JSON 对象' });
        }
      }
    }

    try {
      // await 是必须的：AI 那条对话路径是 async（它要 await 动态 import 的
      // .mjs）。同步处理器 await 一个非 Promise 值没有代价。
      const out = await handlers[route.key]({ req, res, body, params: route.params }, me);
      if (out && out.raw) return undefined;   // SSE：响应已经写完了
      return send(res, out.status, out.body);
    } catch (e) {
      // 不外泄堆栈：它可能带着库文件路径
      console.error(`[${route.key}]`, e && e.message ? e.message : e);
      // 同上：SSE 已经开了流的话不能再 send()，只能在流里补一条错误
      if (res.headersSent) {
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', message: '服务器内部错误', code: 'server' })}\n\n`);
          res.end();
        } catch (_) { /* 连接已经没了 */ }
        return undefined;
      }
      return send(res, 500, { error: '服务器内部错误' });
    }
  });
}

module.exports = { createServer, ROUTES, matchRoute };
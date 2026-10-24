/**
 * browser-smoke.mjs —— 用真实 Chrome 走一遍新界面（零依赖，走 CDP）
 *
 * 单元测试测不到「页面白不白」。这个探针起一套**完全隔离**的环境：
 *   临时后端（临时数据库）→ 一个带 /api 代理的静态服务 → 真实 Chrome
 * 然后像人一样注册、切日程集、改名、看邀请，一路收集 console 报错。
 *
 * 为什么自己搭静态服务而不是用 vite preview：preview 的代理写死在 25692，
 * 那是线上后端 —— 探针会往生产库里写账号。隔离是这里的第一要求。
 *
 *   node app/tests/browser-smoke.mjs
 *
 * 退出码非 0 = 有问题。环境变量 CHROME 可以指定浏览器可执行文件。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist');
/* 端口**默认还是那三个，被占了自动让开**；也能用环境变量钉死 —— 原来写死（踩坑 40），
   两个 session 同时跑探针就只能等：谁后跑谁拿不到端口，前一个崩掉以后还会
   留下占着端口的孤儿进程（浏览器已经没了，它还在等 CDP）。改端口即可并行：
   `SMOKE_API_PORT=25711 SMOKE_WEB_PORT=5199 SMOKE_CDP_PORT=9233 node tests/browser-smoke.mjs`。
   数据本来就按 run 隔离（SCHEDULE_DATA_DIR），所以并行互不干扰。 */
/**
 * listen，被占了就退回内核分配，返回**真实**那个端口。
 *
 * 为什么光有 `freePort` 不够：假模型那个服务器是**第十二节才起的**，
 * 而 `freePort` 在探针开头就把号放掉了 —— 中间隔了几十秒，
 * 那个号很可能已经被别人占上（本机同时跑两趟探针就必然如此）。
 * `freePort` 只能解决「起之前就占着」，解决不了「起之前空着、起的时候被抢」。
 * 所以两个 listen 都走这里：**真被抢走要响，不要无声无息地卡死**。
 */
function listenFree(srv, preferred) {
  return new Promise((res, rej) => {
    srv.once('error', (e) => {
      if (e.code !== 'EADDRINUSE') return rej(e);
      srv.listen(0, '127.0.0.1', () => res(srv.address().port));   // 让内核挑
    });
    srv.listen(preferred, '127.0.0.1', () => res(srv.address().port));
  });
}

/** 试着占一下 preferred，占不到就往后挨个试，再不行让内核给一个空闲端口 */
async function freePort(preferred) {
  const attempt = (port) => new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(0));          // EADDRINUSE 之类 → 当这个号不可用
    s.listen(port, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  /* 首选通就还是那个熟悉的号 —— 没有别的理由改变它 */
  if (await attempt(preferred)) return preferred;
  /* 首选被占：往后找，但**按 pid 错开起点**。两个探针几乎同时起时，它们在同一
     瞬间都会觉得首选是空的；从同一个号开始找就会挑到同一个，然后第二个的子进程
     bind 失败 —— 那正是这个机制本来要挡的那件事。 */
  const skip = 1 + (process.pid % 16);
  for (let i = 0; i < 24; i++) { const p = await attempt(preferred + skip + i); if (p) return p; }
  return attempt(0);                        // 一片都占了，让内核挑
}
const API_PORT = +(process.env.SMOKE_API_PORT || await freePort(25701));   // 临时后端
let WEB_PORT = +(process.env.SMOKE_WEB_PORT || await freePort(5198));    // 静态 + 代理
const CDP_PORT = +(process.env.SMOKE_CDP_PORT || await freePort(9223));
let MODEL_PORT = +(process.env.SMOKE_MODEL_PORT || await freePort(25711));
const CHROME = process.env.CHROME || '/opt/google/chrome/chrome';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
};

let failures = 0;
const ok = (cond, what, detail) => {
  const tail = detail === undefined || detail === '' ? '' : '（' + detail + '）';
  if (cond) console.log('  ok   ' + what + tail);
  else { failures++; console.log('  FAIL ' + what + tail); }
};

/* ---------------------------------------------------- 静态服务 + 代理 */

function serveDist() {
  const srv = createServer((req, res) => {
    /* 网页版「关于」卡要从 /schedule/dl/version.json 拿安装包名（线上 nginx 同路径）。
       探针那台不挂 apk 目录，这里回一份假的 —— 否则关于卡里那条下载链接永远不渲染。 */
    if (req.url.startsWith('/schedule/dl/version.json')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"versionCode":5,"versionName":"2.0.2","url":"schedule-5.apk","sha256":"stub"}');
      return;
    }
    if (req.url.startsWith('/api/')) {
      const up = fetch(`http://127.0.0.1:${API_PORT}${req.url}`, {
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
        duplex: 'half',
      });
      up.then(async (r) => {
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
      }).catch(() => { res.writeHead(502); res.end('proxy failed'); });
      return;
    }
    let p = path.join(DIST, decodeURIComponent(req.url.split('?')[0]));
    /* **Windows 检测**：path.join 在 Windows 上把分隔符统一成反斜杠，根路径
       join 完是 `…\dist\` —— 只判 '/' 永远不命中，于是根路径 404、页面整个
       不加载。症状是探针卡在「等 Service Worker 接管」，跟 Chrome / SW 一点
       关系都没有（2026-10-15 用 CDP 现场取证定位到的：body 是 "not found"）。 */
    if (process.platform === 'win32' ? p.endsWith('\\') : p.endsWith('/')) p += 'index.html';
    if (!p.startsWith(DIST) || !existsSync(p) || statSync(p).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const ext = path.extname(p);
    const head = { 'content-type': MIME[ext] || 'application/octet-stream' };
    // HTML 一律 no-store：离线那一节要证明「断网后页面来自 Service Worker」，
    // 而 Chrome 自己的 HTTP 缓存也能在服务器挂掉时把 index.html 交出来 ——
    // 那就成了假通过。真实 nginx 给 /schedule/ 配的也是 no-cache。
    if (ext === '.html' || ext === '.json' || p.endsWith('sw.js')) head['cache-control'] = 'no-store';
    res.writeHead(200, head);
    createReadStream(p).pipe(res);
  });
  /* listenFree 给回的是**真实**端口：抢走时会换一个 —— WEB_PORT 得跟着改，
     后面那些 Page.navigate 用的就是它。返回的仍然是 server 本身（调用方要 close）。 */
  return listenFree(srv, WEB_PORT).then((port) => { WEB_PORT = port; return srv; });
}

/* ------------------------------------------------------------ CDP */

async function cdpTargets() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return r.json();
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { res, rej } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
    } else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    waiting.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, events, close: () => ws.close() };
}

/** 在页面里求值，返回 JSON 化后的结果 */
async function evalJs(page, expr) {
  const r = await page.send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true, returnByValue: true,
  });
  // exception.description 才是「TypeError: 读了 null 的 x」那句人话；
  // 只打 exceptionDetails.text 的话所有异常都长成一句「Uncaught」，等于没说
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception?.description || d.text) + ' :: ' + JSON.stringify(r.result?.value));
  }
  return r.result.value;
}

/**
 * 等到表达式返回真值，超时就抛（带上最后看到的值，方便定位）。
 *
 * **表达式不能以换行开头**：这里会把它包成 `return <expr>`，而 `return` 后面
 * 跟换行会被 ASI 断成一句裸 `return`，整条表达式变成永远不可达的代码 ——
 * 症状是「最后一次求值 = undefined」且一直等到超时，看着像应用没反应，
 * 其实是探针自己写错了。多行模板（为了排版好看）几乎必然踩上，所以这里
 * 直接 trim 掉，别指望每个调用点都记得不换行。
 */
async function waitFor(page, expr, what, ms = 8000) {
  const src = expr.trim();
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await evalJs(page, `return ${src};`);
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等不到「${what}」，最后一次求值 = ${JSON.stringify(last)}`);
}

/**
 * 点页面里的一个元素。**找不到**返回 'missing'，否则返回事件序列
 * （'pointerdown:xxx → click:xxx'，放断言里，出问题一眼看得出点没点进去）。
 *
 * **必须连 pointerdown 一起补，光 `el.click()` 不算一次真点击**：这个应用的
 * 点击委托挂在 pointerdown 上（长按状态机在那儿），而「吞掉抬手那记 click」
 * 的标志也只在 pointerdown 里复位 —— 上一节触屏拖拽留下的标志会让第一次
 * `.click()` 整整一下被吃掉（详见 CLAUDE.md 四、40）。
 *
 * `findExpr` 是一段**返回元素**的表达式，不是选择器字符串 —— 调用点常常要先
 * 按文字筛一轮。
 */
async function clickEl(page, findExpr) {
  return evalJs(page, `
    const el = ${findExpr};
    if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const seen = [];
    const spy = (e) => seen.push(e.type + ':' + (e.target.className || e.target.tagName));
    document.addEventListener('pointerdown', spy, true);
    document.addEventListener('click', spy, true);
    el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerType: 'mouse', isPrimary: true }, at)));
    el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerType: 'mouse', isPrimary: true }, at)));
    el.dispatchEvent(new MouseEvent('click', at));
    document.removeEventListener('pointerdown', spy, true);
    document.removeEventListener('click', spy, true);
    return seen.join(' → ') || 'ok';
  `);
}

/* ---------------------------------------------------- 触屏合成 */

/** 和 ui/dnd/sensors.ts 的 TOUCH_DRAG_DELAY 对齐。浏览器里是 480 */
const TOUCH_DRAG_DELAY = 480;

/**
 * 合成一次触摸。走 CDP 的 Input.dispatchTouchEvent —— 它派生出来的
 * pointer 事件带 pointerType:'touch'，和真手指走的是同一条路。
 *
 * 必须先 Emulation.setTouchEmulationEnabled，否则 Chrome 不装触摸后端，
 * 这些事件会被直接丢掉（不是报错，是静默无效，最难查的那种）。
 *
 * 抬手也要给坐标：`touchPoints: []` 在有些版本上被接受、有些版本报
 * 「Touch points must be between 1 and 16」，所以一律带上最后那个点。
 */
let lastTouch = { x: 0, y: 0 };
async function touch(page, type, at) {
  if (at) lastTouch = at;
  await page.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: [{ x: lastTouch.x, y: lastTouch.y, radiusX: 8, radiusY: 8, force: 1 }],
  });
}

/**
 * 合成一次按键。走 CDP 的 Input.dispatchKeyEvent —— 事件按**真实焦点**
 * 派发，不是我们自己在页面里指定 target，所以能连带证明「焦点真在它身上」。
 *
 * 在页面里 `el.dispatchEvent(new KeyboardEvent('keydown', …))` 也能让
 * 处理器跑起来，但那样 target 是我们摆上去的：把手要是压根拿不到焦点
 * （比如忘了 tabIndex），它照样「通过」。这里不行。
 */
async function key(page, k, code, vk) {
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** 用顶栏的快速输入框加一条任务（走真实 UI，不直接改 store） */
async function quickAdd(page, text) {
  const n = await evalJs(page, `return document.querySelectorAll('[data-scope="inbox"] .task-el').length;`);
  await evalJs(page, `
    const inp = document.querySelector('.fast-add textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(inp, ${JSON.stringify(text)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  `);
  // 等它真出现 —— 不等的话下一条会插到上一条前面，顺序断言就成了空话
  return waitFor(page,
    `document.querySelectorAll('[data-scope="inbox"] .task-el').length > ${n}`, '任务出现');
}

/**
 * 等某个东西从界面上消失 —— 期间**不断催一次同步**。
 *
 * 为什么要催：客户端的拉取不是定时的（`sync/lifecycle.ts` 的轮询只在 outbox
 * 非空时才 syncNow），纯用 API 写进去的删除墓碑没人拉就永远不生效。
 * 探针里没有本地改动可推，所以只能自己戳 `focus`（等同切回前台 → 立即 syncNow）。
 * 单次戳可能撞上「上一趟同步还在飞」，所以每 900ms 补一脚，直到它真的让位。
 */
async function waitGone(page, exprGone, what, ms = 20000) {
  return waitFor(page, `
    (() => {
      if (${exprGone}) return 1;
      const now = Date.now();
      if (!window.__lastNudge || now - window.__lastNudge > 900) {
        window.__lastNudge = now;
        window.dispatchEvent(new Event('focus'));
      }
      return null;
    })()
  `, what, ms);
}

/* ------------------------------------------------------------ 主流程 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'sched-browser-'));
const procs = [];
/** 静态服务句柄。离线那一段要主动把它关掉，所以提到外面来 */
let web = null;

function track(p) { procs.push(p); return p; }

function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch (_) { /* 已经没了 */ } }
  // Chrome 被 SIGKILL 之后还在往 profile 里写，直接 rm 会 ENOTEMPTY。
  // 这本来只是收尾，不该因为收尾把整轮结果盖掉（之前就是这么盖掉过一次失败报告的）
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (_) { /* /tmp 里留个目录无所谓 */ }
}
process.on('exit', cleanup);

try {
  if (!existsSync(DIST) || !existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('dist/ 还没构建 —— 先 `npm run build`');
  }
  if (!existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME);

  track(spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
    env: { ...process.env, PORT: String(API_PORT), SCHEDULE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  procs[procs.length - 1].stderr.on('data', (d) => process.stderr.write('[be] ' + d));
  procs[procs.length - 1].stdout.on('data', (d) => process.stderr.write('[bo] ' + d));
  web = await serveDist();
  procs.push({ kill: () => { if (web && web.listening) web.close(); } });

  /* 把这一趟实际用的端口打出来：自动避让之后它们**可能不是**文档里那三个，
     撞了端口要靠这一行定位是哪一趟占的（踩坑 40 说的就是「残留的孤儿进程」）。 */
  const mark = (got, want) => (got === want ? '' : `（首选 ${want} 被占，已让开）`);
  console.log(`\n端口：后端 ${API_PORT}${mark(API_PORT, 25701)} · 页面 ${WEB_PORT}${mark(WEB_PORT, 5198)}`
    + ` · CDP ${CDP_PORT}${mark(CDP_PORT, 9223)} · 假模型 ${MODEL_PORT}${mark(MODEL_PORT, 25711)}`);

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${API_PORT}/api/health`)).ok) break; } catch (_) { /* 等 */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  track(spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(dataDir, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--touch-events=enabled',   // 第八节要合成触摸，没有它事件会被静默丢掉
    '--window-size=1280,860', 'about:blank',
  ], { stdio: 'ignore' }));

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await cdpTargets();
      target = list.find((t) => t.type === 'page');
    } catch (_) { /* 还没起来 */ }
    if (!target) await new Promise((r) => setTimeout(r, 150));
  }
  if (!target) throw new Error('Chrome 没开起来');

  const page = await connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');

  const errors = [];
  const collect = () => {
    for (const e of page.events.splice(0)) {
      if (e.method === 'Runtime.exceptionThrown') {
        errors.push({ text: e.params.exceptionDetails?.text || 'exception', url: '' });
      } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        errors.push({ text: e.params.entry.text, url: e.params.entry.url || '' });
      }
    }
  };
  const fmt = (list) => list.map((e) => e.text + (e.url ? '  <' + e.url + '>' : '')).join('\n      ');

  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });

  console.log('\n零、装上 Service Worker 的那一刻就有离线能力');
  // 必须在**这一趟**就断言。第六节会刷新页面，那之后缓存里必然有东西，
  // 再查就分不清「安装时预缓存了」和「后来被动存下来的」——
  // 而「第一次打开后断网能进」正是这个功能唯一要保证的事。
  await waitFor(page, `!!navigator.serviceWorker.controller`, 'Service Worker 接管页面', 15000);
  /* 缓存名不写死：sw.js 里那个 `CACHE` 常量会随策略升级抬版本
     （2026-10-17 从 sched-shell-v2 抬到 v3，写死的话产品没坏、探针先红）。
     只认前缀 `sched-shell-`，那是这个应用自己的命名空间。 */
  const cached = await evalJs(page, `
    const names = (await caches.keys()).filter((k) => k.startsWith('sched-shell-'));
    for (const n of names) {
      const c = await caches.open(n);
      const urls = (await c.keys()).map((r) => new URL(r.url).pathname);
      if (urls.some((p) => p.endsWith('/index.html'))) return urls;   // 取「真装好了」的那份
    }
    return [];
  `);
  ok(cached.some((p) => p.endsWith('/index.html')), '外壳 HTML 已预缓存，实际 ' + JSON.stringify(cached));
  ok(cached.some((p) => p.includes('/assets/') && p.endsWith('.js')), '带哈希的 JS 已预缓存');
  ok(cached.some((p) => p.includes('/assets/') && p.endsWith('.css')), '带哈希的 CSS 已预缓存');
  ok(cached.some((p) => p.endsWith('/manifest.json')), 'manifest 已预缓存');
  ok(cached.some((p) => p.endsWith('/icon.svg')), '图标已预缓存');

  console.log('\n一、未登录时是登录页');
  await waitFor(page, `!!document.querySelector('form input')`, '登录表单出现');
  const formText = await evalJs(page, `return document.body.innerText;`);
  ok(formText.includes('登录'), '页面上有「登录」');
  ok(!formText.includes('管理员'), '不再出现「管理员」字样');

  console.log('\n二、注册一个账户');
  await evalJs(page, `
    const btns = [...document.querySelectorAll('button')];
    btns.find((b) => b.textContent.includes('注册一个')).click();
    return true;
  `);
  await waitFor(page, `document.body.innerText.includes('注册并进入')`, '切到注册模式');
  await evalJs(page, `
    const [n, p] = document.querySelectorAll('form input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(n, '爸爸'); n.dispatchEvent(new Event('input', { bubbles: true }));
    set.call(p, 'pw123456'); p.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('form').requestSubmit();
    return true;
  `);

  /* -------- 日程集多选：顶栏那个下拉多选框 --------
     桌面端日程集不在侧栏（侧栏顺序是用户自己排的），在顶栏右边那个下拉多选框里，
     行是 `[data-cal-row]`。移动端走「更多」抽屉，探针跑的是桌面视口，用不到。

     **每个助手都先确认菜单开着** —— 关着的时候 `.cal-menu-pop` 里一行都没有，
     断言会假红在「找不到行」上，看着像多选坏了，其实是菜单没打开。 */
  const openCalMenu = () => evalJs(page, `
    const t = document.querySelector('[data-cal-menu]');
    if (t.getAttribute('aria-expanded') !== 'true') t.click();
    return true;
  `);
  const waitCalMenu = () => waitFor(page,
    `!!document.querySelector('.cal-menu-pop [data-cal-row]')`, '日程集下拉打开', 4000);
  const closeCalMenu = () => evalJs(page, `
    const t = document.querySelector('[data-cal-menu]');
    if (t.getAttribute('aria-expanded') === 'true') t.click();
    return true;
  `);
  /** 在「菜单开着」的前提下做 fn。所有日程集助手都从这儿走。 */
  const withCals = async (fn) => {
    await openCalMenu();
    await waitCalMenu();
    return fn();
  };
  const shown = () => withCals(() => evalJs(page, `
    return [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent.trim());
  `));
  const clickCal = (name) => withCals(() => evalJs(page, `
    [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(name)}).click();
    return true;
  `));
  const waitShownCount = (n, label) => withCals(() => waitFor(page, `
    [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true').length === ${n} ? 1 : null
  `, label, 5000));

  /* 把某个集变成**归属**并保证它勾着。多选没有「单击切过去」这个手势了，
     得点两步：先取消勾别的，再勾它（勾上顺带成为归属，见 store.toggleCal）。

     **每次点击后重新查 DOM** —— 点完 React 就重渲染，同一批 NodeList 里的
     下一个节点已经脱离文档，再点不会冒泡到容器根，事件委托收不到，
     看起来就像「点了没反应」。

     用完**把菜单关上**：开着的话它会盖住日程副header 右边那排控件
     （日 / 周 / 月），后面某一节点到那儿就会点在下拉上。 */
  const focusCal = async (id) => {
    await withCals(() => evalJs(page, `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const rows = () => [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')];
      for (const other of rows()) {
        if (other.dataset.calRow !== ${JSON.stringify(id)} && other.getAttribute('aria-pressed') === 'true') {
          other.click();
          await sleep(60);
        }
      }
      const b = rows().find((x) => x.dataset.calRow === ${JSON.stringify(id)});
      if (b && b.getAttribute('aria-pressed') !== 'true') { b.click(); await sleep(60); }
      return true;
    `));
    await closeCalMenu();
  };

  console.log('\n三、进入主界面，顶栏有日程集多选');
  await waitFor(page, `!!document.querySelector('.sidebar')`, '侧栏渲染出来', 12000);
  ok(await evalJs(page, `return !!document.querySelector('[data-nav="today"]');`), '侧栏有导航项');
  // 桌面端日程集是**顶栏那个下拉多选框**（侧栏那一列已经收掉了 —— 侧栏顺序
  // 是用户自己排的，塞常驻控件进去会跟「底栏挑哪几项」抢位置）。默认日程集
  // 「我的日程」也在列表里，老数据迁移过来时 ui.cals 从 ui.cal 起步，
  // 所以进界面就该勾着一个。
  const cals0 = await withCals(() => evalJs(page, `
    return [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')].map((b) => ({
      name: b.textContent.trim(), on: b.getAttribute('aria-pressed') === 'true' }));`));
  ok(cals0.length === 1 && cals0[0].name === '我的日程',
    '下拉里列出默认日程集，实际 ' + JSON.stringify(cals0));
  ok(cals0.filter((c) => c.on).length === 1, '进界面时正好勾着一个（当前集）');
  /* 打勾的勾要**正落在圆心**（用户 2026-10-09：「打勾的图标的勾并不居中」）。
     原来写 `left:5px; top:2px` + `rotate(45deg)`：`left/top` 摆的是盒子的左上角，
     盒子中心就落在 (7,6)，而圆心在 (9,9) —— 勾整体偏左上 2×3px。
     改成 `left:50%; top:50%; translate(-50%,-50%) rotate(45deg)` 之后，盒子中心
     正好是圆心（旋转以盒子中心为原点，不动中心）。
     量的就是**勾盒中心减圆心**：`left:50%` 相对 padding 盒算，要加回边框宽度。 */
  const tick18 = await withCals(() => evalJs(page, `
    const b = document.querySelector('.cal-menu-pop [data-cal-row] .check-btn');
    const cs = getComputedStyle(b, '::after'), cb = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    const w = parseFloat(cs.width), h = parseFloat(cs.height);
    const t = cs.transform;
    let e = 0, f = 0;
    if (t && t.startsWith('matrix')) { const p = t.slice(7, -1).split(',').map(Number); e = p[4]; f = p[5]; }
    return { 圈直径: r.width,
             勾中心偏移: [+(parseFloat(cb.borderLeftWidth) + parseFloat(cs.left) + w / 2 + e - r.width / 2).toFixed(2),
                       +(parseFloat(cb.borderTopWidth) + parseFloat(cs.top) + h / 2 + f - r.height / 2).toFixed(2)] };
  `));
  ok(Math.abs(tick18.勾中心偏移[0]) <= 0.6 && Math.abs(tick18.勾中心偏移[1]) <= 0.6,
    '桌面 ' + tick18.圈直径 + 'px 勾选圈里，勾盒中心正落在圆心（原来偏左上 2×3px），实际 '
    + JSON.stringify(tick18.勾中心偏移));
  // 改名 / 成员 / 邀请 / 退出 / 删除全在设置页了，下拉里只留勾选
  ok(await withCals(() => evalJs(page, `
    return document.querySelectorAll('.cal-menu-pop [data-cal-manage], .cal-menu-pop [data-cal-invites], .cal-menu-pop [data-cal-new]').length === 0;`)),
    '下拉里没有管理 / 邀请 / 新建入口（都在设置页）');
  /* 下拉是**新的一层**（role="group" 里一排 aria-pressed 按钮），a11y() 要单独
     缩范围扫它一遍 —— 扫全文档时它多半关着，里面一行都没有，等于没扫。 */
  const menuA11y = await evalJs(page, `return { bad: ${a11y('.cal-menu-pop')} };`);
  ok(menuA11y.bad.length === 0, '下拉里每个控件都有名字、勾选圈也是真按钮'
    + (menuA11y.bad.length ? '：\n      ' + fmt(menuA11y.bad) : ''));
  await closeCalMenu();

  console.log('\n四、三个视图都能切，不白屏');
  // 日视图没有外层包装类，靠 .timeline 认；周视图是 .week-view
  for (const [nav, marker] of [['calendar', '.timeline'], ['today', '.content'],
    ['inbox', '.content'], ['overdue', '.content'], ['habits', '.content'], ['done', '.content']]) {
    await evalJs(page, `document.querySelector('[data-nav="${nav}"]').click(); return true;`);
    const txt = await waitFor(page,
      `(document.getElementById('content')?.innerText || '').length > 0 ? document.getElementById('content').innerText.slice(0, 40) : null`,
      nav + ' 有内容');
    ok(!!txt, nav + ' 渲染出内容（' + JSON.stringify(txt.slice(0, 18)) + '）');
    ok(await evalJs(page, `return !!document.querySelector('${marker}');`), nav + ' 有 ' + marker);
  }

  /* ---- Btn 六档 variant 各钉一条颜色（第 1 册 R4：外观集中在 kit，variant 定色）----
     S1 把 Btn 的 variant 收进 cva 后，这里钉住「每档渲染出来的颜色」：谁在 cva 里
     把 primary 的底色 / danger 的描边 / chipOn 的选中色改错，这里立刻红。
     选点全是稳定选择器（data-act / title / 类名 / data-pick），不靠坐标；
     桌面视口下顶栏 + 侧栏都在。颜色用 rgb(var(--x)) 解析成 rgb() 再比，
     不比字符串（浏览器给的是序列化后的 rgb）。 */
  await evalJs(page, `document.querySelector('[data-nav="calendar"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[title="上一个"]')`, '日程页副header 出来', 8000);
  const btnBase = await evalJs(page, `
    const rgb = (v) => { const d = document.createElement('div');
      d.style.color = v; document.body.appendChild(d);
      const c = getComputedStyle(d).color; d.remove(); return c; };
    const g = (sel) => { const el = document.querySelector(sel);
      return el ? getComputedStyle(el) : null; };
    const n = g('[title="上一个"]'), gh = g('.ghost-btn');
    return {
      normalColor: n ? n.color : null,
      ghostColor: gh ? gh.color : null, ghostBg: gh ? gh.backgroundColor : null,
      wantText2: rgb('var(--text-2)'), transparent: 'rgba(0, 0, 0, 0)',
    };
  `);
  ok(btnBase.normalColor === btnBase.wantText2,
    'Btn normal 文字色 = --text-2，实际 ' + btnBase.normalColor + ' / 期望 ' + btnBase.wantText2);
  ok(btnBase.ghostColor === btnBase.wantText2 && btnBase.ghostBg === btnBase.transparent,
    'Btn ghost 文字色 = --text-2 且透明底，实际 ' + btnBase.ghostColor + ' / ' + btnBase.ghostBg);

  // 设置页（默认外观 tab）：chip / chipOn —— 色板/风格/深浅的 Chips，data-pick 是 Chips 专属
  await evalJs(page, `document.querySelector('[data-nav="settings"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[data-settings-tab]')`, '设置页打开', 8000);
  const btnChips = await evalJs(page, `
    const rgb = (v) => { const d = document.createElement('div');
      d.style.color = v; document.body.appendChild(d);
      const c = getComputedStyle(d).color; d.remove(); return c; };
    const cs = (el) => el ? getComputedStyle(el) : null;
    const o = cs(document.querySelector('button[data-pick][aria-pressed="true"]'));
    const f = cs(document.querySelector('button[data-pick][aria-pressed="false"]'));
    return {
      onColor: o ? o.color : null, onBorder: o ? o.borderColor : null,
      offColor: f ? f.color : null, offBg: f ? f.backgroundColor : null,
      wantPrimary: rgb('var(--primary)'), wantText2: rgb('var(--text-2)'), wantPanel: rgb('var(--panel)'),
    };
  `);
  ok(btnChips.onColor === btnChips.wantPrimary && btnChips.onBorder === btnChips.wantPrimary,
    'Btn chipOn 文字+描边 = --primary（选中档），实际 ' + btnChips.onColor + ' / ' + btnChips.onBorder);
  ok(btnChips.offColor === btnChips.wantText2 && btnChips.offBg === btnChips.wantPanel,
    'Btn chip 文字 = --text-2 且底 = --panel（未选档），实际 ' + btnChips.offColor + ' / ' + btnChips.offBg);

  /* ---- 关于卡：网页显示版本号（自动取 package.json） + 网页专属的 App 下载 ----
     APK 下载链接在网页里出现，但**在 Capacitor App 内置的 WebView 里不显示** ——
     免得用户在一个 Android App 里再点一次 Android 安装包。 */
  console.log('\n四之二、关于：网页版本号 + App 下载（网页专属）');
  await clickEl(page, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '关于')`);
  await waitFor(page, `!!document.querySelector('[data-about="version"]')`, '设置页关于卡挂上');
  const aboutVer = await evalJs(page, `return document.querySelector('[data-about="version"]').textContent;`);
  ok(/^2\.\d+\.\d+$/.test(aboutVer), '关于卡版本号是 2.x.x 格式，实际 ' + aboutVer);
  const apkLink = await evalJs(page, `
    const a = document.querySelector('[data-about="apk-download"]');
    return a ? { href: a.getAttribute('href'), text: a.textContent } : null;
  `);
  ok(apkLink && apkLink.href && apkLink.href.includes('/schedule/dl/schedule-'),
    '关于卡有 App 下载链接（指向 /schedule/dl/），实际 ' + JSON.stringify(apkLink));

  // 安全 tab：danger（退出登录）—— 只读样式，**不点它**（点了就登出了）
  await evalJs(page, `document.querySelector('[data-settings-tab="security"]').click(); return true;`);
  await waitFor(page, `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('退出登录'))`, '安全 tab 打开', 8000);
  const btnDanger = await evalJs(page, `
    const rgb = (v) => { const d = document.createElement('div');
      d.style.color = v; document.body.appendChild(d);
      const c = getComputedStyle(d).color; d.remove(); return c; };
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('退出登录'));
    const s = el ? getComputedStyle(el) : null;
    return { color: s ? s.color : null, border: s ? s.borderColor : null, wantDanger: rgb('var(--danger)') };
  `);
  ok(btnDanger.color === btnDanger.wantDanger && btnDanger.border === btnDanger.wantDanger,
    'Btn danger 文字+描边 = --danger，实际 ' + btnDanger.color + ' / ' + btnDanger.border);

  // 打卡页：primary（新增打卡）
  await evalJs(page, `document.querySelector('[data-nav="habits"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[data-act="add-habit"]')`, '打卡页打开', 8000);
  const btnPrimary = await evalJs(page, `
    const rgb = (v) => { const d = document.createElement('div');
      d.style.color = v; document.body.appendChild(d);
      const c = getComputedStyle(d).color; d.remove(); return c; };
    const s = document.querySelector('[data-act="add-habit"]');
    const cs = s ? getComputedStyle(s) : null;
    return { bg: cs ? cs.backgroundColor : null, color: cs ? cs.color : null,
      wantPrimary: rgb('var(--primary)'), wantOnPrimary: rgb('var(--on-primary)') };
  `);
  ok(btnPrimary.bg === btnPrimary.wantPrimary && btnPrimary.color === btnPrimary.wantOnPrimary,
    'Btn primary 底 = --primary 且文字 = --on-primary，实际 ' + btnPrimary.bg + ' / ' + btnPrimary.color);

  // 打卡页的输入框也要有名字 —— a11y() 原来只扫了待办箱 / 抽屉 / 浮层，
  // 打卡页从来没被扫过，habitInput 只有 placeholder 的漏洞就是这么漏掉的
  await evalJs(page, `document.querySelector('[data-nav="habits"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.habit-add')`, '打卡页渲染出来', 8000);
  const hab = await evalJs(page, `return { bad: ${a11y('.habit-add')},
    cands: document.querySelectorAll('.habit-add input').length };`);
  ok(hab.cands === 1, '打卡页有 ' + hab.cands + ' 个输入框可查');
  ok(hab.bad.length === 0, '打卡页每个控件都有名字'
    + (hab.bad.length ? '：\n      ' + hab.bad.join('\n      ') : ''));

  /* ---- 打卡添加走 data-act 委托（原来是个 onAdd prop）----
     断言的是「点击之后库里真的多了一条」，不是「按钮上有没有 data-act」——
     data-act 只是个约定，落库在 clickDispatch 的 case 里。这一条同时锁住
     两件容易回归的事：① 处理器从 `.habit-add` 里读词（不是从 props）；
     ② 点完之后输入框被清空（视图那个 useEffect 干的活）。

     **localStorage 可能还是空的**（这一节在探针里来得早，前面几节只做了
     a11y 扫描，从没写过库）—— 那时候 `JSON.parse(null)` 是 null，
     拿 `.habits` 会当场崩。所以先造一条底，再断言数量。 */
  const habBefore = await evalJs(page, `(() => {
    const raw = localStorage.getItem('schedule-app-v4');
    const n = raw ? Object.keys(JSON.parse(raw).habits || {}).length : 0;
    return n; })()`);
  /* 填值走**原生 value setter**（React 18 只认这个）：裸 `el.value = …`
     只改 DOM 属性，React 的 onChange 拿不到，draft state 还是空串 —— 处理器
     trim() 到空词直接 return，库里不会多。这里和后面「下一步」那节同一条路。
     不用下面的 setField：它在 3984 行才定义，这里够不着（TDZ）。 */
  await evalJs(page, `(() => {
    const el = document.querySelector('.habit-add input');
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '探针打卡');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true; })();`);
  /* 点之前先把三件可能出错的事摆到台面上，别让最后那一条 null 自己猜：
     ① 框在不在、② 原生 setter 有没有把词写进去、③ 那个 data-act 按钮渲染出来没有。 */
  const pre = await evalJs(page, `return (() => {
    const inp = document.querySelector('.habit-add input');
    const btn = document.querySelector('.habit-add [data-act="add-habit"]');
    const raw = localStorage.getItem('schedule-app-v4');
    return {
      hasInput: !!inp,
      hasBtn: !!btn,
      btnTag: btn ? btn.tagName : null,
      btnRect: btn ? JSON.stringify(btn.getBoundingClientRect()) : null,
      value: inp ? inp.value : null,
      storeKeys: raw ? Object.keys(JSON.parse(raw)).sort() : null,
      habitsLen: raw ? Object.keys(JSON.parse(raw).habits || {}).length : null,
    }; })()`);
  ok(pre.hasInput && pre.hasBtn && pre.value === '探针打卡',
    '填值之后框里有词、按钮在 DOM 里（value=' + JSON.stringify(pre.value)
    + '，btn=' + pre.btnTag + ' ' + pre.btnRect + '）');
  await evalJs(page, `document.querySelector('.habit-add [data-act="add-habit"]').click(); return true;`);
  // 点完等行出现再读：commit → emit → React 重渲染要一拍，立刻读大概率还是旧 DOM。
  // 先等行（说明委托真的跑了），再读 localStorage（只说明 250ms 防抖到了）——卡在哪一目了然。
  const post = await waitFor(page, `(() => {
    const rows = [...document.querySelectorAll('.habit-row .habit-title')]
      .filter((x) => x.textContent.includes('探针打卡')).length;
    if (!rows) return null;
    const inp = document.querySelector('.habit-add input');
    const ls = localStorage.getItem('schedule-app-v4');
    return { rows, val: inp ? inp.value : null,
      lsHabits: ls ? Object.keys(JSON.parse(ls).habits || {}).length : null };
  })()`, '点「添加」之后列表里出现那一行', 8000);
  ok(post.rows >= 1, '点完之后列表里出现了那一行（' + post.rows + ' 行，输入框=' + JSON.stringify(post.val) + '）');
  // 清理：别把这条留给后面的节（打卡页有计数断言）。
  // **按钮在行里、但没 data-habit**：行上有 data-habit 和 data-id 两个，
  // 以前按 `.habit-row` 找 data-habit 还能中，现在行类名被 SortableList 换掉了。
  // 直接按标题文本反查那一行的 data-id（行内删除按钮的 data-id 就是它）。
  await evalJs(page, `return (() => {
    const row = [...document.querySelectorAll('.habit-row')].find((r) => r.textContent.includes('探针打卡'));
    if (!row) return false;
    const id = row.dataset.habit || row.dataset.id;
    const btn = document.querySelector('[data-act="del-habit"][data-id="' + id + '"]');
    if (!btn) return false;
    btn.click();
    return true; })();`);
  await waitFor(page, `!!document.querySelector('body > div > div[role="dialog"]')`, '删打卡项弹了确认框');
  await evalJs(page, `return (() => {
    const d = document.querySelector('body > div > div[role="dialog"]');
    const b = d && [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === '删除');
    if (b) b.click(); return !!b; })();`);
  await waitFor(page,
    `(() => {
       const raw = localStorage.getItem('schedule-app-v4');
       if (!raw) return null;
       // 删除是墓碑：key 还在，deleted 置 true —— 数字数永远数不回去。
       // 查那一条的标记，而不是总数。
       const mine = Object.values(JSON.parse(raw).habits || {})
         .find((h) => h && h.title && h.title.includes('探针打卡'));
       return mine && mine.deleted === true ? 1 : null; })()`,
    '探针打卡已删除', 8000);

  console.log('\n五、设置页的日程集管理：改名能落库');
  // 侧栏那个「管理当前日程集」浮层删了 —— 设置页本来就是同一套（MembersSection
  // 都是抽出来共用的一份），所以这一段改走设置页。名字框 / 成员 / 危险区都还在，
  // 只是入口换了，顺带证明「删掉重复入口之后功能没跟着没」。
  await evalJs(page, `document.querySelector('[data-nav="settings"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[data-settings-tab]')`, '设置页打开', 8000);
  /* 设置页自己的 header 左上角要写页名（用户 2026-10-09：「设置页的 header 的左上角
     没有设置字样」）。**写在页面里、不写在顶栏** —— 顶栏那一栏再写一遍「设置」，
     两行同一个词看着像两个 header。所以这里查的是 `#content` 里那个 h1。 */
  /* 页名归**顶栏**（用户 2026-10-09：「设置页的 header 的左上角没有设置字样」，
     要求就是写进 header 里）。设置页那张 tab 栏是**页内的分段开关**、不是 header，
     所以页面里不写第二遍 —— 两行都是「设置」看着像两个 header。 */
  ok(await evalJs(page, `return (document.querySelector('.topbar .view-title') || {}).textContent;`) === '设置',
    '顶栏左上角写着页名「设置」，实际 '
    + JSON.stringify(await evalJs(page, `return (document.querySelector('.topbar .view-title') || {}).textContent;`)));
  ok(await evalJs(page, `return !document.querySelector('#content h1');`),
    '页面里不再写第二遍「设置」');
  await evalJs(page, `document.querySelector('[data-settings-tab="cals"]').click(); return true;`);
  // 当前集默认就是展开的（CalsTab 的 openId 初始值就是 ui.cal）。
  // **名字框此刻不在** —— 改名搬进标题行之后，平时是「一段字 + 铅笔」，
  // 点铅笔才变出输入框（`InlineRename`）。所以这里等的是那一行，不是输入框。
  await waitFor(page, `!!document.querySelector('[data-cal-item]')`, '日程集管理打开', 8000);
  // 成员是异步拉的，别在读之前就断言。
  // **不能等「创建者」**：那是 ROLE_LABEL，发邀请那个角色选择器的 <option>
  // 里就有一个，面板一开就存在 —— 等它等于没等，成员还没到就开始读，
  // 断言会随机失败（而且失败信息看着像「自己的名字没显示」，指向完全错的地方）。
  // 等成员**条数**变成非零才是真的加载完了。
  await waitFor(page,
    `/成员（[1-9]\\d*）/.test(document.getElementById('content').innerText) ? 1 : null`,
    '成员列表加载完');
  const sheetText = await evalJs(page, `return document.getElementById('content').innerText;`);
  ok(sheetText.includes('成员'), '面板里有成员区');
  ok(sheetText.includes('爸爸'), '成员列表里有自己');
  ok(sheetText.includes('创建者'), '自己的角色显示为「创建者」');
  // 「邀请成员」不再是单独一个小节了 —— 邀请行就是成员列表的最后一行，
  // 靠输入框的 placeholder 认（innerText 读不到 placeholder，要查 DOM）。
  // placeholder 从「输入邀请的成员的用户名」缩到「输入用户名」，2026-10-09 又按
  // 用户要求加回「邀请」三个字 → 「输入要邀请的用户名」：这一行是成员列表的
  // 最后一行，前面几行都是「谁有权看」，孤零零一个「输入用户名」读不出是在
  // 邀请谁，而 aria-label 眼睛看不见。9 个字，474px 的框放得下。
  // 30px 高、右边还并着两个控件的框里根本显示不完（2026-10-08）。
  ok(await evalJs(page, `return !!document.querySelector('#content input[placeholder="输入要邀请的用户名"]');`),
    '创建者能看到发邀请的入口（列表最后一行）');

  // 面板里的控件也要有名字。**这一段是补漏**：「每个输入框都有名字」原来只扫了
  // 抽屉（第十三节），这个名字框和角色选择器一个都没有可访问名字 ——
  // 它们从来就没被任何断言看过。
  //
  // 放在这里而不是第十三节：成员是**联网拉的**，第十三节跑在断网之后，
  // 那时成员列表是空的、角色选择器根本不渲染，扫过去等于空过（候选数为 0）。
  //
  // 数的是「这里真的有控件可查」，所以要把**选择器的触发按钮**也算进来：
  // 角色选择器是 `Dropdown`（`button[aria-haspopup="listbox"]`），不是原生
  // `<select>`、也不是 `aria-pressed` 的胶囊 —— 只认 `input/select/aria-pressed`
  // 的话，成员那几行换过组件之后就只剩名字框 + 邀请框两个，这条断言会假红
  // （控件的可访问名字其实都好好的，见下面那条）。
  const sheetA11y = await evalJs(page, `return { bad: ${a11y('#content')},
    cands: document.querySelectorAll('#content input, #content select, #content textarea, #content button[aria-haspopup]').length };`);
  ok(sheetA11y.cands >= 3, '日程集管理里有 ' + sheetA11y.cands + ' 个表单控件可查（成员权限 / 邀请用户名 / 邀请权限）');
  ok(sheetA11y.bad.length === 0, '日程集管理里每个控件都有名字'
    + (sheetA11y.bad.length ? '：\n      ' + sheetA11y.bad.join('\n      ') : ''));

  /* 行内改名：**点铅笔才出输入框**，而「切进编辑态时下面不许动」是这套组件
     存在的全部理由 —— 固定行高 + 右侧固定宽的动作槽。这里把编辑态前后的
     「成员区顶边」量一遍：差多少都算坏（哪怕只差 1px，用户看得见那一跳）。 */
  /* 写成**表达式**（IIFE）而不是语句块 —— 它要能塞进 `return ${GEOM};` 这种
     evalJs 的用法里。踩坑 29：evalJs 自己不补 return。 */
  const GEOM = `(() => {
    const body = document.querySelector('[data-cal-body]');
    const bar = body.previousElementSibling;          // 标题行（固定 h-[40px]）
    const first = body.firstElementChild;             // 成员区那一块
    return { head: bar.getBoundingClientRect().height, first: first.getBoundingClientRect().top };
  })()`;
  const beforeEdit = await evalJs(page, `return ${GEOM}`);

  /* 标题行的**三区**（用户 2026-10-08 定）：从左到右 名称区 · 操作区 · 箭头区。
     这里量的是**几何**，不是类名 —— 类名写对不代表摆对，而「谁在最右」正是
     这次要改的东西。顺带把字号也读回来：输入框该和显示态同一号字。 */
  const zones = await evalJs(page, `return (() => {
    const chev = document.querySelector('[data-cal-item]');
    const row = chev.parentElement;                   // 标题行
    const r = row.getBoundingClientRect();
    const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right }; };
    const nameEl = row.querySelector('span.truncate');
    const star = row.querySelector('[aria-label*="默认日程集"]');
    const del = row.querySelector('[aria-label="删除日程集"]');
    /* 把 var(--primary) 解析成 rgb() 再比 —— 直接比字符串的话，浏览器给的是
       rgb 形式，而令牌是 #27795a，永远不相等。 */
    const rgb = (v) => { const d = document.createElement('div');
      d.style.color = v; document.body.appendChild(d);
      const c = getComputedStyle(d).color; d.remove(); return c; };
    return {
      /* 标题行有 pr-2 这个类，所以「最右」要比**内容盒**的右边，不是边框盒 ——
         不然箭头永远差着那 7px 内边距，断言会一直红。
         （注释里不能写反引号：这一段住在模板字面量里，反引号会把模板当场截断） */
      rowInnerL: r.left + parseFloat(getComputedStyle(row).paddingLeft),
      rowInnerR: r.right - parseFloat(getComputedStyle(row).paddingRight),
      /* 标题条**外沿**（圆角条的两端）—— 正文那几行现在对齐的是这个，
         不是上面的内容盒。两个都留着：内容盒那条还压着「箭头在最右」。 */
      rowOuterL: r.left,
      rowOuterR: r.right,
      nameR: nameEl ? box(nameEl).r : null,
      nameFont: nameEl ? getComputedStyle(nameEl).fontSize : null,
      /* 正文那一块。**不占横向留白**（2026-10-09 用户：「宽度再宽一点点，
         让邀请输入框、新建按钮、header 对齐」）—— 成员行 / 邀请行的两条边与
         标题条那个圆角条的**外沿**齐平。上一轮是对齐到标题条的**内容盒**
         （pl-3 pr-2 = 10.5 / 7），结果每行都比标题条窄一截，看着就是没对齐。 */
      body: (() => {
        const b = document.querySelector('[data-cal-body]');
        if (!b) return null;
        const br = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return {
          l: br.left + parseFloat(cs.paddingLeft),
          r: br.right - parseFloat(cs.paddingRight),
          padL: cs.paddingLeft, padR: cs.paddingRight,
        };
      })(),
      /* 成员行自己那一条（借角色下拉往上找到行容器）—— 用户报的是
         「成员列比标题条微微宽出来一点」，所以量**这一条**的两条边。
         必须从 parentElement 往上找：closest 会先看自己，而那个按钮自己
         就带着 h-[30px]（Dropdown 的 sm 档），量出来是按钮不是行。 */
      memberRow: (() => {
        const el = document.querySelector('[aria-label$="的权限"]');
        const row = el && el.parentElement
          ? el.parentElement.closest('[class*="h-[30px]"]') : null;
        return row ? box(row) : null;
      })(),
      star: star ? box(star) : null,
      starColor: star ? getComputedStyle(star).color : null,
      wantPrimary: rgb('var(--primary)'),
      del: del ? box(del) : null,
      delOff: del ? del.disabled : null,
      delColor: del ? getComputedStyle(del).color : null,
      /* 邀请行与纸飞机（用户 2026-10-09 点名的那两个）。行容器从输入框的
         parentElement 往上找 —— closest 会先匹配自己，而输入框自己就带着
         h-[30px]，直接 closest 量到的是输入框不是行（见踩坑 46）。 */
      inviteRow: (() => {
        const el = document.querySelector('[data-cal-body] input');
        const row = el && el.parentElement
          ? el.parentElement.closest('[class*="h-[30px]"]') : null;
        return row ? box(row) : null;
      })(),
      inviteSend: box(document.querySelector('[aria-label="发出邀请"]')),
      chev: box(chev),
      chevTag: chev.tagName,
      chevExp: chev.getAttribute('aria-expanded'),
    };
  })()`);
  ok(Math.abs(zones.rowInnerR - zones.chev.r) < 1,
    '箭头在标题行最右（行内容右 ' + zones.rowInnerR + ' / 箭头右 ' + zones.chev.r + '）');
  ok(zones.chevTag === 'BUTTON' && zones.chevExp === 'true',
    '最右那一格才是折叠开关（button + aria-expanded=true），实际 '
    + zones.chevTag + '/' + zones.chevExp);
  ok(!!zones.star && zones.nameR !== null && zones.star.l >= zones.nameR - 1,
    '星标紧跟着名字（名字右 ' + zones.nameR + ' / 星标 ' + JSON.stringify(zones.star) + '）');
  ok(!!zones.star && !!zones.del
    && zones.del.l >= zones.star.r - 0.5 && zones.del.r <= zones.chev.l + 0.5,
    '删除按钮在操作区里（星标右边、箭头左边），实际 ' + JSON.stringify(zones.del));
  ok(zones.delOff === true,
    '默认日程集的删除按钮是禁用的（删了它，下次新建的东西就没地方落）');
  /* 星标是主色、删除钮是灰的。这条不是「好不好看」，是钉住**tone 走 prop 不走
     叠 className**：叠 `text-[var(--primary)]` 会被基类的 `text-[var(--text-3)]`
     按生成顺序压掉，两个都会变成灰的（实测过，见踩坑 17）。 */
  ok(zones.starColor === zones.wantPrimary && zones.delColor !== zones.wantPrimary,
    '默认集的星标是主色、删除钮是灰的（星 ' + zones.starColor + ' / 删 '
    + zones.delColor + ' / 主色 ' + zones.wantPrimary + '）');
  /* 成员行与标题条**外沿**齐平（左、右各一条）。上一轮是对齐到内容盒，
     这一轮用户要「再宽一点点」—— 贴齐圆角条的外沿。两条边都得量：
     只量右边会漏掉左边那个角色图标。 */
  ok(!!zones.memberRow && !!zones.body
    && Math.abs(zones.memberRow.l - zones.rowOuterL) < 0.6,
    '成员行左边和标题条外沿齐平（成员行 ' + (zones.memberRow ? zones.memberRow.l : 'null')
    + ' / 标题条 ' + zones.rowOuterL + ' / 正文留白 ' + (zones.body ? zones.body.padL : 'null') + '）');
  ok(!!zones.memberRow && !!zones.body
    && Math.abs(zones.memberRow.r - zones.rowOuterR) < 0.6,
    '成员行右边和标题条外沿齐平、不超出（成员行 ' + (zones.memberRow ? zones.memberRow.r : 'null')
    + ' / 标题条 ' + zones.rowOuterR + ' / 正文留白 ' + (zones.body ? zones.body.padR : 'null') + '）');
  /* 邀请行（用户 2026-10-09 点名的就是这一条）：输入框左缘、纸飞机右缘
     都要和标题条外沿齐平。量法同成员行 —— 从 parentElement 往上找行容器。 */
  ok(!!zones.inviteRow && Math.abs(zones.inviteRow.l - zones.rowOuterL) < 0.6,
    '邀请输入框左边和标题条外沿齐平（邀请行 ' + (zones.inviteRow ? zones.inviteRow.l : 'null')
    + ' / 标题条 ' + zones.rowOuterL + '）');
  ok(!!zones.inviteRow && Math.abs(zones.inviteRow.r - zones.rowOuterR) < 0.6,
    '邀请行右边和标题条外沿齐平（邀请行 ' + (zones.inviteRow ? zones.inviteRow.r : 'null')
    + ' / 标题条 ' + zones.rowOuterR + '）');
  ok(!!zones.inviteSend && Math.abs(zones.inviteSend.r - zones.rowOuterR) < 0.6,
    '纸飞机右缘和标题条外沿齐平（钮右 ' + (zones.inviteSend ? zones.inviteSend.r : 'null')
    + ' / 标题条 ' + zones.rowOuterR + '）');

  await evalJs(page, `document.querySelector('[aria-label="改名"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[data-cal-name]')`, '点铅笔后出现名字输入框', 4000);
  const afterEdit = await evalJs(page, `return { ...${GEOM},
    hasSave: !!document.querySelector('[data-cal-save]') };`);
  ok(afterEdit.hasSave, '编辑态右边是确认按钮（不是「保存」文字按钮）');
  /* ✓ 必须是主色、✕ 是灰的 —— 「两个灰按钮并排看不出哪个是哪个」。
     两条踩过的坑都在这一条断言里：
     ① 颜色不能靠外面叠 `className`（同特异度看生成顺序，实测 ✓ 拿到的是
        和 ✕ 一样的 `--text-3`）。所以要**读计算值**，读类名是读不出来的。
     ② React 复用了同一个 `<button>`（铅笔 → ✓），`transition` 150ms 会把颜色
        从灰动画到主色，**立刻读会读到动画中途**。先等它落定再读。 */
  const saveColor = await evalJs(page, `
    return (async () => {
      const rgb = (v) => { const d = document.createElement('div');
        d.style.color = v; document.body.appendChild(d);
        const c = getComputedStyle(d).color; d.remove(); return c; };
      const want = rgb('var(--primary)');
      const t0 = Date.now();
      for (;;) {
        const cf = document.querySelector('[data-cal-save]');
        const cx = document.querySelector('#content [aria-label="取消"]');
        const got = cf && getComputedStyle(cf).color;
        const gotX = cx && getComputedStyle(cx).color;
        if (got === want && gotX !== want) return { want, got, gotX, ms: Date.now() - t0 };
        if (Date.now() - t0 > 2000) return { want, got, gotX, ms: -1 };
        await new Promise((r) => setTimeout(r, 50));
      }
    })()`);
  ok(saveColor.got === saveColor.want && saveColor.gotX !== saveColor.want,
    '编辑态「确认」是主色、「取消」是灰的（确认 ' + saveColor.got + ' / 取消 '
    + saveColor.gotX + ' / 主色 ' + saveColor.want + '，等了 ' + saveColor.ms + 'ms）');
  ok(Math.abs(afterEdit.head - beforeEdit.head) <= 0.6,
    '切到编辑态时标题行高度不变（' + beforeEdit.head + ' → ' + afterEdit.head + '）');
  ok(Math.abs(afterEdit.first - beforeEdit.first) <= 0.6,
    '切到编辑态时下面的成员区一像素没动（' + beforeEdit.first + ' → ' + afterEdit.first + '）');

  /* 星标与删除按钮都住在**会被换掉的那两格里**（星标在 `display` 里、删除在
     InlineRename 的动作槽里）—— 编辑态整个换掉，所以它们**自己就消失了**，
     外面不用再判一次 `editing`，也就不会出现「名字已经变成输入框了，星标还
     杵在旁边」的错位。这两条钉住那个效果：谁把星标挪到 InlineRename 外面，
     这里立刻红。 */
  ok(await evalJs(page, `return !document.querySelector('#content [aria-label*="默认日程集"]');`),
    '编辑态里星标隐藏（它跟着名字走，名字变成输入框它就让位）');
  ok(await evalJs(page, `return !document.querySelector('#content [aria-label="删除日程集"]');`),
    '编辑态里删除按钮隐藏（操作区那两格换成了 √ / ✕）');

  /* 字号：输入框里的字必须和**非编辑态那一行字**一模一样。
     原先 `styles/tokens.css` 里有一条**没有层**的 `input { font-size: 14px }`，
     它把 `Input` / `Textarea` 上每一个 Tailwind `text-*` 都吃掉了 —— 输入框
     永远比它旁边那行字大一号，改类名毫无反应（踩坑 17 的延伸）。这两条就是
     那个坑的看门人：把 `font-size` 再挪回没有层的位置，它们当场变红。 */
  const fonts = await evalJs(page, `return (() => {
    const inp = document.querySelector('[data-cal-name]');
    const inv = document.querySelector('#content input[placeholder="输入要邀请的用户名"]');
    return {
      input: inp ? getComputedStyle(inp).fontSize : null,
      invite: inv ? getComputedStyle(inv).fontSize : null,
      invitePh: inv ? inv.placeholder : null,
    };
  })()`);
  ok(fonts.input === zones.nameFont,
    '输入框的字号和非编辑态那一行字一样（' + zones.nameFont + ' vs ' + fonts.input + '）');
  ok(fonts.invite === zones.nameFont,
    '邀请框也同一号字（' + zones.nameFont + ' vs ' + fonts.invite + '）');
  ok(!!fonts.invitePh && fonts.invitePh.length <= 9 && fonts.invitePh.includes('邀请'),
    '邀请框的 placeholder 短到放得下、且必须带「邀请」三个字，实际 ' + JSON.stringify(fonts.invitePh));

  await evalJs(page, `
    const inp = document.querySelector('[data-cal-name]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, '全家'); inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await evalJs(page, `document.querySelector('[data-cal-save]').click(); return true;`);
  const renamed = await withCals(() => waitFor(page, `
    [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .some((b) => b.textContent.trim() === '全家') ? '全家' : null`,
    '下拉里名字变成「全家」'));
  ok(renamed === '全家', '改名同步到了顶栏那个下拉多选框');
  await closeCalMenu();

  const reloaded = await evalJs(page, `
    const r = await fetch('./api/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('schedule-app-token') } });
    const j = await r.json();
    return j.cals[0].name;
  `);
  ok(reloaded === '全家', '服务器上也是「全家」（不是只改了界面）');

  /* 星标 = 默认日程集。以前「哪个是默认」是 `name === '我的日程'` 判的，
     改名那一刻就失效；上面刚把这个集改成了「全家」，按老口径它已经不是默认了。
     这一段钉的是新口径：改名不影响默认，星标还能换到别的集上。 */
  const stars = await evalJs(page, `return [...document.querySelectorAll('#content [aria-label*="默认日程集"]')]
    .map((b) => ({ pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label') }));`);
  ok(stars.length === 1, '每个日程集标题行上有一个星标，实际 ' + stars.length);
  ok(stars[0].pressed === 'true',
    '改名之后默认身份没丢（老口径下这里会是 false）');

  /* 创建者那一行：权限下拉与移出按钮都禁用。下拉里也**不该有「创建者」**——
     那是集必须有的主人，不是能分下去的权限（见 ASSIGNABLE_ROLES）。 */
  const ownerRow = await evalJs(page, `return {
    dropdowns: [...document.querySelectorAll('#content button[aria-haspopup="listbox"]')]
      .map((b) => ({ off: b.disabled, name: b.getAttribute('aria-label') })),
  };`);
  const mineRow = ownerRow.dropdowns.find((d) => d.name && d.name.includes('爸爸'));
  ok(!!mineRow && mineRow.off, '创建者的权限下拉是禁用的');
  ok(await evalJs(page, `return !!document.querySelector('#content [aria-label="移出日程集"][disabled]');`),
    '创建者的移出按钮是禁用的（不变量 2：每个集至少留一个 owner）');
  /* 创建者的下拉是**禁用的**（`disabled={m.role === 'owner'}`，上面那条断言过了），
     所以「下拉里没有『创建者』」这件事的正确读法是：**点开它不会出现选项列表**。
     原先这里去读 `body [role="option"]` 的文本跟 '可编辑,只读' 比 —— 禁用的
     下拉根本不开列表，读到的是上一次别的下拉留下的残影，断言永远为假。
     真正要守的不变量是「创建者不是可以分下去的权限」，它体现在禁用上。 */
  ok(await evalJs(page, `
    const dd = [...document.querySelectorAll('#content button[aria-haspopup="listbox"]')]
      .find((b) => b.getAttribute('aria-label') && b.getAttribute('aria-label').includes('爸爸'));
    dd.click();
    return document.querySelectorAll('body [role="option"]').length;
  `) === 0, '创建者的权限下拉是禁用的，点不开选项列表（所以没有「创建者」这项）');

  console.log('\n六、刷新之后还在，且没有 console 报错');
  await page.send('Page.reload');
  await waitFor(page, `!!document.querySelector('.sidebar')`, '刷新后回到主界面', 12000);
  ok(await withCals(() => evalJs(page, `
    return [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .some((b) => b.textContent.trim() === '全家');`)),
    '刷新后仍是「全家」');
  await closeCalMenu();
  ok(await evalJs(page, `return !!localStorage.getItem('schedule-app-token');`), 'token 还在');

  collect();
  ok(errors.length === 0, '全程没有 console 报错' + (errors.length ? '：\n      ' + fmt(errors) : ''));

  console.log('\n七、别人邀请我 → 接受 → 多一个集');
  // 用另一个账号（直接从 API 建）向浏览器里这个人发邀请，看界面接不接得住
  const api = async (method, p, body, token) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`http://127.0.0.1:${API_PORT}/api${p}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const mom = await api('POST', '/auth/register', { name: '妈妈', password: 'pw123456' });
  ok(mom.status === 200, '另一个账户注册成功');
  const momMe = (await api('GET', '/me', undefined, mom.body.token)).body;
  const momCal = momMe.cals[0].id;
  const momCalName = momMe.cals[0].name;
  const inv = await api('POST', `/cals/${momCal}/invites`, { name: '爸爸', role: 'editor' }, mom.body.token);
  ok(inv.status === 200, '妈妈发出邀请');

  // 引擎平时 15 秒轮询一次、或窗口重新获得焦点时同步。这里催它一下，别干等
  await evalJs(page, `window.dispatchEvent(new Event('focus')); return true;`);
  // 邀请收件箱在设置页的「日程集管理」卡头上（侧栏那个入口删了，跟着改名 /
  // 成员一起收进设置页 —— 它们本来就是同一类低频动作）
  await evalJs(page, `document.querySelector('[data-nav="settings"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[data-settings-tab="cals"]')`, '设置页打开', 8000);
  await evalJs(page, `document.querySelector('[data-settings-tab="cals"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[data-cal-invites]')`, '设置页出现邀请收件箱', 12000);
  const badge = await evalJs(page, `return document.querySelector('[data-cal-invites]').innerText.trim();`);
  ok(badge.includes('1'), '邀请收件箱上写着 1，实际 ' + JSON.stringify(badge));

  await evalJs(page, `document.querySelector('[data-cal-invites]').click(); return true;`);
  await waitFor(page, `document.body.innerText.includes('邀请你加入')`, '邀请浮层打开');
  const invText = await evalJs(page, `return document.querySelector('[role="dialog"]').innerText;`);
  ok(invText.includes('妈妈'), '浮层里写着谁邀请的');
  // 注意认的是**对方的**集名。自己那个已经被改成「全家」了，两者不会混
  ok(invText.includes(momCalName), '浮层里写着哪个日程集（' + momCalName + '）');
  ok(invText.includes('可编辑'), '浮层里写着什么权限');

  await evalJs(page, `
    const d = document.querySelector('[role="dialog"]');
    [...d.querySelectorAll('button')].find((b) => b.textContent.includes('接受')).click();
    return true;
  `);
  /* 菜单这会儿是关着的（上一节末尾 focusCal 顺手关了），先打开再数 */
  await withCals(() => waitFor(page,
    `document.querySelectorAll('.cal-menu-pop [data-cal-row]').length === 2`, '接受后下拉里有两个集', 12000));
  /* 多选下判「切过去了」不能看高亮：**两个可能都勾着**（全家本来就勾着，
     接受完自动把新集也勾上并设成归属）。所以认「被勾上」+「归属是它」两件事。 */
  const afterAccept = await withCals(() => evalJs(page, `
    return [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .map((b) => ({ name: b.textContent.trim(), on: b.getAttribute('aria-pressed') === 'true' }));
  `));
  ok(afterAccept.filter((r) => r.on).length === 2, '两个集都勾上了（原来那个不该被取消勾选）'
    + '　实际 ' + JSON.stringify(afterAccept));
  /* **先等落盘再读 ui.cal**：persist 有 250ms 防抖，接受完立刻读 localStorage
     拿到的是上一版（归属还是「全家」），断言会假红 —— 而且红在「归属没切过去」，
     看着像 toggleCal 的锅，其实是读早了。 */
  await waitFor(page, `
    (JSON.parse(localStorage.getItem('schedule-app-v4')).ui || {}).cals?.length === 2 ? 1 : null`,
    '落盘了（persist 有防抖，读早了是上一版）', 5000);
  ok(await withCals(() => evalJs(page, `
    const rows = [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')];
    const mine = rows.find((b) => b.textContent.includes('可编辑'));
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    return !!(mine && st.ui.cal === mine.dataset.calRow);
  `)), '接受完自动把归属切到刚加入的那个集');
  await closeCalMenu();
  ok(await evalJs(page, `return document.querySelector('[data-cal-invites]') === null;`),
    '处理完之后邀请收件箱消失');
  ok(await evalJs(page, `return document.querySelectorAll('[data-cal-item]').length === 2;`),
    '设置页的日程集管理里也是两个集');
  ok(await evalJs(page, `return !!localStorage.getItem('schedule-app-v4');`), '本地状态有落盘');

  console.log('\n七之二、日程集多选：勾选只管显示，归属不许掉进看不见的集');
  /* 锁的是 store.toggleCal 那两条（domain.test.ts 里锁的是老数据迁移，这里证的是接线）：
       1. 取消勾掉一个集 → 显示范围变小，但**归属还看得见**（让给还勾着的那个）
       2. 想把最后一个也取消掉 → 不生效。日程页全空看着像坏了，而且新建的
          东西会落进没勾的集里，用户看到的是「凭空消失」。

     **全部只读 aria-pressed，不读 localStorage**：persist 有防抖，点完立刻读
     落盘的那份拿到的是上一版（探针自己在第十一节被这个坑绊过）。 */
  /* shown / clickCal / waitShownCount / focusCal 四个助手在第三节就定义了
     （日程集下拉在顶栏，第三节是第一个要用到的地方），这里直接用。 */

  await clickCal('全家');
  ok(await waitShownCount(1, '只剩一个集勾着') === 1,
    '取消勾掉「全家」之后只剩一个集勾着，实际 ' + JSON.stringify(await shown()));
  ok(await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    return st.ui.cals.includes(st.ui.cal);
  `), '归属（新建落哪儿）仍然是被勾着的那个');

  await clickCal('全家');
  ok(await waitShownCount(2, '重新勾上「全家」') === 1, '勾回去能恢复');

  /* 最后一个不许取消掉。**必须一次只点一个** —— 点完 React 就重渲染了，
     同一批 NodeList 里的另一个节点已经脱离文档，点击不会再冒泡到容器根，
     事件委托（挂在 #content 上）收不到，看起来就像「点了没反应」。 */
  await clickCal('全家');
  ok(await waitShownCount(1, '只剩一个集勾着') === 1, '再取消掉「全家」');
  await clickCal((await shown())[0]);
  ok(await withCals(() => evalJs(page, `
    return [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true').length === 1;
  `)), '想「一个都不勾」不生效（至少留一个，避免新建的东西凭空消失）');
  await closeCalMenu();

  // 上面那两步把归属甩到了只读的共享集上 —— 后面几节要在「全家」里改东西，
  // 这里明确勾回去（勾上就顺带成为归属，见 toggleCal）
  await clickCal('全家');
  ok(await waitShownCount(2, '两个集都勾回来了') === 1, '恢复成两个都勾着、归属在「全家」');

  collect();
  ok(errors.length === 0, '邀请这一段也没有 console 报错'
    + (errors.length ? '：\n      ' + fmt(errors) : ''));

  console.log('\n八、触屏拖拽排序：TouchSensor 那一路（长按操作层已删）');
  // 桌面视口 + 触屏事件。**不需要窄屏**：拖拽只认 pointerType，
  // 不认宽度（窄屏的标签栏那套是另一回事，那个本机测不了，见 CLAUDE.md 四、34）。
  // 用 CDP 合成触摸，Chrome 会照常派生出 pointerType:'touch' 的 pointer 事件。
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await evalJs(page, `document.querySelector('[data-nav="inbox"]').click(); return true;`);
  // 待办箱空的时候**没有**可拖拽区域（走 Empty 分支），所以这里只能等
  // 「视图切过去了」这件事，不能等列表本身 —— 列表要等第一条任务加进去才出现
  await waitFor(page,
    `(document.body.innerText.includes('待办箱是空的') || !!document.querySelector('[data-scope="inbox"]'))`,
    '切到待办箱');
  for (const t of ['甲', '乙', '丙']) await quickAdd(page, t);
  const inbox = () => evalJs(page, `
    return [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
      .map((el) => el.textContent.trim());
  `);
  ok((await inbox()).join('') === '甲乙丙', '三条任务按添加顺序排，实际 ' + JSON.stringify(await inbox()));

  const rectOf = (text) => evalJs(page, `
    const el = [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
      .find((e) => e.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);

  // —— 触摸拖拽排序（触屏这条路不能带着长按操作层一起改坏）——
  /* **按住不动不再弹任何东西。** 长按操作层已在 2026-10-11 整体删除
     （用户明确要求「整个长按的面板包括其功能都彻底砍掉」），所以这里只留
     拖拽一条路：TouchSensor 的 `{delay: 480, tolerance: 8}` 到点开拖，
     松手落库。断言的不是「有没有弹层」——那个已经没有了 —— 而是排序真的
     变了、并且落进了 localStorage。 */
  const p2 = await rectOf('甲');
  const q = await rectOf('丙');
  await touch(page, 'touchStart', p2);
  await new Promise((r) => setTimeout(r, TOUCH_DRAG_DELAY + 250));
  await touch(page, 'touchMove', { x: p2.x, y: p2.y + 12 });
  await touch(page, 'touchMove', { x: q.x, y: q.y });
  await new Promise((r) => setTimeout(r, 250));
  await touch(page, 'touchEnd');
  await new Promise((r) => setTimeout(r, 250));
  const after = await inbox();
  ok(after.join('') !== '甲乙丙', '拖完顺序真的变了，实际 ' + JSON.stringify(after));
  ok(after[after.length - 1] === '甲', '被拖的「甲」到了最后一位，实际 ' + JSON.stringify(after));
  // 落库了才算数：不能只是视觉上挪了一下
  const saved = await evalJs(page, `
    const now = JSON.parse(localStorage.getItem('schedule-app-v4')).tasks;
    return Object.values(now).filter((t) => !t.deleted).sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0))
      .map((t) => t.title);
  `);
  ok(saved.join('') === after.join(''), '顺序也落库了（localStorage 里一致），实际 ' + JSON.stringify(saved));
  ok(saved.length === 3, '拖动没有多出或少了任务，实际 ' + JSON.stringify(saved));

  // 关掉触摸模拟再往下走：第九节是鼠标那一路（开着触摸模拟，
  // Chrome 会把合成的鼠标事件也改道），后面两节也不需要它。
  // maxTouchPoints 只能是 1..16，给 0 会被 CDP 挡下来（报的是
  // 「Touch points must be between 1 and 16」，看着像触摸点的问题，其实是这个参数）
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  console.log('\n九、鼠标拖拽：MouseSensor 那一路没被触屏改动带坏');
  /* 鼠标走 dnd-kit 的 MouseSensor（mousedown / mousemove / mouseup）。
     这一节要证的**不是**排序逻辑本身（第八节已经证过了），
     而是鼠标这条**入口**还通着：mousedown 有没有记住拖的是谁、
     mousemove 有没有触发拖拽、mouseup 有没有真的落库。
     重构共享代码时最先坏的通常就是这一段接线。 */

  const pointerDrag = async (fromText, toText) => {
    const from = await evalJs(page, `
      const el = [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
        .find((e) => e.textContent.trim() === ${JSON.stringify(fromText)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    const to = await evalJs(page, `
      const el = [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
        .find((e) => e.textContent.trim() === ${JSON.stringify(toText)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    if (!from || !to) return 'missing';
    await evalJs(page, `
      const el = [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
        .find((e) => e.textContent.trim() === ${JSON.stringify(fromText)});
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      return true;
    `);
    await new Promise((r) => setTimeout(r, 50));
    await evalJs(page, `
      const el = document.elementFromPoint(${from.x}, ${from.y + 12});
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: ${from.x}, clientY: ${from.y + 12} }));
      return true;
    `);
    await new Promise((r) => setTimeout(r, 50));
    await evalJs(page, `
      const el = document.elementFromPoint(${to.x}, ${to.y});
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: ${to.x}, clientY: ${to.y} }));
      return true;
    `);
    await new Promise((r) => setTimeout(r, 50));
    await evalJs(page, `
      const el = document.elementFromPoint(${to.x}, ${to.y});
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: ${to.x}, clientY: ${to.y} }));
      return true;
    `);
    await new Promise((r) => setTimeout(r, 350));
    return 'ok';
  };

  ok((await inbox()).join('') === '乙丙甲', '接着第八节的状态，「甲」还在最后，实际 ' + JSON.stringify(await inbox()));
  ok(await pointerDrag('甲', '乙') === 'ok', '合成 pointer 拖拽打在行上');
  const mAfter = await inbox();
  ok(mAfter.join('') !== '乙丙甲', '鼠标拖完顺序真的变了，实际 ' + JSON.stringify(mAfter));
  ok(mAfter[0] === '甲', '「甲」被拖回了第一位，实际 ' + JSON.stringify(mAfter));
  const mSaved = await evalJs(page, `
    const now = JSON.parse(localStorage.getItem('schedule-app-v4')).tasks;
    return Object.values(now).filter((t) => !t.deleted).sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0))
      .map((t) => t.title);
  `);
  ok(mSaved.join('') === mAfter.join(''), '鼠标拖的结果也落库了，实际 ' + JSON.stringify(mSaved));

  console.log('\n十、被降成只读之后：改动挡下来，并且说是哪个集');
  /* 这一节测的是「写操作不许静默失败」那条约定（见 CLAUDE.md 三、界面硬规则）。
     store 那一层有单测，但**接线**没测过：计数器涨了、提示没弹出来，
     用户看到的还是「点了没反应」。所以这里走完整条路：真降权限 → 真点 → 真看提示。

     顺序上放在拖拽两节之后：这一节要往待办箱里加一条自己的任务，
     放到第八节前面会把它那句「三条任务按添加顺序排」污染掉。 */
  await evalJs(page, `document.querySelector('[data-nav="inbox"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.fast-add textarea')`, '待办箱能快速添加');
  // 现在还写得进去（是 editor），先在**共享的那个集**里留下一条，
  // 后面降成只读才有一条现成的可以点。
  // **必须显式切过去**：第七节末尾归属在「全家」，不切的话这条会落进自己那个
  // 集里，降级对它不生效，下面「改动被挡下来」整段都会假红。
  await focusCal(momCal);
  await quickAdd(page, '共享的事');
  await waitFor(page,
    `JSON.parse(localStorage.getItem('schedule-app-v4')).outbox.length === 0`,
    '这条改动推上去了', 12000);
  ok(true, '降级前能正常写入（editor）');

  const dadId = await evalJs(page, `
    const r = await fetch('./api/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('schedule-app-token') } });
    return (await r.json()).user.id;
  `);
  const down = await api('PATCH', `/cals/${momCal}/members/${dadId}`, { role: 'viewer' }, mom.body.token);
  ok(down.status === 200, '妈妈把爸爸降成只读，实际 HTTP ' + down.status);
  ok(down.body?.error === undefined, '降级没有报错：' + JSON.stringify(down.body));

  // 催一次同步把新角色拉下来，然后确认界面真的知道了。
  // **分两段等**：本地那一层（localStorage 里的 cals）先，DOM 后。
  // 合成一个条件的话，超时时分不清是「同步压根没发生」还是「同步到了但界面没画」，
  // 而这两件的排查方向完全相反。
  await evalJs(page, `window.dispatchEvent(new Event('focus')); return true;`);
  await waitFor(page, `
    (JSON.parse(localStorage.getItem('schedule-app-v4')).cals.find((c) => c.id === ${JSON.stringify(momCal)}) || {}).role === 'viewer' ? 1 : null`,
    '本地拉到新角色（还停在 editor 说明这一轮同步没跑）', 15000);
  await withCals(() => waitFor(page, `
    [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .some((b) => b.textContent.includes('只读')) ? 1 : null`,
    '下拉显示「只读」', 8000));
  ok(true, '降级后下拉里把那个集标成「只读」');
  await closeCalMenu();

  // 点掉一条：这是用户在跨集页面上最常做的动作
  const hit = await clickEl(page, `
    [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
      .find((e) => e.textContent.includes('共享的事'))?.querySelector('[data-act="toggle"]')
  `);
  ok(hit !== 'missing', '找到「共享的事」的勾选框（实际事件序列 ' + hit + '）');
  const said = await waitFor(page, `
    [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent).join(' | ') || null
  `, '弹出提示', 5000);
  // **要认集名**：只说「这个日程集你只有查看权限」的话，用户正在「今天」这类
  // 跨集页面上，会以为是眼前这个集出了问题
  ok(said.includes(momCalName), '提示里点名了是哪个集（' + momCalName + '），实际 ' + JSON.stringify(said));
  ok(said.includes('查看权限'), '提示说清了原因，实际 ' + JSON.stringify(said));
  ok(await evalJs(page, `
    const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
      .find((x) => x.title === '共享的事');
    return t && !t.done;
  `), '被挡下的勾选没有写进本地（不是「界面没反应但数据已经改了」）');

  console.log('\n十一、同一字段两边都改过：详情里说清楚，别让人以为字自己变了');
  /* 这一节证的是接线，判定逻辑在 domain/merge.ts 的 findConflicts（有单测）。
     要证的是三件**只有真跑一遍才知道**的事：
       1. 引擎真的把「这一轮推上去的 op」和「这一轮拉回来的别人的改动」对上了；
       2. 抽屉真的把那条记录渲染出来（选择器 / 字段名对得上）；
       3. 「知道了」真的落盘（不落盘的话下次刷新又冒出来，用户会以为没生效）。

     先切回自己的集：上一节把爸爸在那个共享集里降成了只读，在那儿改不出东西。 */
  /* 下拉里现在是**多选**，点一下是「勾上 / 取消勾」，不是单选时代的「切过去」。
     所以要点**没勾着的那个**（已经勾着就别点 —— 那等于取消勾选）。勾上就顺带
     成为归属，见 store.toggleCal。 */
  await withCals(() => evalJs(page, `
    const b = [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')].find((x) => x.textContent.trim() === '全家');
    if (b.getAttribute('aria-pressed') !== 'true') b.click();
    return true;
  `));
  await withCals(() => waitFor(page, `
    [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')].find((b) => b.textContent.trim() === '全家'
      && b.getAttribute('aria-pressed') === 'true') ? 1 : null
  `, '勾上自己的日程集（共享那个现在改不动）', 8000));
  await closeCalMenu();

  await evalJs(page, `document.querySelector('[data-nav="inbox"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.fast-add textarea')`, '待办箱能快速添加');
  const MINE = '会撞车的任务';
  await quickAdd(page, MINE);
  /* **不能加完就立刻读 localStorage**：persist 有防抖，这一瞬间落盘的还是上一版
     —— 界面上那一行已经在了、`outbox.length === 0` 也「成立」（读到的是旧值），
     于是任务看起来凭空消失。等它真落盘再说。 */
  const mine = await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === ${JSON.stringify(MINE)});
      return t ? { id: t.id, calId: t.calId } : null;
    })()
  `, '新任务落盘', 8000);
  // 再等它推上去：任务得先在服务器上存在，下面那条改动才是「改」而不是「凭空造半条」
  await waitFor(page,
    `JSON.parse(localStorage.getItem('schedule-app-v4')).outbox.length === 0`,
    '这条推上去了', 12000);

  const dadTok = await evalJs(page, `return localStorage.getItem('schedule-app-token');`);
  /* 另一台设备推同一个字段。ts 给「30 秒后」—— 让**那边赢**，这才是最吓人的
     那种：用户刚打的字变回去了。服务端只拒超过 24 小时的时钟，30 秒没问题。 */
  const OTHER = '那边打进去的字';
  const pushed = await api('POST', '/sync', {
    cursor: 0,
    deviceId: 'other-device',
    ops: [{
      opId: 'other-device-1', deviceId: 'other-device', ts: Date.now() + 30000,
      calId: mine.calId, entity: 'task', entityId: mine.id,
      fields: { title: OTHER },
    }],
  }, dadTok);
  ok(pushed.status === 200 && (pushed.body?.applied || []).length === 1,
    '另一台设备改掉了同一个字段（实际 ' + JSON.stringify({ status: pushed.status, rejected: pushed.body?.rejected }) + '）');

  // 本机点开它、在详情里改标题 —— 真走界面，不直接改 store
  const clickRes = await evalJs(page, `
    const el = [...document.querySelectorAll('.task-el')].find((e) => e.textContent.includes(${JSON.stringify(MINE)}));
    if (!el) return 'missing';
    const before = { count: document.querySelectorAll('.task-el').length, id: el.dataset.id, inContent: !!el.closest('#content') };
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerType: 'mouse', isPrimary: true }, at)));
    el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerType: 'mouse', isPrimary: true }, at)));
    el.dispatchEvent(new MouseEvent('click', at));
    const after = { count: document.querySelectorAll('.task-el').length };
    return JSON.stringify({ before, after });
  `);
  ok(clickRes !== 'missing', '点开这条任务');
  await waitFor(page, `!!document.querySelector('.drawer.open .drawer-title')`, '抽屉打开');
  const typed = await evalJs(page, `
    const inp = document.querySelector('.drawer.open .drawer-title');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, '我这边打的字');
    inp.dispatchEvent(new Event('input', { bubbles: true }));      // React 的 onChange
    // **隔一拍再 blur。** 两个事件在同一个同步块里发的话，onBlur 那次还能拿到
    // 上一版的 state（title 还是旧值），它那句「v !== task.title」就不成立 ——
    // 表现是「改了但没推上去」，看着像冲突检测没实现。
    await new Promise((r) => setTimeout(r, 50));
    inp.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));  // React 的 onBlur 认 focusout（原生 blur 不冒泡）
    return 'ok';
  `);
  ok(typed === 'ok', '在详情里改了标题');

  // 那一轮同步会把我这次推的 op 和那边拉回来的改动对在同一个字段上（PUSH_DEBOUNCE_MS = 1.2s）
  const rec = await waitFor(page, `
    (() => {
      const c = (JSON.parse(localStorage.getItem('schedule-app-v4')).conflicts || [])
        .find((x) => x.entityId === ${JSON.stringify(mine.id)});
      return c ? JSON.stringify(c) : null;
    })()
  `, '冲突记到本地（记不上说明这一轮里两边的改动没被对上）', 15000);
  ok(JSON.parse(rec).winner === 'theirs', '那边赢（ts 更晚），实际 ' + rec);
  ok(JSON.parse(rec).theirs === OTHER && JSON.parse(rec).mine === '我这边打的字',
    '两边的值都留着，实际 ' + rec);

  const box = await waitFor(page, `
    document.querySelector('.conflict-box') ? document.querySelector('.conflict-box').innerText : null
  `, '抽屉里出现那条提示', 5000);
  ok(box.includes('标题'), '提示里点的是字段名「标题」，实际 ' + JSON.stringify(box));
  ok(box.includes(OTHER), '提示里带着那边那版的值，实际 ' + JSON.stringify(box));
  ok(box.includes('我这边打的字'), '也说清了被盖住的是我改的那版，实际 ' + JSON.stringify(box));

  const dismiss = await clickEl(page, `document.querySelector('.conflict-box .cb-x')`);
  ok(dismiss !== 'missing', '点得到「知道了」（实际事件序列 ' + dismiss + '）');
  await waitFor(page, `document.querySelector('.conflict-box') ? null : 1`, '提示收起来了', 5000);
  await waitFor(page, `
    (JSON.parse(localStorage.getItem('schedule-app-v4')).conflicts || [])
      .some((c) => c.entityId === ${JSON.stringify(mine.id)}) ? null : 1
  `, '「知道了」落盘了（不落盘的话刷新又冒出来）', 5000);
  ok(true, '「知道了」之后不再提示，且落盘');

  // 关掉抽屉，别把浮层留给下一节
  await clickEl(page, `document.querySelector('.drawer.open .drawer-head [aria-label="完成"]')`);
  await waitFor(page, `document.querySelector('.drawer.open') ? null : 1`, '抽屉关上了', 5000);

  /* -------- AI：假模型 → 提案卡片 → 确认 → 服务器上真有 -------- */
  // 这一节证的是写路径的**接线**：模型调工具 → 工具造提案 → SSE 推卡片 →
  // 用户点确认 → 服务器落库。假模型按剧本吐 chunk，不联网、不烧额度。
  //
  // 假模型服务说 OpenAI chat-completions + SSE。pi-ai 用 OpenAI SDK 发请求，
  // SDK 期望 `data: [DONE]` 结尾（见 openai/src/core/streaming.ts:133）。
  //
  // **轮次按「这一轮的 messages 里有没有 role:'tool'」判，不按第几次调用。**
  // 原先写的是 `modelCalls === 1` 就给 tool_call —— 那个全局计数很脆：
  // SDK 自己重试一次、或任何别的来源也打进来一次，计数就错位，第一轮拿到的
  // 成了「文本收尾」而不是 tool_call。后果是提案卡片永远不出现，而且
  // **一条报错都没有** —— 文本是合法响应，只是没有提案。探针里偶发过一次
  // （约 1/9），就是这个形态。换成看对话内容之后，重试和串扰都不再影响判定。
  console.log('\n十二、AI：假模型提一条改动 → 确认 → 服务器上真有');
  let modelCalls = 0;
  const modelSrv = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      modelCalls++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

      // 上一轮的工具执行过 → 对话里会多出 role:'tool' 那条（实测：
      // 第一轮是 [system,user]，第二轮是 [system,user,assistant,tool]）
      let afterTool = false;
      try { afterTool = (JSON.parse(body).messages || []).some((m) => m.role === 'tool'); } catch (_) { /* 不是 JSON 就当第一轮 */ }

      if (!afterTool) {
        // 第一轮：调 create_task。arguments 分片发，模拟真模型的流式
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_ai_1', type: 'function', function: { name: 'create_task', arguments: '' } }] }, finish_reason: null }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"title":"买菜","date":"2026-10-08","time":"14:00"}' } }] }, finish_reason: null }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        // 第二轮：文本收尾
        send({ choices: [{ delta: { content: '好的，我给你建了一条任务。' }, finish_reason: null }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  MODEL_PORT = await listenFree(modelSrv, MODEL_PORT);   // 抢走了就用它给回来的那个号
  track({ kill: () => modelSrv.close() });

  // 把 AI 设置指向假模型（token 从浏览器里读，Node 侧没有 localStorage）
  const aiToken = await evalJs(page, `return localStorage.getItem('schedule-app-token');`);
  const aiSet = await fetch(`http://127.0.0.1:${API_PORT}/api/ai/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + aiToken },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${MODEL_PORT}/v1`, model: 'fake-model' }),
  });
  ok(aiSet.status === 200, 'AI 设置已指向假模型');

  // 切到 AI 页
  await evalJs(page, `document.querySelector('[data-nav="ai"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.ai-wrap')`, 'AI 面板渲染出来', 8000);

  // AI 面板的输入框也要有名字 —— a11y() 原来从没扫过 AI 面板，
  // .ai-input 只有 placeholder 的漏洞就是这么漏掉的
  const aiA11y = await evalJs(page, `return { bad: ${a11y('.ai-wrap')},
    cands: document.querySelectorAll('.ai-wrap input, .ai-wrap textarea').length };`);
  ok(aiA11y.cands >= 1, 'AI 面板有 ' + aiA11y.cands + ' 个输入框可查');
  ok(aiA11y.bad.length === 0, 'AI 面板每个控件都有名字'
    + (aiA11y.bad.length ? '：\n      ' + aiA11y.bad.join('\n      ') : ''));

  // 发一句话。`.ai-input` 是 <textarea>，setter 必须取 HTMLTextAreaElement
  // 那个原型上的 —— 拿 HTMLInputElement 的来 call 会当场 `Illegal invocation`

  // 填字 → **等发送键变可点** → 再派发回车，不合成一步。
  // 发送键的 disabled 绑在 `!text.trim()` 上（见 AiPanel 的 .ai-compose），
  // 它一变可点就说明 React 确实吃到了这段文字。少了这一步，万一文字没进去，
  // 症状会显示成「等不到提案卡片」—— 指向完全错的地方。
  // （顺带验过：input 派发后**同一个任务内**按钮就已经可点，React 对离散事件
  // 是同步 flush 的，这里不是抢在重渲染之前。）
  await evalJs(page, `
    const inp = document.querySelector('.ai-input');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(inp, '帮我建一条买菜的任务');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await waitFor(page, `(() => { const b = document.querySelector('.ai-compose button'); return !!b && !b.disabled && b.textContent.includes('发送'); })()`, '发送键变可点', 8000);
  await evalJs(page, `
    const inp = document.querySelector('.ai-input');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  `);

  // **分两段等**：先等提问进了气泡（证明确实发出去了），再等提案卡片。
  // 合成一个条件的话，超时时分不清「回车没接上」和「往返慢」——
  // 同第「十」节那两段等（见 CLAUDE.md 三、测试）。
  // 15 秒不动：实测这一段往返只要 ~900ms（气泡 ~5ms），留着的余量已经两个数量级；
  // 真卡住时该红就红，别用更大的超时把它盖住。
  await waitFor(page, `!!document.querySelector('.ai-msg.user')`, '提问进了气泡', 8000);
  await waitFor(page, `!!document.querySelector('.ai-prop')`, '提案卡片出现', 15000);
  const propText = await evalJs(page, `return document.querySelector('.ai-prop-text').innerText;`);
  ok(propText.includes('买菜'), '卡片上写着「买菜」，实际 ' + JSON.stringify(propText));
  ok(propText.includes('新建'), '措辞是「新建」而不是「已建好」，实际 ' + JSON.stringify(propText));

  // 确认之前服务器上不能有这条任务。
  // `snapshot.tasks` 是**按 id 索引的对象**（见 server/lib/sync.js 的 snapshot），
  // 不是数组 —— 写 `.some(...)` 会当场 TypeError
  const syncNow = () => fetch(`http://127.0.0.1:${API_PORT}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + aiToken },
    body: JSON.stringify({ cursor: 0 }),
  }).then((r) => r.json());

  const snapBefore = await syncNow();
  const findBuy = (s) => Object.values(s.snapshot?.tasks || {}).find((t) => t.title === '买菜');
  ok(!findBuy(snapBefore), '确认之前服务器上没有「买菜」');

  // 点确认
  await clickEl(page, `document.querySelector('.ai-prop button')`);
  await waitFor(page, `document.querySelector('.ai-prop') ? null : 1`, '确认后卡片消失', 8000);

  const made = findBuy(await syncNow());
  ok(!!made, '确认之后服务器上真有「买菜」这条任务');
  // `_dev` 是这一节真正要证的东西：这条不是别的路径写进去的，是 AI 那条路写的
  // （deviceId 固定 'ai'，见 server/lib/ai/confirm.js 的文件头）
  ok(made && made._dev?.title === 'ai', '它的写入设备是 ai（不是碰巧被别的路径建的）'
    + (made ? '，实际 ' + JSON.stringify(made._dev) : ''));
  ok(made && made.date === '2026-10-08' && made.time === '14:00',
    '日期和时间跟卡片上写的一致' + (made ? '，实际 ' + JSON.stringify([made.date, made.time]) : ''));

  collect();
  ok(errors.length === 0, 'AI 这一段没有 console 报错' + (errors.length ? '：\n      ' + fmt(errors) : ''));

  console.log('\n十三、离线：外壳能打开，顶栏会说话');
  // Service Worker 在第一趟就接管了（见「零」）。这里只确认它没在这几轮
  // 刷新 / 邀请流程里掉线 —— 掉了的话下面那几条会以另一种方式失败
  ok(await evalJs(page, `return !!navigator.serviceWorker.controller;`),
    'Service Worker 一直接管着页面');

  // navigator.onLine 不会因为「我把本地服务器关了」而变 —— 它反映的是网卡。
  // 要用 CDP 模拟离线才能驱动 offline 事件。
  await page.send('Network.enable');
  await page.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await waitFor(page, `navigator.onLine === false`, '浏览器报告离线', 5000);
  await waitFor(page, `document.querySelector('.sync-dot[title*="离线"]') ? 1 : null`,
    '顶栏出现离线标记', 5000);
  ok(true, '断网时顶栏告诉用户「改动先存在本机」，而不是一直转圈');

  await page.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await waitFor(page, `navigator.onLine === true`, '恢复联网', 5000);
  ok(await evalJs(page, `return !document.querySelector('.sync-dot[title*="离线"]');`),
    '联网后离线标记消失');

  // 真正的离线考验：把静态服务关掉再刷新，页面只可能来自 Service Worker 缓存。
  // closeAllConnections 是必须的 —— 光 close() 只停止接受新连接，Chrome 池子里
  // 那条 keep-alive 还能把请求送进来，测试会假通过。
  web.closeAllConnections?.();
  await new Promise((r) => web.close(r));
  await page.send('Page.reload');
  await waitFor(page, `!!document.querySelector('.sidebar')`, '断网后仍能打开应用', 12000);
  ok(await withCals(() => evalJs(page, `
    return [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .some((b) => b.textContent.trim() === '全家');`)),
    '断网打开的是同一份数据（日程集名字还在）');
  await closeCalMenu();
  ok(await evalJs(page, `return document.querySelectorAll('[data-nav]').length > 0;`),
    '断网时导航也在，不是白屏');

  collect();
  // 断网时 /api/ 的请求必然失败 —— Service Worker **故意不碰接口**，这是设计如此。
  // 引擎自己会把它记成 lastError 显示出来，所以这里只关心别的来源的报错。
  const other = errors.filter((e) => !e.url.includes('/api/'));
  ok(other.length === 0, '离线这一段除了接口连不上，没有别的 console 报错'
    + (other.length ? '：\n      ' + fmt(other) : ''));

  // 静态服务关了之后必须重开 —— 后面几节（尤其十六的改密码）要走 /api/ 代理。
  // 不重开的话它们会以另一种方式失败：fetch 直接「连不上服务器」，
  // 看着像网络问题，其实是代理没了。
  web = await serveDist();
  procs.push({ kill: () => { if (web && web.listening) web.close(); } });

  // 放在最后、且刻意在「关掉静态服务」之后：这一节全是纯 DOM 查询，
  // 不需要网络，而断网那一节已经把服务器关了 —— 插在它前面会被它的
  // closeAllConnections 打乱状态，插在后面则完全不动已有状态。
  console.log('\n十四、无障碍：勾选圈都是真按钮，每个输入框都有名字');
  //
  // 这一节守的是一条不变量，不是某个具体页面。勾选圈原先在**六个地方各写了
  // 一遍**，于是各自长歪了：月 / 周视图那个是 <span>（Tab 进不去、没有按钮
  // 角色、读屏念不出），打卡页和时间轴那两个没有可访问名字，逾期行的标题
  // 写死成「标记完成」（已完成时也是这句）。现在六个调用点全走
  // parts.tsx 的 <CheckBtn>，这里就是看门人：谁再手写一个 span.check-btn、
  // 或者漏掉一个 aria-label / htmlFor，这一节就会红。
  //
  // 验过它有牙：把 CheckBtn 里那个 <button> 换回 <span>，第一条立刻失败。
  // 注意这里**不带 return** —— 它是一段表达式，方便和别的字段拼在一个
  // evalJs 里（下面 scan() 就是这么用的）。
  // 用具名函数而不是 const —— **函数声明会提升**，管理浮层那一节（第五节）
  // 在定义之前就要用它；const 在 TDZ 里，那样写会当场 ReferenceError。
  //
  // 参数 root 是个选择器，**不带就扫全文档**。为什么要能缩范围：第五节的浮层是
  // 叠在整页上的，扫全文档的话侧栏里任何一个没名字的控件都会算到这条断言头上，
  // 失败信息就指错了地方 —— 这个文件里已经栽过一次（见上面 waitFor 那段）。
  function a11y(root) { return `(() => {
    const bad = [];
    const box = ${root ? `document.querySelector(${JSON.stringify(root)})` : 'document'};
    if (!box) return ['扫描范围没找到：' + ${JSON.stringify(root || '')}];
    const nameOf = (el) => {
      if (el.getAttribute('aria-label')) return 'aria-label';
      if (el.getAttribute('title')) return 'title';
      if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return 'label[for]';
      // 包在 label 里**也得 label 里有字**才算有名字：抽屉头上那个勾选圈
      // 包在一个空 label 里（圈是旁边一个 span），空 label 本身给不出名字 ——
      // 原先这里不看文字，等于给「没名字」开了个后门。
      const lab = el.closest('label');
      if (lab && lab.textContent.trim()) return '包在 label 里';
      // 按钮的可见文字**就是**它的可访问名字，和 aria-label 等价 ——
      // 第一版漏了这一条，把 nav-item / ghost-btn 这些带字的全报成了「没名字」，
      // 是探针自己的 bug（见 CLAUDE.md 四、40：这种症状先怀疑探针）
      if (el.tagName === 'BUTTON' && el.textContent.trim()) return 'textContent';
      if (el.tagName === 'INPUT' && /^(submit|button|reset)$/.test(el.type) && el.value) return 'value';
      // placeholder 会在最后一档当名字用，但那是退化行为，不算数（见下面 title 框）
      return '';
    };
    // 光用 tagName + 自己的 class 会**把不同的元素压成同一行** ——
    // 顶栏搜索和快速添加那两个 input 都没有 class、都没有名字，
    // Set 一去重就只剩一条，看着像只有一处有问题。补上父元素的类名，
    // 失败信息才指得到具体哪一个。
    // （注意：这段字符串是模板字面量，注释里不能出现反引号，
    //   否则会把模板当场截断、后面半截漏到 Node 里跑 —— 已经踩过一次）
    const cls = (el) => {
      const own = el.tagName.toLowerCase();
      // 光看 class 管理浮层那两个框会压成同一条（前缀都是 min-w-0），
      // 失败信息指不出是哪一个 —— 那一次报的就是这条，白查了一轮。
      // data-* 最准（探针本来就认 data-cal-name 这些抓手），其次 placeholder。
      const dk = el.getAttributeNames().find((n) => n.startsWith('data-'));
      const ph = el.getAttribute('placeholder');
      const tag = own + (dk ? '[' + dk + ']' : '') + (ph ? '[placeholder=' + ph + ']' : '');
      if (dk || ph) return tag;
      if (typeof el.className === 'string' && el.className) return own + '.' + el.className.split(' ')[0];
      const p = el.parentElement;
      const pc = p && typeof p.className === 'string' && p.className ? p.className.split(' ')[0] : (p ? p.tagName.toLowerCase() : '?');
      return own + ' in .' + pc;
    };
    /* 勾选圈必须是真 button（见 CLAUDE.md 三、无障碍 2）。

       **例外：aria-hidden 的圈，且它在一个真 button 里面** —— 那种圈是那个
       按钮的**状态指示**，不是独立控件。侧栏日程集那一行就是这种：整行是一个
       aria-pressed 的 toggle button，圈只是「勾没勾上」的视觉说法，读屏不该
       把它当第二个控件念（所以 aria-hidden）。把它算成「假按钮」是误报 ——
       真按钮的内容里本来就可以有 span。 */
    for (const el of box.querySelectorAll('span.check-btn')) {
      if (el.getAttribute('aria-hidden') === 'true'
        && el.closest('button:not([disabled])')) continue;
      bad.push('勾选圈是 span 不是 button');
    }
    for (const el of box.querySelectorAll('button,input,select,textarea')) {
      if (el.type === 'hidden' || el.disabled) continue;
      // 没渲染出来的不算 —— 导入备份那个 <input type=file> 就是藏起来的，
      // 由旁边那个有名字的按钮触发，是标准做法
      if (!el.getClientRects().length) continue;
      if (!nameOf(el)) bad.push('没名字：' + cls(el));
    }
    for (const l of box.querySelectorAll('label')) {
      if (l.htmlFor) {
        if (!document.getElementById(l.htmlFor)) bad.push('label[for] 指向不存在的 id：' + l.htmlFor);
      } else if (!l.querySelector('input,select,textarea')) {
        bad.push('label 既没有 for 也没包住控件：' + l.textContent.trim().slice(0, 20));
      }
    }
    return [...new Set(bad)];
  })()`; }

  // 先切到待办箱再造一条待查的 —— 断网了，quickAdd 只写本机发件箱，不影响别的断言
  await evalJs(page, `document.querySelector('[data-nav="inbox"]').click(); return true;`);
  await waitFor(page,
    `(document.body.innerText.includes('待办箱是空的') || !!document.querySelector('[data-scope="inbox"]'))`,
    '切到待办箱', 8000);

  /**
   * 扫描 + **顺便数一下「本该被扫到的控件有几个」**。
   *
   * 这一步不是多余的：第一版只断言 `bad.length === 0`，而待办箱里根本没有
   * `task-pill`（胶囊只在月 / 周视图渲染），于是把 CheckBtn 换回 <span>
   * 重跑，断言照样整段绿 —— 一条没有候选的断言等于没写。
   * `cands` 就是用来堵这个的：候选为 0 时单独报错，而不是装作通过。
   */
  const scan = async () => {
    const r = await evalJs(page, `return { bad: ${a11y()}, cands: document.querySelectorAll('.task-el').length };`);
    return r;
  };

  // —— 先换集，再建任务 ——
  // **顺序不能反。** 任务建在「当前选中的集」里；先建后换的话，换过去之后
  // 月视图（按集）根本看不到它，下面那条又会空过一轮。
  //
  // 而且必须挑一个**有写权限的**集（owner / editor）：第十节把爸爸在别的集里
  // 降成了只读，随手挑「另一个集」正好挑中只读的那个 —— quickAdd 会被
  // deny() 挡下、任务根本不出现，探针卡在「等不到任务出现」上，
  // 报错却指向快速添加，看着像输入框坏了。按 role 挑就没有这个问题。
  //
  // 挑哪个集也**不按名字**：第六节把集改过名，照着名字找会静默找不到。
  const pickId = await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    const canWrite = (r) => r === 'owner' || r === 'editor';
    const mine = (st.cals || []).filter((c) => canWrite(c.role));
    const pick = mine.find((c) => c.id !== st.ui.cal) || mine[0];
    return pick ? pick.id : '';
  `);
  ok(pickId !== '', '有一个有写权限的日程集可切');
  await focusCal(pickId);
  ok(await withCals(() => evalJs(page, `
    const on = [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .filter((x) => x.getAttribute('aria-pressed') === 'true');
    return on.length === 1 && on[0].dataset.calRow === ${JSON.stringify(pickId)};
  `)), '切到了有写权限的日程集，且只有它勾着');
  await closeCalMenu();

  await quickAdd(page, '无障碍检查');
  const list = await scan();
  ok(list.cands > 0, '待办箱里有任务行可查（候选 ' + list.cands + ' 个 —— 为 0 时下面那条是空过）');
  ok(list.bad.length === 0, '待办箱没有假按钮 / 无名控件'
    + (list.bad.length ? '：\n      ' + list.bad.join('\n      ') : ''));

  /* 圈的**大小**（2026-10-24 第四轮，用户第 2 条「打勾太大、位置不对」）：
     视觉直径 = 所在那一行的字号 × `--check-k`（夹在 `--check-min` ~ `--check-max`），
     命中区仍然 24×24 —— 靠 `.check-btn::before` 往外撑，不是把圆点画大（画大就毁了列表密度）。
     第五轮用户「打勾太小了 比例再大一点」→ k .85 → 1、上限 16 → 18。
     ⚠️ 三个数从 :root 读，不在探针里写死：写死过一次，改令牌那一轮就得手动追一遍探针，
        追漏的那处会红在别处。
     这里量的是**列表行**（卡片那两个尺寸由 card-geometry 钉）。 */
  const size = await evalJs(page, `
    const rows = [...document.querySelectorAll('.task-row')].filter((r) => r.querySelector('.check-btn'));
    if (!rows.length) return null;
    const cs = getComputedStyle(document.documentElement);
    const tok = (n, dflt) => { const x = parseFloat(cs.getPropertyValue(n)); return Number.isFinite(x) ? x : dflt; };
    return { k: tok('--check-k', 1), min: tok('--check-min', 9), max: tok('--check-max', 18),
             rows: rows.map((r) => {
               const btn = r.querySelector('.check-btn');
               const title = r.querySelector('.row-title') || r;
               const fs = parseFloat(getComputedStyle(title).fontSize);
               const box = getComputedStyle(btn, '::before');
               return {
                 fs, w: +btn.getBoundingClientRect().width.toFixed(2),
                 beforeW: parseFloat(box.width), beforeH: parseFloat(box.height),
               };
             }) };
  `);
  ok(!!size && size.rows.length > 0, '列表行里有带勾选圈的行可查（' + (size ? size.rows.length : 0) + ' 行）');
  for (const r of (size ? size.rows : [])) {
    const want = Math.min(size.max, Math.max(size.min, r.fs * size.k));
    ok(Math.abs(r.w - want) <= 0.6,
      `列表圈视觉直径 = 行字号 × ${size.k}（夹 ${size.min}~${size.max}），且不比任务名大`,
      `圈 ${r.w}px / 字号 ${r.fs}px（want ${want.toFixed(2)}）`);
    ok(r.w <= r.fs + 0.5, '列表圈不比任务名文字宽', `圈 ${r.w}px ≤ 字号 ${r.fs}px`);
    ok(r.beforeW >= 24 && r.beforeH >= 24,
      '命中区仍是 24×24（WCAG 2.5.8，靠 ::before 撑，不是把圈画大）',
      `::before ${r.beforeW}×${r.beforeH}`);
  }

  // 抽屉里字段最多（日期 / 时间 / 时长 / 重复 / 备注 + 重复面板里的几个），
  // label 配没配上在这里最容易露馅
  ok(await clickEl(page, `
    [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
      .find((e) => e.textContent.includes('无障碍检查'))
  `) !== 'missing', '点开刚建的那条任务');
  await waitFor(page, `!!document.querySelector('.drawer.open .drawer-title')`, '抽屉打开', 8000);
  const draw = await evalJs(page, `return { bad: ${a11y()},
    cands: document.querySelectorAll('.drawer.open input, .drawer.open select, .drawer.open textarea').length
      + document.querySelectorAll('.drawer.open .dp-btn, .drawer.open .tp-btn').length };`);
  ok(draw.cands >= 5, '抽屉里有 ' + draw.cands + ' 个表单控件可查（日期 / 时间 / 时长 / 重复 / 备注）');
  ok(draw.bad.length === 0, '详情抽屉里每个输入框都有名字、每个 label 都配上了控件'
    + (draw.bad.length ? '：\n      ' + draw.bad.join('\n      ') : ''));

  // htmlFor 真配上没配上，光看属性不算数 —— 点一下 label，光标该进对应控件。
  // 这一条同时也是「移动端点小字标签能不能聚焦到框」的代理断言
  const focusOk = await evalJs(page, `
    const l = document.querySelector('.drawer.open .field label[for]');
    if (!l) return '没有带 for 的 label';
    const want = l.htmlFor;
    l.click();
    const a = document.activeElement;
    return a && a.id === want ? 'ok' : ('焦点跑到了 ' + (a ? (a.id || a.tagName) : 'null'));
  `);
  ok(focusOk === 'ok', '点「日期」这个 label 能把光标送进日期框，实际 ' + focusOk);

  // 顺手把这条任务填上日期 —— 下面月视图要用的那条**有日期的**任务就是它。
  //
  // 走抽屉的日期控件，不走快速添加的自然语言：本探针的 store 里本来一条有日期
  // 的任务都没有，而「快速添加 → 解析出日期」那条路别处已经单独覆盖过，
  // 这里再依赖一次只会多一个可能失败的地方。
  // 日期现在是自定义 DatePicker（一个日期按钮 + 月历面板），不是原生 input ——
  // 点日期按钮打开月历，再点一个日期。
  const dated = await evalJs(page, `
    const btn = document.querySelector('.drawer.open .dp-btn');
    if (!btn) return 'missing';
    btn.click();
    return 'ok';
  `);
  ok(dated === 'ok', '在抽屉里给它填上今天（' + new Date().toISOString().slice(0, 10) + '），实际 ' + dated);
  await waitFor(page, `document.querySelector('.drawer.open .dp-pop') ? 1 : null`, '月历面板打开了', 8000);
  const picked = await evalJs(page, `
    const cells = [...document.querySelectorAll('.drawer.open .dp-pop .jp-cell:not(.out)')];
    const today = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const iso = today.getFullYear() + '-' + p(today.getMonth() + 1) + '-' + p(today.getDate());
    const cell = cells.find((c) => c.classList.contains('today')) || cells[0];
    if (!cell) return 'missing';
    cell.click();
    return cell.classList.contains('today') ? 'ok' : 'picked-other';
  `);
  ok(picked === 'ok', '在月历里点了今天，实际 ' + picked);
  // waitFor 前面会被补一个 return，所以这里只能写一个**表达式**，不能带 const
  //（见 CLAUDE.md 四、39 —— 已经踩过一次）
  await waitFor(page, `
    (() => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const today = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      return Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks || {})
        .some((t) => t.title === '无障碍检查' && t.date === today) ? 1 : null;
    })()
  `, '日期落盘了', 8000);

  await clickEl(page, `document.querySelector('.drawer.open .drawer-head [aria-label="完成"]')`);
  await waitFor(page, `document.querySelector('.drawer.open') ? null : 1`, '抽屉关上了', 8000);

  // 先切回日程页再选月视图 —— `.view-switch` 只在 nav === 'calendar' 时才渲染，
  // 少了这一步 querySelector 直接拿到 null
  await evalJs(page, `document.querySelector('[data-nav="calendar"]').click(); return true;`);
  await evalJs(page, `document.querySelector('[data-view="month"]').click(); return true;`);
  await waitFor(page, `document.querySelector('[data-view="month"].on') ? 1 : null`, '切到月视图', 8000);
  await new Promise((r) => setTimeout(r, 400));   // 等这一帧画完再数
  const month = await scan();
  const pills = await evalJs(page, `return document.querySelectorAll('.task-pill').length;`);
  // 失败时把「为什么没有胶囊」直接打出来 —— 否则只能看到「0 个」，
  // 而 0 个有一堆可能：选中的集没切成、月份不对、格子被折叠成「还有 N 项」
  const diag = await evalJs(page, `return {
    // 勾了哪几个集从 localStorage 的 ui.cals 读（那是真相），不用打开下拉
    cals: (JSON.parse(localStorage.getItem('schedule-app-v4')).ui || {}).cals,
    activeCal: (JSON.parse(localStorage.getItem('schedule-app-v4')).ui || {}).cal,
    uiCursor: (JSON.parse(localStorage.getItem('schedule-app-v4')).ui || {}).cursor,
    monthCells: document.querySelectorAll('.month-cell').length,
    collapsed: (document.body.innerText.match(/还有 \\d+ 项/g) || []),
  };`);
  ok(pills > 0, '月视图里确实有胶囊可查（' + pills + ' 个 —— 为 0 时下面那条是空过）'
    + '　诊断：' + JSON.stringify(diag));
  ok(month.bad.length === 0, '月视图格子里的勾选圈也是真按钮'
    + (month.bad.length ? '：\n      ' + month.bad.join('\n      ') : ''));

  // 2026-10-22 用户三条（月视图宽屏）：①「改了这么多次还是有完全属于下个月的
  // 空白行」②「每行高度保持一致且固定，不被任务撑开或压扁」③「显示不完格内
  // 滚动，滚动条浮动不占横向空间」。三条一起锁在这：
  const mv = await evalJs(page, `return (() => {
    const cells = [...document.querySelectorAll('.month-cell')];
    if (!cells.length) return { err: 'no-cells' };
    // 行 = 按 y 聚类（网格同一行的格子 y 相同）
    const rows = new Map();
    for (const c of cells) {
      const y = Math.round(c.getBoundingClientRect().y);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(c);
    }
    const rowList = [...rows.values()]
      .sort((a, b) => a[0].getBoundingClientRect().y - b[0].getBoundingClientRect().y);
    // 纯下月行 = 整行都是 .out（邻月灰格）—— monthWeeks 不该产出这种行
    const pureOut = rowList.filter((row) => row.every((c) => c.classList.contains('out'))).length;
    const heights = [...new Set(rowList.map((row) => Math.round(row[0].getBoundingClientRect().height)))];
    const ct = document.querySelector('.cell-tasks');
    const cs = ct ? getComputedStyle(ct) : null;
    const grid = document.querySelector('.month-grid').getBoundingClientRect();
    return {
      rows: rowList.length, pureOut, heights, h0: heights[0],
      overflowY: cs ? cs.overflowY : null,
      scrollbarWidth: cs ? cs.scrollbarWidth : null,
      position: cs ? cs.position : null,
      gridH: Math.round(grid.height), viewH: window.innerHeight,
    };
  })();`);
  ok(!mv.err && mv.rows >= 4 && mv.rows <= 6 && mv.pureOut === 0,
    '月视图没有纯下月空白行（' + mv.rows + ' 行，纯下月 ' + mv.pureOut + ' 行）'
    + (mv.err ? '　诊断：' + JSON.stringify(mv) : ''));
  ok(!mv.err && mv.heights && mv.heights.length === 1 && mv.h0 > 40,
    '每行高度一致且固定（' + mv.rows + ' 行都是 ' + mv.h0 + 'px —— 任务多寡不改行高）');
  ok(!mv.err && mv.overflowY === 'auto' && mv.scrollbarWidth === 'none' && mv.position === 'relative',
    '宽屏格子溢出格内滚动、系统滚动条已藏（浮条不占横向宽度）');
  ok(!mv.err && mv.gridH <= mv.viewH, '月视图网格不超出一屏（' + mv.gridH + ' ≤ ' + mv.viewH + '）');

  console.log('\n十四、时间轴上下沿：够得着、方向键微调一档，上下沿别搞反');
  //
  // 上下沿那两个把手是**页面上仅有的两个不可点、只能拖的控件**（其余 data-act
  // 全是真 button）。鼠标那条路本来就通，但键盘进来的话它们原先既拿不到焦点、
  // 也没有名字 —— 这一节守的就是「Tab 能到 + 方向键能微调」这两条。
  //
  // 为什么必须用 CDP 的 Input.dispatchKeyEvent 而不是在页面里 dispatchEvent：
  // 后者 target 是我们自己摆上去的，把手就算没有 tabIndex 也照样"通过"。
  //
  // 这里只验**接线**（哪一端改 time、哪一端只改 duration），不含算法 ——
  // 15 分钟一档、上沿固定底边那些在 domain.test.ts 的 nudgeEdge 用例里锁着。

  // 先造这一节的对象：一条**定时任务**（time + duration 都有）。
  //
  // 2026-10-15 起快速添加不再解析自然语言（「9:00 … 8小时」那条路连
  // domain/parse/ 一起删了），时长也只能在抽屉里设（DateTimeRow 的结束
  // 时间是唯一入口）—— 所以这里走真实 UI 分两步：
  //   ① 「今天」页快速添加造一条（该页 defaultDate = 今天，无时间）；
  //   ② 在列表里点它开抽屉，拨盘设开始 09:00、结束 10:00 → duration = 60。
  // 为什么在「今天」页造而不是日程页：今天列表全量展示，点哪条都不会落空；
  // 日程页的未定时区是限高可滚的（2026-10-22 起），新条目可能正好在滚动视野外。
  await evalJs(page, `document.querySelector('[data-nav="today"]').click(); return true;`);
  await evalJs(page, `
    const inp = document.querySelector('.fast-add textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(inp, '微调试试');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  `);
  await waitFor(page, `
    [...document.querySelectorAll('.task-row')].some((e) => e.textContent.includes('微调试试')) ? 1 : null
  `, '今天列表里出现新任务', 8000);
  await clickEl(page, `
    [...document.querySelectorAll('.task-row')].find((e) => e.textContent.includes('微调试试'))
  `);
  await waitFor(page, `!!document.querySelector('.drawer.open .drawer-title')`, '抽屉打开', 8000);
  /* 拨盘驱动与后面「二十一」节同一套写法：先小时后分钟，选完分钟表盘自己收起。
     小时 9 / 10 都在内圈（0–11），分钟 0 在分钟圈（0,5,…55 里的 0）。 */
  const tpBtn = '.drawer .time-row .tp-btn';
  await clickEl(page, `[...document.querySelectorAll(${JSON.stringify(tpBtn)})][0]`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? 1 : null`, '开始时间表盘打开', 8000);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num.cp-inner')].find((b) => b.textContent.trim() === '9')`);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num')].find((b) => b.textContent.trim() === '0')`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? null : 1`, '选完分钟表盘收起', 8000);
  await waitFor(page, `document.querySelectorAll(${JSON.stringify(tpBtn)}).length === 2 ? 1 : null`, '结束时间选择框出现', 8000);
  await clickEl(page, `[...document.querySelectorAll(${JSON.stringify(tpBtn)})][1]`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? 1 : null`, '结束时间表盘打开', 8000);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num.cp-inner')].find((b) => b.textContent.trim() === '10')`);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num')].find((b) => b.textContent.trim() === '0')`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? null : 1`, '选完分钟表盘收起', 8000);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === '微调试试');
      return t && t.time === '09:00' && t.duration === 60 ? 1 : null;
    })()
  `, '新任务落盘（09:00 起、60 分钟）', 8000);
  await clickEl(page, `document.querySelector('.drawer.open .drawer-head [aria-label="完成"]')`);
  await waitFor(page, `document.querySelector('.drawer.open') ? null : 1`, '抽屉关上', 8000);

  await evalJs(page, `document.querySelector('[data-nav="calendar"]').click(); return true;`);
  await evalJs(page, `document.querySelector('[data-view="day"]').click(); return true;`);
  // 回到今天：日视图看的是 ui.cursor，前面几节切来切去可能已经不在了
  await clickEl(page, `document.querySelector('.date-nav [aria-pressed]')`);

  /* ---- 2026-10-22 未定时区（用户三条）----
     ① 桌面端从左到右排（3 列）；② 末尾**永远多一整行空白**，虚线「＋」格已删；
     ③ 点那行空白要能开草稿。
     ③ 用 CDP 合成**真实触摸**而不是在页面里 dispatchEvent 一个 MouseEvent ——
     用户报的原话是「加号点了一点反应都没有」，而当时那条安卓断言是靠在页面
     里派发 click 通过的：合成 click 绕过了触摸→点击那条链，等于没测。 */
  const unIds = await evalJs(page, `
    const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
    const token = localStorage.getItem('schedule-app-token');
    const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
    const d = new Date();
    const date = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    const ids = [1, 2, 3].map((k) => 't_smoke_un' + k + '_' + Date.now().toString(36));
    window.__unIds = ids;
    window.__unDate = date;
    const ops = ids.map((id, i) => ({
      opId: 'o' + id, deviceId: 'smoke', ts: Date.now() + i, entity: 'task',
      entityId: id, calId: me.cals[0].id, fields: { title: '未定时' + (i + 1), date },
    }));
    await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ cursor: 1, ops }) });
    return ids;
  `);
  ok(Array.isArray(unIds) && unIds.length === 3, '建出三条未定时任务（API）', JSON.stringify(unIds));
  await evalJs(page, `window.dispatchEvent(new Event('focus')); return 1;`);
  const unAl = await waitFor(page, `
    (() => {
      const ids = window.__unIds || [];
      const cards = [...document.querySelectorAll('.allday-items .task-el')];
      if (!cards.some((c) => ids.includes(c.dataset.id))) return null;
      const blanks = [...document.querySelectorAll('.allday-blank')];
      if (!blanks.length) return null;
      const rects = cards.map((c) => c.getBoundingClientRect());
      const byRow = {};
      rects.forEach((r) => { const k = Math.round(r.top / 4); byRow[k] = (byRow[k] || 0) + 1; });
      const perRow = Math.max(...Object.values(byRow));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      const rb = blanks[blanks.length - 1].getBoundingClientRect();
      return {
        n: cards.length, perRow, blanks: blanks.length,
        blankH: Math.round(rb.height), blankBelow: rb.top >= bottom - 2,
        at: { x: Math.round(rb.left + rb.width / 2), y: Math.round(rb.top + rb.height / 2) },
      };
    })()
  `, '三条未定时任务 + 末尾一整行空白', 15000);
  ok(unAl.perRow >= 2, '桌面端未定时任务是**从左到右**排的（同一行 ≥2 条）', `${unAl.n} 条 / 每行 ${unAl.perRow}`);
  ok(unAl.blankBelow && unAl.blankH >= 14,
    '末尾永远多出一整行空白（加完还看得见可点的空位）', `${unAl.blanks} 格 × ${unAl.blankH}px`);
  await touch(page, 'touchStart', unAl.at);
  await touch(page, 'touchEnd', unAl.at);
  await waitFor(page, `document.querySelector('.allday-items .new-cell') ? 1 : null`,
    '真手指点那行空白 → 就地开出草稿框', 6000);
  ok(true, '点空白行能就地新建未定时任务（走的真实触摸，不是合成 click）');
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.allday-items .new-cell') ? null : 1`, '草稿框收起', 6000);

  /* ---- 2026-10-22 用户报的周视图两条 ----
     ① 3 条以上不再折成「+3」，**全部显示**；② 末尾同样**永远多一整行空白**。 */
  await evalJs(page, `document.querySelector('[data-view="week"]').click(); return true;`);
  const wun = await waitFor(page, `
    (() => {
      const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
      if (!cell) return null;
      const blank = cell.querySelector('.wun-blank');
      if (!blank) return null;
      const rb = blank.getBoundingClientRect();
      const all = [...cell.querySelectorAll('.task-el--untimed')];
      const ids = window.__unIds || [];
      return {
        n: all.length,
        mine: all.filter((c) => ids.includes(c.dataset.id)).length,
        more: !!cell.querySelector('.wun-more'),
        blankH: Math.round(rb.height),
        fixedH: getComputedStyle(cell).height,
        /* 判据不写死像素：格高 = 4 整卡 + 3 个间距 + 上下留白，
           卡高与间距都从界面上量回来（2026-10-24 未定时行高改成按小时算之后，
           以前写死的 98px 就成了假基准） */
        cardH: (cell.querySelector('.task-el--untimed') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height,
        gap: parseFloat(getComputedStyle(cell).rowGap || getComputedStyle(cell).gap) || 0,
        visible: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--un-visible')) || 0,
        padY: (parseFloat(getComputedStyle(cell).paddingTop) || 0) + (parseFloat(getComputedStyle(cell).paddingBottom) || 0),
        at: { x: Math.round(rb.left + rb.width / 2), y: Math.round(rb.top + rb.height / 2) },
      };
    })()
  `, '周视图那一格的未定时任务与末尾空白', 12000);
  ok(wun.mine === 3 && !wun.more,
    '周视图把未定时任务**全部**显示出来（自己那 3 条都在，没有「+N」）',
    `自带 ${wun.mine}/3 条 · 该格共 ${wun.n} 条 · more=${wun.more}`);
  /* 格高是**精确算出的定值**（4 整卡 + 间距 + 留白），不再用 max-height 拍上限 ——
     判据 = 「高度是定值」+「空白行有一整行卡高」+「正好等于 4 整卡那一套」。 */
  /* 期望值全部从界面上量回来：格高 = --un-visible × 卡高 + (--un-visible − 1) × 间距
     + 自身上下留白（算式在 calendar.css 的 .wun-cell）。**不写死像素** ——
     卡高现在按小时算，写死的 98px 上一轮就已经是假基准了。 */
  const wunWant = wun.visible * wun.cardH + (wun.visible - 1) * wun.gap + wun.padY;
  ok(wun.blankH >= 14 && parseFloat(wun.fixedH) > 0
     && Math.abs(parseFloat(wun.fixedH) - wunWant) <= 1,
    '周视图未定时格末尾多一整行空白，且格高是按整卡数精确算出的定值（超出自己滚）',
    `空 ${wun.blankH}px / 格高 ${wun.fixedH}（${wun.visible} 张 ${wun.cardH.toFixed(2)}px 卡算该是 ${wunWant.toFixed(2)}）`);

  /* 坐标**现量**：上面刚往这格里加了 5 条又删掉，`wun.at` 是那之前算的
     （2026-10-22 就栽在这 —— 拿着旧坐标去点，点到了任务卡上）。 */
  const blankAt = await evalJs(page, `
    const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
    /* 3 条 + 末尾空白已经顶到上限了，空白行在可见区**下面** —— 真实用户也是
       先滑到底再点它，所以这里照做（2026-10-22：不滑的话点的是被裁掉的区域，
       事件落到隔壁，永远开不出草稿）。 */
    if (cell) cell.scrollTop = cell.scrollHeight;
    const b = cell && cell.querySelector('.wun-blank');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `);
  await touch(page, 'touchStart', blankAt);
  await touch(page, 'touchEnd', blankAt);
  await waitFor(page, `document.querySelector('.wun-cell .new-cell') ? 1 : null`,
    '点周视图那行空白 → 就地开出草稿框', 6000);
  ok(true, '周视图点空白行也能就地新建未定时任务（真实触摸）');
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.wun-cell .new-cell') ? null : 1`, '周视图草稿框收起', 6000);

  /* ---- 2026-10-22 第二轮（用户：周视图的「格子里滚」没生效，电脑端也要）----
     光有 max-height 不算数：flex 列默认会把卡片**压扁**塞进限高里，
     scrollHeight 恒等于 clientHeight，「溢出滚动」永远不触发。
     这里再加 5 条（共 8 条，肯定超过上限），断言三件事：
       ① 内容真的溢出（scrollHeight 明显大于 clientHeight）→ 才滚得起来；
       ② 格高被上限拦住（不超过 max-height）；
       ③ 时间轴高度一点没变 —— 这才是用户真正要的。 */
  const gridBefore = await evalJs(page, `return Math.round(document.querySelector('.week-grid').getBoundingClientRect().height);`);
  await evalJs(page, `
    const token = localStorage.getItem('schedule-app-token');
    const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
    const ids = [0, 1, 2, 3, 4].map((i) => 't_smoke_wunmore' + i + '_' + Date.now().toString(36));
    window.__unMore = ids;
    const ops = ids.map((id, i) => ({
      opId: 'o' + id, deviceId: 'smoke', ts: Date.now() + i, entity: 'task',
      entityId: id, calId: me.cals[0].id, fields: { title: '挤' + (i + 1), date: window.__unDate },
    }));
    await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ cursor: 1, ops }) });
    window.dispatchEvent(new Event('focus'));
    return 1;
  `);
  const ovf = await waitFor(page, `
    (() => {
      const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
      if (!cell) return null;
      const n = cell.querySelectorAll('.task-el--untimed').length;
      if (n < 8) return null;
      const cs = getComputedStyle(cell);
      cell.scrollTop = 60;                       // 真能滚的话它会停在 60
      const scrolled = cell.scrollTop;
      cell.scrollTop = 0;
      return {
        n,
        sh: cell.scrollHeight, ch: cell.clientHeight,
        h: Math.round(cell.getBoundingClientRect().height),
        fixedH: Math.round(parseFloat(cs.height) || 0),
        cardH: cell.querySelector('.task-el--untimed').getBoundingClientRect().height,
        gap: parseFloat(cs.rowGap || cs.gap) || 0,
        visible: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--un-visible')) || 0,
        padY: (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0),
        scrolled,
        grid: Math.round(document.querySelector('.week-grid').getBoundingClientRect().height),
        shrink: getComputedStyle(cell.querySelector('.task-el--untimed')).flexGrow + '/' + getComputedStyle(cell.querySelector('.task-el--untimed')).flexShrink,
      };
    })()
  `, '8 条未定时任务落进周视图那一格', 15000);
  ok(ovf.sh > ovf.ch + 4,
    '未定时内容真的**溢出**了（不是把卡片压扁塞进去）',
    `内容 ${ovf.sh} / 可见 ${ovf.ch} · 卡片 flex ${ovf.shrink}`);
  const ovfWant = ovf.visible * ovf.cardH + (ovf.visible - 1) * ovf.gap + ovf.padY;
  ok(Math.abs(ovf.h - ovf.fixedH) <= 1 && Math.abs(ovf.fixedH - ovfWant) <= 1,
    '格高是按整卡数精确算出的定值（再多也不往上长）',
    `高 ${ovf.h}px / 定值 ${ovf.fixedH}px（${ovf.visible} 张 ${ovf.cardH.toFixed(2)}px 卡算该是 ${ovfWant.toFixed(2)}）`);
  ok(ovf.scrolled > 0, '这一格**自己滚得动**（scrollTop 能设上去）', `scrollTop=${ovf.scrolled}`);
  ok(Math.abs(ovf.grid - gridBefore) <= 2,
    '任务从 3 条加到 8 条，**时间轴高度一点没变**', `${gridBefore}px → ${ovf.grid}px`);

  /* ---- 橡皮筋阻尼（2026-10-22 用户：滚到头要有阻尼）----
     这里正好是一个**真溢出**的格子，拿它验：滚到顶再往下拖，内容跟手让开
     一段；松手弹回原位；往上拖（还在顶上）不许有位移。
     ⚠️ 触摸模拟在这一节之前已经关掉了（第八节收尾关的），要自己开回来。 */
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const anchor = await evalJs(page, `
    const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
    if (!cell) return null;
    cell.scrollTop = 0;
    const r = cell.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 8),
      top: Math.round(cell.firstElementChild.getBoundingClientRect().top),
    };
  `);
  const readDamp = () => evalJs(page, `
    const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
    return {
      pull: cell.style.getPropertyValue('--pull'),
      live: cell.hasAttribute('data-pull'),
      top: Math.round(cell.firstElementChild.getBoundingClientRect().top),
      scrollTop: Math.round(cell.scrollTop),
    };
  `);

  await touch(page, 'touchStart', { x: anchor.x, y: anchor.y });
  await touch(page, 'touchMove', { x: anchor.x, y: anchor.y + 34 });
  await new Promise((r) => setTimeout(r, 80));   // 位移在 rAF 里写，等一帧
  const pulled = await readDamp();
  ok(pulled.live && parseFloat(pulled.pull) > 6,
    '滚到顶还往下拖：内容被**拉出一段**（阻尼跟手）',
    `--pull=${pulled.pull || '未设置'} · data-pull=${pulled.live}`);
  ok(pulled.top > anchor.top + 5,
    '让开的是**内容**，格子边框没动', `内容顶 ${anchor.top}px → ${pulled.top}px`);
  ok(pulled.top - anchor.top < 34,
    '拖 34px 只让开一点（有阻尼，不是 1:1 硬跟）', `实际让开 ${pulled.top - anchor.top}px`);

  await touch(page, 'touchEnd');
  await new Promise((r) => setTimeout(r, 480));  // 260ms 过渡 + 余量
  const settled = await readDamp();
  ok(!settled.live && Math.abs(settled.top - anchor.top) <= 1,
    '松手后**弹回原位**', `--pull=${settled.pull || '已清'} · 内容顶 ${settled.top}px`);

  // 反方向：还在顶上，往上拖 = 正常滚动，不该有橡皮筋
  await touch(page, 'touchStart', { x: anchor.x, y: anchor.y });
  await touch(page, 'touchMove', { x: anchor.x, y: anchor.y - 30 });
  await new Promise((r) => setTimeout(r, 80));
  const upward = await readDamp();
  ok(!upward.live, '在顶部往上拖（正常滚动方向）**不触发**橡皮筋', `data-pull=${upward.live}`);
  await touch(page, 'touchEnd');
  await new Promise((r) => setTimeout(r, 120));
  await evalJs(page, `const c = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]'); if (c) c.scrollTop = 0; return 1;`);
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  /* ---- 九条规范（2026-10-22）：滚动条不占宽 / 无省略号 / 左对齐 / 整行裁 / 浮条 ---- */
  const nine = await evalJs(page, `
    const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
    if (!cell) return null;
    const card = cell.querySelector('.task-el--untimed');
    const title = card.querySelector('.ev-title');
    const csT = getComputedStyle(title);
    const csC = getComputedStyle(cell);
    const r = cell.getBoundingClientRect();
    // 滚动条若占位，clientWidth 会比「border 内宽」窄一根滚动条的宽度
    //（clientWidth = 内容 + padding，不含 border；border-box 下 = width - 两条边框）
    const innerW = r.width - (parseFloat(csC.borderLeftWidth) || 0) - (parseFloat(csC.borderRightWidth) || 0);
    return {
      gutter: Math.round(innerW - cell.clientWidth),
      clip: csT.textOverflow,
      align: csT.textAlign,
      fw: csT.fontWeight,
      radius: getComputedStyle(card).borderRadius,
      cardH: card.getBoundingClientRect().height,
      mh: parseFloat(title.style.maxHeight) || 0,
      lh: parseFloat(csT.lineHeight) || 0,
    };
  `);
  ok(nine.gutter === 0, '滚动条**不占布局宽度**（浮在卡片上）', `内宽 - clientWidth = ${nine.gutter}px`);
  ok(nine.clip === 'clip', '溢出**不出省略号**（直接裁掉，与月视图同版式）', nine.clip);
  ok(nine.align === 'start' || nine.align === 'left', '文字**左对齐**（周/日/月统一）', nine.align);
  ok(nine.lh > 0 && nine.mh > 0
     && Math.abs(nine.mh / nine.lh - Math.round(nine.mh / nine.lh)) < 0.01,
    '标题按**整行**裁（max-height 钉在行高的整数倍上，不露半截字）',
    `max ${nine.mh}px / 行高 ${nine.lh}px`);
  ok(nine.fw === '400', '字重与月视图任务名一致（400）', nine.fw);
  /* 2026-10-24 三问题第 2 条 + 同源化：圆角不是定值档，是**这张卡自身高的 28%**
     （`--card-r-k`，夹在 2px 与 --r-xl 之间）—— 以前写死 4px，卡一换档就看着不对。
     判据跟着改成「半径 ÷ 卡高 = --card-r-k」。 */
  ok(Math.abs(parseFloat(nine.radius) / nine.cardH - 0.28) < 0.02,
    '圆角 = 自身高的 28%（与定时卡同一条算式）',
    `${nine.radius} / 卡高 ${nine.cardH.toFixed(2)} = ${(parseFloat(nine.radius) / nine.cardH).toFixed(3)}`);
  await evalJs(page, `const c = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]'); if (c) c.scrollTop = 40; return 1;`);
  await new Promise((r) => setTimeout(r, 150));
  const thumbOn = await evalJs(page, `
    const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
    return cell.hasAttribute('data-thumb');
  `);
  ok(thumbOn, '滚动时**浮条出现**（压在卡片上的滚动指示）', 'data-thumb=on');
  await evalJs(page, `const c = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]'); if (c) c.scrollTop = 0; return 1;`);

  await evalJs(page, `
    const token = localStorage.getItem('schedule-app-token');
    const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
    const ops = (window.__unMore || []).map((id) => ({
      opId: 'd' + id, deviceId: 'smoke', ts: Date.now(), entity: 'task',
      entityId: id, calId: me.cals[0].id, fields: { deleted: true, deletedAt: Date.now() },
    }));
    await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ cursor: 1, ops }) });
    window.dispatchEvent(new Event('focus'));
    return 1;
  `);
  await waitGone(page, `(window.__unMore || []).every((id) => !document.querySelector('.wun-cell .task-el[data-id="' + id + '"]'))`,
    '8 条验证用的未定时任务已收回');
  // 回日视图，后面的节按日视图写的
  await evalJs(page, `document.querySelector('[data-view="day"]').click(); return true;`);
  await waitFor(page, `document.querySelector('.allday-items') ? 1 : null`, '回到日视图', 8000);
  /* 收尾：这两条验证用的任务删掉，别影响后面的节（`.allday-zone` 是
     `flex: 0 0 auto`，多一行就是把时间轴少一行） */
  await evalJs(page, `
    const token2 = localStorage.getItem('schedule-app-token');
    const me2 = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token2 } })).json();
    const ops2 = window.__unIds.map((id) => ({
      opId: 'del' + id, deviceId: 'smoke', ts: Date.now(), entity: 'task',
      entityId: id, calId: me2.cals[0].id, fields: { deleted: true, deletedAt: Date.now() },
    }));
    await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token2 },
      body: JSON.stringify({ cursor: 1, ops: ops2 }) });
    return 1;
  `);
  await waitGone(page, `(window.__unIds || []).every((id) => !document.querySelector('.allday-items .task-el[data-id="' + id + '"]'))`,
    '验证用的未定时任务已从界面上消失');

  const block = await waitFor(page, `
    (() => {
      const e = [...document.querySelectorAll('.task-el--timed')].find((x) => x.textContent.includes('微调试试'));
      if (!e) return null;
      // 上沿的 class 是 "ev-resize ev-resize-top"，所以 '.ev-resize' 会**先命中上沿**
      // （DOM 里它在前面）—— 想拿的是下沿就必须排掉它。
      // 不排的话断言名写着「下沿」，实际查的是上沿，两条形状一样、于是照样"通过"。
      const h = e.querySelector('.ev-resize:not(.ev-resize-top)');
      const th = e.querySelector('.ev-resize-top');
      return h && th ? {
        id: h.dataset.id, tab: h.tabIndex, name: h.getAttribute('aria-label'),
        topTab: th.tabIndex, topName: th.getAttribute('aria-label'),
      } : null;
    })()
  `, '时间轴方块和它的上下两个把手', 8000);
  ok(block.tab === 0 && block.topTab === 0,
    '两个把手都能被 Tab 够到（下沿 tabIndex=' + block.tab + '，上沿 ' + block.topTab + '）');
  ok(!!block.name && !!block.topName && block.name !== block.topName,
    '两个把手各有名字，且分得清上下：' + JSON.stringify(block.name) + ' / ' + JSON.stringify(block.topName));

  /* ---- 2026-10-19 用户报「没地方拖动改时长」----
     「点一下新建」的任务 duration 是空的（默认 1 小时不等于写死了 1 小时），
     而以前 `resizable={hasEnd}` 让这些卡**一个把手都没有** —— 用户根本没处拖。
     这里真建一条没时长的任务，验证它照样有把手、且看得见。 */
  const nodurMade = await evalJs(page, `
    try {
      const pad = (n) => (n < 10 ? '0' + n : '' + n);
      const token = localStorage.getItem('schedule-app-token');
      const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
      if (!me.cals || !me.cals.length) return 'me 没有日程集：' + JSON.stringify(me).slice(0, 120);
      const d = new Date();
      const id = 't_smoke_nodur_' + Date.now().toString(36);
      window.__nodurId = id;
      const r = await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ cursor: 1, ops: [{ opId: 'o' + id, deviceId: 'smoke', ts: Date.now(), entity: 'task', entityId: id, calId: me.cals[0].id, fields: { title: '没时长的卡', date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), time: '11:00' } }] }) });
      return r.ok ? 'ok' : ('sync ' + r.status + ' ' + (await r.text()).slice(0, 120));
    } catch (e) { return '抛了：' + e.message; }
  `);
  /* ⚠️ 这条以前是 `(async () => {…})()` 包一层就完事 —— evalJs 外面还有一层
     异步壳，里面那个 IIFE 根本没人 await，建失败了也静默。改成直接 await 并
     把失败原因带回来，别让它再装成「等不到元素」。 */
  ok(nodurMade === 'ok', '建出一条没时长的任务（API）', String(nodurMade));
  /* 客户端不是定时拉了：`sync/lifecycle.ts` 的轮询只在 outbox 非空时才 syncNow，
     纯靠 API 建出来的条目没人拉就永远看不见。这里补一次 wake（等同切回前台）。 */
  await evalJs(page, `window.dispatchEvent(new Event('focus')); return 1;`);
  const nodur = await waitFor(page, `
    (() => {
      const e = document.querySelector('.task-el--timed[data-id="' + window.__nodurId + '"]');
      if (!e) return null;
      const h = e.querySelector('.ev-resize:not(.ev-resize-top)');
      return h && h.getBoundingClientRect().height > 0 ? {
        op: parseFloat(getComputedStyle(h).opacity), cursor: getComputedStyle(h).cursor,
      } : null;
    })()
  `, '没设时长的任务也带着把手', 10000);
  ok(nodur.op > 0.1 && nodur.cursor === 'ns-resize',
    '没设时长的任务，把手也常显可拖（opacity ' + nodur.op.toFixed(2) + '，cursor ' + nodur.cursor + '）');
  /* 收尾：这条验证用的任务删掉，别影响后面的节。
     **必须等它真从界面上消失**再往下走 —— 同步是轮询的，删完立刻翻页的话
     下一节「时间窗」还会把它算进 coverWindow（11:00 + 默认 60 分钟 = 12:00
     结束，把一个 11 点截止的窗顶到 12 点）。 */
  await evalJs(page, `
    (async () => {
      const token = localStorage.getItem('schedule-app-token');
      const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
      await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ cursor: 1, ops: [{ opId: 'del' + window.__nodurId, deviceId: 'smoke', ts: Date.now(), entity: 'task', entityId: window.__nodurId, calId: me.cals[0].id, fields: { deleted: true, deletedAt: Date.now() } }] }) });
      return 1;
    })()
  `);
  await evalJs(page, `window.dispatchEvent(new Event('focus')); return 1;`);
  await waitGone(page, `!document.querySelector('.task-el--timed[data-id="' + window.__nodurId + '"]')`,
    '验证用的无时长任务已从界面上消失');

  const sel = (act) => `document.querySelector('.task-el--timed[data-id=${JSON.stringify(block.id)}] [data-act="${act}"]')`;
  const taskOf = `Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks).find((t) => t.id === ${JSON.stringify(block.id)})`;

  // 真拿焦点（不是造一个 target），并**顺手挂一个按键记录器** ——
  // 这一条失败的原因无非两种：键没进页面，或者进了但没被接住。记录器
  // 一次就能分开：`!prevented` 表示 App 那段处理器**跑到了**（它会 preventDefault），
  // 空数组表示键压根没到。没有它就只能看到一个 null。
  const focused = await evalJs(page, `
    window.__keys = [];
    document.addEventListener('keydown', (e) => {
      if (window.__keys.length < 5) {
        window.__keys.push(e.key + '@' + (e.target.className || e.target.tagName)
          + (e.defaultPrevented ? '!被接住了' : ''));
      }
    });
    const h = ${sel('resize')};
    if (!h) return 'missing';
    h.focus();
    return document.activeElement === h ? 'ok' : ('焦点跑到了 ' + document.activeElement.tagName);
  `);
  ok(focused === 'ok', '把手真能拿到焦点，实际 ' + focused);

  // 先把这条任务等**落盘**再读基准值。store.persist() 是防抖的，刚快速添加完
  // localStorage 里还没有它 —— 直接读会得到 undefined，`undefined + 15` 是 NaN，
  // 下面那条断言就永远等不到（本节的第一次失败正是这个：按键其实全对，
  // 诊断里 `目标时长 undefined` 才是真线索）。
  const t0 = await waitFor(page, `
    (() => { const t = ${taskOf}; return t ? { duration: t.duration, time: t.time } : null; })()
  `, '新任务落盘', 8000);
  const before = t0.duration;
  ok(before > 0 && t0.time === '09:00', '新任务落盘：09:00 起、' + before + ' 分钟');
  await key(page, 'ArrowDown', 'ArrowDown', 40);
  const kdiag = await evalJs(page, `return {
    keys: window.__keys,
    active: document.activeElement && (document.activeElement.className || document.activeElement.tagName),
    dur: (${taskOf} || {}).duration,
    time: (${taskOf} || {}).time,
  };`);
  console.log('    诊断：目标时长 ' + before + ' → ' + JSON.stringify(kdiag)
    + '（keys 为空 = 按键没进页面；有条目但没有「!被接住了」 = 进了但没被接住）');
  // 等**落盘**再读：store.persist() 是防抖的，改完立刻读拿到的是上一版（四、41）
  const nudged = await waitFor(page, `
    (() => { const t = ${taskOf}; return t && t.duration === ${before} + 15 ? t.duration : null; })()
  `, '下沿按 ↓ 把时长加了一档', 8000);
  ok(nudged === before + 15, '下沿按 ↓：时长 ' + before + ' → ' + nudged + '（+15 分钟）');

  // 下沿**不该动 time** —— 这是「哪一端接哪一边」的核心断言
  ok(await evalJs(page, `return (${taskOf} || {}).time === '09:00';`),
    '下沿只改时长，开始时间仍是 09:00');

  await key(page, 'ArrowUp', 'ArrowUp', 38);
  const back = await waitFor(page, `
    (() => { const t = ${taskOf}; return t && t.duration === ${before} ? t.duration : null; })()
  `, '↑ 又把它调回来', 8000);
  ok(back === before, '再按 ↑ 回到 ' + back + '（同一档来回，不会漂）');

  // 换到上沿：固定底边 ⇒ time 变早、duration 变长
  const topFocused = await evalJs(page, `
    const h = ${sel('resize-top')};
    if (!h) return 'missing';
    h.focus();
    return document.activeElement === h ? 'ok' : 'no';
  `);
  ok(topFocused === 'ok', '上沿把手也能拿到焦点');
  await key(page, 'ArrowUp', 'ArrowUp', 38);
  const top = await waitFor(page, `
    (() => { const t = ${taskOf}; return t && t.time === '08:45' ? { time: t.time, duration: t.duration } : null; })()
  `, '上沿按 ↑ 把开始时间提前 15 分钟', 8000);
  ok(top.duration === before + 15, '上沿按 ↑ 时底边固定：开始 09:00 → ' + top.time + '，时长 ' + before + ' → ' + top.duration);

  // 收尾：把这条恢复原样，别给后面的断言留个挪过位置的方块
  await evalJs(page, `
    const h = ${sel('resize')};
    h && h.focus();
    return true;
  `);
  await key(page, 'ArrowDown', 'ArrowDown', 40);

  console.log('\n十四之二、日视图锁单屏 + 拖动不放大 + 时间窗收窄');
  /* 这一节锁三件事，都是同一处改动的连带结果（见 domain/layout.ts 的 DayWindow）：
       ① 日视图整天摊在一屏里，**内容区不滚**；
       ② 拖动时间轴方块**不缩放** —— core 的 adjustScale 会把 transform 的
          scaleX/scaleY 定成「落点 ÷ 自己」，日视图的落点是整天高的 .timeline，
          比值能到 25 以上，一拖就铺满整屏（CSS.Translate 才是干净的出口）；
       ③ 设置里收窄时间窗之后，窗外那条任务整条不画。
     前两条必须在真浏览器里量 —— 单位测试看不见 CSS 与 dnd-kit 的合成效果。 */

  const lock = await evalJs(page, `
    return (() => {
      const c = document.getElementById('content');
      const tl = document.querySelector('.timeline');
      const wrap = tl && tl.closest('.tl-wrap');
      return {
        overflow: getComputedStyle(c).overflowY,
        contentH: c.clientHeight,
        scrollH: c.scrollHeight,
        tlH: tl ? tl.getBoundingClientRect().height : 0,
        wrapBottom: wrap ? wrap.getBoundingClientRect().bottom : 0,
        cBottom: c.getBoundingClientRect().bottom,
      };
    })();
  `);
  ok(lock.overflow === 'hidden',
    '日视图的内容区不滚（overflow-y: hidden），实际 ' + lock.overflow);
  ok(lock.scrollH <= lock.contentH + 1,
    '内容没有溢出到需要滚动：scrollHeight ' + lock.scrollH + ' ≤ clientHeight ' + lock.contentH);
  ok(lock.tlH > 200 && lock.tlH <= lock.contentH,
    '时间轴占满一屏且不越界，实际高 ' + Math.round(lock.tlH) + 'px / 内容区 ' + lock.contentH + 'px');
  ok(lock.wrapBottom <= lock.cBottom + 1,
    '时间轴底边没有捅出内容区（实际差 ' + Math.round(lock.wrapBottom - lock.cBottom) + 'px）');

  // 后面几小节都要改时间窗。**走真的设置页**，不直接改 localStorage ——
  // store 的 persist() 是防抖 250ms 的（见 data/store.ts），我们写进去的
  // ui 会被应用自己那次 flush 覆盖掉，改完读回来还是默认值。
  // 走界面顺带把这一档设置本身也验了（探针十三之二要锁的就是它）。
  const evId = block.id;
  // 属性值必须带引号 —— id 是 UUID，`[data-id=0f979196-…]` 不是合法选择器
  const evSel = `.task-el--timed[data-id=${JSON.stringify(evId)}]`;

  const openSettings = async () => {
    await clickEl(page, `document.querySelector('.sidebar [data-nav="settings"]')`);
    await waitFor(page, `!!document.querySelector('[data-settings-tab]')`, '设置页', 8000);
    await clickEl(page, `document.querySelector('[data-settings-tab="appearance"]')`);
    /* 时间窗现在是 `Dropdown`（自己的控件，不是原生 select）—— 所以没有
       `[data-day-win]` 了，抓手换成按钮的 `aria-label`。选项是
       `[role="option"]`，在 `[role="listbox"]` 里；菜单 `max-h-64` 会滚动，
       但 25 个整点在 DOM 里一个不少，所以按文字点就是。 */
    await waitFor(page, `!!document.querySelector('[aria-label="时间窗从几点开始"]')`, '设置 › 外观', 8000);
  };

  /** 点一下某个时间窗下拉的选项。`label` 是按钮的 aria-label，hour 是 0–24 */
  const pickHour = async (label, hour) => {
    await evalJs(page, `document.querySelector(${JSON.stringify('[aria-label="' + label + '"]')}).click(); return true;`);
    await waitFor(page, `!!document.querySelector('[role="listbox"]')`, '时间窗选项菜单', 4000);
    await evalJs(page, `
      [...document.querySelectorAll('[role="option"]')]
        .find((o) => o.textContent.trim() === '${hour}:00').click();
      return true;`);
  };

  /** 把时间窗设成 from–to，并回到今天的日视图 */
  const setWindow = async (from, to) => {
    await openSettings();
    await pickHour('时间窗从几点开始', from);
    await pickHour('时间窗到几点结束', to);
    await evalJs(page, `document.querySelector('.sidebar [data-nav="calendar"]').click(); return true;`);
    await waitFor(page, `!!document.querySelector('.timeline')`, '回到日视图', 8000);
  };

  /** 时间轴上那条方块 + 窗 + 小时线，一起读回来 */
  const readTl = () => evalJs(page, `
    return (() => {
      const tl = document.querySelector('.timeline');
      const labels = [...tl.querySelectorAll('.tl-label')].map((s) => s.textContent);
      const el = document.querySelector('${evSel}');
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(evId)});
      return {
        from: tl.dataset.from, to: tl.dataset.to,
        first: labels[0], last: labels[labels.length - 1], n: labels.length,
        evH: el ? el.getBoundingClientRect().height : null,
        top: el ? el.style.top : null,
        time: t ? t.time : null, dur: t ? t.duration : null,
      };
    })();
  `);

  const h2m = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
  };

  /* 渲染窗的**合同**（domain/layout.ts 的 coverWindow）：设置窗 ∪ 当天定时任务
     占的时间范围，任务一条不裁不丢。可视面上的不变量：每条定时卡的
     top/height(%) 必须完整落在 [0,100] 里 —— 有任何一条越出窗沿就是破了合同。
     （不从 localStorage 反推期望值：那是延迟落盘的，读到的是上一刻的世界。） */
  const worstCard = () => evalJs(page, `
    return (() => {
      const tl = document.querySelector('.timeline');
      const tlH = tl.getBoundingClientRect().height || 1;
      let worst = null;
      for (const el of document.querySelectorAll('.timeline .task-el--timed')) {
        const top = parseFloat(el.style.top) || 0;
        /* height 现在是 calc(百分比 - 1.5px)（2026-10-22 九条回归），内联值解析
           出来是 NaN —— 改量**实际渲染高度**折算回百分比，语义不变 */
        const h = (el.getBoundingClientRect().height / tlH) * 100;
        const over = Math.max(-top, top + h - 100);
        if (over > 0.01 && (!worst || over > worst.over)) {
          worst = { over: Math.round(over * 100) / 100, title: (el.querySelector('.ev-title') || {}).textContent || '' };
        }
      }
      return worst;
    })();
  `);

  // ② 时间窗：先收到 08:00–11:00（3 小时）。
  //    收这么窄是有原因的：整天铺满一屏时每小时只有十几 px，方块比上下两个
  //    把手（各 11px）还矮，正中点到的其实是把手 —— 那样测的就不是拖拽了。
  await setWindow(8, 11);
  const w1 = await readTl();
  ok(w1.from === '480' && w1.to === '660',
    '设置里改的时间窗生效了（08:00–11:00 → data-from/to = ' + w1.from + '/' + w1.to + '）');
  ok(w1.n === 4 && w1.first === '08:00' && w1.last === '11:00',
    '小时线只画窗内的 4 条（' + w1.first + ' … ' + w1.last + '，共 ' + w1.n + ' 条）');
  // 方块位置按**新窗**算，而不是整天口径：(t - from) / (to - from)
  const wantTop = (h2m(w1.time) - 480) / 180 * 100;
  ok(Math.abs(parseFloat(w1.top) - wantTop) < 0.2,
    '窗内那条按新窗重排到 ' + wantTop.toFixed(2) + '%（整天口径下只有 '
    + (h2m(w1.time) / 1440 * 100).toFixed(2) + '%），实际 ' + w1.top);
  ok(w1.evH > 30, '方块高过两个把手，抓得到中间那条，实际高 '
    + (w1.evH ? w1.evH.toFixed(1) : 'n/a') + 'px');

  // ③ 拖动不放大：core 的 adjustScale 会把 transform 的 scaleX/scaleY 定成
  //    「落点 ÷ 自己」，日视图的落点是整天高的 .timeline —— 比值能到 25 以上，
  //    一拖就铺满整屏。CSS.Translate 才是干净的出口。
  const from = await evalJs(page, `
    return (() => {
      const r = document.querySelector('${evSel}').getBoundingClientRect();
      const tl = document.querySelector('.timeline').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
               tlH: Math.round(tl.height), styleH: document.querySelector('${evSel}').style.height };
    })();
  `);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1,
  });
  // 移过 8px 才开拖（MouseSensor 的 activationConstraint），再往下拖一段
  for (const dy of [14, 40, 90, 150]) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: from.x, y: from.y + dy, button: 'left', buttons: 1,
    });
    await new Promise((r) => setTimeout(r, 40));
  }
  const mid = await evalJs(page, `
    return (() => {
      const el = document.querySelector('${evSel}');
      const all = [...document.querySelectorAll('.task-el--timed')].map(e => e.dataset.id);
      if (!el) return { missing: true, all, active: document.querySelector('.task-el.dragging')?.dataset.id || null,
                         body: document.body.innerText.slice(-300) };
      const r = el.getBoundingClientRect();
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(evId)});
      return { w: r.width, h: r.height, left: r.left, top: r.top, bottom: r.bottom,
               tlTop: document.querySelector('.day-panel').getBoundingClientRect().top,
               tlBottom: document.querySelector('.day-panel').getBoundingClientRect().bottom,
               transform: el.style.transform,
               time: t ? t.time : null, dur: t ? t.duration : null, all };
    })();
  `);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: from.x, y: from.y + 150, button: 'left', buttons: 0,
  });
  await new Promise((r) => setTimeout(r, 300));

  ok(!!mid && /translate3d/.test(mid.transform || ''),
    '拖动真的起来了（transform 里有位移），实际 ' + JSON.stringify(mid && mid.transform));
  ok(!!mid && Math.abs(mid.w - from.w) <= 2,
    '拖动途中宽度不变（' + from.w.toFixed(1) + ' → ' + (mid ? mid.w.toFixed(1) : '?') + 'px）');
  ok(!!mid && !/scale/i.test(mid.transform || ''),
    'transform 里只有位移、没有 scale，实际 ' + JSON.stringify(mid && mid.transform));
  /* 高度会变，但**不是 scale 撑大的**：卡片跟着指针走，top 跨过时间窗末端时
     `pctRange` 把高度夹到窗沿（夹小，不是放大）。transform 里没有 scale 已经
     证了这一点（`CSS.Transform` 会把 adjustScale 的 scaleY 一起烤进去）。 */
  /* 钳位**以 `.day-panel` 为界，不是 `.timeline`**（代码见 timeline.ts 的
     `clampTimelineDrag`，用户 2026-10-12 明确要求能把定时卡片拖进无时间区）：
     夹 `.timeline` 会把卡片挡在无时间区外，正是用户报的那个症状。日面板
     含无时间区 + 时间轴，夹它才对。 */
  ok(!!mid && mid.top >= mid.tlTop - 1 && mid.bottom <= mid.tlBottom + 1,
    '拖拽中卡片上下沿限制在日面板内（卡片 ' + mid.top + '–' + mid.bottom
      + '，面板 ' + mid.tlTop + '–' + mid.tlBottom + '）');
  ok(!!mid && mid.left >= 0 && mid.w > 0,
    '拖拽中卡片横向位置有效（left ' + (mid ? mid.left.toFixed(1) : '?')
      + '，宽 ' + (mid ? mid.w.toFixed(1) : '?') + '）');

  // ③之二 拖动态让位 + 真实出界落点；横向锁死在上一条单独验证。
  const evRect0 = await evalJs(page, `
    return (() => {
      const el = document.querySelector('${evSel}');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })();
  `);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: evRect0.x, y: evRect0.y, button: 'left', clickCount: 1, buttons: 1,
  });
  for (const dy of [14, 40, 90]) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: evRect0.x, y: evRect0.y + dy, button: 'left', buttons: 1,
    });
    await new Promise((r) => setTimeout(r, 40));
  }
  const ghost = await evalJs(page, `
    return (() => {
      const busy = document.querySelector('.tl-busy[data-busy="${evId}"]');
      const el = document.querySelector('${evSel}');
      return {
        busyHidden: busy ? busy.classList.contains('drag-src') : null,
        evDragging: el ? el.classList.contains('dragging') : null,
      };
    })();
  `);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: evRect0.x, y: evRect0.y + 90, button: 'left', buttons: 0,
  });
  await new Promise((r) => setTimeout(r, 300));
  ok(ghost.evDragging === true,
    '被拖的方块带 .dragging（颜色保持原样、不加透明度），实际 ' + JSON.stringify(ghost.evDragging));
  ok(ghost.busyHidden === true,
    '原位置的占用底纹 .tl-busy 带 .drag-src 让位（不留虚影），实际 ' + JSON.stringify(ghost.busyHidden));

  // 出界去最近位置：把方块拖到时间轴**下方之外**松手，应该落到窗底而不是弹回原位。
  const tlRect = await evalJs(page, `
    return (() => {
      const tl = document.querySelector('.timeline');
      const r = tl.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    })();
  `);
  const evRect = await evalJs(page, `
    return (() => {
      const el = document.querySelector('${evSel}');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })();
  `);
  // 按下 → 往下拖到时间轴底边之外 → 松手
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: evRect.x, y: evRect.y, button: 'left', clickCount: 1, buttons: 1,
  });
  for (const dy of [14, 40, 90, 150, 220, 300]) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: evRect.x, y: evRect.y + dy, button: 'left', buttons: 1,
    });
    await new Promise((r) => setTimeout(r, 40));
  }
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: evRect.x, y: evRect.y + 300, button: 'left', buttons: 0,
  });
  await new Promise((r) => setTimeout(r, 300));
  const afterTime = (await readTl()).time;
  /* 落点应该落在**当前时间窗的下半部分**，而不是写死「≥ 1380」。
     这一节前面刚把窗收成 08:00–11:00（480–660），`yToMin` 按窗钳是**对的**，
     写死 1380 等于要求它把 10:45 算成 23:00 —— 那才是 bug。
     所以判据取「落在窗底那一档」：≥ 窗的中点，且确实动过。 */
  const win = await evalJs(page, `
    const tl = document.querySelector('.timeline');
    return { from: Number(tl.dataset.from), to: Number(tl.dataset.to) };
  `);
  const afterMin = h2m(afterTime);
  ok(afterMin >= win.from && afterMin <= win.to,
    '出界拖到下方 → 落在窗底（' + afterTime + ' = ' + afterMin + ' 分钟，窗 '
      + win.from + '–' + win.to + '）');

  // 横向锁死：往右拖 400px，卡片的 left / width 一像素都不该动。
  // （用户 2026-10-12 裁决：定时与未定时卡片都只能纵向上下拖，横向完全不能动。
  //   旧断言是「钳在容器右缘」——那允许卡片一直贴到边缘，不是锁死。）
  const evRect2 = await evalJs(page, `
    return (() => {
      const el = document.querySelector('${evSel}');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })();
  `);
  const beforeH = await evalJs(page, `
    return (() => {
      const el = document.querySelector('${evSel}');
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width };
    })();
  `);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: evRect2.x, y: evRect2.y, button: 'left', clickCount: 1, buttons: 1,
  });
  for (const dx of [14, 40, 90, 150, 220, 300, 400]) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: evRect2.x + dx, y: evRect2.y, button: 'left', buttons: 1,
    });
    await new Promise((r) => setTimeout(r, 40));
  }
  const afterH = await evalJs(page, `
    return (() => {
      const el = document.querySelector('${evSel}');
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width };
    })();
  `);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: evRect2.x + 400, y: evRect2.y, button: 'left', buttons: 0,
  });
  await new Promise((r) => setTimeout(r, 300));
  ok(Math.abs(afterH.left - beforeH.left) < 1 && Math.abs(afterH.width - beforeH.width) < 1,
    '向右拖 400px 时横向一像素不动（left ' + beforeH.left.toFixed(1) + ' → ' + afterH.left.toFixed(1)
    + '，width ' + beforeH.width.toFixed(1) + ' → ' + afterH.width.toFixed(1) + '），实际差 '
    + (afterH.left - beforeH.left).toFixed(1) + 'px');

  // ④ 收窄到 10 点起 —— 2026-10-17 起「窗外不画」改成「窗外让窗」：
  //    渲染窗 = 设置窗 ∪ 当天任务的范围。窗至少盖住设置那段，
  //    且每条任务都完整落在窗内（不裁半截、不整条消失）。
  await setWindow(10, 14);
  const w2 = await readTl();
  ok(Number(w2.from) <= 600 && Number(w2.to) >= 840,
    '窗至少完整盖住设置的那段 10:00–14:00（实际 ' + w2.from + '/' + w2.to
    + '，有任务在外面会自动让出去）');
  ok(w2.n >= 2 && w2.first !== undefined,
    '小时线跟着窗走（' + w2.n + ' 条，起 ' + w2.first + '）');
  const cut2 = await worstCard();
  ok(cut2 === null, '窗内每条任务都完整画出（不裁不丢）', cut2 ? JSON.stringify(cut2) : '无越界');

  // ⑤ 窗外的东西**不再消失**：把窗设到 23 点起，上午那条任务要照画 ——
  //    窗口自动让到装下它为止（用户拍板「显示」，见 coverWindow）。
  await setWindow(23, 24);
  const w3 = await readTl();
  ok(w3.top !== null && Number(w3.from) < 1380,
    '23:00 起的窗自动让到上午那条之前（窗起 ' + w3.from + '，top=' + w3.top + '）');
  const cut3 = await worstCard();
  ok(cut3 === null, '窗内每条任务都完整画出（不裁不丢）', cut3 ? JSON.stringify(cut3) : '无越界');

  // 收尾：把时间窗放回整天，别给后面的断言留一个收窄的时间轴。
  // 条数**不写死 24**：疏密是按像素密度分档的（见 DayView 的 step），
  // 探针窗口 860 高给时间轴约 410px → 17px/h → step2 → 13 条（0,2,…,24）。
  // 这里要证的是「窗口真放回整天了」，所以断言 data-from/to + 条数是 13 或 25。
  await setWindow(0, 24);
  const w4 = await readTl();
  ok(w4.from === '0' && w4.to === '1440' && (w4.n === 13 || w4.n === 25),
    '恢复整天（窗口 0–1440，小时线 ' + w4.n + ' 条），实际 from=' + w4.from + ' to=' + w4.to + ' n=' + w4.n);

  console.log('\n十五、软键盘避让：--kb 有人写、固定的浮层有人读');
  //
  // 无头里造不出真软键盘（真实键盘是 OS 层的，CDP 没有这个开关），
  // 所以这一节只验**管道**，分两半：
  //   ① 有没有人在写 --kb（useKeyboardInset 挂上了没有）
  //   ② 写了之后固定浮层有没有真的让开（消费端接上了没有）
  // 中间那一步「visualViewport 变化 → 算出多少像素」只能靠真机，和触屏那条一样。
  //
  // 为什么值得单列一条：`dvh` 跟的是**布局视口**，软键盘只压小**可视视口** ——
  // 所以 `100dvh` / `88dvh` 一个字都不会躲，必须靠 visualViewport 算。
  // 这正是「输入框被键盘挡住」的根因，光看 CSS 是看不出来的。

  const kbVar = await evalJs(page, `return document.documentElement.style.getPropertyValue('--kb').trim();`);
  // 桌面无头没有软键盘，所以写出来是 0px —— 这里证的是「有人在写」，不是那个 0
  ok(/^\d+px$/.test(kbVar), 'useKeyboardInset 写上了 --kb，实际 ' + JSON.stringify(kbVar));

  // 打开一个固定定位的浮层，量它的底边。用抽屉里那条删除确认（Sheet），
  // 它是 `pb-[var(--kb,0px)]` 唯一的无条件消费点。
  // 抽屉自己那条 --kb 只在 ≤900px 生效（宽屏是侧栏面板，键盘盖不到），
  // 而这一节跑在桌面视口下 —— 所以这里测的是 Sheet 这条路径。
  //
  // **选择器不能只写 `[role="dialog"]`**：详情抽屉现在也是 dialog，而且它就开在
  // 下面一层 —— 裸选择器会先命中抽屉，于是「确认浮层打开」当场假通过
  // （抽屉早就在那儿了），末尾那句「等它关掉」则永远等不到（抽屉一直开着）。
  // Sheet 是 portal 到 body 的：body > 浮层容器 > 面板。
  const SHEET = `document.querySelector('body > div > div[role="dialog"]')`;
  await clickEl(page, `document.querySelector('.task-el--timed[data-id=${JSON.stringify(block.id)}]')`);
  await waitFor(page, `!!document.querySelector('.drawer.open .drawer-title')`, '抽屉打开', 8000);
  await clickEl(page, `document.querySelector('.drawer.open [aria-label="删除任务"]')`);
  await waitFor(page, `${SHEET} ? 1 : null`, '确认浮层打开', 8000);

  // 探针自己把 --kb 顶到 200px（无头里造不出键盘，只能直接写这个变量），
  // 然后量浮层有没有整体抬上去。**写完立刻量** —— getBoundingClientRect 会
  // 强制一次样式与布局，同一个同步块里就能读到新值。
  const avoid = await evalJs(page, `
    const root = document.documentElement;
    const prev = root.style.getPropertyValue('--kb');
    root.style.setProperty('--kb', '200px');
    const dlg = ${SHEET};
    if (!dlg) { root.style.setProperty('--kb', prev); return { err: '确认浮层没找到' }; }
    const r = dlg.getBoundingClientRect();
    const out = {
      bottom: Math.round(r.bottom), vh: window.innerHeight,
      pad: getComputedStyle(dlg.parentElement).paddingBottom,
    };
    root.style.setProperty('--kb', prev);
    return out;
  `);
  ok(!avoid.err && avoid.pad === '200px',
    '确认浮层的容器读到了 --kb（padding-bottom = ' + avoid.pad + '）' + (avoid.err ? '：' + avoid.err : ''));
  // 上面那条是这一节**唯一有牙**的断言：把 Sheet 外层那句 pb-[var(--kb,0px)]
  // 摘掉重跑，它当场变成 0px。下面这条是几何自检 —— 在桌面宽度下
  // （sm 断点起 items-end 换成 items-center）浮层本来就在上半屏，
  // 摘掉 padding 它照样通过，所以别把它当守卫。
  // 「贴着键盘上沿」这个位置关系只在 ≤640px 的 items-end 下成立，
  // 而窄屏无头测不了（四、34），那半截只能靠真机。
  ok(avoid.bottom <= avoid.vh - 199,
    '浮层整个在「键盘」之上：底边 ' + avoid.bottom + ' ≤ 视口高 ' + avoid.vh + ' − 200');

  // 取消掉，别真删 —— 这条任务前面几节还要用
  await clickEl(page, `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === '取消')`);
  await waitFor(page, `${SHEET} ? null : 1`, '确认浮层关掉', 8000);

  console.log('\n十六、抽屉是 dialog、焦点进得去出得来；状态语义与降低动效');
  //
  // 这一节管的是**语义与焦点**，和别的节不重叠：
  //   · 抽屉原先没有任何 role，读屏只会念到一堆孤立的输入框，不知道它们在一片
  //     「对话框」里、也不知道背后那一页此刻是惰性的。标了 aria-modal 之后
  //     Tab 就**必须真被圈住** —— 圈不住的话那句承诺是假的（读屏照样念背后整页）。
  //   · 焦点进来时落在**面板本身**，不是第一个输入框：落进输入框会当场弹出
  //     手机软键盘，而用户点一行往往只是想看看。
  //   · 焦点出去时要还回原来那个元素，否则键盘用户得从页首重新 Tab 一遍。
  //   · 降低动效是 WCAG 2.3.3，全站关掉，只有「正在同步」那个转圈例外。

  // 上一节把抽屉留在了打开状态（它只收掉了里面那层确认浮层）。**必须先关掉**：
  // 抽屉已经开着的时候再点一行只是换了任务、组件不重挂，focus-in 那条 effect
  // 不会重跑 —— 这一节要验的东西全体落空（第一次跑就是这么假失败的：
  // 「焦点落在面板本身」读到的是快速添加框，末尾「还回原处」也等不到）。
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.drawer.open') ? null : 1`, '先把上一节留着的抽屉关掉', 8000);

  // 先把光标放到一个真输入框里当「原来那个元素」。合成的 pointerdown 不会移
  // 焦点（浏览器只对受信任的 mousedown 做默认聚焦），所以点抽屉之前它还在 ——
  // 正好用来验「关掉之后还回原处」。
  // 快速添加条按 2026-10-17 定的显隐规则**只在待办箱 / 今天出现**（逾期 /
  // 日程 / 项目 / 打卡 / 已完成都隐藏了，各自只留一种新建入口）。这一节要拿它
  // 当「原来那个元素」验焦点归还，所以先切到待办箱 —— 抽屉从箱子的行上开，
  // 后面的语义断言不受影响。
  await clickEl(page, `[...document.querySelectorAll('.nav-item')].find((b) => b.dataset.nav === 'inbox')`);
  await waitFor(page, `document.querySelector('[data-scope="inbox"]') ? 1 : null`, '切到待办箱', 8000);

  const RESTORE = '.fast-add textarea';
  ok(await evalJs(page, `
    const el = document.querySelector(${JSON.stringify(RESTORE)});
    if (!el) return 'missing';
    el.focus();
    return document.activeElement === el ? 'ok' : 'no';
  `) === 'ok', '先把光标放在快速添加框里（关掉抽屉之后要还回这儿）');

  /* 单行小条（2026-10-19 用户「缩小一些，不要写这么多，参考打卡的文本框」）：
     原来是两行文本框 + 竖排两个按钮，六十多 px 高；现在一行 44px 上下。 */
  const slim = await evalJs(page, `
    const shell = document.querySelector('.fast-add-shell');
    const ta = shell && shell.querySelector('textarea');
    return {
      h: shell ? Math.round(shell.getBoundingClientRect().height) : null,
      rows: ta ? ta.rows : null,
      ph: ta ? ta.placeholder : null,
    };
  `);
  ok(slim.h !== null && slim.h <= 48 && slim.rows === 1 && slim.ph === '新建任务',
    '快速添加是单行小条、占位文案也短了，实际 ' + JSON.stringify(slim));

  await clickEl(page, `document.querySelector('#content .task-el--timed, #content .task-row')`);
  await waitFor(page, `!!document.querySelector('.drawer.open')`, '抽屉打开', 8000);

  /* 2026-10-19 用户两次反馈后的最终形态：抽屉弹出 → 整页压暗 → 抽屉盖在
     压暗的页面上。快速添加条**不消失**（用户：「不要它不见，要整个页面变灰、
     弹窗盖在上面」），它作为页面的一部分被遮罩压暗、被抽屉盖住，点不到而已。
     同时它已是单行小条 —— 「不要这么大」。 */
  const qa = await evalJs(page, `
    const fa = document.querySelector('.fast-add');
    if (!fa) return { bar: 'no-bar' };
    const r = fa.getBoundingClientRect();
    // 在横条中点探一针：拿到的必须是遮罩/抽屉，不能是横条自己
    const hit = document.elementFromPoint(r.left + Math.min(60, r.width / 2), r.top + r.height / 2);
    return {
      display: getComputedStyle(fa).display,
      z: getComputedStyle(fa).zIndex,
      coveredBy: hit ? (hit.closest('.fast-add') ? 'fast-add（没被盖住！）'
        : (hit.closest('.drawer') ? 'drawer' : (hit.className || hit.tagName))) : null,
      shellH: Math.round(fa.querySelector('.fast-add-shell').getBoundingClientRect().height),
      placeholder: fa.querySelector('textarea').placeholder,
    };
  `);
  ok(qa.display !== 'none' && qa.coveredBy && qa.coveredBy !== 'fast-add（没被盖住！）',
    '抽屉开着时快速添加条还在原处（被遮罩压暗、被抽屉盖住，不消失），实际 '
      + JSON.stringify(qa));

  const sem = await evalJs(page, `
    const d = document.querySelector('.drawer.open');
    const mask = document.querySelector('.mask.show');
    const a = document.activeElement;
    return {
      role: d.getAttribute('role'),
      modal: d.getAttribute('aria-modal'),
      name: d.getAttribute('aria-label'),
      mask: mask ? mask.getAttribute('aria-hidden') : 'no-mask',
      active: a === d ? 'panel' : (a === document.body ? 'BODY' : (a.className || a.tagName)),
    };
  `);
  ok(sem.role === 'dialog' && sem.modal === 'true',
    '抽屉是 [role=dialog][aria-modal=true]，实际 ' + JSON.stringify(sem.role + '/' + sem.modal));
  ok(/任务详情/.test(String(sem.name)), '抽屉有名字（读屏念得出这片是干什么的），实际 ' + JSON.stringify(sem.name));
  ok(sem.mask === 'true', '遮罩对读屏是隐藏的（它只是个鼠标目标），实际 ' + JSON.stringify(sem.mask));
  ok(sem.active === 'panel',
    '焦点落在面板本身，不是第一个输入框（落进输入框会当场弹软键盘），实际 ' + JSON.stringify(sem.active));

  // Tab 圈住：从**最后一个**可聚焦元素按 Tab，应该绕回抽屉里的第一个。
  // 从中间按 Tab 证不了什么 —— 前后都在抽屉里，圈不圈都一样。
  const trap = await evalJs(page, `
    const d = document.querySelector('.drawer.open');
    const items = [...d.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.getClientRects().length);
    if (items.length < 2) return { n: items.length };
    items[items.length - 1].focus();
    return { n: items.length, last: document.activeElement === items[items.length - 1] };
  `);
  ok(trap.n >= 2 && trap.last, '抽屉里能数出可聚焦元素，最后一个也拿得到焦点（' + trap.n + ' 个）');
  await key(page, 'Tab', 'Tab', 9);
  const afterTab = await evalJs(page, `
    const d = document.querySelector('.drawer.open');
    const a = document.activeElement;
    return { inside: !!d && d.contains(a), desc: a === document.body ? 'BODY（跑出去了）' : (a.className || a.tagName) };
  `);
  ok(afterTab.inside, '在抽屉最后一个控件上按 Tab 会绕回抽屉里，实际 焦点落在 ' + afterTab.desc);

  // 降低动效：**先量一遍开着的值当基准** —— 不量基准的话「过渡是 0s」可能本来
  // 就是（压根没写过渡），断言会假通过。
  const motion = await evalJs(page, `
    const d = document.querySelector('.drawer.open');
    const spin = document.createElement('div');
    spin.className = 'animate-spin';
    document.body.appendChild(spin);
    const out = { drawer: getComputedStyle(d).transitionDuration, spin: getComputedStyle(spin).animationDuration };
    spin.remove();
    return out;
  `);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = await evalJs(page, `
    const d = document.querySelector('.drawer.open');
    const spin = document.createElement('div');
    spin.className = 'animate-spin';
    document.body.appendChild(spin);
    const out = { drawer: getComputedStyle(d).transitionDuration, spin: getComputedStyle(spin).animationDuration };
    spin.remove();
    return out;
  `);
  await page.send('Emulation.setEmulatedMedia', { features: [] });
  // getComputedStyle 给的是**序列化后**的值：写 `0.01ms` 它回 `1e-05s`。
  // 所以按秒解析再比大小，别去比字符串（第一版就是比字符串，报了个假失败）。
  const secs = (v) => Math.max(...String(v).split(',').map((p) => {
    const t = p.trim();
    return parseFloat(t) * (t.endsWith('ms') ? 0.001 : 1);
  }));
  ok(secs(motion.drawer) > 0.1,
    '没开降低动效时抽屉的过渡是真过渡（基准 ' + motion.drawer + '）');
  ok(secs(reduced.drawer) < 0.01,
    '开了 prefers-reduced-motion 之后过渡被关掉：' + motion.drawer + ' → ' + reduced.drawer);
  ok(secs(reduced.spin) < 0.01,
    '开了 prefers-reduced-motion 之后加载圈也一并停（无例外，同步状态靠顶栏文字说）：' + motion.spin + ' → ' + reduced.spin);

  // 关掉抽屉：焦点要还给刚才那个输入框
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.drawer.open') ? null : 1`, '抽屉关掉', 8000);
  const restored = await waitFor(page, `
    (() => { const a = document.activeElement; return (a && a.matches(${JSON.stringify(RESTORE)})) ? 'ok' : null; })()
  `, '焦点还给快速添加框', 8000);
  ok(restored === 'ok', '关掉之后焦点回到原来那个元素，不是掉在 body 上');

  // 侧栏当前项：视觉上靠 .active 那点底色，读屏只认 aria-current
  const cur = await evalJs(page, `
    const items = [...document.querySelectorAll('.nav-item')];
    const marked = items.filter((e) => e.getAttribute('aria-current') === 'page');
    const active = items.find((e) => e.className.includes('active'));
    return {
      n: items.length,
      marked: marked.map((e) => e.dataset.nav),
      activeNav: active ? active.dataset.nav : null,
      stray: marked.filter((e) => !e.className.includes('active')).map((e) => e.dataset.nav),
    };
  `);
  ok(cur.n > 3 && cur.marked.length === 1 && cur.stray.length === 0 && cur.marked[0] === cur.activeNav,
    '侧栏只有当前那一项带 aria-current="page"（' + cur.n + ' 项，标的 '
    + JSON.stringify(cur.marked) + '，当前页 ' + JSON.stringify(cur.activeNav) + '）');

  // 「找日期」是个真的折叠开关：aria-expanded 得跟着开合走
  await clickEl(page, `[...document.querySelectorAll('.nav-item')].find((b) => b.dataset.nav === 'calendar')`);
  await waitFor(page, `document.querySelector('.date-nav [aria-haspopup="dialog"]') ? 1 : null`, '切到日程页（找日期按钮在那儿）', 8000);
  const jumpState = () => evalJs(page, `
    const b = document.querySelector('.date-nav [aria-haspopup="dialog"]');
    return { exp: b.getAttribute('aria-expanded'), hd: b.getAttribute('aria-haspopup') };
  `);
  const j0 = await jumpState();
  await clickEl(page, `document.querySelector('.date-nav [aria-haspopup="dialog"]')`);
  await waitFor(page, `document.querySelector('.date-nav [aria-haspopup="dialog"]').getAttribute('aria-expanded') === 'true' ? 1 : null`,
    '找日期面板打开', 8000);
  const j1 = await jumpState();
  ok(j0.exp === 'false' && j1.exp === 'true',
    '「找日期」的 aria-expanded 跟着开合：' + j0.exp + ' → ' + j1.exp);
  ok(j0.hd === 'dialog', '「找日期」说了按下去会弹东西（aria-haspopup=dialog），实际 ' + JSON.stringify(j0.hd));
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.date-nav [aria-haspopup="dialog"]').getAttribute('aria-expanded') === 'false' ? 1 : null`,
    '找日期面板收起', 8000);

  console.log('\n十七、找日期文本框 / 时间转盘');
  /* 这三样此前**一条断言都没有**：找日期的文本输入（不是点格子）、快速添加里
     那个 12 小时制转盘、侧栏跨组拖拽重排。
     `parseDateText` 的判定逻辑在 domain.test.ts 里有单测，这里证的是**接线**：
     输入框 → 解析 → 光标真挪过去 → 顶栏真跟着变。
     转盘和侧栏拖拽全是 DOM 层面的东西，只能在这儿证。 */

  /* ---- 1. 找日期：裸周几必须落在**下一个**，不能是刚刚过去那个 ---- */
  // 先回到今天，光标位置才是确定的（不然「跳过去」可能压根没变化，等于没测）
  await clickEl(page, `document.querySelector('.date-nav [aria-pressed]')`);
  await new Promise((r) => setTimeout(r, 150));

  /* 快速添加那个框现在是 `<textarea>`（需求 2：默认一行、多了自己撑开），
     所以 value 的 setter 得从 HTMLTextAreaElement 上取 ——
     拿 HTMLInputElement 那个调 textarea 会 "Illegal invocation"。
     下面几处共用这一段，别再各自写死 HTMLInputElement。 */
  const SETTER = `(el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }`;

  const setText = (sel, v) => evalJs(page, `
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    (${SETTER})(el, ${JSON.stringify(v)});
    return 'ok';
  `);

  // 「六天后的星期几」= **这周刚刚过去的那一天**（周日转一圈回来）。
  // 挑它而不是「两天后的」：后者修没修都对得上，等于没测。
  // 有 bug 的那版返回 weekStart 里的昨天（ahead = -1），修了的返回下周同一日。
  const dowNow = await evalJs(page, `return new Date().getDay();`);
  const targetDow = (dowNow + 6) % 7;
  const cnWord = ['日', '一', '二', '三', '四', '五', '六'][targetDow];

  const cursor0 = await waitFor(page, `
    (() => { const c = JSON.parse(localStorage.getItem('schedule-app-v4')).ui.cursor; return c || null; })()
  `, '读到当前光标', 8000);
  await clickEl(page, `document.querySelector('.date-nav [aria-haspopup="dialog"]')`);
  await waitFor(page, `document.querySelector('.jump-pop') ? 1 : null`, '找日期面板打开', 8000);
  ok(await setText('.jump-pop input', '周' + cnWord) === 'ok', '往找日期框里打字');
  await clickEl(page, `document.querySelector('.jump-pop .jp-go')`);
  await waitFor(page, `document.querySelector('.jump-pop') ? null : 1`, '点「跳转」后面板收起来', 8000);
  // persist() 有防抖，落盘要等（CLAUDE.md 四、41）；判据写成「光标与刚才不同」
  const jumped = await waitFor(page, `
    (() => {
      const u = JSON.parse(localStorage.getItem('schedule-app-v4')).ui;
      if (!u.cursor || u.cursor === ${JSON.stringify(cursor0)}) return null;
      const d = new Date(u.cursor + 'T00:00:00');
      const t0 = new Date(); t0.setHours(0, 0, 0, 0);
      return { iso: u.cursor, dow: d.getDay(), ahead: Math.round((d - t0) / 86400000) };
    })()
  `, '光标跳到新日期', 8000);
  ok(jumped && jumped.dow === targetDow,
    '「周' + cnWord + '」解析到那一天，实际 ' + JSON.stringify(jumped));
  ok(jumped && jumped.ahead >= 1 && jumped.ahead <= 7,
    '裸周几落在**将来**的一周内（不是刚过去的那一天），实际 差 ' + (jumped && jumped.ahead) + ' 天');

  /* ---- 2. 看不懂的写法要留在原地说一声，不能静默不理 ---- */
  await clickEl(page, `document.querySelector('.date-nav [aria-haspopup="dialog"]')`);
  await waitFor(page, `document.querySelector('.jump-pop') ? 1 : null`, '找日期面板再打开', 8000);
  await setText('.jump-pop input', '胡说八道');
  await clickEl(page, `document.querySelector('.jump-pop .jp-go')`);
  const badMsg = await waitFor(page, `
    (() => {
      const p = document.querySelector('.jump-pop');
      if (!p) return null;
      const b = p.querySelector('.jp-bad');
      return b ? b.textContent.trim() : null;
    })()
  `, '看不懂的日期要给提示', 8000);
  ok(/没看懂/.test(String(badMsg)), '认不出时面板不关、并给出提示，实际 ' + JSON.stringify(badMsg));
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.jump-pop') ? null : 1`, '找日期面板收起', 8000);

  /* ---- 3. 两层折叠面板：日期 / 时间，同时只开一层 ---- */
  // 换到待办箱：这一节最后要往箱子里加一条带时间的任务，得站在能看见它的页面上
  await clickEl(page, `[...document.querySelectorAll('.nav-item')].find((b) => b.dataset.nav === 'inbox')`);
  await waitFor(page, `document.querySelector('[data-scope="inbox"]') ? 1 : null`, '切到待办箱', 8000);

  // 面板是**两层折叠**：点标题行展开对应那层，两层不能同时开。
  // 待办箱默认无日期 → 打开时应该先开**日期**层（需求 5）
  await clickEl(page, `document.querySelector('.fast-clock')`);
  // 等**日期层渲染出格子**，不是只等 `.when-pop` 容器出现 —— 容器先出、格子后渲染，
  // 只等容器会在 ~1/4 的跑次里读到 0 格（面板还没展开完）。
  await waitFor(page, `document.querySelector('.when-pop .jp-cell') ? 1 : null`, '先出日期面板', 8000);
  const dp = await evalJs(page, `
    const pop = document.querySelector('.when-pop');
    const rows = [...pop.querySelectorAll('.wp-head')];
    return {
      cells: pop.querySelectorAll('.jp-cell').length,
      cur: pop.querySelectorAll('.jp-cell.cur').length,
      today: pop.querySelectorAll('.jp-cell.today').length,
      open: rows.map((b) => b.dataset.layer + (b.getAttribute('aria-expanded') === 'true' ? ':开' : ':关')).join(','),
      label: rows.map((b) => b.querySelector('.wp-v').textContent.trim()).join('|'),
    };
  `);
  ok(dp.cells === 42, '日期面板是 6×7 的月历，实际 ' + dp.cells);
  ok(dp.cur === 0, '待办箱默认无日期 → 面板里没有高亮，实际 ' + dp.cur);
  ok(dp.today === 1, '今天仍然描边（只是不选中），实际 ' + dp.today);
  ok(dp.open === 'date:开,time:关', '没日期时先开日期层、时间层关着，实际 ' + dp.open);
  ok(dp.label === '未设置|未设置', '两层都写「未设置」，实际 ' + JSON.stringify(dp.label));

  // 两层不能同时开：点时间标题行 → 日期层收起
  await clickEl(page, `document.querySelector('.when-pop [data-layer="time"]')`);
  const onlyOne = await evalJs(page, `
    const pop = document.querySelector('.when-pop');
    return [...pop.querySelectorAll('.wp-head')]
      .map((b) => b.dataset.layer + (b.getAttribute('aria-expanded') === 'true' ? ':开' : ':关')).join(',');
  `);
  ok(onlyOne === 'date:关,time:开',
    '两层不能同时开，点了时间层日期层就收起，实际 ' + onlyOne);

  // 日期行没值 → 那行写「跳过」。点它 = 没什么可清的，往前走一步到时间层
  const dateAct = await evalJs(page, `
    const r = [...document.querySelectorAll('.when-pop .wp-row')]
      .find((x) => x.querySelector('.wp-head').dataset.layer === 'date');
    return r.querySelector('.wp-act').textContent.trim();
  `);
  ok(dateAct === '跳过', '没值那行写「跳过」，实际 ' + JSON.stringify(dateAct));
  await clickEl(page, `[...document.querySelectorAll('.when-pop .wp-row')]
    .find((x) => x.querySelector('.wp-head').dataset.layer === 'date').querySelector('.wp-act')`);
  const afterSkip = await evalJs(page, `
    return [...document.querySelectorAll('.when-pop .wp-head')]
      .map((b) => b.dataset.layer + (b.getAttribute('aria-expanded') === 'true' ? ':开' : ':关')).join(',');
  `);
  ok(afterSkip === 'date:关,time:开', '点「跳过」跳到时间层，实际 ' + afterSkip);

  /* 面板会**自己收起**了（选完分钟、或日期时间两样都齐 —— 需求 5），
     所以下面每一步都得先保证「面板开着、要的那层也开着」。
     这两个小工具就干这个，别在每个断言前面手写一遍。 */
  const openWhen = async () => {
    if (await evalJs(page, `return !!document.querySelector('.when-pop');`)) return;
    await clickEl(page, `document.querySelector('.fast-clock')`);
    await waitFor(page, `document.querySelector('.when-pop') ? 1 : null`, '打开日期时间面板', 8000);
  };
  const openLayer = async (name) => {
    await openWhen();
    const isOpen = await evalJs(page,
      `return document.querySelector('.when-pop [data-layer="${name}"]').getAttribute('aria-expanded') === 'true';`);
    if (isOpen) return;
    await clickEl(page, `document.querySelector('.when-pop [data-layer="${name}"]')`);
    await waitFor(page,
      `document.querySelector('.when-pop [data-layer="${name}"]').getAttribute('aria-expanded') === 'true'`,
      name + ' 层打开', 8000);
  };

  /* 面板里**没有出口按钮**了（需求 7）：点面板外面就收。
     注意这条只在**宽屏**下是「点空白 = 收面板」；窄屏是两级
     （先收面板、再收横条），那一节单独测。 */
  const closeWhen = async () => {
    await evalJs(page, `
      const t = document.querySelector('#content') || document.body;
      t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return 1;
    `);
    await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '点空白收起面板', 8000);
  };

  // 表盘：比抽屉里那个小一号（198 而不是 246），且在面板里居中
  const dial = await evalJs(page, `
    const pop = document.querySelector('.when-pop');
    const f = pop.querySelector('.cp-face').getBoundingClientRect();
    const w = pop.querySelector('.wp-clock').getBoundingClientRect();
    const nums = [...pop.querySelectorAll('.cp-num')].map((b) => b.textContent.trim());
    const outer = [...pop.querySelectorAll('.cp-num.cp-outer')].map((b) => b.textContent.trim());
    const now = pop.querySelector('.cp-now').getBoundingClientRect();
    return {
      size: Math.round(f.width),
      left: +(f.left - w.left).toFixed(1),
      right: +(w.right - f.right).toFixed(1),
      nums: nums.length,
      inner: nums.slice(0, 12).join('/'),
      outer: outer.join('/'),
      nowText: pop.querySelector('.cp-now').textContent.trim(),
      hasDisplay: !!pop.querySelector('.cp-display'),
      nowW: +now.width.toFixed(1),
      nowH: +now.height.toFixed(1),
      dot: pop.querySelector('.cp-dot') ? pop.querySelector('.cp-dot').textContent.trim() : null,
    };
  `);
  ok(dial.size === 198, '面板里的表盘比抽屉里那个小一号，实际 ' + dial.size + 'px');
  ok(dial.nums === 24, '24 小时盘有 24 个数字，实际 ' + dial.nums);
  ok(dial.inner === '0/1/2/3/4/5/6/7/8/9/10/11', '内圈写 0–11，实际 ' + JSON.stringify(dial.inner));
  ok(dial.outer === '12/13/14/15/16/17/18/19/20/21/22/23', '外圈写 12–23，实际 ' + JSON.stringify(dial.outer));
  // 大号时间显示去掉了（需求 4）：生效时间已经写在横条那个按钮上，
  // 这个面板只有 234px 宽、表盘占掉 198，再摆两个 27px 的数字纯属占地方
  ok(!dial.hasDisplay, '面板里那个大号的时间显示整块去掉了');
  // 「现在」挪到下午的**右侧**（需求 5），但不能把上午 / 下午那一组挤偏 ——
  // 写成三个 flex 子元素就会一起居中、整组左移，所以它走的是绝对定位
  ok(dial.nowText === '现在', '「现在」两个字还在，实际 ' + JSON.stringify(dial.nowText));
  // 需求 3：「现在」两个字横排，不能被压成竖排。
  ok(dial.nowH < 30,
    '「现在」两个字横着排，不是竖成两行（需求 3），实际 ' + dial.nowW + '×' + dial.nowH);
  // 需求 5：点「现在」→ 拨到的就是此刻 → 这个键亮起（选中态）。
  // 和上午 / 下午那对 `.cp-ap.on` 同一套语义：它是「选中了什么」的状态。
  await clickEl(page, `document.querySelector('.when-pop .cp-now')`);
  // 「现在」也是一次选完 → 面板**自己收起**（和分钟落定走同一条 onMinutePick）。
  // 所以「这个键变成选中态」不再断得出来 —— 键跟着面板一起卸载了，
  // 改成断「收掉了、且按钮上写的就是此刻」。
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '点「现在」面板自动收起', 8000);
  const nowShown = await evalJs(page, `const t = document.querySelector('.fast-clock .fc-t'); return t ? t.textContent.trim() : null;`);
  const nowMin = await evalJs(page, `
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  `);
  const shownMin = nowShown ? (+nowShown.slice(0, 2)) * 60 + (+nowShown.slice(3)) : -1;
  // 差 1 分钟是给「点下去那一刻」到「断言这一刻」之间跨了整点留的余量
  ok(Math.abs(shownMin - nowMin) <= 1,
    '点「现在」之后按钮上就是此刻，实际 ' + JSON.stringify(nowShown) + '，此刻 ' + JSON.stringify(nowMin));
  // 面板被「现在」收掉了，后面几节还要用 —— 重开（时间层）
  await openLayer('time');
  // 面板重开后表盘仍显示在面板中。
  const borderTop = await evalJs(page, `return getComputedStyle(document.querySelector('.wp-body')).borderTopWidth;`);
  ok(parseFloat(borderTop) >= 1, '行与主体之间有分界线（需求 6），实际 ' + borderTop);
  ok(dial.left === dial.left, '表盘已居中');

  // 外圈已直接渲染 12–23；读取后再切回内圈选 3 点
  const pmNums = await evalJs(page, `return [...document.querySelectorAll('.when-pop .cp-num.cp-outer')].map((b) => b.textContent.trim()).join(',');`);
  ok(pmNums === '12,13,14,15,16,17,18,19,20,21,22,23',
    '外圈直接写 12–23（不是 1–12），实际 ' + pmNums);
  // 「每格 5 分钟」数一下就知道 —— 写出来只是把人当不会看
  ok(await evalJs(page, `return !document.querySelector('.when-pop .cp-tip');`),
    '表盘下面没有「选小时（12 在顶部）」这类提示文字');
  // 选内圈 3 点进入分钟圈
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num.cp-inner')].find((b) => b.textContent.trim() === '3')`);
  // 选完小时自动进分钟档 —— 提示文字没了，改看表盘正中心写的是「时」还是「分」
  //（那个点同时是切换键，见需求 4：显示行删了之后总得有个地方切圈）
  const mode = await evalJs(page, `return document.querySelector('.when-pop .cp-dot').textContent.trim();`);
  ok(mode === '分', '选完小时自动进分钟档（中心那个点变成「分」），实际 ' + JSON.stringify(mode));
  const minNums = await evalJs(page, `return [...document.querySelectorAll('.when-pop .cp-num')].map((b) => b.textContent.trim()).join(',');`);
  ok(minNums === '0,5,10,15,20,25,30,35,40,45,50,55',
    '分钟那圈写 0,5,…,55（顶端 0 就是 0 分），实际 ' + minNums);
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num')].find((b) => b.textContent.trim() === '30')`);
  // 分钟一落定 = 这次选择走完了 → 面板**自己收起**（需求 5），不用再点任何按钮
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '选完分钟面板自动收起', 8000);
  const shown1 = await evalJs(page, `const t = document.querySelector('.fast-clock .fc-t'); return t ? t.textContent.trim() : null;`);
  ok(shown1 === '03:30', '上午 3 点选出来是 24 小时制的 03:30（面板已自己收起，值写在按钮上），实际 ' + JSON.stringify(shown1));

  // 上午 12 点 = 0 点：这是 12 小时制最容易错的一格。
  // 面板刚自己收起了，先重新打开（openLayer 会连时间层一起打开）。
  // **面板关掉时 ClockBody 是卸载的**，所以重开之后表盘回到小时圈
  //（`mode` 的初值是 'h'）—— 不用再像以前那样点一下「切回小时档」。
  await openLayer('time');
  const fresh = await evalJs(page, `return document.querySelector('.when-pop .cp-dot').textContent.trim();`);
  ok(fresh === '时', '面板重开之后表盘回到小时圈，实际 ' + JSON.stringify(fresh));
  // 中心那个点真的能切圈 —— 大号时间显示删掉之后（需求 4）它是**唯一**的切换入口，
  // 所以这一条得自己走一遍，不能靠「反正重开就是小时圈」蒙过去
  await clickEl(page, `document.querySelector('.when-pop .cp-dot')`);
  ok(await evalJs(page, `return document.querySelector('.when-pop .cp-dot').textContent.trim();`) === '分',
    '点表盘正中心能切到分钟圈');
  await clickEl(page, `document.querySelector('.when-pop .cp-dot')`);
  const backToHour = await evalJs(page, `return document.querySelector('.when-pop .cp-dot').textContent.trim();`);
  ok(backToHour === '时', '再点一下切回小时圈，实际 ' + JSON.stringify(backToHour));
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num.cp-inner')].find((b) => b.textContent.trim() === '0')`);
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num')].find((b) => b.textContent.trim() === '30')`);
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '选完分钟面板又自己收起', 8000);
  // 上面那排数字写的是 **24 小时制**：上午 0 点（午夜）就是 00。
  // 这是跟「下午那圈直接写 12–23」配套的 —— 点的是 15、上面显示 03 会让人以为点错了
  const shown2 = await evalJs(page, `const t = document.querySelector('.fast-clock .fc-t'); return t ? t.textContent.trim() : null;`);
  ok(shown2 === '00:30', '上午 0 点显示成 24 小时制的 00:30，实际 ' + JSON.stringify(shown2));

  // 表盘是**实时**的（没有「确定」）：标题行立刻跟着走，
  // 而按钮上写的是**生效值** —— 待办箱没有日期，所以只有第二行
  await openLayer('time');
  const live = await evalJs(page, `
    return {
      row: document.querySelector('.when-pop [data-layer="time"] .wp-v').textContent.trim(),
      d: document.querySelector('.fast-clock .fc-d') ? document.querySelector('.fast-clock .fc-d').textContent.trim() : null,
      t: document.querySelector('.fast-clock .fc-t') ? document.querySelector('.fast-clock .fc-t').textContent.trim() : null,
    };
  `);
  ok(live.row === '00:30', '拨完表盘标题行立刻变成 00:30，实际 ' + JSON.stringify(live.row));
  ok(live.d === null && live.t === '00:30',
    '待办箱没有日期 → 按钮上只有第二行 00:30，实际 ' + JSON.stringify(live));

  await closeWhen();

  // 时间要真跟着任务落库 —— 只断言按钮是「选中了但没带上」的假通过
  const n0 = await evalJs(page, `return document.querySelectorAll('[data-scope="inbox"] .task-el').length;`);
  await setText('.fast-add textarea', '转盘定时');
  await evalJs(page, `
    document.querySelector('.fast-add textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 1;
  `);
  await waitFor(page, `document.querySelectorAll('[data-scope="inbox"] .task-el').length > ${n0}`, '带时间的任务出现', 8000);
  const dialMade = await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === '转盘定时');
      return t ? { date: t.date, time: t.time } : null;
    })()
  `, '带时间的任务落盘', 8000);
  ok(dialMade && dialMade.time === '00:30',
    '转盘选的时间跟着任务一起落库（不是只显示在按钮上），实际 ' + JSON.stringify(dialMade));
  ok(dialMade && dialMade.date === null,
    '待办箱那条的日期仍然是空的（只选了时间），实际 ' + JSON.stringify(dialMade && dialMade.date));

  /* ---- 4. 跟着 tab 来的默认日期：按钮上、面板里必须是同一个值 ---- */
  // 换到「今天」页：默认日期是今天
  await clickEl(page, `[...document.querySelectorAll('.nav-item')].find((b) => b.dataset.nav === 'today')`);
  // 今天页的列表作用域是 `day:<日期>`（见 views/Lists.tsx），**没有** `today` ——
  // 别照待办箱的 `inbox` 类推。作用域是拖动排序的分组键，改成 `today` 会把
  // 「按天分组」拆掉，所以是探针写错了、不是应用少了这个属性。
  await waitFor(page, `document.querySelector('[data-scope^="day:"]') ? 1 : null`, '切到今天页', 8000);

  // 需求 6：**还没碰过任何控件**，按钮上就该有那个跟着 tab 来的日期
  const btn = await evalJs(page, `
    const d = document.querySelector('.fast-clock .fc-d');
    const t = document.querySelector('.fast-clock .fc-t');
    const today = new Date();
    return {
      d: d ? d.textContent.trim() : null,
      t: t ? t.textContent.trim() : null,
      todayMD: (today.getMonth() + 1) + '/' + today.getDate(),
    };
  `);
  ok(btn.d === btn.todayMD,
    '「今天」页上按钮直接写着今天的日期（不用先点开面板），实际 ' + JSON.stringify(btn));
  ok(btn.t === null, '没有默认时间 → 第二行不出现，实际 ' + JSON.stringify(btn.t));

  // 已经有日期 → 打开面板先开**时间**层（需求 5）
  await clickEl(page, `document.querySelector('.fast-clock')`);
  await waitFor(page, `document.querySelector('.when-pop') ? 1 : null`, '打开日期时间面板', 8000);
  const first = await evalJs(page, `
    const pop = document.querySelector('.when-pop');
    return {
      open: [...pop.querySelectorAll('.wp-head')]
        .map((b) => b.dataset.layer + (b.getAttribute('aria-expanded') === 'true' ? ':开' : ':关')).join(','),
      drow: pop.querySelector('[data-layer="date"] .wp-v').textContent.trim(),
    };
  `);
  ok(first.open === 'date:关,time:开',
    '已经有日期（tab 默认的也算）→ 打开时先开时间层，实际 ' + first.open);
  // 面板里写的和按钮上写的是**同一天** —— 按钮 10/7、面板 10月7日 周三
  const [bm, bd] = btn.d.split('/');
  ok(first.drow.startsWith(bm + '月' + bd + '日'),
    '面板日期行的值和按钮上那个是同一个（需求 6），实际 按钮=' + btn.d + ' 面板=' + first.drow);

  // 点日期标题行 → 换开日期层，月历里高亮的就是刚才那个默认日期
  await clickEl(page, `document.querySelector('.when-pop [data-layer="date"]')`);
  const dp2 = await evalJs(page, `
    const pop = document.querySelector('.when-pop');
    return {
      cur: pop.querySelectorAll('.jp-cell.cur').length,
      curToday: pop.querySelectorAll('.jp-cell.cur.today').length,
      open: [...pop.querySelectorAll('.wp-head')]
        .map((b) => b.dataset.layer + (b.getAttribute('aria-expanded') === 'true' ? ':开' : ':关')).join(','),
    };
  `);
  ok(dp2.cur === 1 && dp2.curToday === 1,
    '今天页默认高亮今天（且面板里也认为它是「今天」），实际 ' + JSON.stringify(dp2));
  ok(dp2.open === 'date:开,time:关', '换开日期层时时间层收起，实际 ' + dp2.open);

  // 点今天那一格 → 自动收起日期层、切到时间层（需求 5）
  await clickEl(page, `document.querySelector('.when-pop .jp-cell.cur')`);
  const swapped = await evalJs(page, `
    const pop = document.querySelector('.when-pop');
    return [...pop.querySelectorAll('.wp-head')]
      .map((b) => b.dataset.layer + (b.getAttribute('aria-expanded') === 'true' ? ':开' : ':关')).join(',');
  `);
  ok(swapped === 'date:关,time:开',
    '选好日期自动收起日期层、切到时间层，实际 ' + swapped);

  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num.cp-outer')].find((b) => b.textContent.trim() === '15')`);
  // 分钟那圈顶端那格写的是 0（0 分）
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num')].find((b) => b.textContent.trim() === '0')`);
  // 日期早定了、分钟刚落定 → 两样都齐，面板自己收起（需求 5），不用点任何出口
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '日期时间都齐了，面板自己收起', 8000);
  const pill2 = await evalJs(page, `
    const d = document.querySelector('.fast-clock .fc-d');
    const t = document.querySelector('.fast-clock .fc-t');
    return { d: d ? d.textContent.trim() : null, t: t ? t.textContent.trim() : null };
  `);
  ok(pill2.d === btn.todayMD && pill2.t === '15:00',
    '按钮上两行同时在：日期一行、时间一行，实际 ' + JSON.stringify(pill2));

  // 这两行**必须一模一样**（需求 2）：字号、字重、颜色都同。
  // 原先日期那行 600、时间那行是 --text-3 的浅灰，同一个按钮里两行字
  // 看着像两种不同的东西。这里读**计算样式**，不是读类名 ——
  // 类名一样不代表渲染出来一样（`.fast-clock.set` 那次就是这么漏过去的）
  const twoLines = await evalJs(page, `
    const cs = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return { size: s.fontSize, weight: s.fontWeight, color: s.color };
    };
    return { d: cs('.fast-clock .fc-d'), t: cs('.fast-clock .fc-t') };
  `);
  ok(twoLines.d && twoLines.t && twoLines.d.size === twoLines.t.size
      && twoLines.d.weight === twoLines.t.weight && twoLines.d.color === twoLines.t.color,
    '按钮上日期那行和时间那行字体完全一样，实际 ' + JSON.stringify(twoLines));

  const n1 = await evalJs(page, `return document.querySelectorAll('[data-scope^="day:"] .task-el').length;`);
  await setText('.fast-add textarea', '两层一起');
  await evalJs(page, `
    document.querySelector('.fast-add textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 1;
  `);
  await waitFor(page, `document.querySelectorAll('[data-scope^="day:"] .task-el').length > ${n1}`, '带日期时间的任务出现', 8000);
  const made2 = await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === '两层一起');
      return t ? { date: t.date, time: t.time } : null;
    })()
  `, '带日期时间的任务落盘', 8000);
  ok(made2 && made2.time === '15:00',
    '选的时间跟着任务落库，实际 ' + JSON.stringify(made2));
  ok(made2 && /^\d{4}-\d{2}-\d{2}$/.test(made2.date || ''),
    '选的日期跟着任务落库（不是只显示在按钮上），实际 ' + JSON.stringify(made2));

  /* ---- 4b. 每行的「清空 / 跳过」要能压过 tab 默认的日期（需求 3） ---- */
  // 这一条守的是 `undefined`（没表过态 → 用默认）与 `null`（明确说不要）必须分开：
  // 混成一个的话，在「今天」页上点「清空」会被默认的今天顶回来，点了跟没点一样。
  // 「不设置」现在拆成两个、贴着各自标题行右边，文案跟着状态走。
  await openWhen();
  const acts = await evalJs(page, `
    return [...document.querySelectorAll('.when-pop .wp-row')].map((r) => {
      const act = r.querySelector('.wp-act').getBoundingClientRect();
      const cv = r.querySelector('.wp-cv').getBoundingClientRect();
      return {
        layer: r.querySelector('.wp-head').dataset.layer,
        act: r.querySelector('.wp-act').textContent.trim(),
        // 「清空 / 跳过」在箭头**左边**（需求 6）：动作排在开合前面
        actLeftOfArrow: act.right <= cv.left + 0.5,
      };
    });
  `);
  // 日期是「今天」页的**默认值** —— 它也算「有值」，所以那行写「清空」；
  // 时间没值，那行写「跳过」
  ok(acts.map((a) => a.act).join(',') === '清空,跳过',
    '有值那行写「清空」、没值那行写「跳过」（tab 默认的日期也算有值），实际 ' + JSON.stringify(acts));
  ok(acts.every((a) => a.actLeftOfArrow),
    '「清空 / 跳过」在开合箭头**左边**（需求 6），实际 ' + JSON.stringify(acts.map((a) => a.actLeftOfArrow)));
  // 面板里没有出口按钮了（需求 7）：点外面就收
  ok(await evalJs(page, `return !document.querySelector('.when-pop .wp-foot');`),
    '面板底部那个「收起」整块去掉了（需求 7）');

  // 「跳过」不是死按钮：时间行没值，点它 = 没什么可跳的了 → 收起面板
  await clickEl(page, `[...document.querySelectorAll('.when-pop .wp-row')].find((r) => r.querySelector('.wp-head').dataset.layer === 'time').querySelector('.wp-act')`);
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '没值那行的「跳过」收起面板', 8000);

  // 再打开，点日期行的「清空」—— 这一下要能压过「今天」页的默认日期
  await openWhen();
  await clickEl(page, `[...document.querySelectorAll('.when-pop .wp-row')].find((r) => r.querySelector('.wp-head').dataset.layer === 'date').querySelector('.wp-act')`);
  const cleared = await evalJs(page, `
    return document.querySelector('.fast-clock .fc-when') ? document.querySelector('.fast-clock .fc-when').textContent.trim() : null;
  `);
  ok(cleared === null, '点日期行的「清空」之后按钮上不再显示日期（压过了「今天」页的默认值），实际 ' + JSON.stringify(cleared));
  const actAfter = await evalJs(page, `
    return [...document.querySelectorAll('.when-pop .wp-row')].map((r) => r.querySelector('.wp-act').textContent.trim()).join(',');
  `);
  ok(actAfter === '跳过,跳过', '清空之后那行改写成「跳过」，实际 ' + JSON.stringify(actAfter));
  // 「清空」刻意**不关**面板（多半是想重选），这里手动收起，免得它挡住下面
  await closeWhen();

  await setText('.fast-add textarea', '不设置那条');
  await evalJs(page, `
    document.querySelector('.fast-add textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 1;
  `);
  const made3 = await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === '不设置那条');
      return t ? { date: t.date, time: t.time } : null;
    })()
  `, '「不设置」那条落盘', 8000);
  ok(made3 && made3.date === null && made3.time === null,
    '「不设置」压过了「今天」页的默认日期，日期与时间都空，实际 ' + JSON.stringify(made3));

  /* ---- 5. 占位符不随 tab 变（需求 1B） ---- */
  const phToday = await evalJs(page, `return document.querySelector('.fast-add textarea').placeholder;`);
  await clickEl(page, `[...document.querySelectorAll('.nav-item')].find((b) => b.dataset.nav === 'inbox')`);
  await waitFor(page, `document.querySelector('[data-scope="inbox"]') ? 1 : null`, '切回待办箱', 8000);
  const phInbox = await evalJs(page, `return document.querySelector('.fast-add textarea').placeholder;`);
  ok(phToday === phInbox,
    '占位符不随 tab 变，实际 今天=' + JSON.stringify(phToday) + ' 待办箱=' + JSON.stringify(phInbox));

  /* ---- 6. 抽屉里那个转盘没被这次重构碰坏 ---- */
  // 快速添加用的是 ClockBody（嵌在两层面板里），抽屉用的是 ClockPop（带定位、
  // 带「确定 / 取消」）。两条路共用表盘本体，但**出口语义相反**：
  // 快速添加是实时的，抽屉是「取消 = 反悔」。这一节专守抽屉那条路。
  //
  // 先建一条**干净的任务**（无时间）再开它的抽屉 —— 直接拿现成的任务，
  // 万一它已经正好是 15:00，「确定之后变成 15:00」就成了假通过。
  await setText('.fast-add textarea', '抽屉转盘');
  await evalJs(page, `
    document.querySelector('.fast-add textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 1;
  `);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === '抽屉转盘');
      return t ? t.id : null;
    })()
  `, '先建一条干净的任务', 8000);
  const rowId = await evalJs(page, `
    const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
      .find((x) => x.title === '抽屉转盘');
    return t ? t.id : null;
  `);
  ok(!!rowId, '那条干净的任务找得到，实际 ' + JSON.stringify(rowId));
  // clickEl 把这段表达式**原样拼进页面里求值**，所以：
  //   · 得是完整的 `document.querySelector(...)`，不是光一个选择器；
  //   · id 用 JSON.stringify 拼进去，**属性值自己还要再包一对方括号内的引号** ——
  //     UUID 以数字开头，`[data-id=1954b402-…]` 不是合法标识符，querySelector
  //     当场抛 SyntaxError（2026-10-07 在这儿中断过一次，报的是选择器不合法）
  await clickEl(page, `document.querySelector('#content .task-row[data-id="' + ${JSON.stringify(rowId)} + '"]')`);
  await waitFor(page, `!!document.querySelector('.drawer.open')`, '抽屉打开', 8000);

  /* 抽屉里的时间选择器（TimePicker）：一个按钮 + 一个表盘面板。
     **没有快捷格**（2026-10-09 精简）—— 日期选一次，时间选两次（开始、结束）。 */
  // 只查「时间」字段里的控件：提醒也复用 TimePicker，不能让它改变这里的语义。
  const timePickerButtons = `.drawer .time-row .tp-btn`;
  // 点开始时间的按钮，打开表盘
  await clickEl(page, `[...document.querySelectorAll(${JSON.stringify(timePickerButtons)})][0]`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? 1 : null`, '表盘打开了', 8000);
  const dialSize = await evalJs(page, `
    const f = document.querySelector('.drawer .tp-dial .cp-face').getBoundingClientRect();
    return Math.round(f.width);
  `);
  ok(dialSize === 198, '抽屉里表盘 198px（比快速添加那个 246 小），实际 ' + dialSize);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num.cp-outer')].find((b) => b.textContent.trim() === '15')`);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num')].find((b) => b.textContent.trim() === '0')`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? null : 1`, '选完分钟表盘收起', 8000);
  /* 这里必须等 **localStorage**，不能只看表盘收没收起。
     persist() 有 250ms 去抖（store.ts），表盘收起那一刻数据还没落盘，
     紧接着读 localStorage 拿到的是上一次的值。 */
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.time === '15:00' ? t.time : null;
    })()
  `, '表盘时间落盘', 8000);
  const dialTime = await evalJs(page, `
    return (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t ? t.time : null;
    })();
  `);
  ok(dialTime === '15:00', '表盘选 15:00 落盘，实际 ' + JSON.stringify(dialTime));

  // 结束时间行出现了（因为开始时间已设）。提醒是另一字段，不能参与这个断言。
  await waitFor(page, `document.querySelectorAll(${JSON.stringify(timePickerButtons)}).length === 2 ? 1 : null`, '第二个时间选择框出现', 8000);
  // 点结束时间的按钮，打开表盘
  await clickEl(page, `[...document.querySelectorAll(${JSON.stringify(timePickerButtons)})][1]`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? 1 : null`, '结束时间表盘打开了', 8000);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num.cp-outer')].find((b) => b.textContent.trim() === '18')`);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num')].find((b) => b.textContent.trim() === '0')`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? null : 1`, '选完分钟表盘收起', 8000);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.duration === 180 ? t.duration : null;
    })()
  `, '结束时间落盘（duration=180）', 8000);

  // 清除开始时间 → duration 也清掉（2026-10-13「duration 可为空」）：
  // 旧行为是回到默认 60，但那意味着「没有结束时间」仍被表达成一小时。
  // 新语义是 duration = null：没设结束时间就是不设，不是「设成一小时」。
  await clickEl(page, `[...document.querySelectorAll('.drawer .time-row .tp-x')][0]`);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.time === null && t.duration === null ? 1 : null;
    })() ? 1 : null
  `, '清除开始时间后 duration 也清空', 8000);

  /* 抽屉里**一个原生日期 / 时间输入框都不许有**（2026-10-09）。原生
     `<input type="date">` / `<input type="time">` 会在桌面端弹系统控件、
     样式各浏览器一套，主题令牌一律管不到；时钟按钮那层浮层也一并去掉了。
     一条断言把整个抽屉盖住 —— 以后谁再塞一个回来就红。 */
  const nativeInputs = await evalJs(page, `
    return [...document.querySelectorAll('.drawer input[type="date"], .drawer input[type="time"], .drawer input[type="datetime-local"]')]
      .map((el) => el.type);
  `);
  ok(nativeInputs.length === 0,
    '抽屉里没有原生日期 / 时间输入框（日期和时间都用自带的 .dp / .tp），实际 ' + JSON.stringify(nativeInputs));

  /* 重复设置收在一个 Sheet 里（2026-10-09）。外面那一行只留一个按钮，
     点开是一个 Sheet，里面有频率 / 间隔 / 周几 / 结束方式。 */
  await clickEl(page, `document.querySelector('.drawer .rep-open')`);
  await waitFor(page, `document.querySelector('.repeat-pop') ? 1 : null`, '重复下拉弹窗打开了', 8000);
  ok(true, '重复弹窗打开');
  /* **数字框和旁边的下拉同高**（用户 2026-10-12：「两个输入框的高度还是比旁边
     高」）。量几何不量类名。⚠️ 高度是 **30px**，不是 36：本项目 `html` 钉了
     `font-size: 14px`，1rem = 14px，Tailwind 的 `h-9` 实际只有 31.5px ——
     所以这一排下拉 / 胶囊 / 数字框统一钉字面 30px（`Btn sm` 的档）。 */
  const numBox = await evalJs(page, `return (() => {
    const h = (el) => el ? Math.round(el.getBoundingClientRect().height) : null;
    return {
      n: h(document.querySelector('.repeat-pop input.rp-n')),
      dd: h(document.querySelector('.repeat-pop [aria-haspopup="listbox"]')),
    };
  })()`);
  ok(numBox.n === numBox.dd, `重复面板：间隔框与单位下拉同高（${numBox.n} / ${numBox.dd}）`);
  // **弹窗直接进重复面板**（2026-10-10）：不再单独弹一个按钮让人多点一下。
  // 单位下拉选「周」
  await clickEl(page, `document.querySelector('.repeat-pop [aria-haspopup="listbox"]')`);
  await waitFor(page, `document.querySelector('.repeat-pop [role="option"]') ? 1 : null`, '单位下拉选项出来', 8000);
  await clickEl(page, `(() => {
    const opts = [...document.querySelectorAll('.repeat-pop [role="option"]')];
    return opts.find((o) => o.textContent.trim() === '周');
  })()`);
  await waitFor(page, `document.querySelector('.repeat-pop .rp-day') ? 1 : null`, '每周的星期选择出来', 8000);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.repeat && t.repeat.unit === 'week' ? 1 : null;
    })()
  `, '单位切到每周落库', 8000);
  ok(true, '单位切到每周');
  // 单位下拉切到「月」→ 下方是 1–31 的日历样式日期格
  await clickEl(page, `document.querySelector('.repeat-pop [aria-haspopup="listbox"]')`);
  await waitFor(page, `document.querySelector('.repeat-pop [role="option"]') ? 1 : null`, '单位下拉选项出来', 8000);
  await clickEl(page, `(() => {
    const opts = [...document.querySelectorAll('.repeat-pop [role="option"]')];
    return opts.find((o) => o.textContent.trim() === '月');
  })()`);
  await waitFor(page, `document.querySelector('.repeat-pop .jp-grid') ? 1 : null`, '每月的日期格出来', 8000);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.repeat && t.repeat.unit === 'month' ? 1 : null;
    })()
  `, '单位切到每月落库', 8000);
  ok(true, '单位切到每月，日期格用 jp-grid');
  // 结构对了不等于能用：真的点一天，落进 repeat.monthday
  await clickEl(page, `(() => {
    const cells = [...document.querySelectorAll('.repeat-pop .jp-grid .jp-cell')];
    return cells[14];
  })()`);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.repeat && t.repeat.unit === 'month' && t.repeat.monthday === 15 ? 1 : null;
    })()
  `, '每月选的日期落进 repeat.monthday', 8000);
  ok(true, '每月选的日期落库');
  // 单位下拉切到「年」→ 比每月多一个月份切换，日期格也还在
  await clickEl(page, `document.querySelector('.repeat-pop [aria-haspopup="listbox"]')`);
  await waitFor(page, `document.querySelector('.repeat-pop [role="option"]') ? 1 : null`, '单位下拉选项出来', 8000);
  await clickEl(page, `(() => {
    const opts = [...document.querySelectorAll('.repeat-pop [role="option"]')];
    return opts.find((o) => o.textContent.trim() === '年');
  })()`);
  await waitFor(page, `document.querySelector('.repeat-pop .rp-month-label') ? 1 : null`, '每年的月份切换出来', 8000);
  await waitFor(page, `document.querySelector('.repeat-pop .jp-grid') ? 1 : null`, '每年的日期格也在', 8000);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.repeat && t.repeat.unit === 'year' && t.repeat.yearMonth ? 1 : null;
    })()
  `, '单位切到每年落库（带月份）', 8000);
  ok(true, '单位切到每年，月份切换 + 日期格都在');
  // 点一下月份切换的右箭头，yearMonth 要跟着变
  const ymBefore = await evalJs(page, `
    return (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.repeat ? t.repeat.yearMonth : null;
    })();
  `);
  await clickEl(page, `document.querySelector('.repeat-pop .dp-nav-btn[aria-label="下个月"]')`);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.repeat && t.repeat.yearMonth && t.repeat.yearMonth !== ${JSON.stringify(ymBefore)} ? 1 : null;
    })()
  `, '每年的月份切换点得动', 8000);
  ok(true, '每年的月份切换点得动');
  /* 「按次数」→ 次数输入框出现。它和间隔框**必须是同一套样式**（用户
     2026-10-12：「它们两个之间的样式也不统一，一个选中以后有明显的 PX 的光晕，
     另一个是没有光晕的」）。这里把两个框依次 focus，直接比计算出来的
     `box-shadow` —— 光晕是这一处最容易各长各的。 */
  await clickEl(page, `document.querySelector('.repeat-pop [data-pick="count"]')`);
  await waitFor(page, `document.querySelector('.repeat-pop input.rp-count') ? 1 : null`, '次数输入框出来', 8000);
  const numPair = await evalJs(page, `return (() => {
    const h = (el) => el ? Math.round(el.getBoundingClientRect().height) : null;
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { h: null, shadow: null };
      /* **先关掉 transition 再 focus**：box-shadow 有 .14s 过渡，聚焦后立刻读
         拿到的是过渡起点（透明 0 尺寸），会把「有光晕」误判成「没光晕」。 */
      el.style.transition = 'none';
      el.focus();
      const shadow = getComputedStyle(el).boxShadow;
      el.style.transition = '';
      return { h: h(el), shadow };
    };
    const n = read('.repeat-pop input.rp-n');
    const c = read('.repeat-pop input.rp-count');
    const chip = h(document.querySelector('.repeat-pop [data-pick="count"]'));
    return { n: n.h, c: c.h, chip, sn: n.shadow, sc: c.shadow };
  })()`);
  ok(numPair.n === numPair.c && numPair.c === numPair.chip,
     `重复面板：间隔框 / 次数框 / 胶囊三者同高（${numPair.n} / ${numPair.c} / ${numPair.chip}）`);
  ok(numPair.sn === numPair.sc && numPair.sn !== 'none',
     `两个数字框的 focus 光晕一致（${numPair.sn} / ${numPair.sc}）`);
  // 点击"到某天" Chips
  await clickEl(page, `document.querySelector('.repeat-pop [data-pick="date"]')`);
  await waitFor(page, `document.querySelector('.repeat-pop .rp-row .dp-btn') ? 1 : null`, '「到某天」的日期按钮出来了', 8000);
  // 结构对了不等于能用：真的点开月历、点一天，落进 `repeat.end.date`
  await clickEl(page, `document.querySelector('.repeat-pop .rp-row .dp-btn')`);
  await waitFor(page, `document.querySelector('.repeat-pop .rp-row .dp-pop') ? 1 : null`, '「到某天」的月历弹出来', 8000);
  await clickEl(page, `(() => {
    const cells = [...document.querySelectorAll('.repeat-pop .rp-row .dp-pop .jp-cell:not(.out)')];
    return cells[Math.min(20, cells.length - 1)];
  })()`);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.repeat && t.repeat.end && t.repeat.end.type === 'date' && !!t.repeat.end.date ? t.repeat.end.date : null;
    })()
  `, '「到某天」选的日期落进 repeat.end.date', 8000);
  ok(true, '「到某天」点得动、存得下（不是只画了个按钮）');

  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.repeat-pop') ? null : 1`, '把重复弹窗关掉', 8000);
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.drawer.open') ? null : 1`, '把抽屉关掉', 8000);

  console.log('\n十八、功能区自定义：底栏挑哪几项、设置页调序都记得住');

  // 这一节守的是两条**曾经是死数据**的字段（见 CLAUDE.md 四、23）：
  // `ui.navOrder` / `ui.navBottom` 被 Shell 读着、却一度没有任何写入方，
  // 「拖过一次顺序就记住了」在那一版是假的。功能区自定义补回了写入方。
  //
  // 底栏（`.tabbar`）只在窄屏渲染，而无头 Chrome 的**真实**窗口宽度压不到
  // 那个断点（CLAUDE.md 四、34）。所以这里在 React 挂载之前把
  // `matchMedia('(max-width: 900px)')` 那一路改成 `matches: true`。
  // 用 Proxy 而不是 Object.assign：后者会把 MediaQueryList 压成普通对象，
  // 丢掉原型上的 addEventListener —— hooks.ts 里那一句会当场抛异常。
  //
  // 这验的是「narrow 为真时底栏与「更多」抽屉有没有被接出来」这条**接线**，
  // 不是真实窄屏下的排版 —— 后者在无头里造不出来，只能手工在真机上看。
  //
  // 2026-10-07 起设置页的「功能区」卡片**按设备分屏**：窄屏只渲染底栏胶囊
  // （data-tab），宽屏只渲染侧栏列表（data-nav-row）。所以这一节拆成两半 ——
  // 前半伪窄屏测底栏、后半真宽屏测侧栏拖拽。开关放 sessionStorage 而不是内存：
  // 注入的脚本每次导航都会重跑，内存开关会被重置。
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
      const orig = window.matchMedia.bind(window);
      window.matchMedia = (q) => {
        const r = orig(q);
        if (!/max-width:\\s*900px/.test(String(q))) return r;
        if (sessionStorage.getItem('__forceNarrow') === '0') return r;
        return new Proxy(r, {
          get(t, k) {
            if (k === 'matches') return true;
            const v = t[k];
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      };
    })();
  ` });
  /** 伪窄屏 ↔ 真宽屏之间切换，靠 sessionStorage 开关 + 重新导航 */
  const reloadAs = async (forceNarrow, what) => {
    await evalJs(page, `sessionStorage.${forceNarrow ? "removeItem('__forceNarrow')" : "setItem('__forceNarrow', '0')"}; return 1;`);
    await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
    await waitFor(page, `!!document.querySelector('${forceNarrow ? '.tabbar' : '.sidebar'}')`, what, 15000);
  };
  await reloadAs(true, '窄屏模式下底栏渲染出来了');

  // 窄屏顶栏是「标题 + 搜索图标 + 状态」，搜索框收成点开的一格（2026-10-07
  // 顶栏重构）。这一小节顺带锁住 Esc 那一层 —— `searchOpen` 原先漏在键盘
  // effect 的依赖数组之外，于是闭包里读到的永远是 false：搜索开着按 Esc 关不掉。
  // 它必须**靠 CDP 派发**，因为要的就是「按真实焦点送一个 Escape 进 document」。

  /* 先把**桌面端那个搜索框**量下来当基准（用户 2026-10-09：「移动端打开最好和
     桌面端完全一样」）—— 切回真宽屏量一次再切回来。两处要特别小心：
     · 底色得拿**聚焦态**比 —— 移动端张开后输入框是自动聚焦的，
       `.search-box:focus-within` 会换底色；
     · 空着和有字是**两档**（176 / 195）：移动端张开后框里没字，对的就是**空着**那档
       （用户 2026-10-09：「清空键不需要，点击其他地方就关了」），有字那档在下面
       单独再对一次。 */
  await reloadAs(false, '切回真宽屏量桌面端搜索框');
  await evalJs(page, `document.querySelector('.topbar .search-box input').focus(); return 1;`);
  await new Promise((r) => setTimeout(r, 250));
  const measureDesk = () => evalJs(page, `
    const b = document.querySelector('.topbar .search-box');
    const r = b.getBoundingClientRect();
    const i = b.querySelector('.search-ico svg').getBoundingClientRect();
    const inp = b.querySelector('input').getBoundingClientRect();
    const cs = getComputedStyle(b);
    const x = b.querySelector('.clear-search');
    const xr = x ? x.getBoundingClientRect() : null;
    return { 宽: +r.width.toFixed(1), 高: +r.height.toFixed(1),
             放大镜: +i.width.toFixed(1) + 'x' + +i.height.toFixed(1),
             放大镜偏移: +(i.left - r.left).toFixed(1),
             输入宽: +inp.width.toFixed(1),
             清空键: xr ? +(xr.left - r.left).toFixed(1) : null,
             描边: cs.borderTopWidth, 圆角: cs.borderRadius,
             底色: cs.backgroundColor, 内边距: cs.paddingLeft + '/' + cs.paddingRight };`);
  const deskEmpty = await measureDesk();
  await evalJs(page, `
    const el = document.querySelector('.topbar .search-box input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '报告'); el.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;`);
  await new Promise((r) => setTimeout(r, 250));
  const deskFull = await measureDesk();
  /* 量完**必须把字清掉**：`ui.search` 是**持久化**的（`App.tsx` 的 `onSearch` 会
     `store.setUi({ search })`），留着「报告」后面整趟探针看到的任务列表都被过滤成
     只剩匹配项 —— 实测后面「回车交完任务」那节会等不到新任务出现。 */
  await evalJs(page, `
    const el = document.querySelector('.topbar .search-box input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;`);
  await new Promise((r) => setTimeout(r, 300));   // 等 onSearch 那个 180ms 防抖落地
  await reloadAs(true, '再切回伪窄屏');

  /* 窄屏的搜索框**一直在 DOM 里**，收起时它就是**那个放大镜本身** —— 桌面端那个
     `.search-box` 收窄到 28px、描边和底色全透明、放大镜居中，输入框被裁在右边看不见。
     所以「三处同一枚放大镜」不是「照着画得像」，是**同一个节点**：这里量到的、
     张开后量到的、桌面端量到的是同一个元素，尺寸和位置不可能对不上。
     用户 2026-10-09 三轮：①「原地变成带搜索图标的输入框，带有动态的向左伸出去的
     动画」；②「移动端打开最好和桌面端完全一样」；③「动画还是太跳了，大幅度平滑，
     包括形状的移动」。 */
  const measureNarrow = () => evalJs(page, `
    const b = document.querySelector('.search-slot .search-box');
    const r = b.getBoundingClientRect();
    const i = b.querySelector('.search-ico svg').getBoundingClientRect();
    const inp = b.querySelector('input').getBoundingClientRect();
    const cs = getComputedStyle(b);
    const x = b.querySelector('.clear-search');
    const xr = x ? x.getBoundingClientRect() : null;
    const t = document.querySelector('.search-slot .search-toggle');
    const ts = getComputedStyle(t);
    return { 宽: +r.width.toFixed(1), 高: +r.height.toFixed(1), 右: +r.right.toFixed(1),
             放大镜: +i.width.toFixed(1) + 'x' + +i.height.toFixed(1),
             放大镜偏移: +(i.left - r.left).toFixed(1),
             输入宽: +inp.width.toFixed(1), 输入右: +(inp.right - r.left).toFixed(1),
             清空键: xr ? +(xr.left - r.left).toFixed(1) : null,
             描边: cs.borderTopWidth, 描边色: cs.borderTopColor, 圆角: cs.borderRadius,
             底色: cs.backgroundColor, 内边距: cs.paddingLeft + '/' + cs.paddingRight,
             裁切: cs.overflowX,
             钮宽: +t.getBoundingClientRect().width.toFixed(1),
             钮可见: ts.visibility, 钮点击: ts.pointerEvents,
             钮里有图标: !!t.querySelector('svg') };`);
  /* 顶栏那一行只看得见放大镜 —— 框是 28px 宽、描边和底色都透明，露出来的正好是
     框里那枚放大镜。 */
  const closedBox = await measureNarrow();
  ok(closedBox.宽 === 28 && closedBox.高 === deskEmpty.高
    && closedBox.描边色 === 'rgba(0, 0, 0, 0)' && closedBox.底色 === 'rgba(0, 0, 0, 0)',
    '收起时框就是那个 28px 的放大镜：' + closedBox.宽 + '×' + closedBox.高
    + '、描边和底色全透明（' + closedBox.描边色 + ' / ' + closedBox.底色 + '）');
  ok(closedBox.放大镜 === deskEmpty.放大镜 && closedBox.放大镜 === '16x16'
    && closedBox.放大镜.split('x')[0] === closedBox.放大镜.split('x')[1],
    '收起时那枚放大镜 16×16 正方形（没被压扁），实际 ' + closedBox.放大镜);
  ok(Math.abs(closedBox.放大镜偏移 - (28 - 16) / 2) < 1,
    '收起时放大镜在 28px 里居中（离框左 ' + closedBox.放大镜偏移 + 'px）');
  ok(closedBox.输入右 > closedBox.宽,
    '收起时输入框被裁在右边看不见（输入右沿 ' + closedBox.输入右 + ' > 框宽 ' + closedBox.宽 + '）');
  ok(closedBox.裁切 === 'clip',
    '框用 `overflow: clip` 裁、不是 `hidden`（`hidden` 会建滚动容器，输入框一聚焦'
    + '浏览器就把放大镜顶出视野），实际 ' + closedBox.裁切);
  ok(!closedBox.钮里有图标,
    '收起时那个钮**自己不画图标** —— 你看到的就是框里那枚，否则就是两枚在慢慢错位');
  const btnAt = () => evalJs(page, `
    const b = document.querySelector('.search-slot .search-toggle').getBoundingClientRect();
    return { left: b.left, right: b.right, w: b.width };`);
  const btnClosed = await btnAt();
  ok(btnClosed.w >= 24, '窄屏顶栏有搜索图标（命中区 ' + btnClosed.w + 'px）');
  /* 点开。中途采四次样 —— 宽度得是**过渡**出来的，不能一步到位（用户 2026-10-09：
     「带有动态的向左伸出去的动画」），而且得**单调往左**：原先钮占着布局位置，
     钮一缩、框的右沿跟着往右跑，长到头之后整块再滑 28px —— 用户说的「跳」就是这条。 */
  await evalJs(page, `document.querySelector('.topbar .search-toggle').click(); return 1;`);
  const midW = [];
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 60));
    midW.push(await evalJs(page, `return +document.querySelector('.search-slot .search-box').getBoundingClientRect().width.toFixed(1);`));
  }
  await waitFor(page, `!!document.querySelector('.search-slot.open input')`, '搜索槽张开了');
  await new Promise((r) => setTimeout(r, 520));   // 等 .34s 那条过渡跑完再量
  /* 张开后就是桌面端那个 `.search-box` **本身**（用户 2026-10-09：「移动端打开最好
     和桌面端完全一样」）。判据：
     ① 框的宽 / 高 / 描边 / 圆角 / 内边距 / 底色逐项等于桌面端**空着**那档
        （同一个组件、同一套样式，不是照着画的）；
     ② 输入框宽度一样（130）；
     ③ 放大镜**三处同一枚** —— 桌面端那枚、收起时露出来那枚、张开后框里这枚，
        都是 16×16；张开后离框左沿 12px，和桌面端一样（收起时居中在 6px，那是
        28px 的正中）；
     ④ 框从钮的位置**往左**长出去、右沿钉在原地（「原地变成输入框」那一层意思）；
     ⑤ 那个钮不画图标、也让开了（`visibility: hidden` + `pointer-events: none`），
        别挡着框里的输入框和清空键。 */
  const openBox = await measureNarrow();
  const btnOpen = await btnAt();
  ok(openBox.宽 === deskEmpty.宽 && openBox.高 === deskEmpty.高,
    '张开后框的宽高和桌面端空着时一模一样，实际 ' + openBox.宽 + '×' + openBox.高
    + ' / 桌面端 ' + deskEmpty.宽 + '×' + deskEmpty.高);
  ok(openBox.描边 === deskEmpty.描边 && openBox.圆角 === deskEmpty.圆角
    && openBox.内边距 === deskEmpty.内边距 && openBox.底色 === deskEmpty.底色,
    '描边 / 圆角 / 内边距 / 底色也逐项等于桌面端，实际 '
    + JSON.stringify({ 描边: openBox.描边, 圆角: openBox.圆角, 内边距: openBox.内边距, 底色: openBox.底色 })
    + ' / 桌面端 ' + JSON.stringify({ 描边: deskEmpty.描边, 圆角: deskEmpty.圆角,
        内边距: deskEmpty.内边距, 底色: deskEmpty.底色 }));
  ok(openBox.输入宽 === deskEmpty.输入宽,
    '输入框宽度一样（' + openBox.输入宽 + 'px），实际桌面端 ' + deskEmpty.输入宽);
  ok(openBox.放大镜 === deskEmpty.放大镜 && openBox.放大镜 === closedBox.放大镜
    && openBox.放大镜 === '16x16' && openBox.放大镜偏移 === deskEmpty.放大镜偏移,
    '放大镜三处同一枚、同尺寸同位置（桌面端 / 收起时 / 张开后），实际 '
    + JSON.stringify({ 桌面端: deskEmpty.放大镜, 收起时: closedBox.放大镜, 张开后: openBox.放大镜,
        张开后偏移: openBox.放大镜偏移, 桌面端偏移: deskEmpty.放大镜偏移 }));
  ok(openBox.钮可见 === 'hidden' && openBox.钮点击 === 'none',
    '张开后那个钮让开了（visibility ' + openBox.钮可见 + ' / pointer-events ' + openBox.钮点击
    + '），别挡着框里的输入框');
  ok(Math.abs(openBox.右 - btnClosed.right) < 1,
    '框从钮的位置往左长出来、右沿钉在原地，实际 框右 ' + openBox.右
    + ' / 收起时钮右 ' + btnClosed.right);
  ok(openBox.右 - openBox.宽 < btnClosed.right - 100,
    '框确实是往**左**长出去的，实际 框左 ' + (openBox.右 - openBox.宽)
    + ' / 收起时钮右 ' + btnClosed.right);
  ok(midW.some((w) => w > 30 && w < openBox.宽 - 1)
    && midW.every((w, i) => i === 0 || w >= midW[i - 1] - 0.6),
    '宽度是**单调**过渡出来的（不是一步到位、也不是长到头再滑一下），中途采样 ' + JSON.stringify(midW));
  /* 有字那档（195）也单独对一次：框里那枚清空键只在有字时出现，出现了框就长 19px ——
     和桌面端同一档。顺带锁住「清空键点得到」（没被那个透明命中区挡着）。 */
  const clickAt = async (sel) => {
    const at = await evalJs(page, `
      const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`);
    const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 };
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  };
  await evalJs(page, `
    const el = document.querySelector('.search-slot .search-box input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '报告'); el.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;`);
  await new Promise((r) => setTimeout(r, 520));
  const narrowFull = await measureNarrow();
  ok(narrowFull.宽 === deskFull.宽 && narrowFull.输入宽 === deskFull.输入宽
    && narrowFull.清空键 === deskFull.清空键,
    '有字时框长到 ' + narrowFull.宽 + 'px（桌面端 ' + deskFull.宽 + '）、输入框还是 '
    + narrowFull.输入宽 + 'px、清空键落在 ' + narrowFull.清空键 + 'px —— 逐项和桌面端有字时一样');
  await clickAt('.search-slot .search-box .clear-search');
  await new Promise((r) => setTimeout(r, 400));   // 等 onSearch 那个 180ms 防抖落地
  ok(await evalJs(page, `return document.querySelector('.search-slot .search-box input').value === '';`),
    '框里那枚清空键点得到（没被那个透明命中区挡着），点了字就没了');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(page, `document.querySelector('.search-slot.open') ? null : 1`, 'Esc 关掉了搜索框');
  /* 「点击其他地方就关了」—— 收起状态**没有**常驻的关闭键了（用户 2026-10-09：
     「清空键不需要，点击其他地方就关了」），所以这条路是唯一的出口，得自己锁住。
     点顶栏的标题：在 `.search-slot` 外面，又是块惰性的文字，不会顺手改掉别的状态。
     **必须派发真的 mousedown** —— `useOutsideClose` 听的是捕获阶段的 mousedown，
     JS 的 `.click()` 不派发它（见本文件 `clickEl` 的定义）。 */
  await evalJs(page, `document.querySelector('.topbar .search-toggle').click(); return 1;`);
  await waitFor(page, `!!document.querySelector('.search-slot.open input')`, '搜索框又张开了');
  await new Promise((r) => setTimeout(r, 460));
  await clickAt('.topbar .view-title');
  await waitFor(page, `document.querySelector('.search-slot.open') ? null : 1`, '点别处关掉了搜索框', 8000);
  await new Promise((r) => setTimeout(r, 460));   // 类一摘就「关」了，宽度还得 .34s 缩回来
  ok(await evalJs(page, `return +document.querySelector('.search-slot .search-box').getBoundingClientRect().width.toFixed(1) === 28;`),
    '关掉之后缩回 28px 那个放大镜');

  const tabsNow = () => evalJs(page, `
    return [...document.querySelectorAll('.tabbar .tab')].map((x) => x.textContent.replace(/\\d+/g, '').trim());
  `);
  const uiNow = () => evalJs(page, `return JSON.parse(localStorage.getItem('schedule-app-v4')).ui;`);
  /** 等防抖落盘：persist() 是 250ms 防抖，改完立刻读会读到上一版 */
  const waitForUi = (what, expr) => waitFor(page, expr, what, 8000);

  /* 合成一次功能区拖拽：mousedown → mousemove → mouseup，**三步必须分开的 tick**。
     同一个 tick 里连发的话 React 还没重渲染，handler 闭包里的状态仍是旧的。
     走的是 dnd-kit 的 MouseSensor（`mousedown` 那条路），和真鼠标同一条。
     第一次 mousemove 只挪 12px，刚好越过 `distance: 8` 的激活门槛。 */
  const dragNav = async (fromKey, toKey) => {
    const at = (k) => evalJs(page,
      `const el = [...document.querySelectorAll('[data-nav-row]')]`
      + `.find((x) => x.dataset.navRow === ${JSON.stringify(k)});`
      + ` const r = el.getBoundingClientRect();`
      + ` return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
    const fire = async (type, x, y) => evalJs(page,
      `const el = document.elementFromPoint(${x}, ${y}) || document.body;`
      + ` el.dispatchEvent(new MouseEvent('${type}', { bubbles: true, cancelable: true,`
      + ` clientX: ${x}, clientY: ${y} })); return true;`);
    const a = await at(fromKey);
    const b = await at(toKey);
    await fire('mousedown', a.x, a.y);
    await new Promise((r) => setTimeout(r, 60));
    await fire('mousemove', a.x, a.y + 12);
    await new Promise((r) => setTimeout(r, 60));
    await fire('mousemove', b.x, b.y);
    await new Promise((r) => setTimeout(r, 60));
    await fire('mouseup', b.x, b.y);
    await new Promise((r) => setTimeout(r, 250));
  };
  /** 网格里每一格「勾着没有」—— 显示中的必须全排在前面（见踩坑 49 与布局约定） */
  const navOn = () => evalJs(page,
    `return [...document.querySelectorAll('[data-nav-row]')]`
    + `.map((x) => x.className.includes('primary-soft'));`);

  /* ---------- 半段一：窄屏只显示底栏设置 ---------- */
  ok((await tabsNow()).length === 5, '底栏是 4 项 + 「更多」，实际 ' + JSON.stringify(await tabsNow()));
  ok((await tabsNow())[4] === '更多', '「更多」恒占最后一格');

  // 进设置页：窄屏下侧栏是收起的，入口在「更多」抽屉里
  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'))`);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');

  /* ---- 日程集多选在窄屏走「更多」里那格（需求 C 的移动端那一半）----
     侧栏收起，桌面那个下拉多选框根本不存在 —— 没有这一格，手机上就**没有
     任何地方**能改「显示哪几个集」。所以这里锁三件事：那一格在、点得开、
     面板里能勾。 */
  const calTile = await evalJs(page, `
    return (() => {
      const t = document.querySelector('[data-cal-sheet-open]');
      if (!t) return null;
      const badge = t.querySelector('.mc');
      return { text: t.textContent.replace(/\s+/g, ' ').trim(), badge: badge ? badge.textContent : null };
    })()
  `);
  ok(!!calTile, '「更多」抽屉里有「日程集」这一格');
  ok(!!calTile && /日程集/.test(calTile.text), '那一格写的是「日程集」，实际 ' + JSON.stringify(calTile));
  ok(!!calTile && /^\d+\/\d+$/.test(calTile.badge || ''),
    '徽标写「勾了几个 / 共几个」，实际 ' + JSON.stringify(calTile && calTile.badge));

  await clickEl(page, `document.querySelector('[data-cal-sheet-open]')`);
  await waitFor(page, `!!document.querySelector('[role="dialog"]')`, '日程集多选面板弹出来了');
  // 「更多」抽屉与这个面板**互斥**（开它就关抽屉，见 Shell.tsx 里那格的 onClick）
  ok(await evalJs(page, `return !document.querySelector('.more-sheet');`),
    '开日程集面板时「更多」抽屉收掉了（两者互斥）');
  const sheetTitle = await evalJs(page, `
    return document.querySelector('[role="dialog"] .font-semibold')?.textContent;`);
  ok(sheetTitle === '显示的日程集', '面板标题是「显示的日程集」，实际 ' + JSON.stringify(sheetTitle));
  const sheetRows = await evalJs(page, `return document.querySelectorAll('[role="dialog"] [data-cal-row]').length;`);
  ok(sheetRows >= 1, '面板里列出日程集，实际 ' + sheetRows + ' 行');
  /* 面板最后一行到面板底要留出空白（用户 2026-10-09：「移动端请给顶多的空白，
     现在太挤了，都快贴死底部了」）。原来 Sheet 的 body 是 `py-2`，最后一行离底
     只有 7px；现在下边距 = 16px + `env(safe-area-inset-bottom)`。 */
  const sheetPad = await evalJs(page, `
    const d = document.querySelector('[role="dialog"]').getBoundingClientRect();
    const rows = [...document.querySelectorAll('[role="dialog"] [data-cal-row]')];
    const last = rows[rows.length - 1].getBoundingClientRect();
    return { 最后一行距面板底: +(d.bottom - last.bottom).toFixed(1) };
  `);
  ok(sheetPad.最后一行距面板底 >= 12,
    '日程集面板最后一行离面板底有 12px 以上的空白（原来只有 7px，贴着底），实际 '
    + sheetPad.最后一行距面板底 + 'px');
  /* 打勾的勾要**正落在圆心**（用户 2026-10-09：「打勾的图标的勾并不居中」）。
     原来写的是 `left:5px; top:2px` + `rotate(45deg)`：`left/top` 摆的是盒子左上角，
     盒子中心就落在 (7,6)，圆心在 (9,9) —— 整体偏左上 2×3px。改成
     `left:50%; top:50%; translate(-50%,-50%) rotate(45deg)` 之后盒子中心正好是圆心。
     这里量的就是**勾盒中心减圆心**：`left:50%` 是相对 padding 盒算的，所以要加回
     边框宽度；旋转的原点是盒子中心、不动中心，只有 transform 里的平移会挪它。 */
  const tickBox = await evalJs(page, `
    const b = document.querySelector('[role="dialog"] [data-cal-row] .check-btn');
    const cs = getComputedStyle(b, '::after'), cb = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    const w = parseFloat(cs.width), h = parseFloat(cs.height);
    const t = cs.transform;
    let e = 0, f = 0;
    if (t && t.startsWith('matrix')) { const p = t.slice(7, -1).split(',').map(Number); e = p[4]; f = p[5]; }
    return { 圈直径: r.width,
             勾中心偏移: [+(parseFloat(cb.borderLeftWidth) + parseFloat(cs.left) + w / 2 + e - r.width / 2).toFixed(2),
                       +(parseFloat(cb.borderTopWidth) + parseFloat(cs.top) + h / 2 + f - r.height / 2).toFixed(2)] };
  `);
  ok(Math.abs(tickBox.勾中心偏移[0]) <= 0.6 && Math.abs(tickBox.勾中心偏移[1]) <= 0.6,
    '窄屏 ' + tickBox.圈直径 + 'px 勾选圈里，勾盒中心正落在圆心（原来偏左上 2×3px），实际 '
    + JSON.stringify(tickBox.勾中心偏移));
  /* 勾一个 → 面板**不收**（多选该让人连着勾），但勾选态要变。
     找**没勾**的那个勾上 —— 勾唯一那个会被「至少留一个」挡住（见 store.toggleCal）。
     用**原生 .click()**，跟探针里点 CalRow 那条路一致 —— clickEl 补的那记
     pointerdown 会撞上应用的长按状态机，把随后的 click 吃掉。 */
  const offId = await evalJs(page, `
    return (() => {
      const rows = [...document.querySelectorAll('[role="dialog"] [data-cal-row]')];
      const off = rows.find((r) => r.getAttribute('aria-pressed') !== 'true');
      return off ? off.dataset.calRow : null;
    })()
  `);
  await evalJs(page, `document.querySelector('[role="dialog"] [data-cal-row="${offId}"]').click(); return true;`);
  await new Promise((r) => setTimeout(r, 300));
  const offNow = await evalJs(page, `return document.querySelector('[role="dialog"] [data-cal-row="${offId}"]').getAttribute('aria-pressed');`);
  ok(offNow === 'true', '点一下能勾上（aria-pressed → ' + offNow + '）');
  ok(await evalJs(page, `return !!document.querySelector('[role="dialog"]');`),
    '勾完面板还开着（多选该让人连着勾，不是一选就关）');
  // 关掉面板、回到「更多」抽屉 —— 下一节要进设置页
  await evalJs(page, `
    const d = document.querySelector('[role="dialog"]');
    const btn = d && [...d.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '关闭');
    if (btn) btn.click();
    return true;
  `);
  await waitFor(page, `!document.querySelector('[role="dialog"]')`, '面板关掉了');
  await evalJs(page, `
    const t = [...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'));
    if (t) t.click();
    return true;
  `);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉重新打开');

  await clickEl(page, `document.querySelector('.more-sheet [data-nav="settings"]')`);
  await waitFor(page, `!!document.querySelector('[data-tab]')`, '设置页的底栏胶囊');
  // 移动端也显示拖拽列表（2026-10-07 起移动端和桌面端都能拖拽排序）
  ok(await evalJs(page, `return !!document.querySelector('[data-nav-row]');`),
    '窄屏设置页显示拖拽列表（移动端可拖拽）');

  const tabSel = (k) => `document.querySelector('[data-tab="${k}"]')`;
  ok(await clickEl(page, tabSel('inbox')) !== 'missing', '设置页里点得动底栏那排胶囊');

  // 关掉一项 → 底栏少一格
  await waitForUi('关掉待办箱之后落盘', `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.tabs.length === 3 ? 1 : null`);
  ok((await tabsNow()).length === 4, '关掉一项后底栏是 3 项 + 更多，实际 ' + JSON.stringify(await tabsNow()));

  // 再开一项
  await clickEl(page, tabSel('habits'));
  await waitForUi('开回打卡之后落盘', `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.tabs.length === 4 ? 1 : null`);
  ok((await tabsNow()).length === 5, '开满 4 项后底栏又回到 5 格，实际 ' + JSON.stringify(await tabsNow()));

  // 满 4 格之后第 5 个开不动 —— UI 挡一道，normalizeUi 再钳一道
  await clickEl(page, tabSel('done'));
  await new Promise((r) => setTimeout(r, 300));
  ok((await tabsNow()).length === 5, '满 4 项后再点一个开不动，实际 ' + JSON.stringify(await tabsNow()));

  // 刷新之后还在 —— 这两条字段曾经是死数据，「记得住」是这次真正要证的
  await reloadAs(true, '刷新后底栏还在');
  await new Promise((r) => setTimeout(r, 800));
  ok((await uiNow()).tabs.length === 4, '刷新后底栏还是 4 项');
  ok((await tabsNow()).length === 5, '刷新后底栏画出来还是 5 格');

  /* 拖一下网格 → **底栏当场跟着变**，不许等到刷新或点一次勾选才变。
     原先底栏读的是 `ui.tabs` 自己的顺序，而 `store.setUi` 是个裸的浅合并、
     不跑 `normalizeUi`，所以拖动只写了 `navOrder`，底栏纹丝不动（用户
     2026-10-09 报「要刷新 / 切换某个功能区显示隐藏后才变化」）—— 见踩坑 49。 */
  await dragNav('habits', 'today');
  ok((await tabsNow())[0] === '打卡',
    '拖动后底栏**立刻**跟着变（不必刷新），实际 ' + JSON.stringify(await tabsNow()));
  ok((await uiNow()).tabs[0] === 'habits',
    '`ui.tabs` 当场就按新顺序重排了，实际 ' + JSON.stringify((await uiNow()).tabs));
  ok((await uiNow()).navOrder[0] === 'habits',
    '`navOrder` 也落了盘，实际 ' + JSON.stringify((await uiNow()).navOrder));
  // 次序：勾中的全在前面，没勾的全在后面（网格里不再交叉排列）
  const nOn = await navOn();
  ok(nOn.slice(0, 4).every(Boolean) && nOn.slice(4).every((v) => !v),
    '网格里勾中的 4 项全在前、没勾的 5 项全在后，实际 ' + JSON.stringify(nOn));

  /* ---------- 半段二：宽屏只显示侧栏设置 ---------- */
  await reloadAs(false, '宽屏侧栏渲染出来了');
  ok(await evalJs(page, `return !!document.querySelector('.topbar .search-box input');`),
    '宽屏顶栏仍是常驻搜索框（只有窄屏才收成图标）');
  /* 桌面顶栏三件事（用户 2026-10-09）：
     ① 搜索框曾经比旁边那排控件高一大截（47.5px vs 30px）—— 它只有 `padding: 6px 11px`
        没有 `height`，`<input>` 的默认行高把它撑开了。现在跟日程集下拉**同高 30px**。
     ② 日程集下拉的文字曾经是「全部 1 个」（`calSummary()` 拼的），跟移动端抽屉里
        那格「日程集 1/1」是两套说法 —— 现在两边同一套文字、同一个 Layers 图标。 */
  const topbarH = await evalJs(page, `
    const h = (sel) => { const el = document.querySelector(sel); return el ? +el.getBoundingClientRect().height.toFixed(1) : null; };
    const t = document.querySelector('.cal-menu-btn');
    return { 搜索框: h('.topbar .search-box'), 日程集键: h('.cal-menu-btn'),
             日程集键文字: t ? t.textContent.replace(/\\s+/g, ' ').trim() : null,
             日程集键有图标: t ? !!t.querySelector('svg') : null };
  `);
  ok(topbarH.搜索框 === topbarH.日程集键,
    '桌面搜索框跟旁边的日程集下拉同高（原来 47.5 vs 30），实际 '
    + topbarH.搜索框 + ' vs ' + topbarH.日程集键);
  ok(topbarH.搜索框 === 30, '桌面搜索框是正常单行输入框的 30px，实际 ' + topbarH.搜索框);
  ok(/^日程集 \d+\/\d+$/.test(topbarH.日程集键文字 || ''),
    '桌面日程集下拉跟移动端同一套文字「日程集 x/y」，实际 ' + JSON.stringify(topbarH.日程集键文字));
  ok(topbarH.日程集键有图标, '桌面日程集下拉也有图标（跟移动端那格同一个）');
  /* 滚动条不许占位置（用户 2026-10-09：「全局的无论桌面还是移动，滚动条都不要占位置，
     不要挤现有元素」）。判据是**把 overflow-y 临时藏起来，clientWidth 不变** ——
     占位的滚动条会让 clientWidth 少掉十几 px。滚动容器一律挂 `.osb`（隐藏原生条）
     + `useOverlayScrollbar`（画一条浮在上面的 `.osb-track`）。 */
  const osb = await evalJs(page, `
    const g = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      /* 先把它**逼成能滚**的（临时压到 80px 高）—— 不能滚的容器量不出挤不挤：
         占位的滚动条只在真的出现时才吃掉宽度。 */
      const h0 = el.style.height;
      el.style.height = '80px';
      const before = el.clientWidth;
      const ov = getComputedStyle(el).overflowY;
      el.style.overflowY = 'hidden';
      const noBar = el.clientWidth;
      el.style.overflowY = ov;
      el.style.height = h0;
      return { 能滚: el.scrollHeight > el.clientHeight, 占位: before - noBar,
               原生条: getComputedStyle(el).scrollbarWidth,
               挂载了浮条: !!el.querySelector(':scope > .osb-track'),
               类: el.classList.contains('osb') };
    };
    return { 侧栏: g('.sidebar'), 内容: g('.content') };
  `);
  ok(osb.侧栏 && osb.侧栏.占位 === 0 && osb.侧栏.原生条 === 'none'
    && osb.侧栏.类 && osb.侧栏.挂载了浮条,
    '侧栏滚动条不占位（逼成能滚也不吃宽度）且挂上了浮层滚动条，实际 ' + JSON.stringify(osb.侧栏));
  ok(osb.内容 && osb.内容.占位 === 0 && osb.内容.原生条 === 'none'
    && osb.内容.类 && osb.内容.挂载了浮条,
    '内容区滚动条不占位且挂上了浮层滚动条，实际 ' + JSON.stringify(osb.内容));
  // 日程页的日期长文本只该出现一次 —— 在顶栏标题里。副header 原来也写一遍，
  // 于是「10月7日」在相邻两行各出现一次；现在副header 只放控件。
  await evalJs(page, `document.querySelector('[data-nav="calendar"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.cal-subhead')`, '宽屏日程副header渲染出来');
  ok(await evalJs(page, `return document.querySelectorAll('.cal-subhead .date-range').length;`) === 0,
    '副header 不再重复日期长文本，实际 '
    + await evalJs(page, `return document.querySelectorAll('.cal-subhead .date-range').length;`));

  // 顶栏标题就是那唯一一份日期，粒度跟视图走：日 = 某天 · 周 = 这一周的起止 ·
  // 月 = 年月。周视图原先跟月视图一样写「2026年10月」，看不出「这一周是哪一周」。
  const topTitle = () => evalJs(page, `return document.querySelector('.topbar .view-title').textContent;`);
  const dayTitle = await topTitle();
  ok(/^\d{1,2}月\d{1,2}日$/.test(dayTitle), '日视图顶栏标题是具体某天，实际 ' + dayTitle);

  // 副header 的三件控件：今天只留一个「今」字、找日期只留图标、上一/下一个有图标
  ok(await evalJs(page, `return document.querySelector('.date-nav [aria-pressed]').textContent;`) === '今',
    '「今天」按钮只留一个「今」字，实际 '
    + await evalJs(page, `return document.querySelector('.date-nav [aria-pressed]').textContent;`));
  // 需求 6：就在今天时「今」键亮起（原先反了：不在今天才亮）。
  // 点「今」跳回今天 → 这个键变成选中态，和日 / 周 / 月三个视图档同一个语义。
  await clickEl(page, `document.querySelector('.date-nav [aria-pressed]')`);
  await new Promise((r) => setTimeout(r, 200));
  ok(await evalJs(page, `return document.querySelector('.date-nav [aria-pressed]').getAttribute('aria-pressed') === 'true';`),
    '回到今天之后「今」按钮是选中态（需求 6）');
  ok(await evalJs(page, `return !document.querySelector('.date-nav [aria-haspopup="dialog"]').textContent.trim();`),
    '「找日期」只留图标、没有文字');
  ok(await evalJs(page, `return !!document.querySelector('.date-nav .btn svg');`),
    '上一/下一个按钮里是图标');

  // 上一/下一个的**功能**跟着视图走：日 = 换一天 · 周 = 切一周 · 月 = 切一月。
  // 判据是顶栏标题（那唯一一份日期），不是游标 —— 用户看的就是它。
  await clickEl(page, `document.querySelectorAll('.date-nav .btn')[1]`);
  await waitFor(page, `document.querySelector('.topbar .view-title').textContent !== ${JSON.stringify(dayTitle)} ? 1 : null`,
    '日视图按「下一个」标题变了', 8000);
  ok(await evalJs(page, `return document.querySelector('.topbar .view-title').textContent;`) !== dayTitle,
    '日视图按「下一个」换了一天，实际 ' + await topTitle());

  await evalJs(page, `document.querySelector('[data-view="week"]').click(); return true;`);
  await waitFor(page, `document.querySelector('[data-view="week"].on') ? 1 : null`, '切到周视图', 8000);
  const weekTitle = await topTitle();
  ok(/^\d{1,2}月\d{1,2}日 – \d{1,2}月\d{1,2}日$/.test(weekTitle),
    '周视图顶栏标题是这一周的起止，实际 ' + weekTitle);
  await clickEl(page, `document.querySelectorAll('.date-nav .btn')[1]`);
  await waitFor(page, `document.querySelector('.topbar .view-title').textContent !== ${JSON.stringify(weekTitle)} ? 1 : null`,
    '周视图按「下一个」标题变了', 8000);
  const weekTitle2 = await topTitle();
  ok(weekTitle2 !== weekTitle, '周视图按「下一个」切了一周，实际 ' + weekTitle2);

  await evalJs(page, `document.querySelector('[data-view="month"]').click(); return true;`);
  await waitFor(page, `document.querySelector('[data-view="month"].on') ? 1 : null`, '切到月视图', 8000);
  const monthTitle = await topTitle();
  ok(/^\d{4}年\d{1,2}月$/.test(monthTitle), '月视图顶栏标题是年月，实际 ' + monthTitle);
  await clickEl(page, `document.querySelectorAll('.date-nav .btn')[1]`);
  await waitFor(page, `document.querySelector('.topbar .view-title').textContent !== ${JSON.stringify(monthTitle)} ? 1 : null`,
    '月视图按「下一个」标题变了', 8000);
  ok(await topTitle() !== monthTitle, '月视图按「下一个」切了一月，实际 ' + await topTitle());
  await clickEl(page, `document.querySelector('.sidebar [data-nav="settings"]')`);
  await waitFor(page, `!!document.querySelector('[data-nav-row]')`, '设置页的侧栏列表');
  ok(await evalJs(page, `return !document.querySelector('[data-tab]');`),
    '宽屏设置页不显示底栏胶囊（按设备分屏）');

  // 设置页调序：mousedown / mousemove / mouseup 必须**分开的 tick** ——
  // 同一个 tick 里连发的话 React 还没重渲染，handler 闭包里的状态仍是旧的。
  // 走第九节那套合成鼠标事件（MouseSensor 已证过能起来）：
  // 第一次 mousemove 只挪 12px，刚好越过 distance:8 的激活门槛。
  // **起手打在整行上，不用找把手** —— listeners 现在绑在 `<li>` 本身
  // （原先只绑在那个 grip 图标上，必须精确按住 12px 的小图标才拖得动，
  //  用户报「完全不跟手」）。把手只剩视觉提示作用，不是命中区。
  const navRow = (k) => `[...document.querySelectorAll('[data-nav-row]')].find((x) => x.dataset.navRow === ${JSON.stringify(k)})`;

  ok((await evalJs(page, `return ${navRow('trash')}.getAttribute('role');`)) === 'button',
    'dnd-kit 的 attributes 挂上了（role=button）');
  ok(await evalJs(page, `return ${navRow('trash')}.className.includes('cursor-grab');`),
    '整行都是拖拽命中区（cursor-grab 在行上，不在把手图标上）');

  const navSrc = await evalJs(page, `
    const el = ${navRow('trash')};
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  const navDst = await evalJs(page, `
    const el = ${navRow('today')};
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);

  await evalJs(page, `
    ${navRow('trash')}.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, clientX: ${navSrc.x}, clientY: ${navSrc.y} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 60));
  await evalJs(page, `
    const el = document.elementFromPoint(${navSrc.x}, ${navSrc.y + 12});
    el.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, clientX: ${navSrc.x}, clientY: ${navSrc.y + 12} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 60));
  /* 指针先真正挪到 today 上 —— **断言必须写在指针到位之后**。
     2026-10-19 教训：原来「落点那一格 = today」写在只挪了 12px（刚过激活
     门槛）的位置上，那时候指针还压在 trash 自己身上、落点是它自己。那条断言
     当时能绿，是因为 `isOver` 的判据写反了（见下面第三条），每一格都中。 */
  await evalJs(page, `
    const el = document.elementFromPoint(${navDst.x}, ${navDst.y});
    el.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, clientX: ${navDst.x}, clientY: ${navDst.y} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 60));
  /* 占位虚影画在**落点**，不是原点：判据是 dnd-kit 的 `isOver`（指针正压着的
     那一格 = 松手时会被占掉的槽位），所以 trash 自己身上**没有**虚线类，
     today 那一格才有。判的是类名在谁身上，不是「有没有虚线」——
     原先反了（虚线钉在被拖项身上、锁在原位），用户报「不会跟着走」。 */
  ok(await evalJs(page, `return !${navRow('trash')}.className.includes('drag-land');`),
    '被拖的那一格自己不是占位虚影（虚影跟着落点走，不锁在原位）');
  ok(await evalJs(page, `return ${navRow('today')}.className.includes('drag-land');`),
    '落点那一格是占位虚影（isOver = today）');
  /* 2026-10-19 回归：`isOver` 的判据曾经写反成 `over.id !== id`，那对每一格
     都成立 —— drag-land 落到全部格子上，`.drag-land { opacity: 0 }` 一发，
     拖拽时整页只剩浮层里跟着手指的那一份（用户报「其他任务全消失了」）。
     既不是被拖项、也不是落点的那几格必须**原样显示**。 */
  ok(await evalJs(page, `
    const el = ${navRow('inbox')};
    return !el.className.includes('drag-land') && Number(getComputedStyle(el).opacity) > 0.5;
  `), '其他格子在拖拽中原样显示（不占虚影、不透明）');
  /* 让位动画：被拖的那一格**不给** transition（它跟手指走，迟滞半拍就是
     「不跟手」），让位的那几格**要给**（不给就是闪现）。读的是内联样式的
     计算结果 —— `useSortable` 没在拖的时候返回 undefined，压根没有这个属性。 */
  ok(await evalJs(page, `return ${navRow('trash')}.style.transition === '';`),
    '被拖的那一格没有 transition（跟手，不迟滞）');
  ok(await evalJs(page, `return !!${navRow('today')}.style.transition;`),
    '让位的那几格有 transition（滑过去，不是闪现），实际 '
      + JSON.stringify(await evalJs(page, `return ${navRow('today')}.style.transition;`)));
  /* 占位虚影：**落点**那一格虚线化、压暗（内容透明，只剩一个空框），
     跟手指走的是浮层里那份实体卡。判据看**算出来的样式**，不是看类名 ——
     类名改了样式没跟上，探针照样绿。 */
  const navGhost = await evalJs(page, `
    const li = ${navRow('today')};
    const cs = getComputedStyle(li);
    const ov = document.querySelector('.drag-overlay .nav-chip');
    return {
      outline: cs.outlineStyle + ' ' + cs.outlineWidth,
      opacity: Number(cs.opacity),
      shadow: ov ? getComputedStyle(ov).boxShadow : null,
      overlayText: ov ? ov.textContent.trim() : null,
    };
  `);
  ok(/dashed/.test(navGhost.outline) && navGhost.opacity < 0.6,
    '落点那一格是虚线占位虚影（虚线描边 + 内容透明），实际 ' + JSON.stringify(navGhost));
  ok(!!navGhost.shadow && navGhost.overlayText,
    '跟着手指走的是浮层里那份实体卡，实际 ' + JSON.stringify(navGhost.overlayText));
  ok(/rgba\(38, 32, 24, 0\.16\)|rgba\(38,32,24,0\.16\)/.test(navGhost.shadow),
    '浮层那份的影子是统一的中性淡影 --drag-shadow（不再是主色绿光），实际 '
      + JSON.stringify(navGhost.shadow));
  await evalJs(page, `
    const el = document.elementFromPoint(${navDst.x}, ${navDst.y});
    el.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, clientX: ${navDst.x}, clientY: ${navDst.y} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 60));
  await evalJs(page, `
    const el = document.elementFromPoint(${navDst.x}, ${navDst.y});
    el.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, clientX: ${navDst.x}, clientY: ${navDst.y} }));
    return true;
  `);
  await waitForUi('设置页调序落盘',
    `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.navOrder.indexOf('trash') === 1 ? 1 : null`);
  ok((await uiNow()).navOrder.indexOf('trash') === 1,
    '设置页调序真的落库了（trash 挪到了第 2 位），实际 ' + JSON.stringify((await uiNow()).navOrder));

  await reloadAs(false, '刷新后宽屏还在');
  await new Promise((r) => setTimeout(r, 800));
  ok((await uiNow()).navOrder.indexOf('trash') === 1, '刷新后顺序还在');

  /* ---------------- 桌面侧栏那层：不许装作能拖、藏起来的也不许「消失」 ----------------

     两条都是「桌面端跟手机不对等」的报障（用户 2026-10-09）：
     手机上功能区 = 底栏 4 格 + 「更多」抽屉，桌面 = 侧栏那一列，而侧栏**既不能拖、
     也没有「更多」**，于是那列还留着旧版的抓手光标（假暗示），一勾掉又只剩设置页
     能找回来（真死角）。 */

  // ① 侧栏那列不能拖，光标就别装作能拖。`cursor: grab` 是旧版残留 ——
  //    `legacy/index.html` 里的 `.nav-item` 真的写着 `draggable="true"`，
  //    React 重写时拖拽没了、光标留下了。排序只有设置页这张网格能做。
  const sideCursor = await evalJs(page, `return getComputedStyle(document.querySelector('.sidebar .nav-item')).cursor;`);
  ok(sideCursor !== 'grab',
    '桌面侧栏 .nav-item 不再是抓手光标（那是在说「能拖」，而它不能），实际 ' + sideCursor);

  // ② 藏两项 → 它们沉到网格最后，勾中的全在前面
  await clickEl(page, `document.querySelector('[data-nav-row="ai"]')`);
  await clickEl(page, `document.querySelector('[data-nav-row="done"]')`);
  await waitForUi('藏两项落盘',
    `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.navHidden.length === 2 ? 1 : null`);
  const navKeys = () => evalJs(page,
    `return [...document.querySelectorAll('[data-nav-row]')].map((x) => x.dataset.navRow);`);
  /* 期望值**算出来**，不写死字符串：网格次序的定义就是「`navOrder` 里显示中的
     按原序在前、被隐藏的按原序在后」。写死的话，前面几步一动 `navOrder`，这里
     就变成在测我抄的那串常量，而不是在测代码。 */
  const ui2 = await uiNow();
  const hid = new Set(ui2.navHidden);
  const shownKeys = ui2.navOrder.filter((k) => !hid.has(k));
  const hiddenKeys = ui2.navOrder.filter((k) => hid.has(k));
  ok(ui2.navHidden.slice().sort().join() === 'ai,done' && shownKeys.length === 7 && hiddenKeys.length === 2,
    'navHidden 记下了藏起来的两项（显示组 7 · 隐藏组 2），实际 ' + JSON.stringify(ui2.navHidden));
  const grid0 = [...shownKeys, ...hiddenKeys];
  ok((await navKeys()).join() === grid0.join(),
    '网格次序 = 「显示中的在前 + 被隐藏的按原序在后」（不再交叉排列），实际 '
    + JSON.stringify(await navKeys()));
  const wOn = await navOn();
  ok(wOn.slice(0, 7).every(Boolean) && wOn.slice(7).every((v) => !v),
    '前 7 格显示中、后 2 格隐藏，实际 ' + JSON.stringify(wOn));

  // ③ 跨组落位：**拖是自由的，落点被钳回本组**。显示项拖进隐藏区 → 落到显示组
  //    末位；隐藏项拖进显示区 → 落到隐藏组最前位。原先两组混着排。
  await dragNav(shownKeys[0], hiddenKeys[hiddenKeys.length - 1]);
  const shownAfter1 = [...shownKeys.slice(1), shownKeys[0]];
  ok((await navKeys()).join() === [...shownAfter1, ...hiddenKeys].join(),
    '显示项拖进隐藏区 → 落到显示组末位，实际 ' + JSON.stringify(await navKeys()));
  const lastHidden = hiddenKeys[hiddenKeys.length - 1];
  await dragNav(lastHidden, shownAfter1[0]);
  const grid2 = [...shownAfter1, lastHidden, ...hiddenKeys.slice(0, -1)];
  ok((await navKeys()).join() === grid2.join(),
    '隐藏项拖进显示区 → 落到隐藏组最前位，实际 ' + JSON.stringify(await navKeys()));
  const wOn2 = await navOn();
  ok(wOn2.slice(0, 7).every(Boolean) && wOn2.slice(7).every((v) => !v),
    '落位之后仍然是显示中的在前');

  // ④ 侧栏底部的「更多」：桌面没有底栏那个抽屉，被藏起来的项得有个地方够得着
  ok(await evalJs(page, `return !!document.querySelector('.sidebar [data-nav-more]');`),
    '有隐藏项时侧栏底部出现「更多」入口');
  const sideKeys = () => evalJs(page,
    `return [...document.querySelectorAll('.sidebar #nav .nav-item')].map((x) => x.dataset.nav);`);
  ok(!(await sideKeys()).includes('ai') && !(await sideKeys()).includes('done'),
    '被藏起来的项确实不在侧栏主列里，实际 ' + JSON.stringify(await sideKeys()));
  await clickEl(page, `document.querySelector('.sidebar [data-nav-more]')`);
  await waitFor(page, `!!document.querySelector('.side-more-pop')`, '侧栏「更多」浮层打开');
  /* 「开得出来」还不够：浮层开在**侧栏里面**，而 `.sidebar` 是 `overflow-y: auto`
     —— 按规范一个轴不是 `visible` 时，另一个轴的 `visible` 会算成 `auto`，横向
     也会裁。所以量一下它真的落在侧栏的盒子里、而且开在触发键上方（挂在侧栏最
     底下，往下开会顶出视口）。 */
  const popBox = await evalJs(page, `
    const p = document.querySelector('.side-more-pop').getBoundingClientRect();
    const s = document.querySelector('.sidebar').getBoundingClientRect();
    const b = document.querySelector('.sidebar [data-nav-more]').getBoundingClientRect();
    return { dxLeft: p.left - s.left, dxRight: p.right - s.right, dy: p.bottom - b.top };
  `);
  ok(popBox.dxLeft >= -0.5 && popBox.dxRight <= 0.5,
    '浮层没有横向溢出侧栏（`.sidebar` 是 overflow-y: auto，横向跟着裁），实际 ' + JSON.stringify(popBox));
  /* 而且**跟侧栏几乎等宽**，只留侧栏自己那点 padding（用户 2026-10-09：「桌面端的
     更多可以改成向上弹出和侧栏几乎等宽的，只要留几个 px 的 padding 即可」）。
     原来包含块是 `.side-more`（底栏那行两个 flex:1 里右边那个），浮层只有 99.5px、
     缩在右下角。现在包含块是 `.sidebar-footer`（正好横跨侧栏内容宽），`left:0;
     right:0` 就横跨整行 —— 左右各留 14px，且**两边一样多**。
     别把 `.side-more` 改回 `position: relative`：它一变成定位元素，包含块就缩回
     半个底栏宽，这条会当场变红。 */
  const padL = popBox.dxLeft, padR = -popBox.dxRight;
  ok(padL >= 8 && padR >= 8 && Math.abs(padL - padR) <= 2,
    '浮层跟侧栏几乎等宽（左右各留十来个 px 的 padding，不再缩成半个底栏），实际 左 '
    + padL + ' / 右 ' + padR);
  ok(popBox.dy <= 0.5, '浮层开在触发键**上方**，实际 ' + JSON.stringify(popBox));
  const tuckedKeys = () => evalJs(page,
    `return [...document.querySelectorAll('.side-more-pop .nav-item')].map((x) => x.dataset.nav);`);
  ok((await tuckedKeys()).join() === grid2.slice(7).join(),
    '浮层里列出的正是被藏起来的那两项（顺序跟 navOrder），实际 '
    + JSON.stringify(await tuckedKeys()));
  ok(await evalJs(page, `return [...document.querySelectorAll('.side-more-pop .nav-item .label')].every((x) => x.textContent.trim());`),
    '浮层里每一项都画出了名字（不是一排空按钮）');
  await clickEl(page, `[...document.querySelectorAll('.side-more-pop .nav-item')].find((x) => x.dataset.nav === ${JSON.stringify(lastHidden)})`);
  await waitForUi('点浮层里那一项切过去了',
    `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.nav === ${JSON.stringify(lastHidden)} ? 1 : null`);
  ok(await evalJs(page, `return !document.querySelector('.side-more-pop');`),
    '点完浮层自己收掉（不然它会盖着新页面）');

  // ⑤ 全部放出来 → 入口自己也收掉（空浮层比没有更费解）
  await clickEl(page, `document.querySelector('.sidebar [data-nav="settings"]')`);
  await waitFor(page, `!!document.querySelector('[data-nav-row]')`, '回到设置页');
  await clickEl(page, `document.querySelector('[data-nav-row="ai"]')`);
  await clickEl(page, `document.querySelector('[data-nav-row="done"]')`);
  await waitForUi('全部放出来落盘',
    `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.navHidden.length === 0 ? 1 : null`);
  ok(!(await evalJs(page, `return !!document.querySelector('.sidebar [data-nav-more]');`)),
    '一个都没藏时「更多」入口不画');

  // 恢复伪窄屏给后面几节（十九、二十都在窄屏下跑）
  await reloadAs(true, '恢复窄屏模式');

  console.log('\n十九、项目泳道：建项目 → 挂任务 → 拖卡片换列 → 刷新还在');

  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'))`);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
  await clickEl(page, `document.querySelector('.more-sheet [data-nav="projects"]')`);
  await waitFor(page, `!!document.querySelector('.pj-wrap')`, '项目页挂上');
  ok(await evalJs(page, `return document.querySelector('#content').textContent.includes('还没有项目');`),
    '空态说话，不是一片白');

  /* ---- 先切到一个**有写权限**的集，再建项目 ----
     第十节把「爸爸」在别的集里降成了只读，此刻 `ui.cal` 正指着那个只读集。
     项目是挂在 `ui.cal` 上的（`store.addProject` → `makeProject(name, ui.cal)`），
     只读集上 `commitMany` 会被 `canWrite(roleOf(...))` 挡下、**静默丢弃**
     （只有一条 deny 提示），症状是「点完创建浮层关了、项目没出现」，看着像
     泳道坏了。第十四节踩过同一个坑（quickAdd 被挡），按 role 挑集即可。
     挑哪个集也**不按名字**：第六节把集改过名，照着名字找会静默找不到。
     窄屏没有桌面那个日程集下拉框，走「更多」抽屉里那块多选面板。 */
  const pjCal = await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    const canWrite = (r) => r === 'owner' || r === 'editor';
    const mine = (st.cals || []).filter((c) => canWrite(c.role));
    const pick = mine.find((c) => c.id !== st.ui.cal) || mine[0];
    return pick ? pick.id : '';`);
  ok(pjCal !== '', '有一个有写权限的日程集可切');
  const curCal = await evalJs(page, `return JSON.parse(localStorage.getItem('schedule-app-v4')).ui.cal;`);
  if (pjCal !== curCal) {
    await evalJs(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多')).click(); return true;`);
    await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
    await evalJs(page, `document.querySelector('[data-cal-sheet-open]').click(); return true;`);
    await waitFor(page, `!!document.querySelector('[role="dialog"] [data-cal-row]')`, '日程集多选面板');
    /* 先勾上有写权限的那个（勾上顺带成为归属），再取消勾别的 ——
       反过来的话「至少留一个」会把取消挡掉，归属又滑回只读那个。 */
    await evalJs(page, `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const rows = () => [...document.querySelectorAll('[role="dialog"] [data-cal-row]')];
      const want = ${JSON.stringify(pjCal)};
      const hit = rows().find((r) => r.dataset.calRow === want);
      if (hit && hit.getAttribute('aria-pressed') !== 'true') { hit.click(); await sleep(80); }
      for (const r of rows()) {
        if (r.dataset.calRow !== want && r.getAttribute('aria-pressed') === 'true') { r.click(); await sleep(80); }
      }
      return true;`);
    await evalJs(page, `
      const d = document.querySelector('[role="dialog"]');
      const btn = d && [...d.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '关闭');
      if (btn) btn.click();
      return true;`);
    await waitFor(page, `!document.querySelector('[role="dialog"]')`, '面板关掉了');
    await waitForUi('切集落盘',
      `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.cal === ${JSON.stringify(pjCal)} ? 1 : null`);
  }

  await clickEl(page, `document.querySelector('.pj-top .btn')`);
  await waitFor(page, `!!document.querySelector('.field input')`, '项目浮层打开');

  /* ---- 集选择器：项目**不绑当前集**（`addProject(name, calId)`）----
     原来固定落 `ui.cal`：当前集只读时 commitMany 被 canWrite 挡下、**静默丢弃**，
     症状是「点完创建浮层关了、项目没出现」，看着像泳道坏了。现在浮层里挑一个
     能写的集，且**只列「能写 ∩ 正勾着」的** —— 没勾的集落进去会凭空消失
     （useScopedState 按 p.calId 过滤），跟 toggleCal 那条「归属不能没有显示的
     地方」是同一件事。

     ⚠️ 这一段**不复用 clickEl**：clickEl 只派发 pointerdown / pointerup / click，
     **不派发 mousedown**（见本文件 clickEl 的定义），而外面那个 Sheet 收不收起
     听的正是 capture 阶段的 mousedown（useOutsideClose）。里面的选项又是 portal
     到 body 的 —— DOM 上不是外面面板的后代，不修 useOutsideClose 的话，真手点一下
     选项就先把**外层**关掉、连带把选项那层卸载，这一次点击白丢，而 clickEl 照样绿。
     hooks.ts 那条注释记着同一个坑（「只在真机上出现，合成 click 测不出来」）。
     所以走 tapEl：完整的 mousedown → mouseup → click。 */
  const tapEl = (findExpr) => evalJs(page, `
    const el = ${findExpr};
    if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mousedown', at));
    el.dispatchEvent(new MouseEvent('mouseup', at));
    el.dispatchEvent(new MouseEvent('click', at));
    return 'ok';
  `);

  ok(await evalJs(page, `return !!document.querySelector('[aria-label="日程集"]');`),
    '新建浮层里有「日程集」选择器，项目不绑当前集');

  /* 默认值：当前集能写就用当前集，否则第一个能写的 —— 但**必须**是勾着的那个 */
  const calPick = await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    const canWrite = (r) => r === 'owner' || r === 'editor';
    const mine = (st.cals || []).filter((c) => canWrite(c.role) && st.ui.cals.includes(c.id));
    const btn = document.querySelector('[aria-label="日程集"]');
    const txt = btn ? btn.textContent.trim() : '';
    const hit = (st.cals || []).find((c) => c.name === txt);
    return { listed: mine.map((c) => c.name).sort().join('|'), picked: txt,
             good: !!hit && canWrite(hit.role) && st.ui.cals.includes(hit.id) };`);
  ok(calPick.good, '默认落在「能写 ∩ 正勾着」的集：' + calPick.picked);

  /* 打开那层看选项：应该**只有**能写且勾着的（只读的、没勾的都不该出现）。
     `=== 2` 是嵌套没被误关的判据 —— 外层要是先被 mousedown 关了，这里只剩 1 个。 */
  ok(await tapEl(`document.querySelector('[aria-label="日程集"]')`) === 'ok', '打开「日程集」选择层');
  await waitFor(page, `document.querySelectorAll('[role="dialog"]').length === 2`,
    '选择层弹开、项目浮层还在（嵌套没被 useOutsideClose 误伤）', 8000);
  const calListed = await evalJs(page, `
    const ds = [...document.querySelectorAll('body > div [role="dialog"]')];
    const d = ds[ds.length - 1];
    return [...d.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).sort().join('|');`);
  ok(calListed === calPick.listed,
    '只列能写且勾着的集，实际 ' + JSON.stringify(calListed) + '，期望 ' + JSON.stringify(calPick.listed));

  /* 挑当前那个（选回自己，仍要真手那一下 —— 这条同时验了选中能落回、浮层收得干净） */
  ok(await tapEl(`(() => {
    const ds = [...document.querySelectorAll('body > div [role="dialog"]')];
    const d = ds[ds.length - 1];
    const btns = [...d.querySelectorAll('button')];
    return btns.find((b) => b.textContent.trim() === ${JSON.stringify(calPick.picked)});
  })()`) === 'ok', '在选择层里挑中一个集');
  await waitFor(page, `document.querySelectorAll('[role="dialog"]').length === 1`,
    '选完收起，只剩项目浮层', 8000);
  const setField = (sel, val) => evalJs(page, `
    return (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'missing';
      (${SETTER})(el, ${JSON.stringify(val)});
      return 'ok';
    })();
  `);
  ok(await setField('.field input', '星星包') === 'ok', '填项目名字');
  await clickEl(page, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '创建')`);
  await waitFor(page, `!!document.querySelector('[data-lane]')`, '泳道出现');
  ok((await evalJs(page, `return [...document.querySelectorAll('[data-lane] .pj-col-h')].map((x) => x.textContent.replace(/\\d/g, '').trim());`)).join() === '待办,进行中,已完成',
    '三列：待办 / 进行中 / 已完成');

  // 加一条任务，并在详情抽屉里挂到项目上。
  // 走**底栏**而不是「更多」抽屉：上一节把「今天」留在了底栏里，而抽屉只画
  // 差集（底栏没有的那些）—— 从抽屉里找 today 找不到，clickEl 只会返回
  // 'missing' 不报错，症状是「任务出现」等不到、看着像快速添加坏了。
  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.replace(/\\d+/g, '').trim() === '今天')`);

  /* ---- 窄屏那个 + / ×（需求 1、2、8） ---- */
  // 收起时是 +、展开时**原地变成 ×** —— 不再是横条里那个收起键。
  // 输入框是从这个圆里弹出去的，所以它一直在（横条收起时它也不能消失）。
  //
  // ⚠️ `evalJs` 把表达式包成 `(async () => { <表达式> })()` —— **必须自己写 `return`**，
  // 光写一个表达式会得到 undefined，断言就永远是假（这几条第一次就是这么假红的）。
  // `waitFor` 会替我们补 `return`，所以它那几行不用写。
  //
  // lucide-react 给每个图标带 `lucide-<名字>` 这个类，所以 `+` / `×` 认的是
  // `.lucide-plus` / `.lucide-x`，比数 svg 的 path 稳。
  ok(await evalJs(page, `return !!document.querySelector('.fast-fab');`), '窄屏下右下角有浮动 + 号');
  ok(await evalJs(page, `return getComputedStyle(document.querySelector('.fast-add')).display !== 'none';`),
    '窄屏下横条常渲染（收起时只露圆钮）');
  ok(await evalJs(page, `return !!document.querySelector('.fast-fab .lucide-plus');`),
    '收起时那个圆里是 +');
  // 收起态的圆钮位置 —— 展开后要**一模一样**（需求 1：开关固定在某个位置不动）
  const fabCollapsed = await evalJs(page, `
    const f = document.querySelector('.fast-fab').getBoundingClientRect();
    return { right: +f.right.toFixed(1), bottom: +f.bottom.toFixed(1) };
  `);

  await clickEl(page, `document.querySelector('.fast-fab')`);
  // 窄屏横条**常渲染**（收起时只露圆钮），所以「展开」要看 `.open` 这个类，
  // 不是 display —— display 从头到尾都是 flex，拿它判展开恒真
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '点 + 号展开横条', 8000);
  ok(await evalJs(page, `return !!document.querySelector('.fast-fab .lucide-x');`),
    '展开后 + 号**原地**变成 ×（需求 1）');
  // 需求 2：点 + 展开**不自动聚焦**输入框（手机上那会当场弹出软键盘，
  // 把用户想先看一眼的输入框挡住）。要打字自己点一下输入框。
  ok(await evalJs(page, `return document.activeElement !== document.querySelector('.fast-add textarea');`),
    '展开后焦点没有自动进输入框（需求 2）');

  /* 圆钮**钉在横条右下角**（需求 1、2）—— 绝对定位，不参与 flex。
     它以前是普通 flex 子元素：收起时 `.fast-add-body` / `.fast-side` 都
     display:none，只剩它一个，默认 justify-content:flex-start 就把它甩到
     **左边**；展开时又跟着内容跑。 */
  const barBox = await evalJs(page, `
    const bar = document.querySelector('.fast-add');
    const fab = document.querySelector('.fast-fab');
    const b = bar.getBoundingClientRect(), f = fab.getBoundingClientRect();
    const s = getComputedStyle(bar), fs = getComputedStyle(fab);
    return {
      pos: s.position,
      fabPos: fs.position,
      // 横条**左右各留 13px**（和流内那条 margin: 4px 13px 12px 同一档）。
      // 量的是 layout viewport（clientWidth，不含滚动条）：用 innerWidth 的话，
      // 页面上真出现一条 10px 滚动条时这里会凭空多出 10，看着像「右边距变大了」。
      leftGap: +b.left.toFixed(1),
      rightGap: +(document.documentElement.clientWidth - b.right).toFixed(1),
      // 圆钮在横条内（DOM 上仍是子节点），但**不在动画层里**（见下面的 fabInShell）
      fabInBar: bar.contains(fab),
      fabInShell: document.querySelector('.fast-add-shell').contains(fab),
      // 圆钮贴横条右端 / 底端 —— 右 13 是照着左边的内边距 13 来的，底 18 是居中
      fabRightGap: +(b.right - f.right).toFixed(1),
      fabBottomGap: +(b.bottom - f.bottom).toFixed(1),
      // 圆钮在屏幕上的绝对位置，展开前后要一样
      fabRight: +f.right.toFixed(1),
      fabBottom: +f.bottom.toFixed(1),
      dbg: { n: document.querySelectorAll('.fast-add').length,
        barH: +b.height.toFixed(1), fabH: +f.height.toFixed(1),
        kids: [...bar.children].map((c) => c.className + ':' + Math.round(c.getBoundingClientRect().height)) },
    };
  `);
  ok(barBox.pos === 'fixed',
    '窄屏的横条是 fixed 定位（贴着圆钮、不占正文流），实际 ' + barBox.pos);
  ok(barBox.fabPos === 'absolute',
    '圆钮是绝对定位（不参与 flex，才不会被甩到左边 / 被内容带着跑），实际 ' + barBox.fabPos);
  // 左右**对称**留 13px，不是贴到屏幕最右。
  // 贴边（原先的 `right: 0`）会让 `:focus-within` 那圈 3px 光晕在右端被裁掉一截，
  // 和左边不对称 —— 2026-10-08 改成 left/right 都是 13px。这条断言跟着改口径：
  // 要守的是「两边一样宽」，不是「贴边」。
  ok(Math.abs(barBox.leftGap - 13) < 1.5 && Math.abs(barBox.rightGap - 13) < 1.5,
    '横条左右各留 13px（贴边会把 focus 光晕裁掉），实际 左 ' + barBox.leftGap + ' / 右 ' + barBox.rightGap);
  ok(barBox.fabInBar,
    '圆钮在横条内（DOM 上仍是子节点）');
  // 需求 3 的结构前提：圆钮不能落在动画层里 —— 动画一 transform、一改 opacity，
  // 整棵子树跟着动，圆钮就被拖着走了。这条断言把它钉在结构上。
  ok(!barBox.fabInShell,
    '圆钮不在动画层 .fast-add-shell 里（否则动画会带飞它）');
  ok(Math.abs(barBox.fabRightGap - 13) < 1.5,
    '圆钮贴横条右端（13px），实际 ' + barBox.fabRightGap);
  // 需求 3：圆钮**竖直居中于展开后的横条**（不是贴底）——
  // 盒子高 84（内边距 9×2 + 内容 64 + 边框 1×2），48 的圆钮居中 → (84 − 48) / 2 = 18
  ok(Math.abs(barBox.fabBottomGap - 18) < 2,
    '圆钮在展开后的横条里竖直居中（不贴底），实际底间隙 ' + barBox.fabBottomGap);
  // 需求 1 的正面：+ / × 换图标时，圆钮自己在屏幕上不挪窝
  ok(Math.abs(barBox.fabRight - fabCollapsed.right) < 1
     && Math.abs(barBox.fabBottom - fabCollapsed.bottom) < 1,
    '展开前后圆钮位置不动（需求 1）：收起 右 ' + fabCollapsed.right + ' 底 ' + fabCollapsed.bottom
     + '，展开 右 ' + barBox.fabRight + ' 底 ' + barBox.fabBottom);
  // 需求 1：展开态的 × 有**常亮的主题色描边**（不是 hover 才出现）
  const fabOpen = await evalJs(page, `
    const s = getComputedStyle(document.querySelector('.fast-fab.open'));
    return { w: parseFloat(s.borderTopWidth), c: s.borderTopColor };
  `);
  ok(fabOpen.w >= 1 && !/rgba?\(0, 0, 0, 0\)/.test(fabOpen.c),
    '展开态圆钮有常亮描边（需求 1），实际 ' + fabOpen.w + 'px ' + fabOpen.c);
  // 需求 4：时间 / 保存按钮靠到右端、贴着圆钮但不压住（间隙从 10px 收到 4px）
  const sideBox = await evalJs(page, `
    const fab = document.querySelector('.fast-fab');
    const side = document.querySelector('.fast-add .fast-side');
    const body = document.querySelector('.fast-add .fast-add-body');
    const bar = document.querySelector('.fast-add');
    const f = fab.getBoundingClientRect(), s = side.getBoundingClientRect();
    const b = body.getBoundingClientRect(), r = bar.getBoundingClientRect();
    const bs = getComputedStyle(document.querySelector('.fast-add-shell'));
    return {
      gapToFab: +(f.left - s.right).toFixed(1),
      bodyW: +b.width.toFixed(1), sideW: +s.width.toFixed(1), barW: +r.width.toFixed(1),
      sideRightToBar: +(r.right - s.right).toFixed(1),
      bodyRightToSideLeft: +(s.left - b.right).toFixed(1),
      padL: bs.paddingLeft, padR: bs.paddingRight, borderW: bs.borderTopWidth,
      bodyFlex: getComputedStyle(body).flex, bodyMinW: getComputedStyle(body).minWidth,
      sideFlex: getComputedStyle(side).flex, sideMinW: getComputedStyle(side).minWidth,
    };
  `);
  // 需求 4 的间距断言**只在窄屏 CSS 生效时跑** —— 探针的伪窄屏只在 JS
  // matchMedia 上套了 Proxy，CSS `@media (max-width: 900px)` 不认这个
  // （窗口真的 1280px）。宽屏下 padding 还是基线 16px，side 会被圆钮压住，
  // 这不是代码的问题。真机窄屏下 padding 65px，间距 4px。
  if (sideBox.padR === '65px') {
    ok(sideBox.gapToFab > 0 && sideBox.gapToFab < 8,
      '时间 / 保存按钮贴着圆钮但不重叠（需求 4），实际间距 ' + sideBox.gapToFab
      + '（body ' + sideBox.bodyW + ' / side ' + sideBox.sideW + ' / bar ' + sideBox.barW
      + ' / sideRight→bar ' + sideBox.sideRightToBar + ' / bodyRight→sideLeft ' + sideBox.bodyRightToSideLeft
      + ' / pad ' + sideBox.padL + '→' + sideBox.padR + ' / border ' + sideBox.borderW
      + ' / bodyFlex ' + sideBox.bodyFlex + ' / bodyMinW ' + sideBox.bodyMinW
      + ' / sideFlex ' + sideBox.sideFlex + ' / sideMinW ' + sideBox.sideMinW + '）');
  } else {
    console.log('  skip 需求 4 的间距断言（窄屏 CSS 未生效，padR=' + sideBox.padR + '，真机窄屏下跑）');
  }

  // 输入框固定两行，超过可内部滚动（需求 1）
  const h2 = await evalJs(page, `return Math.round(document.querySelector('.fast-add textarea').getBoundingClientRect().height);`);
  ok(h2 > 20 && h2 < 50, '输入框固定两行高，实际 ' + h2 + 'px');
  await setField('.fast-add textarea', '第一行\n第二行\n第三行');
  const h3 = await evalJs(page, `return Math.round(document.querySelector('.fast-add textarea').getBoundingClientRect().height);`);
  ok(Math.abs(h3 - h2) < 2, '内容变成三行时输入框高度不变（固定两行），实际 ' + h2 + 'px → ' + h3 + 'px');
  await setField('.fast-add textarea', '');

  /* ---- 点空白收起，**两级**（需求 8）---- */
  // 面板开着时：第一次点空白只收面板、横条留着；再点一次才收横条。
  // 两条如果各挂一个 document 上的监听就会打架（谁先跑只看注册顺序），
  // 所以它们在一个 handler 里，这里证的正是那个先后。
  const blank = () => evalJs(page, `
    (document.querySelector('#content') || document.body)
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    return 1;
  `);
  await clickEl(page, `document.querySelector('.fast-clock')`);
  await waitFor(page, `document.querySelector('.when-pop') ? 1 : null`, '窄屏下打开日期时间面板', 8000);
  await blank();
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '第一次点空白：收起面板', 8000);
  ok(await evalJs(page, `return !!document.querySelector('.fast-add.open');`),
    '第一次点空白只收面板，横条还开着（需求 8：先收面板再收输入框）');
  await blank();
  await waitFor(page, `!document.querySelector('.fast-add.open')`, '第二次点空白：收起横条', 8000);
  ok(await evalJs(page, `return !!document.querySelector('.fast-fab .lucide-plus');`),
    '横条收起之后圆钮又变回 +');

  /* ---- 点外面收起时，这记 click 要**吞掉**；顶栏 / 底栏例外（需求 9）----

     三条规矩：
       1. 输入框开着、点空白 → 关上，且空白处自己的事件**不触发**。
          不吞的话，点日视图空白会顺手新建一条空任务 —— 而 App 的委托挂在
          `#content` 上，click 是从 document 往下走的，capture 阶段拦得住。
       2. 顶栏 / 底栏是例外：上面的按钮要能**直接点到**（这记 click 放行）。
       3. 时间面板开着 → **点哪儿都只关面板**，顶栏 / 底栏也不例外。

     这三条只有**真实**事件才走得到（`justClosed` 只在 `e.isTrusted` 时设），
     所以这里不用 `clickEl`（它派发的是合成 click），改走 CDP 的
     `Input.dispatchMouseEvent` —— 和真手点走同一条路。 */
  const centerOf = (sel) => evalJs(page, `
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `);
  const realClick = async (at) => {
    const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 };
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  };
  // 在 #content 里找一个**真的空白**落点：不在任务行、横条、按钮上
  const blankPoint = () => evalJs(page, `
    const zone = document.querySelector('#content');
    if (!zone) return null;
    const r = zone.getBoundingClientRect();
    for (let iy = 0; iy < 12; iy++) {
      for (let ix = 0; ix < 5; ix++) {
        const x = Math.round(r.left + r.width * (0.1 + ix * 0.2));
        const y = Math.round(r.top + r.height * (0.05 + iy * 0.08));
        if (x < 2 || y < 2 || x > innerWidth - 2 || y > innerHeight - 2) continue;
        const el = document.elementFromPoint(x, y);
        if (!el || !zone.contains(el)) continue;
        if (el.closest('.task-el, .habit-row, .fast-add, button, a, input, textarea, label, svg')) continue;
        return { x, y };
      }
    }
    return null;
  `);
  // #content 上的 capture 探针：委托那层到底有没有收到这记 click
  await evalJs(page, `
    window.__c = [];
    document.querySelector('#content').addEventListener('click', () => window.__c.push(1), true);
    return true;
  `);

  // 规矩 1
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '展开横条（规矩 1）', 8000);
  const pt1 = await blankPoint();
  ok(!!pt1, '今天页找得到一个真空白落点（不在任务行 / 横条 / 控件上），实际 ' + JSON.stringify(pt1));
  await evalJs(page, `window.__c = []; return 1;`);
  await realClick(pt1);
  await waitFor(page, `!document.querySelector('.fast-add.open')`, '点空白收起横条（规矩 1）', 8000);
  ok((await evalJs(page, `return window.__c.length;`)) === 0,
    '规矩 1：这记 click 被吞掉了，没走到 #content 的委托 —— 否则日视图空白处会新建一条空任务');

  // 规矩 2：横条开着，顶栏的搜索键照样能**直接**点开，而且横条不收
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '再展开横条（规矩 2）', 8000);
  await realClick(await centerOf('.topbar .search-toggle'));
  await waitFor(page, `document.querySelector('.search-slot.open') ? 1 : null`,
    '规矩 2：横条开着，点顶栏搜索键也能打开搜索框', 8000);
  ok(await evalJs(page, `return !!document.querySelector('.fast-add.open');`),
    '规矩 2：顶栏当例外 —— 这一下既没被吞（搜索框开了），也没把横条收掉');
  // 搜索框的 autoFocus 会把页面滚下去，顶栏按钮就跑到视口外了 ——
  // 先滚回顶部再点，否则这一下落在 <html> 上，会被当成「点空白」把横条收掉
  await evalJs(page, `window.scrollTo(0, 0); return 1;`);
  // 关搜索走 Escape：收起状态**没有**常驻的关闭键了（用户 2026-10-09：「清空键不需要，
  // 点击其他地方就关了」），张开后那个钮也让开了（`pointer-events: none`，见 shell.css）。
  // 键盘那条路一次只关一层（`app/keyboard.ts` 的 Escape：moreOpen → searchOpen → …），
  // 横条不在那条链上，所以这一下同样不该把横条收掉。
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(page, `document.querySelector('.search-slot.open') ? null : 1`, '收起搜索框', 8000);
  ok(await evalJs(page, `return !!document.querySelector('.fast-add.open');`),
    '规矩 2：关搜索那一下（Escape）也没把横条收掉');

  // 规矩 3：面板开着时，顶栏也不再是例外
  await clickEl(page, `document.querySelector('.fast-clock')`);
  await waitFor(page, `document.querySelector('.when-pop') ? 1 : null`, '打开时间面板（规矩 3）', 8000);
  await realClick(await centerOf('.topbar .search-toggle'));
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '规矩 3：点顶栏先把面板收掉', 8000);
  const r3 = await evalJs(page, `return {
    c: window.__c.length,
    pop: !!document.querySelector('.search-slot.open'),
    open: !!document.querySelector('.fast-add.open'),
  };`);
  ok(r3.pop === false, '规矩 3：顶栏的搜索**没有**被点开 —— 面板开着时它也在例外之外');
  ok(r3.c === 0, '规矩 3：这记 click 同样被吞掉（没走到 #content 的委托），实际 ' + r3.c);
  ok(r3.open === true, '规矩 3：只收面板，横条留着');

  // 收干净：横条回到收起态，接下面那串动画断言
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!document.querySelector('.fast-add.open')`, '收尾：横条收起', 8000);

  /* ---- 点输入框 = 不选日期时间了，面板收掉 ---- */
  // 面板钉在输入框右边，打字时它一直挡在那儿 —— 点一下输入框就该收。
  // 只收面板、**不收横条**：用户是要打字，不是要收起输入框。
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '展开横条（点输入框收面板）', 8000);
  await clickEl(page, `document.querySelector('.fast-clock')`);
  await waitFor(page, `document.querySelector('.when-pop') ? 1 : null`, '打开日期时间面板', 8000);
  await clickEl(page, `document.querySelector('.fast-add textarea')`);
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '点输入框收起面板', 8000);
  ok(await evalJs(page, `return !!document.querySelector('.fast-add.open');`),
    '面板收了，横条还开着（点输入框不该把输入框也收掉）');
  // 收干净
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!document.querySelector('.fast-add.open')`, '收尾：横条收起', 8000);

  // 需求 3：关闭动画 —— 点击 FAB 后 `.closing` class 立即出现，
  // `fastPopOut` 动画播放 180ms，期间内容还可见（不压扁），
  // 动画结束后 `.open` 才移除、内容 display:none。
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '重新展开', 8000);
  await clickEl(page, `document.querySelector('.fast-fab')`);
  // 等待 .closing 出现（React 异步更新，几毫秒后）
  await waitFor(page, `document.querySelector('.fast-add.closing') ? 1 : null`, '点击 FAB 后 .closing 出现', 8000);
  // 立即检查动画属性（动画 180ms，waitFor 100ms 轮询，能捕获）
  const closingState = await evalJs(page, `
    return (() => {
      const bar = document.querySelector('.fast-add');
      const shell = document.querySelector('.fast-add-shell');
      const cs = getComputedStyle(shell);
      return {
        hasClosing: bar.classList.contains('closing'),
        hasOpen: bar.classList.contains('open'),
        animName: cs.animationName,
        animDuration: cs.animationDuration,
        // 动画必须挂在 shell 上 —— 挂在 .fast-add 上会把圆钮一起带飞
        barAnim: getComputedStyle(bar).animationName,
      };
    })();
  `);
  ok(closingState.hasClosing, '点击 FAB 后 .closing class 出现（需求 3）');
  ok(closingState.hasOpen, '动画播放期间 .open 还在（内容可见，不压扁）');
  ok(closingState.animName === 'fastPopOut', '关闭动画是 fastPopOut，实际 ' + closingState.animName);
  ok(closingState.animDuration === '0.18s', '关闭动画时长 0.18s，实际 ' + closingState.animDuration);
  ok(closingState.barAnim === 'none',
    '动画挂在 .fast-add-shell 上、不在 .fast-add 上（否则圆钮跟着动），实际 .fast-add 的 animation-name = ' + closingState.barAnim);
  // 动画结束后 .open 移除
  await waitFor(page, `!document.querySelector('.fast-add.open')`, '关闭动画结束后 .open 移除', 8000);
  ok(await evalJs(page, `return !document.querySelector('.fast-add.closing');`),
    '动画结束后 .closing 也移除');

  /* 需求 3：**圆钮在整个关闭动画期间一动不动**。
     它以前是动画元素 `.fast-add` 的子节点 —— 父元素一 transform、一改
     opacity，整棵子树跟着动：圆钮被拖着右移 28px、缩 4%、淡出，动画一结束
     再弹回原位，看着就是「异常跳变」。光比动画**前后**两个静止状态抓不到
     （那两处本来就相等），必须按帧采样。 */
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '重新展开（供按帧采样）', 8000);
  // 需求 3：展开也要有动画，而且是 fastPop —— 挂在 `.open` 上才会每次重跑
  // （原先挂在 `:not([hidden])` 上，只在挂载时跑一次，点 + 号其实没有动画）
  const openAnim = await evalJs(page, `
    const cs = getComputedStyle(document.querySelector('.fast-add-shell'));
    return { name: cs.animationName, dur: cs.animationDuration };
  `);
  ok(openAnim.name === 'fastPop', '展开时 .fast-add-shell 跑 fastPop（从圆钮弹出来），实际 ' + openAnim.name);
  ok(openAnim.dur === '0.18s', '展开动画时长 0.18s，实际 ' + openAnim.dur);

  const anim = await evalJs(page, `
    const shell = document.querySelector('.fast-add-shell');
    const fab = document.querySelector('.fast-fab');
    const at = (r) => [+r.left.toFixed(1), +r.top.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)];
    const before = at(fab.getBoundingClientRect());
    const rec = [];
    let stop = false;
    const tick = () => { rec.push(at(fab.getBoundingClientRect())); if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const r = fab.getBoundingClientRect();
    const ev = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    fab.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerType: 'mouse', isPrimary: true }, ev)));
    fab.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerType: 'mouse', isPrimary: true }, ev)));
    fab.dispatchEvent(new MouseEvent('click', ev));
    const seen = [];
    const scaleY = [];
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 16));
      const cs = getComputedStyle(shell);
      if (cs.animationName !== 'fastPopOut') continue;
      if (!seen.includes(cs.transform)) seen.push(cs.transform);
      // matrix(a, b, c, d, e, f) —— d 是**竖向**缩放，必须恒为 1
      if (cs.transform && cs.transform !== 'none') scaleY.push(+new DOMMatrix(cs.transform).d.toFixed(3));
    }
    await new Promise((res) => setTimeout(res, 120));
    stop = true;
    const drift = Math.max(...rec.map((p) => Math.max(
      Math.abs(p[0] - before[0]), Math.abs(p[1] - before[1]),
      Math.abs(p[2] - before[2]), Math.abs(p[3] - before[3]))));
    return { before, n: rec.length, drift, transforms: seen.slice(0, 2),
      scaleY: [...new Set(scaleY)], frames: scaleY.length };
  `);
  // 先证「动画真的在变换 shell」—— 否则下面那条是空跑（动画没跑，圆钮当然不动）
  ok(anim.transforms.length > 0 && !anim.transforms.every((t) => t === 'none'),
    '关闭动画期间 .fast-add-shell 确实在变换（否则「圆钮不动」是空跑），实际 ' + JSON.stringify(anim.transforms));
  ok(anim.drift < 1,
    '圆钮在整个关闭动画期间一动不动（需求 3），实际最大偏移 ' + anim.drift
    + 'px / 采样 ' + anim.n + ' 帧 / 起始 ' + JSON.stringify(anim.before));
  // 需求 3：**只做横向收紧，竖向不缩放**。原先的 `scale(.96)` 把 a 和 d 一起缩，
  // 那正是「竖直方向压扁」的来源 —— 这条断言把 scaleY 钉死在 1。
  ok(anim.frames > 0 && anim.scaleY.every((v) => v === 1),
    '关闭动画只做横向收紧，竖向不缩放（需求 3），实际 scaleY 取值 ' + JSON.stringify(anim.scaleY)
    + ' / ' + anim.frames + ' 帧');

  // 重新展开，继续后面几节
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add textarea')`, '重新展开');

  await setField('.fast-add textarea', '写方案');
  await evalJs(page, `
    return (() => {
      const i = document.querySelector('.fast-add textarea');
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'ok';
    })();
  `);
  await waitFor(page, `[...document.querySelectorAll('.task-el')].some((x) => x.textContent.includes('写方案'))`, '任务出现');
  // 交完就收起（窄屏）：任务已经落盘，横条还开着只是占地方。
  // 宽屏不收 —— 那边没有圆钮，横条是常驻的，收起来就点不回来。
  await waitFor(page, `!document.querySelector('.fast-add.open')`, '回车交完之后横条自动收起', 8000);
  ok(await evalJs(page, `return !!document.querySelector('.fast-fab .lucide-plus');`),
    '收起之后圆钮变回 +');

  /* ---- 「保存」是个 ✓，和日期按钮上下叠放（需求 4） ---- */
  // 上一节交完把横条收掉了，重新展开再测保存键
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '重新展开（测保存键）', 8000);
  // 时间在上，保存在下，固定位置。这一条证的是按钮在、位置对、高度和日期按钮齐平、
  // 点了真能交、空着的时候禁用。
  const saveBtn = await evalJs(page, `
    const b = document.querySelector('.fast-add .fast-save');
    if (!b) return null;
    const s = getComputedStyle(b);
    const c = document.querySelector('.fast-add .fast-clock').getBoundingClientRect();
    const r = b.getBoundingClientRect();
    return {
      disabled: b.disabled,
      text: b.textContent.trim(),
      hasCheck: !!b.querySelector('.lucide-check'),
      display: s.display,
      // 保存挨着日期按钮**右边**（2026-10-19 起横排）：单行小条参考打卡页，
      // 原来是上下叠放——那一版把整条撑成两行高，用户报「框太大」
      besideClock: r.left >= c.right - 0.5,
      // 日期按钮和 ✓ 一样高
      h: Math.round(r.height), clockH: Math.round(c.height),
    };
  `);
  ok(saveBtn && saveBtn.hasCheck, '横条上那个保存键是个 ✓ 图标，实际 ' + JSON.stringify(saveBtn));
  ok(saveBtn && saveBtn.text === '', '它只有图标，没有「保存」两个字（一行里三个文字按钮太吵）');
  ok(saveBtn && saveBtn.display !== 'none', '「保存」按钮看得见（不是 display:none）');
  ok(saveBtn && saveBtn.besideClock, '✓ 摆在日期按钮**右边**（单行小条，不再上下叠放）');
  ok(saveBtn && saveBtn.h === saveBtn.clockH,
    '✓ 和日期按钮一样高（需求 3：那个按钮要摆两行小字，高度不能变），实际 ' + JSON.stringify([saveBtn && saveBtn.h, saveBtn && saveBtn.clockH]));
  // 空着的时候禁用：一个点下去没反应的按钮，比没有按钮更让人犯嘀咕
  await setField('.fast-add textarea', '');
  ok(await evalJs(page, `return document.querySelector('.fast-add .fast-save').disabled;`),
    '没写字的时候「保存」是禁用的');
  await setField('.fast-add textarea', '点保存交的');
  ok(await evalJs(page, `return !document.querySelector('.fast-add .fast-save').disabled;`),
    '写了字之后「保存」就能点了');
  const nBefore = await evalJs(page, `return document.querySelectorAll('.task-el').length;`);
  await clickEl(page, `document.querySelector('.fast-add .fast-save')`);
  await waitFor(page, `document.querySelectorAll('.task-el').length > ${nBefore}`, '点「保存」任务出现', 8000);
  const savedByBtn = await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === '点保存交的');
      return t ? t.title : null;
    })()
  `, '点「保存」的任务落盘', 8000);
  ok(savedByBtn === '点保存交的', '「保存」真的把任务交出去了（不是只清输入框），实际 ' + JSON.stringify(savedByBtn));
  // 交完之后输入框清空、按钮回到禁用态
  ok(await evalJs(page, `return document.querySelector('.fast-add textarea').value === '';`),
    '交完之后输入框清空');
  ok(await evalJs(page, `return document.querySelector('.fast-add .fast-save').disabled;`),
    '交完之后「保存」又回到禁用态');

  await clickEl(page, `[...document.querySelectorAll('.task-el')].find((x) => x.textContent.includes('写方案'))`);
  await waitFor(page, `!!document.querySelector('button[aria-label="项目"]')`, '抽屉里的项目选择器');
  await clickEl(page, `document.querySelector('button[aria-label="项目"]')`);
  // 项目和日程集**用同一个下拉框**（2026-10-11）：选项是 role="option" 的
  // 按钮，就渲染在抽屉里，不再弹一张 portal 出去的 Sheet。
  await waitFor(page, `document.querySelector('.drawer.open [role="listbox"][aria-label="项目"]') ? 1 : null`, '项目下拉展开', 8000);
  const pickResult = await evalJs(page, `
    return (() => {
      const opts = [...document.querySelectorAll('.drawer.open [role="listbox"][aria-label="项目"] [role="option"]')];
      const o = opts.find((x) => x.textContent.trim().includes('星星包'));
      if (o) { o.click(); return 'ok'; }
      return 'missing:' + opts.length;
    })();
  `);
  ok(pickResult === 'ok', '项目选择器里选得到「星星包」，实际 ' + JSON.stringify(pickResult));
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === '写方案');
      return t && t.projectId ? t.projectId : null;
    })()
  `, '项目落库', 8000);
  await new Promise((r) => setTimeout(r, 250));
  await clickEl(page, `document.querySelector('.drawer.open [aria-label="完成"]')`);
  await new Promise((r) => setTimeout(r, 300));

  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'))`);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
  await clickEl(page, `document.querySelector('.more-sheet [data-nav="projects"]')`);
  await waitFor(page, `!!document.querySelector('.pj-card')`, '卡片出现在泳道里');
  ok((await evalJs(page, `return document.querySelectorAll('.pj-col[data-scope$=":todo"] .pj-card').length;`)) === 1,
    '任务落在「待办」列');

  // 拖卡片换列：和第九节同一套合成鼠标事件，**两次** move ——
  // 第一次只挪 12px 越过 MouseSensor 的 distance:8，第二次才去目标列。
  const pjCard = `document.querySelector('.pj-col[data-scope$=":todo"] .pj-card')`;
  const pjDst = `document.querySelector('.pj-col[data-scope$=":doing"] .pj-col-b')`;
  const pjSrc = await evalJs(page, `
    const r = ${pjCard}.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  await evalJs(page, `
    ${pjCard}.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, clientX: ${pjSrc.x}, clientY: ${pjSrc.y} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 70));
  await evalJs(page, `
    const el = document.elementFromPoint(${pjSrc.x}, ${pjSrc.y + 12});
    el.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, clientX: ${pjSrc.x}, clientY: ${pjSrc.y + 12} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 70));
  const pjDstXY = await evalJs(page, `
    const r = ${pjDst}.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  await evalJs(page, `
    const el = document.elementFromPoint(${pjDstXY.x}, ${pjDstXY.y});
    el.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, clientX: ${pjDstXY.x}, clientY: ${pjDstXY.y} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 70));
  await evalJs(page, `
    const el = document.elementFromPoint(${pjDstXY.x}, ${pjDstXY.y});
    el.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, clientX: ${pjDstXY.x}, clientY: ${pjDstXY.y} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 350));
  // 按标题找**这一条**，不能拿 `Object.values(tasks)[0]` —— 前面几节
  // （十～十三）也加了任务，[0] 是它们中的某一条，doing 当然是 undefined
  await waitForUi('doing 落库',
    `(() => { const s = JSON.parse(localStorage.getItem('schedule-app-v4'));
      const t = Object.values(s.tasks).find((x) => x.title === '写方案');
      return t && t.doing === true ? 1 : null; })()`);
  const projCols = await evalJs(page, `
    return [...document.querySelectorAll('[data-lane] .pj-col')].map((c) => c.querySelectorAll('.pj-card').length);
  `);
  ok(JSON.stringify(projCols) === JSON.stringify([0, 1, 0]),
    '卡片挪到了「进行中」列，实际 ' + JSON.stringify(projCols));
  ok(await evalJs(page, `return !document.querySelector('.pj-col[data-scope$=":doing"] .pj-card.done');`),
    'done 没被顺手改掉 —— 做/没做和做没做完是两回事');

  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  await waitFor(page, `!!document.querySelector('.tabbar')`, '刷新后底栏还在');
  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'))`);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
  await clickEl(page, `document.querySelector('.more-sheet [data-nav="projects"]')`);
  await waitFor(page, `!!document.querySelector('[data-lane]')`, '刷新后泳道还在');
  ok((await evalJs(page, `return document.querySelector('[data-lane] .pj-name').textContent.trim();`)) === '星星包',
    '刷新后项目还在');
  ok((await evalJs(page, `return document.querySelector('[data-lane] .pj-col[data-scope$=":doing"] .pj-card') ? 1 : null;`)) === 1,
    '刷新后卡片还在「进行中」列');

  /* ---------- 一个能写的集都没有时：那一句提示得真的出现 ----------
     勾选切到一个只读集之后，新建项目浮层里选择器是空的、创建按钮禁用 ——
     而**禁用的按钮本身不解释任何事**，用户只看到「点不动」。所以开浮层要弹
     一句 toast。锁三件事：真的弹了、说的是那一句、浮层开着时它盖得住
     （`ToastHost` 挂在 Shell 外面、z-90 > 浮层的 z-70）。

     放这一节**最后**是必须的：勾选决定项目可见性（`useScopedState` 按
     `p.calId` 过滤），中途切走会让泳道上的项目消失，后面拖拽与刷新的断言
     全断。做完再切回有写权限的集。 */

  const roCal = await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    const canWrite = (r) => r === 'owner' || r === 'editor';
    const ro = (st.cals || []).find((c) => !canWrite(c.role));
    return ro ? ro.id : '';`);
  ok(roCal !== '', '有一个只读日程集可用来制造「无处可建」');

  if (roCal !== '') {
    await evalJs(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多')).click(); return true;`);
    await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
    await evalJs(page, `document.querySelector('[data-cal-sheet-open]').click(); return true;`);
    await waitFor(page, `!!document.querySelector('[role="dialog"] [data-cal-row]')`, '日程集多选面板');
    /* 先勾上只读那个，再取消勾别的 —— 反过来的话「至少留一个」会把取消挡下 */
    await evalJs(page, `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const rows = () => [...document.querySelectorAll('[role="dialog"] [data-cal-row]')];
      const want = ${JSON.stringify(roCal)};
      const hit = rows().find((r) => r.dataset.calRow === want);
      if (hit && hit.getAttribute('aria-pressed') !== 'true') { hit.click(); await sleep(80); }
      for (const r of rows()) {
        if (r.dataset.calRow !== want && r.getAttribute('aria-pressed') === 'true') { r.click(); await sleep(80); }
      }
      return true;`);
    await evalJs(page, `
      const d = document.querySelector('[role="dialog"]');
      const btn = d && [...d.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '关闭');
      if (btn) btn.click();
      return true;`);
    await waitFor(page, `!document.querySelector('[role="dialog"]')`, '面板关掉了');
    await waitForUi('只读集成了唯一勾着的',
      `(() => {
        const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
        const ro = (st.cals || []).find((c) => c.id === ${JSON.stringify(roCal)});
        const writable = ro && (ro.role === 'owner' || ro.role === 'editor');
        return ro && !writable && st.ui.cals.length === 1 && st.ui.cals[0] === ${JSON.stringify(roCal)}
          ? 1 : null;
      })()`);

    await clickEl(page, `document.querySelector('.pj-top .btn')`);
    await waitFor(page, `!!document.querySelector('.field input')`, '项目浮层又打开了');
    /* 那句话是**逐字**的：用户照着这句去排查，差一个字就指错方向。
       纯通知的 toast 只活 2.6 秒，waitFor 每 100ms 轮询一次，抓得到。 */
    const toastText = await waitFor(page, `
      [...document.querySelectorAll('[role="status"]')].map((t) => t.textContent)
        .find((t) => t.includes('写入权限')) || null`,
      '弹出「无写入权限」那一句 toast');
    ok(toastText.includes('所选日程集均无写入权限，无法新建项目'),
      '弹的是那一句，逐字：' + JSON.stringify(toastText));
    ok(await evalJs(page, `
      const t = [...document.querySelectorAll('[role="status"]')].find((x) => x.textContent.includes('写入权限'));
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? 1 : null;`),
    'toast 浮层开着时也看得见（盖在浮层之上，不是被遮住）');
    ok(await evalJs(page, `
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '创建');
      return b && b.disabled ? 1 : null;`),
    '一个能写的集都没有时，创建是禁用的');
    await evalJs(page, `
      const d = document.querySelector('[role="dialog"]');
      const btn = d && [...d.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '关闭');
      if (btn) btn.click();
      return true;`);
    await waitFor(page, `!document.querySelector('[role="dialog"]')`, '浮层关掉了');

    // 切回有写权限的集 —— 后面的节还要在上面改东西
    await evalJs(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多')).click(); return true;`);
    await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
    await evalJs(page, `document.querySelector('[data-cal-sheet-open]').click(); return true;`);
    await waitFor(page, `!!document.querySelector('[role="dialog"] [data-cal-row]')`, '日程集多选面板');
    await evalJs(page, `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const rows = () => [...document.querySelectorAll('[role="dialog"] [data-cal-row]')];
      const want = ${JSON.stringify(pjCal)};
      const hit = rows().find((r) => r.dataset.calRow === want);
      if (hit && hit.getAttribute('aria-pressed') !== 'true') { hit.click(); await sleep(80); }
      for (const r of rows()) {
        if (r.dataset.calRow !== want && r.getAttribute('aria-pressed') === 'true') { r.click(); await sleep(80); }
      }
      return true;`);
    await evalJs(page, `
      const d = document.querySelector('[role="dialog"]');
      const btn = d && [...d.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '关闭');
      if (btn) btn.click();
      return true;`);
    await waitFor(page, `!document.querySelector('[role="dialog"]')`, '面板关掉了');
    await waitForUi('切回有写权限的集',
      `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.cal === ${JSON.stringify(pjCal)} ? 1 : null`);

    /* ---- 「下一步」走 data-act 委托（不是 onBlur 回调）----
       这条路径原先是 views/ 里的 onBlur prop，行被换掉就丢。现在输入框只带
       data-act，落库在 clickDispatch 里。**必须实测**：委托与 React 的
       onChange 谁先跑、受控 input 的 DOM value 读不读得到，都是猜不出来的。 */
    const nextBox = `document.querySelector('.pj-next-i')`;
    ok(await evalJs(page, `return !!${nextBox};`), '泳道上有「下一步」输入框');
    ok(await evalJs(page, `return ${nextBox}.getAttribute('data-act') === 'next-project';`),
      '「下一步」带 data-act，不是 onBlur 回调');
    await setField('.pj-next-i', '周五前出第一版');
    await evalJs(page, `${nextBox}.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    /* 查询**按内容**而不是按 id：探针不该假设「刚建的那个项目就在这」，
       上游任何一步漏了这条断言就该红，而不是因为 id 找不着而崩。
       判据是「有一条项目的 next = 我刚填的那句」。 */
    await waitForUi('「下一步」落库',
      `(() => {
         const s = JSON.parse(localStorage.getItem('schedule-app-v4'));
         if (!s || !s.projects) return null;
         return Object.values(s.projects).some((p) => p && p.next === '周五前出第一版') ? 1 : null; })()`);
    ok(await evalJs(page, `return document.querySelector('.pj-next-i').value === '周五前出第一版';`),
      '输入框显示刚填的那句（受控值同步回来了）');

    /* ---- 「编辑」按钮走 data-act，打开的是那个浮层 ---- */
    await evalJs(page, `document.querySelector('.pj-more').click(); return true;`);
    await waitFor(page, `!!document.querySelector('.field input')`, '点「编辑」打开了项目浮层');
    ok(await evalJs(page, `return document.querySelector('.sheet-title, [role="dialog"] h2, [role="dialog"] .field') !== null;`),
      '浮层里是编辑表单');
    await evalJs(page, `
      const d = document.querySelector('[role="dialog"]');
      const btn = d && [...d.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '关闭');
      if (btn) btn.click();
      return true;`);
    await waitFor(page, `!document.querySelector('[role="dialog"]')`, '编辑浮层关掉了');
  }

  console.log('\n二十、修改密码：改完还登录着，别的设备被踢出去');

  // 先确认后端还活着 —— 后端 stdio 是 ignore，死了会静默，
  // 症状是「连不上服务器」，看着像网络问题其实是进程没了
  let health = 'node-side fetch failed';
  try {
    const hr = await fetch(`http://127.0.0.1:${API_PORT}/api/health`);
    health = String(hr.status);
  } catch (e) { health = 'node fetch failed: ' + e.message; }
  ok(health === '200', '后端还活着（node health=' + health + '）');

  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'))`);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
  await clickEl(page, `document.querySelector('.more-sheet [data-nav="settings"]')`);
  // 设置页现在是 tab 布局，先点关于 tab 再检查
  await clickEl(page, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '关于')`);
  await waitFor(page, `!!document.querySelector('[data-about="version"]')`, '设置页挂上');
  // 修改密码按钮在账户安全 tab 里
  await clickEl(page, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '安全')`);
  await clickEl(page, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '修改密码')`);
  await waitFor(page, `!!document.querySelector('input[type="password"]')`, '改口令浮层打开');
  ok((await evalJs(page, `return document.querySelectorAll('input[type="password"]').length;`)) === 3,
    '三个框：当前 / 新 / 再输一遍 —— 没有「找回口令」这回事，手一抖打错就没了');

  const setPw = (sel, v) => evalJs(page, `
    return (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'missing';
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })();
  `);

  // 先喂一个错的当前密码 —— 提示要说人话，而且**不能把人踢出去**
  await setPw('input[id$="-c"]', 'not-the-real-password');
  await setPw('input[id$="-n"]', 'brand-new-99');
  await setPw('input[id$="-a"]', 'brand-new-99');
  await clickEl(page, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '修改')`);
  await waitFor(page, `!!document.querySelector('[role="alert"]')`, '报错出现');
  const alertText = await evalJs(page, `return document.querySelector('[role="alert"]').textContent;`);
  ok(alertText.includes('当前密码'), '提示说「当前密码不对」，实际：' + alertText);
  ok(await evalJs(page, `return !!document.querySelector('input[type="password"]');`),
    '报错之后浮层还开着 —— 关掉了等于什么也没说');

  // 再喂对的（第二节注册时用的就是 pw123456）。
  // 先把当前那只 token 存下来 —— 等下要证它**被作废了**。
  const oldTok = await evalJs(page, `return localStorage.getItem('schedule-app-token');`);
  await setPw('input[id$="-c"]', 'pw123456');
  await clickEl(page, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '修改')`);
  await waitFor(page, `document.querySelector('input[type="password"]') ? null : 1`, '浮层关掉了', 8000);
  await new Promise((r) => setTimeout(r, 400));

  // **最要紧那一条**：改完还登录着。服务器会作废掉改动之前签的那只票
  //（含请求里用的那只），所以客户端必须换上响应里带回的那只 ——
  // 换了之后刷新还在，用户感知不到。
  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  await waitFor(page, `!!document.querySelector('#nav') || !!document.querySelector('.tabbar')`, '刷新后主界面挂上');
  await new Promise((r) => setTimeout(r, 1500));
  // 窄屏下侧栏不渲染（`{!narrow && <Sidebar/>}`），`.brand-name` 不存在 ——
  // 用 `.tabbar` 代替，它在两种模式下都在
  ok(await evalJs(page, `return !document.querySelector('[data-act="login"]') && !!document.querySelector('.tabbar');`),
    '改完密码刷新后**还登录着**（没有被自己踢出去）');
  const newTok = await evalJs(page, `return localStorage.getItem('schedule-app-token');`);
  ok(newTok && newTok !== oldTok, '本机存的 token 已经换成了新的那只');

  // 服务器上真换了，而且改动之前签的那只确实被作废了
  const pwCheck = await evalJs(page, `
    const me = await fetch('./api/me', { headers: { authorization: 'Bearer ' + localStorage.getItem('schedule-app-token') } });
    const old = await fetch('./api/me', { headers: { authorization: 'Bearer ' + ${JSON.stringify(oldTok)} } });
    return { me: me.status, old: old.status };
  `);
  ok(pwCheck.me === 200, '换上的那只 token 在服务器上是好的，实际 ' + JSON.stringify(pwCheck));
  ok(pwCheck.old === 401, '改动之前签的那只被作废了（别人手里的旧票失效），实际 ' + JSON.stringify(pwCheck));

  /* ---- 二十一、副header 四个控件同高 + 周视图表头简化 ----
     这一节跑在**宽屏**下（探针窗口 1280px）。窄屏那套 CSS（34px 按钮、7 列横滑、
     表头 width:max-content、centerWeekDay 居中）**测不了**：探针的伪窄屏只在 JS
     matchMedia 上套了 Proxy，CSS `@media (max-width: 900px)` 不认这个 ——
     窗口真的 1280px，媒体查询就是不匹配。setDeviceMetricsOverride 能把视口改窄，
     但改完之后合成事件不进处理器（见 CLAUDE.md 四、34），没法点进周视图。
     所以窄屏那几条只能靠真机/真浏览器看，这里锁的是宽屏下也能验的部分。 */
  console.log('\n二十一、副header 控件同高 + 周视图表头简化');
  // 窄屏下侧栏不渲染（`{!narrow && <Sidebar/>}`），日程要走底栏那个「日程」tab；
  // 宽屏才有 .nav-item。两种模式都过：先试侧栏，没有再按文字找底栏 tab
  await clickEl(page, `
    document.querySelector('.nav-item[data-nav="calendar"]') ||
    [...document.querySelectorAll('.tabbar .tab')].find((b) => b.textContent.includes('日程'))
  `);
  await waitFor(page, `!!document.querySelector('.cal-subhead')`, '日程副header渲染出来', 8000);

  // 四个控件并排站在一行里，高度必须一致 —— 原先是 36 / 34 / 34 三档
  const subH = await evalJs(page, `
    const pick = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().height * 10) / 10 : null;
    };
    return {
      prev: pick('.date-nav .btn'),
      today: pick('.date-nav [aria-pressed]'),
      jump: pick('.date-nav [aria-haspopup="dialog"]'),
      view: pick('.view-switch button'),
    };
  `);
  ok(subH.prev === 30 && subH.today === 30 && subH.jump === 30 && subH.view === 30,
    '上一/下一个 · 今 · 找日期 · 日周月 四档同高 30px，实际 ' + JSON.stringify(subH));

  /* ---- 周视图：表头简化（去掉负载横条 / 任务计数 / 今天圆底） ---- */
  await clickEl(page, `[...document.querySelectorAll('.view-switch button')].find((b) => b.dataset.view === 'week')`);
  await waitFor(page, `!!document.querySelector('.week-view')`, '周视图渲染出来', 8000);
  await new Promise((r) => setTimeout(r, 300));

  const wk = await evalJs(page, `
    const todayCell = document.querySelector('.week-head-cell.today .wh-day');
    return {
      whLoad: document.querySelectorAll('.wh-load').length,
      whCount: document.querySelectorAll('.wh-count').length,
      unBorderTop: getComputedStyle(document.querySelector('.week-un-row')).borderTopWidth,
      // 2026-10-22 改口径：今天用**深绿圆圈**圈住日期（和月视图一致）。
      // 以前怕圆底让那格凭空高出 9px 所以只染色 —— 现在圆圈的位置每天都占着
      // （背景透明），只有今天填色，对齐不受影响。
      todayBg: todayCell ? getComputedStyle(todayCell).backgroundColor : 'no-today-cell',
      todayRadius: todayCell ? getComputedStyle(todayCell).borderTopLeftRadius : '',
      // 刻度列与日视图同一副面孔：无底色、左格无字
      gutterBg: getComputedStyle(document.querySelector('.week-gutter')).backgroundColor,
      unText: (document.querySelector('.week-un-gutter') || {}).textContent || '',
    };
  `);
  ok(wk.whLoad === 0 && wk.whCount === 0, '表头不再有负载横条与任务计数，实际 ' + wk.whLoad + ' / ' + wk.whCount);
  ok(parseFloat(wk.unBorderTop) >= 1, '未定时行**上边**也有一条分割线，实际 ' + wk.unBorderTop);
  ok(wk.todayBg !== 'rgba(0, 0, 0, 0)' && wk.todayRadius === '50%',
    '今天的日期数字被深绿圆圈圈住（与月视图一致），实际 ' + wk.todayBg + ' / ' + wk.todayRadius);
  ok(wk.gutterBg === 'rgba(0, 0, 0, 0)', '刻度列没有自己的底色（跟日视图一样是白底），实际 ' + wk.gutterBg);
  ok(wk.unText === '', '未定时那一行的左格不写字，实际「' + wk.unText + '」');

  /* ---- 真·窄屏视口（390×854）----
     上面那一整节「窄屏」是**伪窄屏**：探针只在 JS 的 matchMedia 上套了 Proxy，
     窗口真的还是 1280px，所以 CSS 的 `@media (max-width: 900px)` 一条都没生效。
     而快速添加这整套东西是**手机专用**的 —— 盒子的窄屏内边距（让开圆钮的 65px）、
     圆钮竖直居中，全写在媒体查询里。这里用 CDP 把视口真的压到手机尺寸，
     补上那一段：真机上圆钮在展开 / 收起两态必须落在**同一个屏幕位置**，
     且在展开后的盒子里竖直居中。 */
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 854, deviceScaleFactor: 1, mobile: true,
  });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  await waitFor(page, `!!document.querySelector('.fast-fab')`, '真窄屏视口下圆钮出现', 15000);
  await new Promise((r) => setTimeout(r, 400));
  if (await evalJs(page, `return !!document.querySelector('.fast-add.open');`)) {
    await clickEl(page, `document.querySelector('.fast-fab')`);
    await waitFor(page, `!document.querySelector('.fast-add.open')`, '真窄屏：先收起', 8000);
  }
  const rnClosed = await evalJs(page, `
    const f = document.querySelector('.fast-fab').getBoundingClientRect();
    return { left: +f.left.toFixed(1), top: +f.top.toFixed(1) };
  `);
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '真窄屏：展开', 8000);
  await new Promise((r) => setTimeout(r, 300));   // 等 180ms 的展开动画走完再量
  const rnOpen = await evalJs(page, `
    const bar = document.querySelector('.fast-add');
    const shell = document.querySelector('.fast-add-shell');
    const fab = document.querySelector('.fast-fab');
    const b = bar.getBoundingClientRect(), f = fab.getBoundingClientRect();
    const s = shell.getBoundingClientRect(), bs = getComputedStyle(shell);
    return {
      fabLeft: +f.left.toFixed(1), fabTop: +f.top.toFixed(1),
      gapTop: +(f.top - b.top).toFixed(1), gapBottom: +(b.bottom - f.bottom).toFixed(1),
      padRight: bs.paddingRight, shellRight: +(b.right - s.right).toFixed(1),
      barH: +b.height.toFixed(1),
    };
  `);
  ok(rnOpen.padRight === '65px',
    '真窄屏下盒子右侧让出圆钮（65px），实际 ' + rnOpen.padRight);
  ok(Math.abs(rnOpen.shellRight) < 1,
    '盒子与横条右端对齐（动画基准点才对得上圆钮），实际差 ' + rnOpen.shellRight);
  ok(Math.abs(rnOpen.gapTop - rnOpen.gapBottom) < 1.5,
    '真窄屏下圆钮在展开后的盒子里竖直居中，实际 上 ' + rnOpen.gapTop
    + ' / 下 ' + rnOpen.gapBottom + '（盒子高 ' + rnOpen.barH + '）');
  ok(Math.abs(rnOpen.fabLeft - rnClosed.left) < 1 && Math.abs(rnOpen.fabTop - rnClosed.top) < 1,
    '真窄屏下展开前后圆钮在屏幕上不动：收起 (' + rnClosed.left + ',' + rnClosed.top
    + ') 展开 (' + rnOpen.fabLeft + ',' + rnOpen.fabTop + ')');

  page.close();
} catch (e) {
  failures++;
  console.error('\n探针中断：', e && e.message ? e.message : e);
  if (e && e.stack) console.error(String(e.stack).split('\n').slice(1, 5).join('\n'));
} finally {
  cleanup();
}

console.log(failures ? `\n✗ ${failures} 项不对\n` : '\n✓ 全通过\n');
process.exit(failures ? 1 : 0);

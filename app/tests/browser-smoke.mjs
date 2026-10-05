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
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist');
const API_PORT = 25701;      // 临时后端
const WEB_PORT = 5198;       // 静态 + 代理
const CDP_PORT = 9223;
const CHROME = process.env.CHROME || '/opt/google/chrome/chrome';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
};

let failures = 0;
const ok = (cond, what) => {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what); }
};

/* ---------------------------------------------------- 静态服务 + 代理 */

function serveDist() {
  const srv = createServer((req, res) => {
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
    if (p.endsWith('/')) p += 'index.html';
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
  return new Promise((r) => srv.listen(WEB_PORT, '127.0.0.1', () => r(srv)));
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

/** 和 ui/hooks.ts 的 LONG_PRESS_MS 对齐。浏览器里是 480 */
const LONG_PRESS_MS = 480;

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

/** 用顶栏的快速输入框加一条任务（走真实 UI，不直接改 store） */
async function quickAdd(page, text) {
  const n = await evalJs(page, `return document.querySelectorAll('[data-scope="inbox"] .task-el').length;`);
  await evalJs(page, `
    const inp = document.querySelector('.fast-add input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, ${JSON.stringify(text)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  `);
  // 等它真出现 —— 不等的话下一条会插到上一条前面，顺序断言就成了空话
  return waitFor(page,
    `document.querySelectorAll('[data-scope="inbox"] .task-el').length > ${n}`, '任务出现');
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
    stdio: 'ignore',
  }));
  web = await serveDist();
  procs.push({ kill: () => { if (web && web.listening) web.close(); } });

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
  const cached = await evalJs(page, `
    const c = await caches.open('sched-shell-v1');
    return (await c.keys()).map((r) => new URL(r.url).pathname);
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

  console.log('\n三、进入主界面，侧栏有日程集');
  await waitFor(page, `!!document.querySelector('.sidebar')`, '侧栏渲染出来', 12000);
  ok(await evalJs(page, `return !!document.querySelector('[data-nav="today"]');`), '侧栏有导航项');
  const calName = await waitFor(page, `document.querySelector('[data-cal]')?.textContent.trim() || null`, '日程集出现');
  ok(calName === '我的日程', '默认日程集叫「我的日程」，实际是 ' + JSON.stringify(calName));
  ok(await evalJs(page, `return !!document.querySelector('[data-cal-manage]');`), '有「管理当前日程集」入口');
  ok(await evalJs(page, `return document.querySelectorAll('[data-cal-invites]').length === 0;`), '没有邀请时不显示邀请入口');

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

  console.log('\n五、管理浮层：改名能落库');
  await evalJs(page, `document.querySelector('[data-cal-manage]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[data-cal-name]')`, '管理浮层打开');
  // 成员是异步拉的，别在读之前就断言。
  // **不能等「创建者」**：那是 ROLE_LABEL，发邀请那个 <select> 的 <option>
  // 里就有一个，浮层一开就存在 —— 等它等于没等，成员还没到就开始读，
  // 断言会随机失败（而且失败信息看着像「自己的名字没显示」，指向完全错的地方）。
  // 等成员**条数**变成非零才是真的加载完了。
  await waitFor(page,
    `[...document.querySelectorAll('[role="dialog"]')].some((d) => /成员（[1-9]\\d*）/.test(d.innerText)) ? 1 : null`,
    '成员列表加载完');
  const sheetText = await evalJs(page, `
    return [...document.querySelectorAll('[role="dialog"]')].map((d) => d.innerText).join('\\n');
  `);
  ok(sheetText.includes('成员'), '浮层里有成员区');
  ok(sheetText.includes('爸爸'), '成员列表里有自己');
  ok(sheetText.includes('创建者'), '自己的角色显示为「创建者」');
  ok(sheetText.includes('邀请成员'), '创建者能看到发邀请的入口');

  await evalJs(page, `
    const inp = document.querySelector('[data-cal-name]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, '全家'); inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await evalJs(page, `document.querySelector('[data-cal-save]').click(); return true;`);
  const renamed = await waitFor(page,
    `document.querySelector('[data-cal]')?.textContent.trim() === '全家' ? '全家' : null`,
    '侧栏名字变成「全家」');
  ok(renamed === '全家', '改名同步到了侧栏');

  const reloaded = await evalJs(page, `
    const r = await fetch('./api/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('schedule-app-token') } });
    const j = await r.json();
    return j.cals[0].name;
  `);
  ok(reloaded === '全家', '服务器上也是「全家」（不是只改了界面）');

  console.log('\n六、刷新之后还在，且没有 console 报错');
  await evalJs(page, `document.querySelector('[role="dialog"] button[aria-label="关闭"]')?.click(); return true;`);
  await page.send('Page.reload');
  await waitFor(page, `!!document.querySelector('.sidebar')`, '刷新后回到主界面', 12000);
  ok(await evalJs(page, `return document.querySelector('[data-cal]')?.textContent.trim() === '全家';`),
    '刷新后仍是「全家」');
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
  await waitFor(page, `!!document.querySelector('[data-cal-invites]')`, '侧栏出现邀请入口', 12000);
  const badge = await evalJs(page, `return document.querySelector('[data-cal-invites]').innerText.trim();`);
  ok(badge.includes('1'), '邀请入口上写着 1 条，实际 ' + JSON.stringify(badge));

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
  await waitFor(page, `document.querySelectorAll('[data-cal]').length === 2`, '接受后侧栏有两个集', 12000);
  // 高亮项的判定不看名字：**只有不是自己创建的集才带角色小标**，
  // 所以「高亮项带可编辑」就等价于「自动切到了刚加入的那个」
  const nowActive = await evalJs(page, `
    const on = [...document.querySelectorAll('[data-cal]')].find((b) => b.className.includes('--primary'));
    return on ? on.textContent.trim() : null;
  `);
  ok(nowActive && nowActive.includes('可编辑'), '接受完自动切到刚加入的那个集，实际 ' + JSON.stringify(nowActive));
  ok(await evalJs(page, `return document.querySelector('[data-cal-invites]') === null;`),
    '处理完之后邀请入口消失');
  ok(await evalJs(page, `return !!document.querySelector('[data-cal-manage]');`), '仍然能管理日程集');
  ok(await evalJs(page, `return !!localStorage.getItem('schedule-app-v4');`), '本地状态有落盘');

  collect();
  ok(errors.length === 0, '邀请这一段也没有 console 报错'
    + (errors.length ? '：\n      ' + fmt(errors) : ''));

  console.log('\n八、触屏：长按提起 → 拖动排序 → 没动就弹操作层');
  // 桌面视口 + 触屏事件。**不需要窄屏**：长按 / 拖拽只认 pointerType，
  // 不认宽度（while 窄屏的标签栏那套是另一回事，那个本机测不了，见 CLAUDE.md 四、34）。
  // 用 CDP 合成触摸，Chrome 会照常派生出 pointerType:'touch' 的 pointer 事件。
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await evalJs(page, `document.querySelector('[data-nav="inbox"]').click(); return true;`);
  // 待办箱空的时候**没有** [data-drop] 那块（走 Empty 分支），所以这里只能等
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

  // —— 先验长按：不动手，松手应该弹操作层 ——
  // 先证「合成的触摸确实进得来」。这一步单独断言，是为了失败时能分清
  // 「触摸事件被 Chrome 吞了」和「拖拽逻辑本身不对」—— 后者会伪装成前者。
  await evalJs(page, `
    window.__pt = [];
    document.addEventListener('pointerdown', (e) => window.__pt.push(e.pointerType), true);
    return true;
  `);
  await evalJs(page, `
    window.__pt = [];
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave',
      'mousedown', 'mouseup', 'click', 'contextmenu']) {
      document.addEventListener(t, (e) => window.__pt.push(
        t + ':' + e.pointerType + ':'
        + (e.target?.closest?.('.task-el') ? '任务行' : String(e.target?.className || e.target?.tagName))), true);
    }
    return true;
  `);
  const p = await rectOf('甲');
  await touch(page, 'touchStart', p);
  await waitFor(page, `window.__pt.length ? window.__pt : null`, '合成触摸被派发');
  await new Promise((r) => setTimeout(r, LONG_PRESS_MS + 250));
  const pt = await evalJs(page, `return window.__pt;`);
  // 只断言「收到过 pointerdown」是不够的 —— 之前就吃过一次教训：
  // 事件是到了，但 target 是个盖住的浮层，落点根本不在那一行上，
  // 后面的断言全跟着假失败。所以这里连 target 一起查。
  ok(pt.some((x) => x.startsWith('pointerdown:touch:任务行')),
    '合成的触摸打在任务行上，事件序列 = ' + JSON.stringify(pt));
  const lifted = await evalJs(page,
    `return !!document.querySelector('[data-scope="inbox"] .task-el.touch-drag');`);
  ok(lifted, '长按 0.5 秒后那一行进入「提起」状态');
  await touch(page, 'touchEnd');
  await new Promise((r) => setTimeout(r, 200));
  const up = await evalJs(page, `return {
    seq: window.__pt,
    sheet: !!document.querySelector('.act-sheet.open'),
    lifted: !!document.querySelector('.task-el.touch-drag'),
    editing: document.body.dataset.dragging || null,
  };`);
  ok(up.sheet, '提起后原地松手 → 弹出操作层（原来的老路没丢）；'
    + '事件序列 ' + JSON.stringify(up.seq.slice(1)) + '，'
    + '还提着？' + up.lifted + '，拖动中？' + up.editing);
  ok(await evalJs(page, `return document.querySelectorAll('.act-sheet.open .as-btn').length > 0;`),
    '操作层里有按钮');
  await evalJs(page, `document.querySelector('.act-sheet .as-cancel').click(); return true;`);
  ok(await evalJs(page, `return !document.querySelector('.act-sheet.open');`), '操作层能关掉');

  // —— 再验拖动：提起后往下挪一条 ——
  const p2 = await rectOf('甲');
  const q = await rectOf('丙');
  await touch(page, 'touchStart', p2);
  await new Promise((r) => setTimeout(r, LONG_PRESS_MS + 250));
  await touch(page, 'touchMove', { x: p2.x, y: p2.y + 12 });
  await touch(page, 'touchMove', { x: q.x, y: q.y });
  await new Promise((r) => setTimeout(r, 250));
  ok(await evalJs(page, `return !!document.querySelector('.drop-hole');`),
    '拖到别处时出现了让位洞');
  await touch(page, 'touchEnd');
  await new Promise((r) => setTimeout(r, 250));
  const after = await inbox();
  ok(after.join('') !== '甲乙丙', '拖完顺序真的变了，实际 ' + JSON.stringify(after));
  ok(after[after.length - 1] === '甲', '被拖的「甲」到了最后一位，实际 ' + JSON.stringify(after));
  ok(await evalJs(page, `return !document.querySelector('.drop-hole') && !document.querySelector('.task-el.touch-drag');`),
    '松手后洞和「提起」状态都收干净了');
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

  console.log('\n九、鼠标拖拽：HTML5 那一路没被触屏改动带坏');
  /* 两条路（HTML5 / 触屏）共用 applyDropAt + finishDrag + commitDrop，
     所以这一节要证的**不是**排序逻辑本身（第八节已经证过了），
     而是鼠标这条**入口**还通着：dragstart 有没有记住拖的是谁、
     dragover 有没有靠 closest 找到落点容器、drop 有没有真的落库。
     重构共享代码时最先坏的通常就是这一段接线。

     合成 DragEvent 要显式给 dataTransfer —— Chrome 上不给是 null，
     onDragStart 里一句 e.dataTransfer.effectAllowed = 'move' 就抛异常，
     表现成「拖了半天没反应」。CLAUDE.md 四、33 还记着另一条：
     target 默认是派发元素，所以事件要派在**行**上、不要派在容器上。 */
  const dragFire = (type, text) => evalJs(page, `
    const el = [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
      .find((e) => e.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return 'missing:' + ${JSON.stringify(text)};
    const r = el.getBoundingClientRect();
    if (!window.__dt) window.__dt = new DataTransfer();   // 同一个 drag 要共用一份
    el.dispatchEvent(new DragEvent(${JSON.stringify(type)}, {
      bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      dataTransfer: window.__dt,
    }));
    return 'ok';
  `);

  ok((await inbox()).join('') === '乙丙甲', '接着第八节的状态，「甲」还在最后，实际 ' + JSON.stringify(await inbox()));
  ok(await dragFire('dragstart', '甲') === 'ok', '合成 dragstart 打在行上');
  ok(await evalJs(page, `return document.body.classList.contains('dragging-active');`),
    'dragstart 之后进入了拖动状态（说明事件真进了处理器，不是被丢了）');
  ok(await dragFire('dragover', '乙') === 'ok', '合成 dragover 打在目标行上');
  ok(await evalJs(page, `return !!document.querySelector('.drop-hole');`),
    'dragover 时也让位出了洞（鼠标这条路同样走 applyDropAt）');
  await dragFire('drop', '乙');
  await new Promise((r) => setTimeout(r, 200));
  const mAfter = await inbox();
  ok(mAfter.join('') !== '乙丙甲', '鼠标拖完顺序真的变了，实际 ' + JSON.stringify(mAfter));
  ok(mAfter[0] === '甲', '「甲」被拖回了第一位，实际 ' + JSON.stringify(mAfter));
  await dragFire('dragend', '甲');
  await new Promise((r) => setTimeout(r, 200));
  ok(await evalJs(page, `return !document.querySelector('.drop-hole') && !document.body.classList.contains('dragging-active');`),
    'dragend 之后洞和拖动状态都收干净了');
  const mSaved = await evalJs(page, `
    const now = JSON.parse(localStorage.getItem('schedule-app-v4')).tasks;
    return Object.values(now).filter((t) => !t.deleted).sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0))
      .map((t) => t.title);
  `);
  ok(mSaved.join('') === mAfter.join(''), '鼠标拖的结果也落库了，实际 ' + JSON.stringify(mSaved));

  console.log('\n十、被降成只读之后：改动挡下来，并且说是哪个集');
  /* 这一节测的是「写操作不许静默失败」那条约定（见 CLAUDE.md 五、界面约定）。
     store 那一层有单测，但**接线**没测过：计数器涨了、提示没弹出来，
     用户看到的还是「点了没反应」。所以这里走完整条路：真降权限 → 真点 → 真看提示。

     顺序上放在拖拽两节之后：这一节要往待办箱里加一条自己的任务，
     放到第八节前面会把它那句「三条任务按添加顺序排」污染掉。 */
  await evalJs(page, `document.querySelector('[data-nav="inbox"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.fast-add input')`, '待办箱能快速添加');
  // 现在还写得进去（是 editor），先在**共享的那个集**里留下一条，
  // 后面降成只读才有一条现成的可以点
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
  await waitFor(page, `
    [...document.querySelectorAll('[data-cal]')].some((b) => b.textContent.includes('只读')) ? 1 : null`,
    '侧栏显示「只读」', 8000);
  ok(true, '降级后侧栏把那个集标成「只读」');

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
  await clickEl(page, `
    [...document.querySelectorAll('[data-cal]')].find((b) => b.textContent.trim() === '全家')
  `);
  await waitFor(page, `
    [...document.querySelectorAll('[data-cal]')].find((b) => b.className.includes('--primary'))?.textContent.trim() === '全家' ? 1 : null
  `, '切回自己的日程集（共享那个现在改不动）', 8000);

  await evalJs(page, `document.querySelector('[data-nav="inbox"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.fast-add input')`, '待办箱能快速添加');
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
  ok(await clickEl(page, `
    [...document.querySelectorAll('.task-el')].find((e) => e.textContent.includes(${JSON.stringify(MINE)}))
  `) !== 'missing', '点开这条任务');
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
  await clickEl(page, `document.querySelector('.drawer.open .drawer-head .icon-btn')`);
  await waitFor(page, `document.querySelector('.drawer.open') ? null : 1`, '抽屉关上了', 5000);

  console.log('\n十二、离线：外壳能打开，顶栏会说话');
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
  ok(await evalJs(page, `return document.querySelector('[data-cal]')?.textContent.trim() === '全家';`),
    '断网打开的是同一份数据（日程集名字还在）');
  ok(await evalJs(page, `return document.querySelectorAll('[data-nav]').length > 0;`),
    '断网时导航也在，不是白屏');

  collect();
  // 断网时 /api/ 的请求必然失败 —— Service Worker **故意不碰接口**，这是设计如此。
  // 引擎自己会把它记成 lastError 显示出来，所以这里只关心别的来源的报错。
  const other = errors.filter((e) => !e.url.includes('/api/'));
  ok(other.length === 0, '离线这一段除了接口连不上，没有别的 console 报错'
    + (other.length ? '：\n      ' + fmt(other) : ''));

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

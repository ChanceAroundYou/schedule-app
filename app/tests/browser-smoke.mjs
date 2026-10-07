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
  // 默认日程集「我的日程」不再出现在侧栏列表里（见 Calendars.tsx 的 visible 过滤）
  const calName = await evalJs(page, `return document.querySelector('[data-cal]')?.textContent.trim() || null;`);
  ok(calName === null || calName !== '我的日程', '默认日程集不在侧栏列表里，实际是 ' + JSON.stringify(calName));
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

  // 打卡页的输入框也要有名字 —— a11y() 原来只扫了待办箱 / 抽屉 / 浮层，
  // 打卡页从来没被扫过，habitInput 只有 placeholder 的漏洞就是这么漏掉的
  await evalJs(page, `document.querySelector('[data-nav="habits"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.habit-add')`, '打卡页渲染出来', 8000);
  const hab = await evalJs(page, `return { bad: ${a11y('.habit-add')},
    cands: document.querySelectorAll('.habit-add input').length };`);
  ok(hab.cands === 1, '打卡页有 ' + hab.cands + ' 个输入框可查');
  ok(hab.bad.length === 0, '打卡页每个控件都有名字'
    + (hab.bad.length ? '：\n      ' + hab.bad.join('\n      ') : ''));

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

  // 浮层里的控件也要有名字。**这一段是补漏**：「每个输入框都有名字」原来只扫了
  // 抽屉（第十三节），管理浮层的名字框和两个角色下拉一个都没有可访问名字 ——
  // 它们从来就没被任何断言看过。
  //
  // 放在这里而不是第十三节：成员是**联网拉的**，第十三节跑在断网之后，
  // 那时成员列表是空的、角色下拉根本不渲染，扫过去等于空过（候选数为 0）。
  const sheetA11y = await evalJs(page, `return { bad: ${a11y('[role="dialog"]')},
    cands: document.querySelectorAll('[role="dialog"] input, [role="dialog"] select').length };`);
  ok(sheetA11y.cands >= 3, '管理浮层里有 ' + sheetA11y.cands + ' 个表单控件可查（名字框 / 两个角色下拉）');
  ok(sheetA11y.bad.length === 0, '管理浮层里每个控件都有名字'
    + (sheetA11y.bad.length ? '：\n      ' + sheetA11y.bad.join('\n      ') : ''));

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
  /* 这一节测的是「写操作不许静默失败」那条约定（见 CLAUDE.md 三、界面硬规则）。
     store 那一层有单测，但**接线**没测过：计数器涨了、提示没弹出来，
     用户看到的还是「点了没反应」。所以这里走完整条路：真降权限 → 真点 → 真看提示。

     顺序上放在拖拽两节之后：这一节要往待办箱里加一条自己的任务，
     放到第八节前面会把它那句「三条任务按添加顺序排」污染掉。 */
  await evalJs(page, `document.querySelector('[data-nav="inbox"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.fast-add textarea')`, '待办箱能快速添加');
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
  const MODEL_PORT = 25711;
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
  await new Promise((r) => modelSrv.listen(MODEL_PORT, '127.0.0.1', r));
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
    for (const el of box.querySelectorAll('span.check-btn')) bad.push('勾选圈是 span 不是 button');
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
  const switched = await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    const canWrite = (r) => r === 'owner' || r === 'editor';
    const mine = (st.cals || []).filter((c) => canWrite(c.role));
    const pick = mine.find((c) => c.id !== st.ui.cal) || mine[0];
    const el = pick && [...document.querySelectorAll('[data-cal]')].find((x) => x.dataset.cal === pick.id);
    if (el) el.click();
    return pick ? pick.name + ' / ' + pick.role : 'none';
  `);
  ok(switched !== 'none', '切到了有写权限的日程集（' + switched + '）');

  await quickAdd(page, '无障碍检查');
  const list = await scan();
  ok(list.cands > 0, '待办箱里有任务行可查（候选 ' + list.cands + ' 个 —— 为 0 时下面那条是空过）');
  ok(list.bad.length === 0, '待办箱没有假按钮 / 无名控件'
    + (list.bad.length ? '：\n      ' + list.bad.join('\n      ') : ''));

  // 抽屉里字段最多（日期 / 时间 / 时长 / 重复 / 备注 + 重复面板里的几个），
  // label 配没配上在这里最容易露馅
  ok(await clickEl(page, `
    [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
      .find((e) => e.textContent.includes('无障碍检查'))
  `) !== 'missing', '点开刚建的那条任务');
  await waitFor(page, `!!document.querySelector('.drawer.open .drawer-title')`, '抽屉打开', 8000);
  const draw = await evalJs(page, `return { bad: ${a11y()},
    cands: document.querySelectorAll('.drawer.open input, .drawer.open select, .drawer.open textarea').length };`);
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
  // 走抽屉的日期框，不走快速添加的自然语言：本探针的 store 里本来一条有日期
  // 的任务都没有，而「快速添加 → 解析出日期」那条路别处已经单独覆盖过，
  // 这里再依赖一次只会多一个可能失败的地方。
  const todayIso = await evalJs(page, `
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  `);
  const dated = await evalJs(page, `
    const inp = document.querySelector('.drawer.open .field input[type="date"]');
    if (!inp) return 'missing';
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, ${JSON.stringify(todayIso)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  `);
  ok(dated === 'ok', '在抽屉里给它填上今天（' + todayIso + '），实际 ' + dated);
  // waitFor 前面会被补一个 return，所以这里只能写一个**表达式**，不能带 const
  //（见 CLAUDE.md 四、39 —— 已经踩过一次）
  await waitFor(page, `
    Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks || {})
      .some((t) => t.title === '无障碍检查' && t.date === ${JSON.stringify(todayIso)}) ? 1 : null
  `, '日期落盘了', 8000);

  await clickEl(page, `document.querySelector('.drawer.open .drawer-head .icon-btn')`);
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
    cals: [...document.querySelectorAll('[data-cal]')].map((x) => x.textContent.trim()),
    activeCal: (JSON.parse(localStorage.getItem('schedule-app-v4')).ui || {}).cal,
    uiCursor: (JSON.parse(localStorage.getItem('schedule-app-v4')).ui || {}).cursor,
    monthCells: document.querySelectorAll('.month-cell').length,
    collapsed: (document.body.innerText.match(/还有 \\d+ 项/g) || []),
  };`);
  ok(pills > 0, '月视图里确实有胶囊可查（' + pills + ' 个 —— 为 0 时下面那条是空过）'
    + '　诊断：' + JSON.stringify(diag));
  ok(month.bad.length === 0, '月视图格子里的勾选圈也是真按钮'
    + (month.bad.length ? '：\n      ' + month.bad.join('\n      ') : ''));

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

  await evalJs(page, `document.querySelector('[data-nav="calendar"]').click(); return true;`);
  await evalJs(page, `document.querySelector('[data-view="day"]').click(); return true;`);
  // 回到今天：日视图看的是 ui.cursor，前面几节切来切去可能已经不在了
  await clickEl(page, `document.querySelector('.today-btn')`);
  // 从**日程页**快速添加，不走 quickAdd 那个 helper：它的等条件是
  // 「[data-scope="inbox"] 里多出一行」，而这一条**有日期**、根本不在待办箱。
  // 而日期这一项必须由页面自己给：待办箱的 defaultDate 是 null，加出来的是
  // 「有时间、没日期」的任务，哪个日视图都不会把它画上时间轴（下方就会一直
  // 等不到方块）。日程页的 defaultDate 是 ui.cursor，正好是今天。
  await evalJs(page, `
    const inp = document.querySelector('.fast-add textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(inp, '9:00 微调试试');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  `);
  const block = await waitFor(page, `
    (() => {
      const e = [...document.querySelectorAll('.tl-event')].find((x) => x.textContent.includes('微调试试'));
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

  const sel = (act) => `document.querySelector('.tl-event[data-id=${JSON.stringify(block.id)}] [data-act="${act}"]')`;
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
  await clickEl(page, `document.querySelector('.tl-event[data-id=${JSON.stringify(block.id)}]')`);
  await waitFor(page, `!!document.querySelector('.drawer.open .drawer-title')`, '抽屉打开', 8000);
  await clickEl(page, `[...document.querySelectorAll('.drawer.open button')].find((b) => b.textContent.includes('删除任务'))`);
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
  const RESTORE = '.fast-add textarea';
  ok(await evalJs(page, `
    const el = document.querySelector(${JSON.stringify(RESTORE)});
    if (!el) return 'missing';
    el.focus();
    return document.activeElement === el ? 'ok' : 'no';
  `) === 'ok', '先把光标放在快速添加框里（关掉抽屉之后要还回这儿）');

  await clickEl(page, `document.querySelector('#content .tl-event, #content .task-row')`);
  await waitFor(page, `!!document.querySelector('.drawer.open')`, '抽屉打开', 8000);

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
  ok(reduced.spin === '1s',
    '加载圈是例外，照转不误（它不是动效，是在说「正在同步」）：' + motion.spin + ' → ' + reduced.spin);

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
  await waitFor(page, `document.querySelector('.jump-btn') ? 1 : null`, '切到日程页（找日期按钮在那儿）', 8000);
  const jumpState = () => evalJs(page, `
    const b = document.querySelector('.jump-btn');
    return { exp: b.getAttribute('aria-expanded'), hd: b.getAttribute('aria-haspopup') };
  `);
  const j0 = await jumpState();
  await clickEl(page, `document.querySelector('.jump-btn')`);
  await waitFor(page, `document.querySelector('.jump-btn').getAttribute('aria-expanded') === 'true' ? 1 : null`,
    '找日期面板打开', 8000);
  const j1 = await jumpState();
  ok(j0.exp === 'false' && j1.exp === 'true',
    '「找日期」的 aria-expanded 跟着开合：' + j0.exp + ' → ' + j1.exp);
  ok(j0.hd === 'dialog', '「找日期」说了按下去会弹东西（aria-haspopup=dialog），实际 ' + JSON.stringify(j0.hd));
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.jump-btn').getAttribute('aria-expanded') === 'false' ? 1 : null`,
    '找日期面板收起', 8000);

  console.log('\n十七、找日期文本框 / 时间转盘');
  /* 这三样此前**一条断言都没有**：找日期的文本输入（不是点格子）、快速添加里
     那个 12 小时制转盘、侧栏跨组拖拽重排。
     `parseDateText` 的判定逻辑在 domain.test.ts 里有单测，这里证的是**接线**：
     输入框 → 解析 → 光标真挪过去 → 顶栏真跟着变。
     转盘和侧栏拖拽全是 DOM 层面的东西，只能在这儿证。 */

  /* ---- 1. 找日期：裸周几必须落在**下一个**，不能是刚刚过去那个 ---- */
  // 先回到今天，光标位置才是确定的（不然「跳过去」可能压根没变化，等于没测）
  await clickEl(page, `document.querySelector('.today-btn')`);
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
  await clickEl(page, `document.querySelector('.jump-btn')`);
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
  await clickEl(page, `document.querySelector('.jump-btn')`);
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
  await waitFor(page, `document.querySelector('.when-pop') ? 1 : null`, '先出日期面板', 8000);
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
    const ampm = pop.querySelector('.cp-ampm').getBoundingClientRect();
    const apm = pop.querySelector('.cp-apm').getBoundingClientRect();
    const now = pop.querySelector('.cp-now').getBoundingClientRect();
    const pm = [...pop.querySelectorAll('.cp-ap')].find((b) => b.textContent.trim() === '下午').getBoundingClientRect();
    return {
      size: Math.round(f.width),
      left: +(f.left - w.left).toFixed(1),
      right: +(w.right - f.right).toFixed(1),
      nums: pop.querySelectorAll('.cp-num').length,
      ap: [...pop.querySelectorAll('.cp-ap')].map((b) => b.textContent.trim()).join('/'),
      nowParent: pop.querySelector('.cp-now').parentElement.className,
      nowText: pop.querySelector('.cp-now').textContent.trim(),
      // 大号时间显示**整块没了**（需求 4）
      hasDisplay: !!pop.querySelector('.cp-display'),
      // 上午 / 下午那一组的中心 vs 整行的中心：居中就该是 0（需求 5）
      apmOff: +((((apm.left + apm.right) / 2) - ((ampm.left + ampm.right) / 2))).toFixed(1),
      // 「现在」在下午右边多少（需求 5）
      nowGap: +(now.left - pm.right).toFixed(1),
      // 「现在」两个字横排还是竖排（需求 3）：竖排会高出一行
      nowW: +now.width.toFixed(1),
      nowH: +now.height.toFixed(1),
      dot: pop.querySelector('.cp-dot') ? pop.querySelector('.cp-dot').textContent.trim() : null,
    };
  `);
  ok(dial.size === 198, '面板里的表盘比抽屉里那个小一号，实际 ' + dial.size + 'px');
  ok(dial.nums === 12, '一圈 12 个数，不是 24 个（每个 15° 必然点不准），实际 ' + dial.nums);
  ok(dial.ap === '上午/下午', '两圈靠上午 / 下午区分，实际 ' + JSON.stringify(dial.ap));
  // 大号时间显示去掉了（需求 4）：生效时间已经写在横条那个按钮上，
  // 这个面板只有 234px 宽、表盘占掉 198，再摆两个 27px 的数字纯属占地方
  ok(!dial.hasDisplay, '面板里那个大号的时间显示整块去掉了');
  // 「现在」挪到下午的**右侧**（需求 5），但不能把上午 / 下午那一组挤偏 ——
  // 写成三个 flex 子元素就会一起居中、整组左移，所以它走的是绝对定位
  ok(dial.nowParent === 'cp-apm', '「现在」在上午 / 下午那一行里，实际 ' + JSON.stringify(dial.nowParent));
  ok(dial.nowText === '现在', '「现在」两个字还在，实际 ' + JSON.stringify(dial.nowText));
  ok(dial.nowGap > 0 && dial.nowGap < 20, '「现在」紧贴下午按钮，实际间距 ' + dial.nowGap);
  // 需求 3：「现在」两个字**横着排**。它的包含块是 `.cp-apm`，而 left 超出
  // 包含块宽度 → 绝对定位的可用宽度算成负数 → 被压到一个汉字宽、竖成两行。
  // 横排时高度就是一行
  ok(dial.nowH < 30,
    '「现在」两个字横着排，不是竖成两行（需求 3），实际 ' + dial.nowW + '×' + dial.nowH);
  ok(Math.abs(dial.apmOff) < 1,
    '上午 / 下午 那一组**仍然居中**（没被「现在」挤偏），实际偏 ' + dial.apmOff + 'px');
  ok(dial.dot === '时', '表盘正中心写着当前在拨哪一圈，初始是「时」，实际 ' + JSON.stringify(dial.dot));
  // 行与主体之间有分界线（需求 6）
  const borderTop = await evalJs(page, `return getComputedStyle(document.querySelector('.wp-body')).borderTopWidth;`);
  ok(parseFloat(borderTop) >= 1, '行与主体之间有分界线（需求 6），实际 ' + borderTop);
  ok(Math.abs(dial.left - dial.right) < 1,
    '表盘在面板里居中，实际 左 ' + dial.left + ' / 右 ' + dial.right);

  // 下午那圈直接写 12–23，不用心算 +12；分钟那圈写 60,5,…,55（真钟表的样子）
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-ap')].find((b) => b.textContent.trim() === '下午')`);
  const pmNums = await evalJs(page, `return [...document.querySelectorAll('.when-pop .cp-num')].map((b) => b.textContent.trim()).join(',');`);
  ok(pmNums === '12,13,14,15,16,17,18,19,20,21,22,23',
    '下午那圈直接写 12–23（不是 1–12），实际 ' + pmNums);
  // 上午那圈写 0–11（24 小时制），和按钮/输入框显示一致
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-ap')].find((b) => b.textContent.trim() === '上午')`);
  // 表盘下面**不该有任何说明文字**（需求 7）：12 在顶部是画着的，
  // 「每格 5 分钟」数一下就知道 —— 写出来只是把人当不会看
  ok(await evalJs(page, `return !document.querySelector('.when-pop .cp-tip');`),
    '表盘下面没有「选小时（12 在顶部）」这类提示文字');
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num')].find((b) => b.textContent.trim() === '3')`);
  // 选完小时自动进分钟档 —— 提示文字没了，改看表盘正中心写的是「时」还是「分」
  //（那个点同时是切换键，见需求 4：显示行删了之后总得有个地方切圈）
  const mode = await evalJs(page, `return document.querySelector('.when-pop .cp-dot').textContent.trim();`);
  ok(mode === '分', '选完小时自动进分钟档（中心那个点变成「分」），实际 ' + JSON.stringify(mode));
  const minNums = await evalJs(page, `return [...document.querySelectorAll('.when-pop .cp-num')].map((b) => b.textContent.trim()).join(',');`);
  ok(minNums === '60,5,10,15,20,25,30,35,40,45,50,55',
    '分钟那圈写 60,5,…,55（顶端 60 就是 0 分），实际 ' + minNums);
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num')].find((b) => b.textContent.trim() === '30')`);
  // 分钟一落定 = 这次选择走完了 → 面板**自己收起**（需求 5），不用再点任何按钮
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '选完分钟面板自动收起', 8000);
  const shown = await evalJs(page, `const t = document.querySelector('.fast-clock .fc-t'); return t ? t.textContent.trim() : null;`);
  ok(shown === '03:30', '上午 3 点选出来是 24 小时制的 03:30（面板已自己收起，值写在按钮上），实际 ' + JSON.stringify(shown));

  // 上午 12 点 = 0 点：这是 12 小时制最容易错的一格。
  // 面板刚自己收起了，先重新打开（openLayer 会连时间层一起打开）。
  // **面板关掉时 ClockBody 是卸载的**，所以重开之后表盘回到小时圈
  //（`mode` 的初值是 'h'）—— 不用再像以前那样点一下「切回小时档」。
  await openLayer('time');
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-ap')].find((b) => b.textContent.trim() === '上午')`);
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
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num')].find((b) => b.textContent.trim() === '0')`);
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

  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-ap')].find((b) => b.textContent.trim() === '下午')`);
  // 下午那圈写的是 12–23，3 点就是「15」——点 '3' 会落空（上午圈才有 '3'）
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num')].find((b) => b.textContent.trim() === '15')`);
  // 分钟那圈顶端那格写的是 60（就是 0 分），没有「0」这一格
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num')].find((b) => b.textContent.trim() === '60')`);
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

  await clickEl(page, `document.querySelector('.drawer .fast-clock')`);
  await waitFor(page, `document.querySelector('.clock-pop') ? 1 : null`, '抽屉里弹出转盘', 8000);
  const dface = await evalJs(page, `
    const f = document.querySelector('.clock-pop .cp-face').getBoundingClientRect();
    const p = document.querySelector('.clock-pop').getBoundingClientRect();
    return {
      size: Math.round(f.width),
      left: +(f.left - p.left).toFixed(1),
      right: +(p.right - f.right).toFixed(1),
      foot: [...document.querySelectorAll('.clock-pop .cp-foot button')].map((b) => b.textContent.trim()).join('/'),
      quick: [...document.querySelectorAll('.clock-pop .cp-now')].map((b) => b.textContent.trim()).join('/'),
    };
  `);
  // 抽屉里那只**不缩小**：`.clock-pop` 的 278px 宽度是按 246 的表盘配出来的
  // （见 legacy.css 那段注释），给它套上 `.wp-clock` 那套小字会顶到边
  ok(dface.size === 246, '抽屉里那只表盘仍是 246px（没被面板那套小字带跑），实际 ' + dface.size);
  ok(Math.abs(dface.left - dface.right) < 1,
    '表盘在弹层里居中，实际 左 ' + dface.left + ' / 右 ' + dface.right);
  ok(dface.foot === '清除/取消/确定', '出口是「清除 / 取消 / 确定」，实际 ' + JSON.stringify(dface.foot));
  ok(dface.quick === '现在', '「现在」跟着表盘走（它拨的是针），实际 ' + JSON.stringify(dface.quick));

  await clickEl(page, `[...document.querySelectorAll('.clock-pop .cp-ap')].find((b) => b.textContent.trim() === '下午')`);
  await clickEl(page, `[...document.querySelectorAll('.clock-pop .cp-num')].find((b) => b.textContent.trim() === '15')`);
  await clickEl(page, `[...document.querySelectorAll('.clock-pop .cp-num')].find((b) => b.textContent.trim() === '60')`);
  await clickEl(page, `[...document.querySelectorAll('.clock-pop .cp-foot button')].find((b) => b.textContent.trim() === '确定')`);
  await waitFor(page, `document.querySelector('.clock-pop') ? null : 1`, '点「确定」收起转盘', 8000);
  const committed = await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t ? t.time : null;
    })()
  `, '抽屉里选的时间落盘', 8000);
  ok(committed === '15:00', '点「确定」之后时间真的写进任务，实际 ' + JSON.stringify(committed));
  ok(await evalJs(page, `return document.querySelector('.drawer .fast-clock').classList.contains('on');`),
    '抽屉那个时钟按钮亮起来了（它表示「这条已经定了时间」）');

  // 「取消 = 反悔」：拨一个**不一样**的时间再取消，任务上的时间不能变
  await clickEl(page, `document.querySelector('.drawer .fast-clock')`);
  await waitFor(page, `document.querySelector('.clock-pop') ? 1 : null`, '转盘再打开', 8000);
  await clickEl(page, `[...document.querySelectorAll('.clock-pop .cp-ap')].find((b) => b.textContent.trim() === '上午')`);
  await clickEl(page, `[...document.querySelectorAll('.clock-pop .cp-num')].find((b) => b.textContent.trim() === '9')`);
  await clickEl(page, `[...document.querySelectorAll('.clock-pop .cp-num')].find((b) => b.textContent.trim() === '60')`);
  await clickEl(page, `[...document.querySelectorAll('.clock-pop .cp-foot button')].find((b) => b.textContent.trim() === '取消')`);
  await waitFor(page, `document.querySelector('.clock-pop') ? null : 1`, '点「取消」收起转盘', 8000);
  const afterCancel = await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t ? t.time : null;
    })()
  `, '取消之后读回时间', 8000);
  ok(afterCancel === '15:00',
    '「取消」是反悔：拨到 09:00 又取消，任务上仍是 15:00，实际 ' + JSON.stringify(afterCancel));

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

  // 窄屏顶栏是「标题 + 搜索图标 + 状态」，搜索框收成点开的小浮条（2026-10-07
  // 顶栏重构）。这一小节顺带锁住 Esc 那一层 —— `searchOpen` 原先漏在键盘
  // effect 的依赖数组之外，于是闭包里读到的永远是 false：浮条开着按 Esc 关不掉。
  // 它必须**靠 CDP 派发**，因为要的就是「按真实焦点送一个 Escape 进 document」。
  ok(await evalJs(page, `return !document.querySelector('.topbar .search-box');`),
    '窄屏顶栏不摆常驻搜索框，只留图标');
  ok(await clickEl(page, `document.querySelector('.topbar .search-toggle')`) !== 'missing',
    '窄屏顶栏有搜索图标');
  await waitFor(page, `!!document.querySelector('.search-pop input')`, '搜索浮条弹出来了');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(page, `document.querySelector('.search-pop') ? null : 1`, 'Esc 关掉了搜索浮条');

  const tabsNow = () => evalJs(page, `
    return [...document.querySelectorAll('.tabbar .tab')].map((x) => x.textContent.replace(/\\d+/g, '').trim());
  `);
  const uiNow = () => evalJs(page, `return JSON.parse(localStorage.getItem('schedule-app-v4')).ui;`);
  /** 等防抖落盘：persist() 是 250ms 防抖，改完立刻读会读到上一版 */
  const waitForUi = (what, expr) => waitFor(page, expr, what, 8000);

  /* ---------- 半段一：窄屏只显示底栏设置 ---------- */
  ok((await tabsNow()).length === 5, '底栏是 4 项 + 「更多」，实际 ' + JSON.stringify(await tabsNow()));
  ok((await tabsNow())[4] === '更多', '「更多」恒占最后一格');

  // 进设置页：窄屏下侧栏是收起的，入口在「更多」抽屉里
  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'))`);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
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

  /* ---------- 半段二：宽屏只显示侧栏设置 ---------- */
  await reloadAs(false, '宽屏侧栏渲染出来了');
  ok(await evalJs(page, `return !!document.querySelector('.topbar .search-box input');`),
    '宽屏顶栏仍是常驻搜索框（只有窄屏才收成图标）');
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
  ok(await evalJs(page, `return document.querySelector('.today-btn').textContent;`) === '今',
    '「今天」按钮只留一个「今」字，实际 '
    + await evalJs(page, `return document.querySelector('.today-btn').textContent;`));
  ok(await evalJs(page, `return !document.querySelector('.jump-btn').textContent.trim();`),
    '「找日期」只留图标、没有文字');
  ok(await evalJs(page, `return !!document.querySelector('.date-nav .round-btn svg');`),
    '上一/下一个按钮里是图标');

  // 上一/下一个的**功能**跟着视图走：日 = 换一天 · 周 = 切一周 · 月 = 切一月。
  // 判据是顶栏标题（那唯一一份日期），不是游标 —— 用户看的就是它。
  await clickEl(page, `document.querySelectorAll('.date-nav .round-btn')[1]`);
  await waitFor(page, `document.querySelector('.topbar .view-title').textContent !== ${JSON.stringify(dayTitle)} ? 1 : null`,
    '日视图按「下一个」标题变了', 8000);
  ok(await evalJs(page, `return document.querySelector('.topbar .view-title').textContent;`) !== dayTitle,
    '日视图按「下一个」换了一天，实际 ' + await topTitle());

  await evalJs(page, `document.querySelector('[data-view="week"]').click(); return true;`);
  await waitFor(page, `document.querySelector('[data-view="week"].on') ? 1 : null`, '切到周视图', 8000);
  const weekTitle = await topTitle();
  ok(/^\d{1,2}月\d{1,2}日 – \d{1,2}月\d{1,2}日$/.test(weekTitle),
    '周视图顶栏标题是这一周的起止，实际 ' + weekTitle);
  await clickEl(page, `document.querySelectorAll('.date-nav .round-btn')[1]`);
  await waitFor(page, `document.querySelector('.topbar .view-title').textContent !== ${JSON.stringify(weekTitle)} ? 1 : null`,
    '周视图按「下一个」标题变了', 8000);
  const weekTitle2 = await topTitle();
  ok(weekTitle2 !== weekTitle, '周视图按「下一个」切了一周，实际 ' + weekTitle2);

  await evalJs(page, `document.querySelector('[data-view="month"]').click(); return true;`);
  await waitFor(page, `document.querySelector('[data-view="month"].on') ? 1 : null`, '切到月视图', 8000);
  const monthTitle = await topTitle();
  ok(/^\d{4}年\d{1,2}月$/.test(monthTitle), '月视图顶栏标题是年月，实际 ' + monthTitle);
  await clickEl(page, `document.querySelectorAll('.date-nav .round-btn')[1]`);
  await waitFor(page, `document.querySelector('.topbar .view-title').textContent !== ${JSON.stringify(monthTitle)} ? 1 : null`,
    '月视图按「下一个」标题变了', 8000);
  ok(await topTitle() !== monthTitle, '月视图按「下一个」切了一月，实际 ' + await topTitle());
  await clickEl(page, `document.querySelector('.sidebar [data-nav="settings"]')`);
  await waitFor(page, `!!document.querySelector('[data-nav-row]')`, '设置页的侧栏列表');
  ok(await evalJs(page, `return !document.querySelector('[data-tab]');`),
    '宽屏设置页不显示底栏胶囊（按设备分屏）');

  // 设置页调序：dragstart / dragover / drop 必须**分开的 tick** ——
  // 同一个 tick 里连发的话 React 还没重渲染，handler 闭包里的 dragKey 仍是 null
  // （加探针时踩过，症状是「拖了但完全没反应」，看着像产品坏了）
  const navRow = (k) => `[...document.querySelectorAll('[data-nav-row]')].find((x) => x.dataset.navRow === ${JSON.stringify(k)})`;
  await evalJs(page, `
    return (() => {
      const el = ${navRow('trash')};
      el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
      return 'ok';
    })();
  `);
  await new Promise((r) => setTimeout(r, 70));
  await evalJs(page, `
    return (() => {
      const el = ${navRow('today')};
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: new DataTransfer() }));
      return 'ok';
    })();
  `);
  await new Promise((r) => setTimeout(r, 70));
  await evalJs(page, `
    return (() => {
      const dst = ${navRow('today')};
      const src = ${navRow('trash')};
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      return 'ok';
    })();
  `);
  await waitForUi('设置页调序落盘',
    `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.navOrder.indexOf('trash') === 1 ? 1 : null`);
  ok((await uiNow()).navOrder.indexOf('trash') === 1,
    '设置页调序真的落库了（trash 挪到了第 2 位），实际 ' + JSON.stringify((await uiNow()).navOrder));

  await reloadAs(false, '刷新后宽屏还在');
  await new Promise((r) => setTimeout(r, 800));
  ok((await uiNow()).navOrder.indexOf('trash') === 1, '刷新后顺序还在');

  // 恢复伪窄屏给后面几节（十九、二十都在窄屏下跑）
  await reloadAs(true, '恢复窄屏模式');

  console.log('\n十九、项目泳道：建项目 → 挂任务 → 拖卡片换列 → 刷新还在');

  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'))`);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
  await clickEl(page, `document.querySelector('.more-sheet [data-nav="projects"]')`);
  await waitFor(page, `!!document.querySelector('.pj-wrap')`, '项目页挂上');
  ok(await evalJs(page, `return document.querySelector('#content').textContent.includes('还没有项目');`),
    '空态说话，不是一片白');

  await clickEl(page, `document.querySelector('.pj-top .text-btn')`);
  await waitFor(page, `!!document.querySelector('.field input')`, '项目浮层打开');
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
      // 横条延伸到屏幕最右（right: 0）
      rightGap: +(window.innerWidth - b.right).toFixed(1),
      // 圆钮在横条内（DOM 上仍是子节点）
      fabInBar: bar.contains(fab),
      // 圆钮贴横条右端 / 底端 —— 就是横条的内边距（右 13、底 9）
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
  ok(barBox.rightGap < 2,
    '横条延伸到屏幕最右（right: 0），实际间距 ' + barBox.rightGap);
  ok(barBox.fabInBar,
    '圆钮在横条内（DOM 上仍是子节点）');
  ok(Math.abs(barBox.fabRightGap - 13) < 1.5,
    '圆钮贴横条右端（横条内边距 13px），实际 ' + barBox.fabRightGap);
  ok(Math.abs(barBox.fabBottomGap - 9) < 1.5,
    '圆钮贴横条底端（横条内边距 9px），实际 ' + barBox.fabBottomGap);
  // 需求 1 的正面：+ / × 换图标时，圆钮自己在屏幕上不挪窝
  ok(Math.abs(barBox.fabRight - fabCollapsed.right) < 1
     && Math.abs(barBox.fabBottom - fabCollapsed.bottom) < 1,
    '展开前后圆钮位置不动（需求 1）：收起 右 ' + fabCollapsed.right + ' 底 ' + fabCollapsed.bottom
     + '，展开 右 ' + barBox.fabRight + ' 底 ' + barBox.fabBottom);
  // 需求 2：圆钮让出的那点空间里，时间 / 保存按钮靠到右端、没被圆钮压住
  const sideBox = await evalJs(page, `
    const fab = document.querySelector('.fast-fab');
    const side = document.querySelector('.fast-add .fast-side');
    const f = fab.getBoundingClientRect(), s = side.getBoundingClientRect();
    return { gapToFab: +(f.left - s.right).toFixed(1) };
  `);
  ok(sideBox.gapToFab > 0,
    '时间 / 保存按钮在圆钮左边、没被压住（需求 2），实际间距 ' + sideBox.gapToFab);

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

  /* ---- 「保存」是个 ✓，和日期按钮上下叠放（需求 4） ---- */
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
      // 保存在时间下面（需求 4）
      belowClock: r.top >= c.bottom - 0.5,
      // 日期按钮和 ✓ 一样高（需求 3）
      h: Math.round(r.height), clockH: Math.round(c.height),
    };
  `);
  ok(saveBtn && saveBtn.hasCheck, '横条上那个保存键是个 ✓ 图标，实际 ' + JSON.stringify(saveBtn));
  ok(saveBtn && saveBtn.text === '', '它只有图标，没有「保存」两个字（一行里三个文字按钮太吵）');
  ok(saveBtn && saveBtn.display !== 'none', '「保存」按钮看得见（不是 display:none）');
  ok(saveBtn && saveBtn.belowClock, '✓ 摆在日期按钮**下面**（需求 4）');
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
  await waitFor(page, `!!document.querySelector('select[id$="-proj"]')`, '抽屉里的项目下拉');
  const optVal = await evalJs(page, `
    return (() => {
      const s = document.querySelector('select[id$="-proj"]');
      const o = [...s.options].find((x) => x.textContent.trim() === '星星包');
      return o ? o.value : null;
    })();
  `);
  ok(!!optVal, '项目下拉里列得到这个项目');
  await evalJs(page, `
    return (() => {
      const s = document.querySelector('select[id$="-proj"]');
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      set.call(s, ${JSON.stringify(optVal)});
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })();
  `);
  await new Promise((r) => setTimeout(r, 250));
  await clickEl(page, `document.querySelector('.drawer-foot button:last-child')`);
  await new Promise((r) => setTimeout(r, 300));

  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'))`);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
  await clickEl(page, `document.querySelector('.more-sheet [data-nav="projects"]')`);
  await waitFor(page, `!!document.querySelector('.pj-card')`, '卡片出现在泳道里');
  ok((await evalJs(page, `return document.querySelectorAll('.pj-col[data-scope$=":todo"] .pj-card').length;`)) === 1,
    '任务落在「待办」列');

  // 拖卡片换列：同样是分开的 tick（见上一节的说明）
  await evalJs(page, `
    return (() => {
      const el = document.querySelector('.pj-col[data-scope$=":todo"] .pj-card');
      el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
      return 'ok';
    })();
  `);
  await new Promise((r) => setTimeout(r, 70));
  await evalJs(page, `
    return (() => {
      const el = document.querySelector('.pj-col[data-scope$=":doing"] .pj-col-b');
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: new DataTransfer() }));
      return 'ok';
    })();
  `);
  await new Promise((r) => setTimeout(r, 70));
  await evalJs(page, `
    return (() => {
      document.querySelector('.pj-col[data-scope$=":doing"] .pj-col-b')
        .dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() }));
      return 'ok';
    })();
  `);
  await new Promise((r) => setTimeout(r, 250));
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
      prev: pick('.date-nav .round-btn'),
      today: pick('.today-btn'),
      jump: pick('.jump-btn'),
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
      // 今天的数字**只染色**，不加圆底 —— 圆底会让那一格凭空高出 9px
      todayBg: todayCell ? getComputedStyle(todayCell).backgroundColor : 'no-today-cell',
    };
  `);
  ok(wk.whLoad === 0 && wk.whCount === 0, '表头不再有负载横条与任务计数，实际 ' + wk.whLoad + ' / ' + wk.whCount);
  ok(parseFloat(wk.unBorderTop) >= 1, '未定时行**上边**也有一条分割线，实际 ' + wk.unBorderTop);
  ok(wk.todayBg === 'rgba(0, 0, 0, 0)', '今天的数字没有圆底（只染色），实际 ' + wk.todayBg);

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

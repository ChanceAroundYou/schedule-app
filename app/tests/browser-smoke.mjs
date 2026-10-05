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
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + JSON.stringify(r.result?.value));
  return r.result.value;
}

/** 等到表达式返回真值，超时就抛（带上最后看到的值，方便定位） */
async function waitFor(page, expr, what, ms = 8000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await evalJs(page, `return ${expr};`);
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等不到「${what}」，最后一次求值 = ${JSON.stringify(last)}`);
}

/* ------------------------------------------------------------ 主流程 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'sched-browser-'));
const procs = [];

function track(p) { procs.push(p); return p; }

function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch (_) { /* 已经没了 */ } }
  rmSync(dataDir, { recursive: true, force: true });
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
  const web = await serveDist();
  procs.push({ kill: () => web.close() });

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${API_PORT}/api/health`)).ok) break; } catch (_) { /* 等 */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  track(spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(dataDir, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
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
        errors.push(e.params.exceptionDetails?.text || 'exception');
      } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        errors.push(e.params.entry.text);
      }
    }
  };

  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });

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
  // 成员是异步拉的，别在读之前就断言
  await waitFor(page,
    `[...document.querySelectorAll('[role="dialog"]')].some((d) => d.innerText.includes('创建者')) ? 1 : null`,
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
  ok(errors.length === 0, '全程没有 console 报错' + (errors.length ? '：\n      ' + errors.join('\n      ') : ''));

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
    + (errors.length ? '：\n      ' + errors.join('\n      ') : ''));

  page.close();
} catch (e) {
  failures++;
  console.error('\n探针中断：', e && e.message ? e.message : e);
} finally {
  cleanup();
}

console.log(failures ? `\n✗ ${failures} 项不对\n` : '\n✓ 全通过\n');
process.exit(failures ? 1 : 0);

/**
 * browser-cards.mjs —— 卡片版面回归探针
 *
 *   CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' \
 *     node app/tests/browser-cards.mjs
 *
 * ## 为什么单独一个探针，而不是塞进 browser-smoke.mjs
 *
 * 2026-10-14 用户报「好多和卡片相关的样式都退化了」。根因值得单独盯住：
 *
 *   `.task-el` 是**跨界面共用的行为标记**（dnd-kit 的 useDraggableEvent 认它，
 *   列表的点击委托也认它），日历卡片、周事件、列表行、未定时胶囊、项目卡
 *   五种界面都挂着它。而 calendar.css 里那段按日历卡写的视觉块写的是
 *   `flex-direction: column`（日历卡是「勾选圈+标题 / 时间」上下两行）。
 *   同特异度下这段只要排在那几个文件前面就赢 —— 它们自己谁都没声明
 *   flex-direction，于是列表行整行变成竖排居中，胶囊和项目卡跟着一起歪。
 *
 * 这套断言要能在**任何时候单独跑**（几秒钟），所以不依赖 smoke 那套长流程；
 * 那边要等 Service Worker、要跑十几节，跑一趟几分钟，出了问题也不想为了
 * 看版面去等它。
 *
 * 环境与 smoke 一样是**完全隔离**的：临时后端 + 临时数据库 + 临时 Chrome
 * profile，不会碰到线上后端与线上库。
 *
 * 退出码非 0 = 版面不对。
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
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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

/* ------------------------------------------------------------------ 端口 */

/** 让内核挑一个空闲端口（避免和同时跑的另一趟撞号） */
function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* ------------------------------------------------------ 静态服务 + 代理 */

function serveDist(apiPort, webPort) {
  const srv = createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      fetch(`http://127.0.0.1:${apiPort}${req.url}`, {
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${apiPort}` },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
        duplex: 'half',
      }).then(async (r) => {
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
      }).catch(() => { res.writeHead(502); res.end('proxy failed'); });
      return;
    }
    /* ⚠️ 先给 URL 补 index.html，再 path.join。反过来不行：
       Windows 上 path.join 会把结尾的 '/' 规范化成 '\\'，
       于是 `p.endsWith('/')` 判不出来，根路径直接 404。 */
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    const p = path.join(DIST, rel);
    if (!p.startsWith(DIST) || !existsSync(p) || statSync(p).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    createReadStream(p).pipe(res);
  });
  return new Promise((res) => srv.listen(webPort, '127.0.0.1', () => res(srv)));
}

/* ------------------------------------------------------------------ CDP */

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { res, rej } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    waiting.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, close: () => ws.close() };
}

/** 在页面里求值（表达式要自己写 return） */
async function evalJs(page, expr) {
  const r = await page.send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception?.description || d.text) + ' :: ' + JSON.stringify(r.result?.value));
  }
  return r.result.value;
}

/** 页面没起来时把关键信息打出来 —— 不然只知道「等不到外壳」，不知道为啥 */
async function dumpPage(page) {
  try {
    const info = await evalJs(page, `
      return {
        href: location.href,
        readyState: document.readyState,
        rootExists: !!document.querySelector('#root'),
        rootChildren: (document.querySelector('#root') || {}).childElementCount || 0,
        bodyLen: document.body ? document.body.innerHTML.length : -1,
        head: document.body ? document.body.innerHTML.slice(0, 200) : '',
        scripts: [...document.querySelectorAll('script')].map((s) => s.src),
      };
    `);
    console.error('  [诊断] ' + JSON.stringify(info, null, 1));
  } catch (e) {
    console.error('  [诊断] 连求值都失败：' + e.message);
  }
}

/** 等到表达式为真。**别让表达式以换行开头**（会被包成 `return\n…` 而断句） */
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

/* ------------------------------------------------------------ 主流程 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'sched-cards-'));
const procs = [];
function track(p) { procs.push(p); return p; }
function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch (_) { /* 已经没了 */ } }
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (_) { /* /tmp 里留个目录无所谓 */ }
}
process.on('exit', cleanup);

let page = null;
try {
  if (!existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('dist/ 还没构建 —— 先 `npm run build`');
  }
  if (!existsSync(CHROME)) {
    throw new Error('找不到 Chrome：' + CHROME + '（可用 CHROME 环境变量指定）');
  }

  const API_PORT = await freePort();
  const WEB_PORT = await freePort();
  const CDP_PORT = await freePort();

  track(spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
    env: { ...process.env, PORT: String(API_PORT), SCHEDULE_DATA_DIR: dataDir },
    stdio: 'ignore',
  }));
  const web = await serveDist(API_PORT, WEB_PORT);
  procs.push({ kill: () => { try { web.close(); } catch (_) { /* 已关 */ } } });

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
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch (_) { /* 还没起来 */ }
    if (!target) await new Promise((r) => setTimeout(r, 150));
  }
  if (!target) throw new Error('Chrome 没开起来');

  page = await connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  try {
    await waitFor(page, `!!document.querySelector('#root')`, '应用外壳挂上');
  } catch (e) {
    await dumpPage(page);
    throw e;
  }

  /* 注册一个账户并直接写进 localStorage（等价于登录成功后的状态）。
     走接口而不是点界面：这个探针要盯的是**版面**，不是注册流程
     —— 注册流程由 browser-smoke 覆盖，这里少一步就少一处会坏的地方。 */
  const reg = await evalJs(page, `
    const r = await fetch('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '版面探针', password: 'cards-pw-123' }),
    });
    const j = await r.json();
    localStorage.setItem('schedule-app-token', j.token);
    localStorage.setItem('schedule-app-user', JSON.stringify(j.user));
    return { ok: r.ok, name: j.user && j.user.name };
  `);
  if (!reg || !reg.ok) throw new Error('注册失败：' + JSON.stringify(reg));

  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  await waitFor(page, `!!document.querySelector('[data-nav="inbox"]')`,
    '登录后的外壳（有导航）', 15000);

  /* ---- 造一条任务 ----
     走**接口**建、再重载让 App 自己拉下来。为什么不点界面上的快速输入框：
     账户刚注册时默认日程集还在同步路上，落在那个窗口里建任务是会丢的
     （实测「输入框被清空、列表里没有、服务端也没有」）。这里要盯的是**版面**，
     造数据这一步越确定越好 —— 快速添加的行为由 browser-smoke 覆盖。 */
  const seed = await evalJs(page, `
    const me = await (await fetch('/api/me', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('schedule-app-token') },
    })).json();
    const cal = me.cals[0];
    const d = new Date();
    const p2 = (n) => (n < 10 ? '0' + n : '' + n);
    const today = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    const id = 't_cards_probe';
    const ts = Date.now();
    const fields = {
      title: '卡片版面探针', date: today, time: null, duration: null,
      done: false, doneAt: null,
      repeat: { unit: 'none', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null },
      seriesId: null, reminder: null, note: '',
    };
    const ops = Object.keys(fields).map((f) => ({
      opId: 'op-' + f, deviceId: 'cards-probe', ts, entity: 'task',
      entityId: id, calId: cal.id, fields: { [f]: fields[f] },
    }));
    const r = await fetch('/api/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + localStorage.getItem('schedule-app-token'),
      },
      body: JSON.stringify({ cursor: 1, ops }),
    });
    const j = await r.json();
    return {
      calName: cal.name, calId: cal.id, today,
      accepted: (j.applied || []).length, rejected: j.rejected || [],
    };
  `);
  if (!seed || !seed.accepted) {
    throw new Error('造任务失败：' + JSON.stringify(seed));
  }
  console.log('  已造任务（' + seed.today + '，日程集「' + seed.calName + '」）');

  /* 新账户的 ui.cal / ui.cals 是空的（App 不会自动勾上一个集），
     于是列表全是空的。探针自己把它指到刚建任务的那个集上 —— 这一步是
     **环境准备**，不是被测行为。 */
  await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    st.ui.cal = ${JSON.stringify(seed.calId)};
    st.ui.cals = [${JSON.stringify(seed.calId)}];
    st.ui.nav = 'today';
    localStorage.setItem('schedule-app-v4', JSON.stringify(st));
    return true;
  `);

  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  try {
    await waitFor(page, `!!document.querySelector('.list-view .task-row')`,
      '任务行出现（App 自己拉下来的）', 20000);
  } catch (e) {
    const dbg = await evalJs(page, `
      let ui = null; let taskCount = -1; let tasks = []; let cals = null; let lastError = null;
      try {
        const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
        ui = st && st.ui;
        cals = (st.cals || []).map((c) => c.id + ':' + c.name);
        lastError = st.lastError;
        tasks = Object.values(st.tasks || {}).map((t) => ({ title: t.title, date: t.date, calId: t.calId }));
        taskCount = tasks.length;
      } catch (_) { /* 没存上 */ }
      const me = await (await fetch('/api/me', {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('schedule-app-token') },
      })).json();
      return {
        myCals: me.cals.map((c) => c.id + ':' + c.name),
        stateCals: cals,
        lastError,
        localTasks: tasks,
        nav: document.querySelector('.view-title')?.textContent,
        loginShown: !!document.querySelector('.auth-screen'),
        listViews: document.querySelectorAll('.list-view').length,
        taskEls: document.querySelectorAll('.task-el').length,
        lsKeys: Object.keys(localStorage),
        ui: ui && { nav: ui.nav, cal: ui.cal, cals: ui.cals },
        sidebar: (document.querySelector('.sidebar') || {}).textContent?.slice(0, 120),
      };
    `);
    console.error('  [诊断] ' + JSON.stringify(dbg, null, 1));
    throw e;
  }

  /* ==================== 断言 1：列表行的真实几何 ==================== */
  console.log('\n一、列表行（待办箱 / 今天 / 逾期 / 已完成 共用同一个 .task-row）');
  const geom = await evalJs(page, `
    const row = document.querySelector('.list-view .task-row');
    const dot = row.querySelector('.check-btn, .sel-dot');
    const title = row.querySelector('.row-title');
    const cs = getComputedStyle(row);
    const rb = row.getBoundingClientRect();
    const db = dot ? dot.getBoundingClientRect() : null;
    const tb = title ? title.getBoundingClientRect() : null;
    return {
      flexDirection: cs.flexDirection,
      justifyContent: cs.justifyContent,
      titleLeft: tb ? +(tb.left - rb.left).toFixed(1) : null,
      dotRight: db ? +(db.right - rb.left).toFixed(1) : null,
      dotTop: db ? +(db.top - rb.top).toFixed(1) : null,
      titleTop: tb ? +(tb.top - rb.top).toFixed(1) : null,
    };
  `);
  ok(geom.flexDirection === 'row', '整行是横向排布，实际 ' + geom.flexDirection);
  ok(geom.justifyContent !== 'center',
    '整行没有继承日历卡的 justify-content: center，实际 ' + geom.justifyContent);
  ok(geom.titleLeft > geom.dotRight + 2,
    '标题在勾选圈**右侧**（不是被挤到下一行）：标题 left=' + geom.titleLeft
    + ' vs 勾选圈 right=' + geom.dotRight);
  ok(geom.titleTop < geom.dotTop + 4,
    '标题与勾选圈同一行（不是上下堆叠）：标题 top=' + geom.titleTop
    + ' vs 勾选圈 top=' + geom.dotTop);

  /* ============ 断言 2：根因 —— 不许再有别的界面把布局漏进来 ============
     扫整张样式表：凡是给 flex-direction 定值、且**能命中列表行**的规则，
     只允许列表行自己那条（值是 row）。多一条就说明又有界面把布局漏过来了
     —— 这正是这次回归发生的方式，比只盯当前表现更能防下一次。 */
  console.log('\n二、根因：没有别的界面的布局漏到列表行上');
  const leaks = await evalJs(page, `
    const probe = document.querySelector('.list-view .task-row');
    const bad = [];
    const walk = (rules) => {
      for (const r of rules) {
        // 现代 Chrome 里 style rule 也有（可能为空的）cssRules，所以先看自身声明
        if (r.style && r.selectorText) {
          const fd = r.style.getPropertyValue('flex-direction');
          if (fd) {
            let hit = false;
            try { hit = probe.matches(r.selectorText); } catch (_) { hit = false; }
            if (hit && fd !== 'row') bad.push(r.selectorText + ' { flex-direction: ' + fd + ' }');
          }
        }
        if (r.cssRules && r.cssRules.length) walk(r.cssRules);
      }
    };
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (_) { continue; }
      walk(rules);
    }
    return bad;
  `);
  ok(leaks.length === 0,
    '没有别的界面的 flex-direction 漏到列表行' + (leaks.length ? '：' + leaks.join(' | ') : ''));

  /* ============ 断言 3：日历卡片自己没被改坏 ============
     上面那条把日历卡的视觉收窄成只认 `--timed` / `--untimed` 两个修饰类，
     所以必须反过来确认**它还认这两个类**（收窄收过头就是把日历页弄坏）。 */
  console.log('\n三、日历卡片仍保留竖排（收窄不能收过头）');
  await evalJs(page, `document.querySelector('[data-nav="calendar"]').click(); return true;`);
  await evalJs(page, `
    const sw = [...document.querySelectorAll('.view-switch button')]
      .find((b) => b.textContent.trim() === '日');
    if (sw) sw.click();
    return true;
  `);
  await waitFor(page, `!!document.querySelector('.content-day')`, '日视图');

  const calCard = await evalJs(page, `
    const el = document.querySelector('.task-el--untimed, .task-el--timed');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      cls: el.className,
      flexDirection: cs.flexDirection,
      background: cs.backgroundColor,
      borderLeftWidth: cs.borderLeftWidth,
      borderRightWidth: cs.borderRightWidth,
      borderLeftColor: cs.borderLeftColor,
      borderRightColor: cs.borderRightColor,
    };
  `);
  if (!calCard) {
    console.log('  --   日视图里没有任务卡（本轮的探针任务没有日期），跳过');
  } else {
    ok(calCard.flexDirection === 'column',
      '日历卡片仍是竖排（内容那一块 + 上下把手），实际 ' + calCard.flexDirection);
    /* 2026-10-19：卡片那条 3px 主色竖线**按要求全去掉**了，四面是同一条中性灰框
       （原来这里断言 border-left 3px，从那天起这条就一直红 —— 探针自己过期了）。
       判据改成「四面一样」：左边和右边的宽度与颜色都必须一致。 */
    ok(calCard.borderLeftWidth === calCard.borderRightWidth
      && calCard.borderLeftColor === calCard.borderRightColor,
      '日历卡片四面是同一条框（不是左侧一根主色强调线）',
      `左 ${calCard.borderLeftWidth} ${calCard.borderLeftColor} / 右 ${calCard.borderRightWidth} ${calCard.borderRightColor}`);
  }
} catch (e) {
  failures++;
  console.error('\n探针中断：', e && e.message ? e.message : e);
  if (e && e.stack) console.error(String(e.stack).split('\n').slice(1, 4).join('\n'));
} finally {
  if (page) { try { page.close(); } catch (_) { /* 已关 */ } }
  cleanup();
}

console.log(failures ? `\n✗ ${failures} 项不对\n` : '\n✓ 卡片版面全通过\n');
process.exit(failures ? 1 : 0);

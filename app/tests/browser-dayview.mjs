/**
 * browser-dayview.mjs —— 只测日视图。临时探针，用完可删。
 *
 * 检查项（对应用户 2026-10-11 报的 4 条）：
 *   二  定时卡片与未定时卡片共用 `.task-el`、都在 `.day-panel` 的堆叠上下文里
 *   三  两个区都不建堆叠上下文、都不裁剪 → 上下拖动互不遮挡
 *   四  未定时区固定两行、第 3 个起三列、卡片上下各 1px 边距
 *   五  拖起来时卡片同时存在于 DOM 且不被裁掉
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP = path.resolve(ROOT, 'app');
const DIST = path.join(ROOT, 'dist');
const API_PORT = 25801;
const WEB_PORT = 5198;
const CDP_PORT = 9224;

let failures = 0;
const ok = (cond, what) => {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what); }
};

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function listenFree(srv, preferred) {
  const attempt = (port) => new Promise((res, rej) => {
    const onErr = (e) => { srv.removeListener('error', onErr); if (e.code === 'EADDRINUSE') res(attempt(freePort())); else rej(e); };
    srv.on('error', onErr);
    srv.listen(port, '127.0.0.1', () => res(srv.address().port));
  });
  return attempt(preferred);
}

function serveDist() {
  const srv = createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      const up = fetch(`http://127.0.0.1:${API_PORT}${req.url}`, {
        method: req.method, headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req, duplex: 'half',
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
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    createReadStream(p).pipe(res);
  });
  return listenFree(srv, WEB_PORT).then((port) => { srv.__port = port; return srv; });
}

async function cdpTargets() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return r.json();
}

async function connect(url) {
  /* Node 的 WebSocket 在「服务端连上了但一直不回握手」时既不 open 也不
     error —— promise 永远挂着。真实 CDP 不会这样，但超时必须有，否则
     探针会静默挂死（踩坑 29 同一条纪律：等不到要喊）。 */
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CDP 握手超时：' + url)), 8000);
    ws.onopen = () => { clearTimeout(timer); res(); };
    ws.onerror = (e) => { clearTimeout(timer); rej(e); };
  });
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

async function waitFor(page, expr, what, ms = 10000) {
  const src = expr.trim();
  const t0 = Date.now();
  for (;;) {
    const v = await evalJs(page, `return (${src});`);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等不到：' + what + '（最后看到 ' + JSON.stringify(v) + '）');
    await new Promise((r) => setTimeout(r, 120));
  }
}

/* 合成一次完整的鼠标按下→移动→抬起。走 CDP 的 Input 域，
   和探针主文件那套（dispatchEvent）不同 —— 这里要真的让 MouseSensor 起来。 */
async function drag(page, from, to, steps = 12) {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + (to.x - from.x) * i / steps;
    const y = from.y + (to.y - from.y) * i / steps;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' });
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
}

const procs = [];
const track = (p) => { procs.push(p); return p; };
const cleanup = () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (_) {} } };
process.on('exit', cleanup);

const dataDir = await import('node:fs').then((fs) => fs.mkdtempSync(path.join(tmpdir(), 'dayview-')));

try {
  track(spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: { ...process.env, PORT: String(API_PORT), SCHEDULE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const web = await serveDist();
  procs.push({ kill: () => { if (web.listening) web.close(); } });
  console.log(`\n端口：后端 ${API_PORT} · 页面 ${web.__port} · CDP ${CDP_PORT}`);

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${API_PORT}/api/health`)).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  track(spawn('/opt/google/chrome/chrome', [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(dataDir, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1280,860', 'about:blank',
  ], { stdio: 'ignore' }));

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try { target = (await cdpTargets()).find((t) => t.type === 'page'); } catch (_) {}
    if (!target) await new Promise((r) => setTimeout(r, 150));
  }
  const page = await connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');

  await page.send('Page.navigate', { url: `http://127.0.0.1:${web.__port}/` });

  /* 注册 + 登录 */
  await waitFor(page, `!!document.querySelector('form input')`, '登录表单');
  await evalJs(page, `
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => x.textContent.includes('注册一个'));
    if (b) b.click();
    return true;
  `);
  await new Promise((r) => setTimeout(r, 300));
  await evalJs(page, `
    const ins = document.querySelectorAll('form input');
    const [n, p] = ins;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(n, '爸爸'); n.dispatchEvent(new Event('input', { bubbles: true }));
    set.call(p, 'pw123456'); p.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('form').requestSubmit();
    return true;
  `);
  /* 进「日程」页再切日视图 —— 注册完落在「今天」列表页，
     `.day-panel` 只在 nav === 'calendar' 时渲染。 */
  await waitFor(page, `!!document.querySelector('[data-nav="calendar"]')`, '侧栏有日程入口', 10000);
  await evalJs(page, `document.querySelector('[data-nav="calendar"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[data-view="day"]')`, '视图切换出现', 10000);
  await evalJs(page, `document.querySelector('[data-view="day"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.day-panel')`, '日视图出现', 20000);
  await new Promise((r) => setTimeout(r, 1200));

  /* 用 UI 造任务，不写 localStorage —— 写库后一次 reload，同步引擎会用
     服务端快照把它盖掉（这正是「直接 setItem 造出来的卡片一条都不出现」的原因）。
     快速添加的自然语言认「9:00 标题」，回车即建。

     6 条未定时（`date` 有、`time` 空）：先给日期再清时间太绕，
     直接从**待办箱**的快速添加建「无日期」的也不行 —— 日视图根本不画待办箱的东西。
     这里走的是**日程页**的快速添加，它的 defaultDate 是 ui.cursor（今天），
     输「明天 未定时N」拿到有日期、无时间的任务。 */
  const typeAdd = async (text) => {
    await evalJs(page, `
      const inp = document.querySelector('.fast-add textarea');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(inp, ${JSON.stringify(text)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    `);
    await new Promise((r) => setTimeout(r, 350));
  };
  for (let i = 1; i <= 6; i++) await typeAdd('未定时' + i);
  await typeAdd('9:00 定时早');
  await typeAdd('21:00 定时晚');
  await waitFor(page, `
    (() => {
      const ts = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4') || '{}').tasks || {});
      return ts.length >= 8 ? 1 : null;
    })()
  `, '8 条任务落盘', 15000);
  /* 快速添加建出来的都是**今天**的（defaultDate = ui.cursor = 今天）。
     「未定时N」不带时间，就是未定时卡片；「9:00 定时早」是定时卡片。
     日视图看的就是 ui.cursor 这一天，刚才那些任务全在这儿。 */
  await page.send('Page.reload');
  await waitFor(page, `!!document.querySelector('.day-panel')`, '日视图出现', 15000);
  await new Promise((r) => setTimeout(r, 600));

  console.log('\n一、两种卡片共用一套组件与样式');
  const cls = await evalJs(page, `
    return {
      untimed: [...document.querySelectorAll('.task-el--untimed')].map((e) => e.className),
      timed: [...document.querySelectorAll('.task-el--timed')].map((e) => e.className),
      oldUntimed: document.querySelectorAll('.allday-items .task-pill').length,
      oldTimed: document.querySelectorAll('.tl-event').length,
    };
  `);
  ok(cls.untimed.length === 6, '6 张未定时卡片都带 .task-el--untimed，实际 ' + cls.untimed.length);
  ok(cls.timed.length === 2, '2 张定时卡片都带 .task-el--timed，实际 ' + cls.timed.length);
  ok(cls.oldUntimed === 0 && cls.oldTimed === 0, '旧类名 .task-pill / .tl-event 已无残留');
  ok(cls.untimed.every((c) => c.includes('task-el')) && cls.timed.every((c) => c.includes('task-el')),
    '两种卡片都带共用的 .task-el 基类');

  console.log('\n二、两个区同处 .day-panel 一个堆叠上下文，都不裁剪');
  const stack = await evalJs(page, `
    const panel = document.querySelector('.day-panel');
    const zone = document.querySelector('.allday-zone');
    const wrap = document.querySelector('.tl-wrap');
    const cs = (el) => el ? getComputedStyle(el) : null;
    return {
      panelIso: cs(panel).isolation,
      zonePos: cs(zone).position,
      zoneZ: cs(zone).zIndex,
      zoneOverflowY: cs(zone).overflowY,
      zoneOverflowX: cs(zone).overflowX,
      wrapPos: cs(wrap).position,
      wrapZ: cs(wrap).zIndex,
      wrapOverflowY: cs(wrap).overflowY,
      wrapOverflowX: cs(wrap).overflowX,
    };
  `);
  ok(stack.panelIso === 'isolate', '.day-panel 建了唯一一个堆叠上下文（isolation: isolate），实际 ' + stack.panelIso);
  ok(stack.zonePos !== 'relative' || stack.zoneZ === 'auto', '未定时区不再自己建堆叠上下文');
  ok(stack.wrapPos !== 'relative' || stack.wrapZ === 'auto', '时间轴区不再自己建堆叠上下文');
  ok(stack.zoneOverflowY === 'visible' && stack.zoneOverflowX === 'visible',
    `未定时区不裁剪（实际 y=${stack.zoneOverflowY} x=${stack.zoneOverflowX}）`);
  ok(stack.wrapOverflowY === 'visible' && stack.wrapOverflowX === 'visible',
    `时间轴区不裁剪（实际 y=${stack.wrapOverflowY} x=${stack.wrapOverflowX}）`);

  console.log('\n三、未定时网格：两行、第 3 个起三列、卡片上下各 1px');
  const grid = await evalJs(page, `
    const items = document.querySelector('.allday-items');
    const cards = [...items.querySelectorAll('.task-el--untimed')];
    const r = (el) => el.getBoundingClientRect();
    const rows = new Set(cards.map((c) => Math.round(r(c).top)));
    const cols = new Set(cards.map((c) => Math.round(r(c).left)));
    return {
      colsAttr: items.dataset.cols,
      cssVar: getComputedStyle(items).getPropertyValue('--cols').trim(),
      rowCount: rows.size,
      colCount: cols.size,
      cardH: Math.round(r(cards[0]).height),
      marginTop: getComputedStyle(cards[0]).marginTop,
      marginBottom: getComputedStyle(cards[0]).marginBottom,
      zoneH: Math.round(r(document.querySelector('.allday-zone')).height),
      tlH: Math.round(r(document.querySelector('.timeline')).height),
      // 时间轴上一小时的像素数（定时卡片高度就是按它算的）
      hourPx: Math.round(r(document.querySelector('.timeline')).height / 24),
    };
  `);
  ok(grid.colsAttr === '3' && grid.cssVar === '3', '6 个卡片时 --cols = 3，实际 attr=' + grid.colsAttr + ' var=' + grid.cssVar);
  ok(grid.rowCount === 2, '排成 2 行，实际 ' + grid.rowCount);
  ok(grid.colCount === 3, '排成 3 列，实际 ' + grid.colCount);
  ok(grid.marginTop === '1px' && grid.marginBottom === '1px',
    `卡片上下各 1px 边距，实际 top=${grid.marginTop} bottom=${grid.marginBottom}`);
  ok(grid.cardH === grid.hourPx - 2, `卡片高度 = 一小时 - 2px（边距吃掉），实际 ${grid.cardH} / ${grid.hourPx - 2}`);

  console.log('\n四、垂直拖动：卡片不被裁、不被另一个区挡');
  /* 定时卡片往上拖出 .tl-wrap 上沿 —— 这是「向上被分割线挡」的复现路径。
     抓卡片**正文**（.ev-head），不抓中间：1 小时高的卡片正中正好压在
     下沿那个拖拽把手上，抓到的是 resize 而不是拖动（实测过）。 */
  const grab = await evalJs(page, `
    const c = document.querySelector('.task-el--timed[data-id]');
    const r = c.getBoundingClientRect();
    const h = c.querySelector('.ev-head').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: h.top + h.height / 2, id: c.dataset.id };
  `);
  const overlap = await evalJs(page, `
    const tl = document.querySelector('.task-el--timed');
    const r = tl.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  `);
  // 往上拖 90px：定时卡片 9:00 在时间轴上部，往上会越过未定时区分界线
  await drag(page, { x: grab.x, y: grab.y }, { x: grab.x, y: Math.max(20, grab.y - 90) }, 15);
  await new Promise((r) => setTimeout(r, 400));
  const afterUp = await evalJs(page, `
    const c = document.querySelector('.task-el--timed');
    if (!c) return { gone: true };
    const r = c.getBoundingClientRect();
    const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
      .find((x) => x.id === c.dataset.id);
    return { top: r.top, bottom: r.bottom, height: r.height,
      time: c.textContent.trim().slice(0, 5), storeTime: t && t.time,
      toast: (document.body.innerText.match(/已改到 \\d{1,2}:\\d{2}/) || [null])[0] };
  `);
  ok(!afterUp.gone && afterUp.height > 0,
    `上拖后卡片还在且有高度（未被人为裁掉），实际 ${JSON.stringify(afterUp)}`);
  ok(!!afterUp.toast, `上拖后落库并提示「已改到 …」，实际 ${JSON.stringify(afterUp)}`);
  ok(afterUp.top !== undefined && Math.abs(afterUp.top - overlap.top) > 1,
    `上拖后位置真的变了（不是被挡回原地），${Math.round(overlap.top)} → ${Math.round(afterUp.top)}`);

  /* 未定时卡片往下拖进时间轴 */
  const un = await evalJs(page, `
    const c = document.querySelector('.task-el--untimed');
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  await drag(page, un, { x: un.x, y: un.y + 220 }, 15);
  await new Promise((r) => setTimeout(r, 400));
  const afterDown = await evalJs(page, `
    const cards = [...document.querySelectorAll('.task-el--untimed')];
    return {
      untimedCount: cards.length,
      // 拖下来的卡片：等引擎落库后它会变成定时卡片
      toast: (document.body.innerText.match(/已改到 \\d{1,2}:\\d{2}/) || [null])[0],
    };
  `);
  ok(!!afterDown.toast, '下拖到时间轴后弹出「已改到 …」提示，实际 ' + afterDown.toast);
  await new Promise((r) => setTimeout(r, 500));
  const settled = await evalJs(page, `
    return {
      untimed: document.querySelectorAll('.task-el--untimed').length,
      timed: document.querySelectorAll('.task-el--timed').length,
    };
  `);
  ok(settled.untimed === 5 && settled.timed === 3,
    `落库后未定时少一个、定时多一个，实际 untimed=${settled.untimed} timed=${settled.timed}`);

  console.log('\n五、水平方向也钳得住');
  const hx = await evalJs(page, `
    const c = document.querySelector('.task-el--untimed') || document.querySelector('.task-el--timed');
    const r = c.getBoundingClientRect();
    const p = document.querySelector('.day-panel').getBoundingClientRect();
    return { cardRight: r.right, panelRight: p.right, cardLeft: r.left, panelLeft: p.left };
  `);
  // 卡片停在网格/时间轴内即算钳住（不要求贴边，只要求不越界）
  ok(hx.cardLeft >= hx.panelLeft - 1 && hx.cardRight <= hx.panelRight + 1,
    `卡片没有漂到面板外，卡片 [${Math.round(hx.cardLeft)}, ${Math.round(hx.cardRight)}] vs 面板 [${Math.round(hx.panelLeft)}, ${Math.round(hx.panelRight)}]`);

  const errs = [];
  for (const e of page.events.splice(0)) {
    if (e.method === 'Runtime.exceptionThrown') errs.push(e.params.exceptionDetails?.text || 'exception');
    else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') errs.push(e.params.entry.text);
  }
  ok(errs.length === 0, '全程无 JS 报错' + (errs.length ? '：' + errs.join(' | ') : ''));
} catch (e) {
  console.error('\n探针本身跑挂了：', e.message);
  failures++;
} finally {
  cleanup();
  try { await import('node:fs').then((fs) => fs.rmSync(dataDir, { recursive: true, force: true })); } catch (_) {}
}

console.log('\n' + (failures ? `✗ ${failures} 项不通过` : '✓ 全部通过'));
process.exit(failures ? 1 : 0);

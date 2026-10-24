/**
 * card-geometry.mjs —— 三视图任务卡的「处处一样」量尺 + 触屏拖动/滚动分工
 *
 *   CHROME=/path/to/chrome node app/tests/card-geometry.mjs
 *
 * ## 盯的是哪几条约定
 *
 * 2026-10-24 五项反馈：
 *   ② 打勾圈左侧的间距（= 卡片左 padding + 左边框）三视图同值
 *   ③ 圆角由**卡片自己的短边**推出：radius ≈ 短边 × K，不写死像素档
 *   ④ 周视图表头（日期数字 / 圆圈 / 表头总高）在桌面与窄屏**两档同步**收小
 *   ⑤ 触屏长按拽起卡片后**只拖卡片**，承载区域不再跟着滑；不长按时区域照常滚
 *   ⑥ 卡片上不被文字选中 / 复制
 *
 * 同日第四轮（第三节）：
 *   ① 时间行的左端 = 标题**文字**的左端（不是卡片左边缘、不是勾选圈）
 *   ② 勾选圈直径 = 所在行字号 × CHECK_K（夹 CHECK_MIN~CHECK_MAX），且中心落在「标题 + 时间」那一整块的中线上
 *   ③ 时间行**只由时长决定**：> 60 分钟必须有且完整可见，≤ 60 分钟必须没有，月视图永远没有
 *
 * 同日第五轮（同一节，用户三项）：
 *   ① 时间行**完整显示**：`timeClip ≤ 0`（横向一点不被裁）
 *   ② **没有加长兜底**：卡上没有内联 `min-height`，卡高 = 按时长算出来的（CSS 地板另算）
 *   ③ 装不下只许压：`.ev-text` 的 scrollHeight 不得高出 `.ev-body` 的 clientHeight
 *      —— 与 TaskCard 的 `vFits` 同一口径，两边必须同绿同红
 *   ④ 圈比例放大：直径按新 K 断言（CHECK_K=1 / CHECK_MAX=18 与本文件的常量同步；
 *      `--check-k` / `--check-max` 那两条令牌读数在 browser-smoke 里钉）
 *
 * 与 browser-cards.mjs 一样是**完全隔离**的：临时后端 + 临时库 + 临时 Chrome profile。
 * 视口用 CDP 的 `Emulation.setDeviceMetricsOverride` 切，一趟量完桌面(1400)与窄屏(390)。
 *
 * 退出码非 0 = 约定不对。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/* dist 默认是本工程的构建产物；DIST 可以指到**别处的构建** ——
   ⑤ 那次就是靠这个把「autoScroll 开着」的临时构建拿来对照的 */
const DIST = process.env.DIST ? path.resolve(process.env.DIST) : path.join(ROOT, 'dist');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** 圆角公式的 K 与下限（改公式时这里同步改 —— 断言不写死像素） */
const RADIUS_K = 0.28;
const RADIUS_MIN = 2;
/** 允许的误差：半径比 0.03；左内边距 0.5px；两档表头高的差按比例 */
const TOL_RATIO = 0.03;
const TOL_PAD = 0.5;

/** 勾选圈：直径 = 所在行字号 × CHECK_K，夹在 CHECK_MIN / CHECK_MAX（与 tokens.css 同步）
 *  k = .85 → 1、上限 16 → 18（2026-10-24 第五轮，用户：「打勾太小了 比例再大一点」） */
const CHECK_K = 1;
const CHECK_MIN = 9;
const CHECK_MAX = 18;

/** ④ 周表头目标（桌面 / 窄屏）：日期字号、圆圈边长、表头总高上限 */
const WEEK_HEAD = {
  desktop: { dayFontMax: 14, circleMax: 23, headMax: 56 },
  narrow: { dayFontMax: 13, circleMax: 21, headMax: 48 },
};

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
const num = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));

/* ------------------------------------------------------------------ 端口 */

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
    /* ⚠️ 先给 URL 补 index.html，再 path.join（Windows 上 path.join 会把结尾 '/' 规范化） */
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
  /** 事件（无 id 的消息）也留给触摸那节用 */
  const eventHandlers = new Set();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { res, rej } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
    } else if (msg.method) {
      for (const h of eventHandlers) h(msg.method, msg.params);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    waiting.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return {
    send,
    onEvent: (fn) => eventHandlers.add(fn),
    close: () => ws.close(),
  };
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

async function dumpPage(page) {
  try {
    const info = await evalJs(page, `
      return {
        href: location.href, readyState: document.readyState,
        rootChildren: (document.querySelector('#root') || {}).childElementCount || 0,
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

const dataDir = mkdtempSync(path.join(tmpdir(), 'sched-geom-'));
const procs = [];
function track(p) { procs.push(p); return p; }
function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch (_) { /* 已经没了 */ } }
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (_) { /* /tmp 里留个目录无所谓 */ }
}
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page = null;
try {
  if (!existsSync(path.join(DIST, 'index.html'))) throw new Error('dist/ 还没构建 —— 先 `npm run build`');
  if (!existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME + '（可用 CHROME 环境变量指定）');

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
    await sleep(100);
  }

  track(spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(dataDir, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1440,940', 'about:blank',
  ], { stdio: 'ignore' }));

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch (_) { /* 还没起来 */ }
    if (!target) await sleep(150);
  }
  if (!target) throw new Error('Chrome 没开起来');

  page = await connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  try {
    await waitFor(page, `!!document.querySelector('#root')`, '应用外壳挂上');
  } catch (e) { await dumpPage(page); throw e; }

  /* 注册 + 造数据都走接口（与 browser-cards 同理：这里盯的是**版面与手势**，
     注册与快速添加由 browser-smoke 覆盖，少一步就少一处会坏的地方）。
     造**两条**：一条定时 2 小时（有 `.ev-time` 行）、一条未定（进未定时区）。 */
  const reg = await evalJs(page, `
    const r = await fetch('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '几何探针', password: 'geom-pw-123' }),
    });
    const j = await r.json();
    localStorage.setItem('schedule-app-token', j.token);
    localStorage.setItem('schedule-app-user', JSON.stringify(j.user));
    return { ok: r.ok, cal: j.user && j.user.name };
  `);
  if (!reg || !reg.ok) throw new Error('注册失败：' + JSON.stringify(reg));

  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  await waitFor(page, `!!document.querySelector('[data-nav="calendar"]')`, '登录后的外壳（有导航）', 15000);

  /* 新账户的 ui.cal / ui.cals 是空的（App 不自动勾集）—— 环境准备，不是被测行为 */
  /* 定时的一条要**跨时长档**造（2026-10-24 第四轮，规则「时长 > 60 分钟必须有时间行」）：
     120 / 90 / 75 / 61 是「必须有」，60 / 45 是「必须没有」。61 而不是 60+1 分钟以上
     的随便一条 —— 边界那一格最容易写错（`>` 写成 `>=` 就是整小时那档多出第二行）。
     时间都摆在 09:00–21:45 这段：默认时间窗是 0–24 整日，coverWindow 只往外让，
     所以加几条不会改动时间轴每小时的像素高（第一节那些数才不至于跟着漂）。 */
  const SEED_TIMED = [
    { id: 't_geom_timed', time: '09:00', duration: 120, title: '定时两小时' },
    { id: 't_geom_t90', time: '13:00', duration: 90, title: '定时九十分钟' },
    { id: 't_geom_t75', time: '15:00', duration: 75, title: '定时七十五分' },
    { id: 't_geom_t61', time: '17:00', duration: 61, title: '定时六十一分' },
    { id: 't_geom_t60', time: '19:00', duration: 60, title: '定时整一小时' },
    { id: 't_geom_t45', time: '21:00', duration: 45, title: '定时四十五分' },
    /* 30 分钟 = 压缩阶梯的**下限探针**（第五轮加的）：窄屏周视图这一档只有 ~11px，
       连「压到字号下限」都装不下。有它在，报告里才会出现「压到底还是装不下」这一行，
       而不是只报「全绿」。 */
    { id: 't_geom_t30', time: '11:00', duration: 30, title: '定时三十分' },
  ];
  const DUR = Object.fromEntries(SEED_TIMED.map((r) => [r.id, r.duration]));
  const seed = await evalJs(page, `
    const tok = localStorage.getItem('schedule-app-token');
    const me = await (await fetch('/api/me', { headers: { Authorization: 'Bearer ' + tok } })).json();
    const cal = me.cals[0];
    const d = new Date();
    const p2 = (n) => (n < 10 ? '0' + n : '' + n);
    const today = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    const none = { unit: 'none', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null };
    const rows = [
      ...${JSON.stringify(SEED_TIMED)},
      /* 未定的一条 + 二十五条：容器恒 3.2 行高，够多了才 overflow，
         「拖卡时区域滑不滑」这件事才有得测 */
      ...Array.from({ length: 25 }, (_, i) => (
        { id: 't_geom_untimed_' + i, time: null, duration: null, title: '未定时刻' + (i + 1) }
      )),
    ];
    const ts = Date.now();
    const ops = [];
    for (const row of rows) {
      const fields = {
        title: row.title, date: today, time: row.time, duration: row.duration,
        done: false, doneAt: null, repeat: none, seriesId: null, reminder: null, note: '',
      };
      for (const f of Object.keys(fields)) {
        ops.push({ opId: 'op-' + row.id + '-' + f, deviceId: 'geom-probe', ts,
                   entity: 'task', entityId: row.id, calId: cal.id, fields: { [f]: fields[f] } });
      }
    }
    const r = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ cursor: 1, ops }),
    });
    const j = await r.json();
    return { calId: cal.id, calName: cal.name, today, accepted: (j.applied || []).length, rejected: j.rejected || [] };
  `);
  if (!seed || seed.accepted < 22) throw new Error('造任务失败：' + JSON.stringify(seed));
  console.log('  已造任务：定时 ' + SEED_TIMED.map((r) => r.duration).join('/') + ' 分钟各一条'
    + ' + 未定 25 条（' + seed.today + '，日程集「' + seed.calName + '」）');

  /* 新账户的 ui.cal / ui.cals 是空的（App 不自动勾集）—— 环境准备，不是被测行为 */
  await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    st.ui.cal = ${JSON.stringify(seed.calId)};
    st.ui.cals = [${JSON.stringify(seed.calId)}];
    /* 只指归属的集与勾选：nav 不在这儿写 —— App 内存里那份会在落盘时盖回来
       （实测写 'calendar' 检出来是 'today'）。导航一律**点侧栏**。 */
    localStorage.setItem('schedule-app-v4', JSON.stringify(st));
    return true;
  `);

  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  await waitFor(page, `!!document.querySelector('[data-nav="calendar"]')`, '登录后的外壳（有导航）', 15000);

  /* ================= 一、三视图 × 两视口 的卡片几何 ================= */
  const measure = () => evalJs(page, `
    const box = (el) => {
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      const num = (s) => parseFloat(s) || 0;
      const check = el.querySelector('.check-btn');
      const title = el.querySelector('.ev-title, .pill-title');
      /* display:none 的元素 rect 全是 0 —— 窄屏月 pill 不画勾选圈，别把「没有」
         读成「偏到卡片左边 277px」 */
      const cb = check && check.getBoundingClientRect().width > 0 ? check.getBoundingClientRect() : null;
      const tb = title ? title.getBoundingClientRect() : null;
      return {
        cls: el.className,
        h: +b.height.toFixed(2), w: +b.width.toFixed(2), x: +b.left.toFixed(2),
        /* 月视图：胶囊挤在格子里，格子有多宽、标题实际能用多宽都要量 ——
           responsive.css 那段「一格能显示几个汉字」的注释全靠这两个数 */
        cellW: (() => { const c = el.closest('.month-cell'); return c ? +c.getBoundingClientRect().width.toFixed(2) : null; })(),
        titleW: tb ? +tb.width.toFixed(2) : null,
        padL: num(cs.paddingLeft), padR: num(cs.paddingRight),
        borderL: num(cs.borderLeftWidth),
        radius: num(cs.borderTopLeftRadius),
        /* 打勾圈左侧的间距：卡片**外**左边界到勾选圈**外**左边界 */
        checkGap: cb ? +(cb.left - b.left).toFixed(2) : null,
        titleGap: (cb && tb) ? +(tb.left - cb.right).toFixed(2) : null,
        fontSize: num(cs.fontSize),
        rXl: num(cs.getPropertyValue('--r-xl')),
        padX: cs.getPropertyValue('--card-pad-x').trim() || null,
        cardPx: cs.getPropertyValue('--card-px').trim() || null,
        row: cs.getPropertyValue('--row').trim() || null,
      };
    };
    const pick = (sel) => { const el = document.querySelector(sel); return el ? box(el) : null; };
    const head = document.querySelector('.week-head');
    const hb = head ? head.getBoundingClientRect() : null;
    const day = document.querySelector('.week-head-cell .wh-day');
    const cell = document.querySelector('.week-head-cell');
    return {
      timed: pick('.content .task-el--timed'),
      untimed: pick('.content .task-el--untimed'),
      pill: pick('.content .task-pill'),
      weekHead: hb ? +hb.height.toFixed(2) : null,
      whDayFont: day ? parseFloat(getComputedStyle(day).fontSize) : null,
      whDayW: day ? +day.getBoundingClientRect().width.toFixed(2) : null,
      whCellPad: cell ? getComputedStyle(cell).padding : null,
      narrow: matchMedia('(max-width: 720px)').matches,
    };
  `);

  /** 进日程页：宽屏点侧栏，窄屏侧栏不渲染、点底栏那一格（`.tab` 上没有 data-nav，只有文字） */
  const gotoCalendar = async () => {
    await evalJs(page, `
      const n = document.querySelector('[data-nav="calendar"]')
        || [...document.querySelectorAll('.tabbar .tab')].find((b) => /日程/.test(b.textContent));
      if (n) n.click();
      return !!n;
    `);
    await waitFor(page, `!!document.querySelector('.content-day, .content-month')`, '日程页');
  };

  /** 逐张卡的细节（第三节全靠它）：时间行在不在、在不在卡里、圈多大、圈中心对没对上文字块中心 */
  const measureDetail = () => evalJs(page, `
    const R = (el) => {
      const b = el.getBoundingClientRect();
      return { l: +b.left.toFixed(2), t: +b.top.toFixed(2), b: +b.bottom.toFixed(2),
               w: +b.width.toFixed(2), h: +b.height.toFixed(2) };
    };
    const one = (el) => {
      const title = el.querySelector('.ev-title');
      const time = el.querySelector('.ev-time');
      const note = el.querySelector('.ev-note');
      const check = el.querySelector('.check-btn');
      const text = el.querySelector('.ev-text');
      const cb = check ? R(check) : null;
      const tb = title ? R(title) : null;
      const mr = time ? R(time) : null;
      const nr = note ? R(note) : null;
      const texts = [tb, mr, nr].filter(Boolean);
      const body = el.querySelector('.ev-body');
      return {
        id: el.getAttribute('data-id'),
        card: R(el),
        titleFs: title ? +parseFloat(getComputedStyle(title).fontSize).toFixed(2) : null,
        timeFs: time ? +parseFloat(getComputedStyle(time).fontSize).toFixed(2) : null,
        /* display:none 与「没有这个元素」是两件事：前者是 CSS 藏掉了，后者是没渲染 */
        timeDisplay: time ? getComputedStyle(time).display : null,
        timeText: time ? (time.textContent || '').trim() : null,
        /* **横向有没有被裁**：scrollWidth 大于 clientWidth 就是文字超出可用宽，
           CSS 的 text-overflow 会把尾巴换成省略号 —— 用户看到的「时间显示不全」。
           只读 DOM 属性，不靠猜 CSS。（这段跑在浏览器里，注释里不能出现反引号） */
        timeClip: time ? Math.round(time.scrollWidth - time.clientWidth) : null,
        titleClip: title ? Math.round(title.scrollWidth - title.clientWidth) : null,
        timeW: time ? +time.clientWidth.toFixed(2) : null,
        timeAvail: time ? +time.parentElement.clientWidth.toFixed(2) : null,
        /* **纵向有没有溢出**读的是**文字块自己**（ev-text）而不是 ev-body：
           勾选圈那块 24×24 命中区（靠 ::before 撑）是**故意**超出矮卡的（WCAG 2.5.8），
           把它算进 scrollHeight 会让每一张矮卡都「溢出」—— 第一版就是这么误报的。
           判据：文字块自己的内容高 ≤ 内容层可用高。 */
        bodyCH: body ? body.clientHeight : null,
        textCH: text ? text.clientHeight : null,
        textSH: text ? text.scrollHeight : null,
        /* 卡片自身的 CSS 地板（calendar.css 给定时卡写的 min-height: 12px）。
           它是**旧的**、不是压缩阶梯给的：30 分钟的卡在窄屏只有 9.5px，
           这条把它顶到 12px。报出来，别让它藏在「卡高 = 时长」这条断言背后。 */
        cssMinH: (function () {
          const x = parseFloat(getComputedStyle(el).minHeight);
          return Number.isFinite(x) ? x : 0;
        })(),
        titleH: title ? +title.getBoundingClientRect().height.toFixed(2) : null,
        timeH: time ? +time.getBoundingClientRect().height.toFixed(2) : null,
        titleLh: title ? getComputedStyle(title).lineHeight : null,
        timeLh: time ? getComputedStyle(time).lineHeight : null,
        hourPx: (function () {
          /* --row-hour 是 DayView / WeekView 写在**未定时容器**上的内联值
             （:root 上没有这条，从 documentElement 读恒 0 —— 上一轮就误读成 0.00）。
             定时卡不在那个容器里（它站在时间轴上），所以要退到页面上找那一个容器：
             「这一屏上的一小时」是整屏一个数，不是每张卡一个数。 */
          const host = el.closest('.allday-zone') || el.closest('.wun-cell')
            || document.querySelector('.allday-zone') || document.querySelector('.wun-cell');
          if (!host) return null;
          const x = parseFloat(getComputedStyle(host).getPropertyValue('--row-hour'));
          return Number.isFinite(x) ? +x.toFixed(2) : null;
        })(),
        /* **压缩阶梯落在第几档**（0 = 宽松）。判据在 TaskCard 的 useCardFit，
           这里只报读数：哪一屏需要压到第几档，是要能看见的 */
        fit: el.getAttribute('data-fit') || null,
        /* TimedCard 报给圆角算式的那个数 = 这张卡按时长该有的高（百分比 × 容器实高 − 缝）。
           渲染高与它不等 = 有人偷偷给卡加长了（第五轮撤掉的正是这个） */
        cardPx: (function () {
          const x = parseFloat(getComputedStyle(el).getPropertyValue('--card-px'));
          return Number.isFinite(x) ? +x.toFixed(2) : null;
        })(),
        titleL: tb ? tb.l : null, timeL: mr ? mr.l : null,
        timeTop: mr ? mr.t : null, timeBottom: mr ? mr.b : null,
        checkW: cb ? cb.w : null,
        checkCy: cb ? +(cb.t + cb.h / 2).toFixed(2) : null,
        textTop: texts.length ? Math.min(...texts.map((x) => x.t)) : null,
        textBottom: texts.length ? Math.max(...texts.map((x) => x.b)) : null,
        bodyAlign: body ? getComputedStyle(body).alignContent : null,
        titleMaxH: title ? (title.style.maxHeight || null) : null,
        minHeight: el.style.minHeight || null,
      };
    };
    return {
      timed: [...document.querySelectorAll('.content .task-el--timed')].map(one),
      untimed: [...document.querySelectorAll('.content .task-el--untimed')].map(one),
      pills: [...document.querySelectorAll('.content .task-pill')].map((el) => {
        const c = el.querySelector('.check-btn');
        const cb = c ? c.getBoundingClientRect() : null;
        const t = el.querySelector('.pill-title');
        return {
          id: el.getAttribute('data-id'),
          untimed: el.getAttribute('data-untimed') === '1',
          hasTimeEl: !!el.querySelector('.pill-time, .ev-time'),
          tip: el.getAttribute('title') || '',
          checkW: cb && cb.width > 0 ? +cb.width.toFixed(2) : null,
          titleFs: t ? +parseFloat(getComputedStyle(t).fontSize).toFixed(2) : null,
        };
      }),
      /* 全页扫一遍：「.pill-time」这个元素现在**根本不该存在**（CompactCard 不画）
         —— 注意这段跑在浏览器里，注释里不能出现反引号（会把外层模板截断） */
      pillTimeEls: document.querySelectorAll('.pill-time').length,
      evTimeEls: document.querySelectorAll('.ev-time').length,
    };
  `);

  const VIEWPORTS = [
    { name: '桌面 1400', w: 1400, h: 900, mobile: false },
    { name: '窄屏 390', w: 390, h: 844, mobile: true },
  ];
  const VIEWS = ['day', 'week', 'month'];
  const table = {};
  /** 逐张卡的读数（第三节用），与 table 同一套 key */
  const detail = {};

  for (const vp of VIEWPORTS) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w, height: vp.h, deviceScaleFactor: vp.mobile ? 2 : 1, mobile: vp.mobile,
    });
    /* matchMedia 变了要靠一次重载让 React 的 narrow 分支重算 */
    await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
    try { await waitFor(page, `!!document.querySelector('.main')`, vp.name + ' 外壳', 15000); }
    catch (err) {
      const dbg = await evalJs(page, `
        return { href: location.href, ready: document.readyState,
                 rootChildren: (document.querySelector('#root') || {}).childElementCount,
                 navs: [...document.querySelectorAll('[data-nav]')].map((e) => e.getAttribute('data-nav')),
                 tabs: [...document.querySelectorAll('.tabs, .tabbar, .bottom-tabs')].map((e) => e.className),
                 bodyStart: document.body ? document.body.innerHTML.slice(0, 300) : null };
      `);
      console.error('  [诊断] ' + JSON.stringify(dbg, null, 1)); throw err;
    }

    await gotoCalendar();

    for (const view of VIEWS) {
      await evalJs(page, `
        const b = document.querySelector('.view-switch [data-view="${view}"]');
        if (b) b.click();
        return true;
      `);
      const marker = view === 'month' ? `.content-month` : `.content-day`;
      try { await waitFor(page, `!!document.querySelector('${marker}')`, vp.name + ' / ' + view + ' 视图'); }
      catch (err) {
        const dbg = await evalJs(page, `
          const st = JSON.parse(localStorage.getItem('schedule-app-v4') || 'null');
          return { ui: st && st.ui, contentCls: [...document.querySelectorAll('.content')].map((e) => e.className),
                   views: [...document.querySelectorAll('.view-switch button')].map((b) => b.className + '/' + b.textContent),
                   navs: [...document.querySelectorAll('[data-nav]')].map((e) => e.getAttribute('data-nav')),
                   taskEls: document.querySelectorAll('.task-el').length };
        `);
        console.error('  [诊断] ' + JSON.stringify(dbg, null, 1)); throw err;
      }
      /* 卡片几何在 JS 量完容器高度后才落定（--row-hour / --card-px），多等一拍 */
      await sleep(450);
      const key = vp.name + ' / ' + view;
      table[key] = await measure();
      detail[key] = await measureDetail();
    }
  }

  console.log('\n一、卡片几何（radius = 短边 × ' + RADIUS_K + '，下限 ' + RADIUS_MIN + 'px）');
  for (const [key, m] of Object.entries(table)) {
    console.log('\n  ' + key);
    for (const kind of ['timed', 'untimed', 'pill']) {
      const c = m[kind];
      if (!c) { console.log('    --   ' + kind + '：这一屏没有'); continue; }
      const short = Math.min(c.h, c.w);
      console.log('    ' + kind.padEnd(7) + ' h=' + num(c.h) + ' w=' + num(c.w)
        + ' x=' + num(c.x) + ' 左padding=' + num(c.padL) + ' 右=' + num(c.padR)
        + ' 圆角=' + num(c.radius) + '（短边 ' + num(short) + ' → 比 ' + (c.radius / short).toFixed(3) + '）'
        + ' 勾左间距=' + num(c.checkGap) + ' 勾→标题=' + num(c.titleGap));
      if (c.cellW != null) {
        console.log('           格子宽=' + num(c.cellW) + ' 标题可用宽=' + num(c.titleW)
          + '（卡 ' + num(c.w) + ' − 左右 padding ' + num(c.padL) + '/' + num(c.padR)
          + ' − 边框 ' + num(c.borderL) + '×2）');
      }
    }
    if (m.weekHead != null) {
      console.log('    表头 高=' + num(m.weekHead) + ' 日期字号=' + num(m.whDayFont)
        + ' 圆圈=' + num(m.whDayW) + ' padding=' + m.whCellPad);
    }
  }

  /* ---- 断言：三视图同值 + 圆角走短边 ---- */
  console.log('\n二、断言：打勾左侧间距、圆角公式');
  for (const [key, m] of Object.entries(table)) {
    const cards = ['timed', 'untimed', 'pill'].map((k) => m[k]).filter(Boolean);
    if (!cards.length) continue;

    for (const c of cards) {
      const short = Math.min(c.h, c.w);
      /* 公式：min(--r-xl, max(下限, 短边 × K)) —— 上限走风格档，flat 档全是 0 */
      const want = Math.min(c.rXl, Math.max(RADIUS_MIN, short * RADIUS_K));
      ok(Math.abs(c.radius - want) <= 0.6,
        key + ' ' + c.cls.split(' ')[0] + ' 圆角 ' + num(c.radius)
        + ' = 短边 ' + num(short) + ' × ' + RADIUS_K + ' 夹在 ' + RADIUS_MIN + '~' + c.rXl
        + '（want ' + want.toFixed(2) + '）');
    }
    /* 月胶囊不许溢出格子，而且标题要真剩得下字（窄屏 5 个汉字是硬约束） */
    for (const c of cards.filter((k) => k.cellW != null)) {
      ok(c.w <= c.cellW + 0.5, key + ' 胶囊 ' + num(c.w) + ' 不溢出格子 ' + num(c.cellW));
      /* narrow 是这一屏的属性（在 m 上），不在单张卡上 —— 写成 c.narrow 会恒 undefined，
         于是窄屏也被拿桌面的 60 去量，红得指错地方 */
      const minTitle = m.narrow ? 40 : 60;
      ok(c.titleW >= minTitle, key + ' 标题可用宽 ' + num(c.titleW) + ' ≥ ' + minTitle
        + (m.narrow ? '（窄屏要装得下 5 个汉字）' : ''));
    }
    /* 打勾左侧间距：同一屏上所有卡一致（窄屏月 pill 没有勾选圈 → 不参与） */
    const gaps = cards.filter((c) => c.checkGap != null);
    if (gaps.length >= 2) {
      const base = gaps[0].checkGap;
      for (const c of gaps.slice(1)) {
        ok(Math.abs(c.checkGap - base) <= TOL_PAD,
          key + ' 勾选圈左侧间距一致：' + num(base) + ' vs ' + num(c.checkGap)
          + '（' + c.cls.split(' ')[0] + '）');
      }
    }
  }

  console.log('\n三、断言：时间行只由时长决定 · 圈径跟字号走 · 文字左对齐 · 圈跨行居中 · 装不下只压不加');
  console.log('    规则（2026-10-24 第四轮用户定）：时长 > 60 分钟 → 时间行**必须有**且完整在卡里；'
    + '≤ 60 分钟 → 必须没有；月视图**永远**没有');
  console.log('    第五轮补三条：时间行还要**完整可见**（横向不裁）、内容不许被纵向剪、'
    + '卡高只由时长定（**没有 min-height 加长兜底**）；圈径 = 字号 × ' + CHECK_K);
  for (const [key, d] of Object.entries(detail)) {
    if (key.indexOf('month') >= 0) {
      /* 月视图只查两件事：**不画时间**，而且时间没丢（挂在气泡上） */
      ok(d.pillTimeEls === 0, '  ' + key + ' 没有 .pill-time 元素（全页扫到 ' + d.pillTimeEls + ' 个）');
      ok(d.evTimeEls === 0, '  ' + key + ' 没有 .ev-time 元素（全页扫到 ' + d.evTimeEls + ' 个）');
      ok(d.pills.length >= 1, '  ' + key + ' 这一屏有 ' + d.pills.length + ' 条胶囊可量');
      for (const p of d.pills.filter((x) => !x.untimed)) {
        ok(/\d{1,2}:\d{2}/.test(p.tip), '  ' + key + ' 定时胶囊的时间在气泡里：「' + p.tip + '」');
      }
      for (const p of d.pills.filter((x) => x.checkW != null)) {
        ok(p.checkW <= p.titleFs + 0.5, '  ' + key + ' 胶囊圈 ' + num(p.checkW)
          + ' ≤ 标题字号 ' + num(p.titleFs) + '（不比文字大）');
      }
      continue;
    }
    const rows = [...d.timed, ...d.untimed];
    if (!rows.length) { console.log('  ' + key + '：这一屏没有卡'); continue; }
    console.log('\n  ' + key);
    for (const c of rows) {
      const dur = DUR[c.id];
      const label = (dur != null ? dur + ' 分钟 ' : '未定时 ') + c.id;
      const has = c.timeText != null && c.timeDisplay !== 'none';
      const mid = (c.textTop + c.textBottom) / 2;
      const centerDiff = c.checkCy != null ? +(c.checkCy - mid).toFixed(2) : null;
      const alignDiff = (c.timeL != null && c.titleL != null) ? +(c.timeL - c.titleL).toFixed(2) : null;
      /* 只有定时卡的「应高」算得出来（未定时卡的高度走 --row，:root 那条 --card-px=20px
         是它的默认值、不是这张卡的算式 —— 拿它当应高会误报） */
      const floor = dur != null && c.cardPx != null ? Math.max(c.cardPx, c.cssMinH || 0) : null;
      console.log('    ' + label.padEnd(20) + ' 卡高=' + num(c.card.h)
        + (c.cardPx != null
          ? '/按时长应高 ' + num(c.cardPx) + (c.cssMinH > c.cardPx ? '（CSS 地板 ' + c.cssMinH + 'px 顶的）' : '')
          : '')
        + (c.minHeight ? '（❌ 被加长到 ' + c.minHeight + '）' : '')
        + ' 档=' + (c.fit == null ? '?' : c.fit)
        + ' 标题字号=' + num(c.titleFs) + ' 圈=' + num(c.checkW)
        + ' 时间行=' + (has ? '「' + c.timeText + '」fs=' + num(c.timeFs) : '无')
        + (has ? ' 裁=' + num(c.timeClip) + 'px 文字宽=' + num(c.timeW) + '/可用 ' + num(c.timeAvail) : '')
        + ' 标题裁=' + num(c.titleClip)
        + ' 文字 ' + num(c.textSH) + '/可用 ' + num(c.bodyCH)
        + ' 左端差=' + num(alignDiff) + ' 中心差=' + num(centerDiff)
        + ' 一小时=' + num(c.hourPx) + 'px'
        + ' align-content=' + c.bodyAlign);

      /* ③ 时间行：只由时长决定 */
      if (dur != null) {
        const want = dur > 60;
        ok(has === want, '    ' + label + ' 时间行' + (want ? '必须显示' : '必须不显示')
          + '，实际' + (has ? '显示「' + c.timeText + '」' : '没显示')
          + (c.timeText && !want ? '（元素在但…）' : ''));
        if (want) {
          ok(c.timeTop >= c.card.t - 0.5 && c.timeBottom <= c.card.b + 0.5,
            '    ' + label + ' 时间行完整在卡里（行 ' + num(c.timeTop) + '~' + num(c.timeBottom)
            + '，卡 ' + num(c.card.t) + '~' + num(c.card.b) + '）');
          /* ① 左对齐：时间行左端 == 标题**文字**左端（不是卡片左边缘、不是勾选圈） */
          ok(Math.abs(alignDiff) <= 0.5,
            '    ' + label + ' 时间行与标题文字左端对齐（差 ' + num(alignDiff) + 'px）');
          /* ④ 第五轮：整条时间**完整可见** —— scrollWidth 大于 clientWidth 就是尾巴
             被省略号吃掉了，用户报的「周视图时间显示不全」就是这个数（实测 13px） */
          ok(c.timeClip <= 0,
            '    ' + label + ' 时间行没被横向裁（裁 ' + num(c.timeClip) + 'px，文字 '
            + num(c.timeW) + ' / 可用 ' + num(c.timeAvail) + '）');
        }
        /* ④ 第五轮：内容不许被纵向剪（.ev-body 是 overflow hidden，行照排 ——
           行的矩形在卡里不等于没被剪，文字块自己的 scrollHeight > 可用高才是真装不下） */
        ok(c.textSH == null || c.textSH <= c.bodyCH + 0.5,
          '    ' + label + ' 文字没被纵向剪（文字 ' + num(c.textSH) + ' ≤ 可用 ' + num(c.bodyCH) + '）');
        /* ④ 第五轮：**没有加长兜底** —— 卡高只由时长定（用户：「没有什么地方有给卡片
           加长的兜底」）。上一轮的 min-height 让 61 分钟的卡画到 28.25px（一小时 ~22px），
           等于把时长画长了。这条断言锁的是「不许再加回来」。
           ⚠️ 唯一的例外是 CSS 那条旧的 `min-height: 12px`（`.task-el--timed`）：
           它比压缩阶梯老，作用是「比手指还短的卡总得能点着」。断言把它算进应高里，
           并在打印里点名（30 分钟卡在窄屏就靠它）。 */
        ok(c.minHeight == null, '    ' + label + ' 卡上没有内联 min-height（加长兜底已撤，实际 '
          + c.minHeight + '）');
        if (floor != null) {
          ok(Math.abs(c.card.h - floor) <= 2.0,
            '    ' + label + ' 卡高 ' + num(c.card.h) + ' = 按时长算出来的 ' + num(c.cardPx)
            + (c.cssMinH > c.cardPx ? '（CSS 地板 ' + c.cssMinH + 'px）' : '')
            + '（差 ' + num(+(c.card.h - floor).toFixed(2)) + 'px）');
        }
      } else {
        ok(!has, '    ' + label + ' 未定时卡没有时间行');
      }

      /* ② 圈径 = 标题字号 × --check-k，夹在 --check-min / --check-max 之间，不比文字大 */
      const want2 = Math.min(CHECK_MAX, Math.max(CHECK_MIN, c.titleFs * CHECK_K));
      ok(c.checkW != null && Math.abs(c.checkW - want2) <= 0.6,
        '    ' + label + ' 圈径 ' + num(c.checkW) + ' = 字号 ' + num(c.titleFs) + ' × ' + CHECK_K
        + ' 夹在 ' + CHECK_MIN + '~' + CHECK_MAX + '（want ' + want2.toFixed(2) + '）');
      ok(c.checkW != null && c.checkW <= c.titleFs + 0.5,
        '    ' + label + ' 圈不比任务名大（圈 ' + num(c.checkW) + ' ≤ 字号 ' + num(c.titleFs) + '）');
      /* ② 圈中心 = 「标题 + 时间（+ 摘要）」那一整块的中心（跨行居中，不是只跟第一行） */
      ok(centerDiff != null && Math.abs(centerDiff) <= 1,
        '    ' + label + ' 圈中心与文字块中心差 ' + num(centerDiff) + 'px（圈跨满所有行）');
      /* 内容层那一条 align-content 要真的生效：写坏了浏览器会退回 normal（=拉伸），
         中心与「居中」这件事就都没了 —— 上面那条中心差会一起红，但这条指得更准 */
      ok(String(c.bodyAlign).indexOf('center') >= 0,
        '    ' + label + ' 内容层 align-content=' + c.bodyAlign + '（不是退回 normal）');
    }
  }

  console.log('\n四、断言：周视图表头两档同步收小');
  for (const [key, m] of Object.entries(table)) {
    if (key.indexOf('week') < 0 || m.weekHead == null) continue;
    const want = m.narrow ? WEEK_HEAD.narrow : WEEK_HEAD.desktop;
    ok(m.whDayFont <= want.dayFontMax, key + ' 日期字号 ' + num(m.whDayFont) + ' ≤ ' + want.dayFontMax);
    ok(m.whDayW <= want.circleMax, key + ' 日期圆圈 ' + num(m.whDayW) + ' ≤ ' + want.circleMax);
    ok(m.weekHead <= want.headMax, key + ' 表头总高 ' + num(m.weekHead) + ' ≤ ' + want.headMax);
  }

  /* ============ 五、触屏：长按拽起卡片后只拖卡片，区域不跟着滑 ============ */
  console.log('\n五、断言：长按拽起 → 只拖卡片；不长按 → 区域照常滚');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  await waitFor(page, `!!document.querySelector('.main')`, '触摸档外壳', 15000);
  await gotoCalendar();
  await evalJs(page, `
    const b = document.querySelector('.view-switch [data-view="day"]');
    if (b) b.click();
    return true;
  `);
  await waitFor(page, `!!document.querySelector('.content-day')`, '日视图（触摸档）');
  await sleep(450);

  /* 未定时区放不下时才有滚动余地：临时把它的 scrollTop 推一格看它滚不滚得动 */
  const scrollable = await evalJs(page, `
    const z = document.querySelector('.allday-zone') || document.querySelector('.wun-cell');
    if (!z) return null;
    z.scrollTop = 40;
    return { cls: z.className, scrollTop: z.scrollTop, scrollH: z.scrollHeight, clientH: z.clientHeight };
  `);
  console.log('    未定时区：' + JSON.stringify(scrollable));

  /* 手指事件走 CDP 的 Input.dispatchTouchEvent（不是 DOM 合成事件 —— 合成事件
     不产生默认滚动行为，那样测不出「区域跟着滑」） */
  const touch = async (type, x, y) => {
    await page.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
    });
  };

  const dragCard = async (holdMs, movePx) => {
    const start = await evalJs(page, `
      const z = document.querySelector('.allday-zone') || document.querySelector('.wun-cell');
      const el = z && z.querySelector('.task-el--untimed');
      if (!el) return null;
      /* 起点一律归零再量：拖拽中容器会切 overflow: visible（见 .allday-zone:has），
         那时 scrollTop 自己会回 0 —— 起点不归零就分不清「谁把它推走的」 */
      const c = document.querySelector('.content');
      z.scrollTop = 0;
      if (c) c.scrollTop = 0;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
               zoneTop: z.scrollTop, contentTop: c ? c.scrollTop : 0, pageTop: 0 };
    `);
    if (!start) return null;
    await touch('touchStart', start.x, start.y);
    await sleep(holdMs);
    /* 按住后再挪：一次一小步，模拟「拽起来再拖动」 */
    for (let i = 1; i <= 4; i++) {
      await touch('touchMove', start.x, start.y + (movePx * i) / 4);
      await sleep(40);
    }
    const state = await evalJs(page, `
      const z = document.querySelector('.allday-zone') || document.querySelector('.wun-cell');
      const c = document.querySelector('.content');
      const dragged = document.querySelector('.task-el.dragging');
      return {
        dragging: !!dragged,
        scrollTop: z ? z.scrollTop : null,
        /* 拖拽中那一区切 overflow: visible（.allday-zone:has(.task-el.dragging)），
           此时「整个区域在滑」只会出现在外层容器 / 文档上，所以两层都看 */
        contentTop: c ? c.scrollTop : null,
        pageTop: document.scrollingElement ? document.scrollingElement.scrollTop : null,
        selection: String(window.getSelection() || '').length,
      };
    `);
    await touch('touchEnd', start.x, start.y + movePx);
    await sleep(150);
    await evalJs(page, `return true;`);
    return { ...state, startTop: start.zoneTop, startContent: start.contentTop, startPage: start.pageTop };
  };

  /* 先照现状跑一遍长的（超过当前 480ms 阈值）：卡片被拽起之后区域到底滑不滑，
     这条是「根因是 dnd-kit 自带的 autoScroll」还是「只是 preventDefault 没生效」的分水岭 */
  /* 拖得久一点、挪得多一点：dnd-kit 的 AutoScroll 是按 interval 跑的，
     小幅挪动不一定触发，挪 200px / 1.2s 才够它出手（关掉之后应当一层都不滚） */
  const diag = await dragCard(560, 200);
  console.log('    [体检] 按住 560ms 再挪 200px：dragging=' + (diag && diag.dragging)
    + ' 未定时区 ' + (diag && diag.startTop) + ' → ' + (diag && diag.scrollTop)
    + ' / .content ' + (diag && diag.startContent) + ' → ' + (diag && diag.contentTop)
    + ' / 文档 ' + (diag && diag.startPage) + ' → ' + (diag && diag.pageTop));

  /* 机制层的证据：dnd-kit 只在**开拖之后** preventDefault（delay 窗口里直接 return）。
     我们的记录器挂在 document 的**冒泡**阶段 —— dnd-kit 的监听挂在卡片元素自己上
     （target 阶段更早），所以到这里时 preventDefault 该发生的发生完了。
     「开拖之后的每个 touchmove 都被拦下」= 浏览器不会再滚这一区；
     「开拖之前一个都不拦」= 不长按时区域照常滚得动。这两半都得在。 */
  await evalJs(page, `
    window.__tm = { pre: 0, prePrevented: 0, post: 0, postPrevented: 0 };
    document.addEventListener('touchmove', (e) => {
      const k = document.querySelector('.task-el.dragging') ? 'post' : 'pre';
      window.__tm[k] += 1;
      if (e.defaultPrevented) window.__tm[k + 'Prevented'] += 1;
    }, { passive: true });
    return true;
  `);

  /* A. 长按到位（> 阈值）→ 卡片被拽起，未定时区没跟着滑 */
  await evalJs(page, `window.__tm = { pre: 0, prePrevented: 0, post: 0, postPrevented: 0 }; return true;`);
  const held = await dragCard(380, 60);
  const tmHeld = await evalJs(page, `return window.__tm;`);
  console.log('    [机制] 长按 380ms 那趟：开拖前 touchmove ' + tmHeld.pre + '（拦下 ' + tmHeld.prePrevented
    + '）/ 开拖后 ' + tmHeld.post + '（拦下 ' + tmHeld.postPrevented + '）');
  ok(held && held.dragging, '长按 380ms 后卡片进入拖拽态');
  ok(tmHeld.post > 0 && tmHeld.postPrevented === tmHeld.post,
    '开拖之后的每个 touchmove 都被 preventDefault（' + tmHeld.postPrevented + '/' + tmHeld.post + '）');
  /* 这一条抓的是 **dnd-kit 自己代为滚动**（AutoScroll 调 scrollBy，是 JS 写的
     scrollTop，无头环境里也看得见）。原生触摸滚动在合成事件下不发生，归上面那两条机制断言。 */
  ok(held && held.contentTop === held.startContent && held.pageTop === held.startPage,
    '拖卡期间外层也没滚（.content ' + held?.startContent + ' → ' + held?.contentTop
    + '，文档 ' + held?.startPage + ' → ' + held?.pageTop + '）');
  ok(held && held.scrollTop === held.startTop,
    '拖卡期间没有谁替未定时区滚（scrollTop ' + held?.startTop + ' → ' + held?.scrollTop + '）');
  ok(held && held.selection === 0, '拖卡期间没有被选中的文字');

  const short = await dragCard(200, 60);
  ok(short && !short.dragging, '按住 200ms（阈值以下）不进入拖拽态 —— 300ms 这条线在');

  /* B. 不按长按、直接快速划 → 不拖卡，区域该滚（这是「让给滚动」那一半，不许被修没） */
  await evalJs(page, `window.__tm = { pre: 0, prePrevented: 0, post: 0, postPrevented: 0 }; return true;`);
  const quick = await dragCard(60, 60);
  const tmQuick = await evalJs(page, `return window.__tm;`);
  console.log('    [机制] 快速划那趟：开拖前 touchmove ' + tmQuick.pre + '（拦下 ' + tmQuick.prePrevented + '）');
  ok(quick && !quick.dragging, '不按长按（60ms）不进入拖拽态');
  /* 无头 Chrome 的合成触摸不会真的驱动原生滚动，所以「区域滚了」这一半
     只能从机制上断言：没开拖 ⇒ 没有任何一个 touchmove 被拦下 ⇒ 浏览器自己滚。
     真机上的那一半手工走（见 docs/测试.md）。 */
  ok(tmQuick.pre > 0 && tmQuick.prePrevented === 0,
    '不长按时没有一个 touchmove 被拦（' + tmQuick.pre + ' 个全放行）= 区域滚得动');

  /* ============ 六、列表里拖一行：整页不许跟着滑 ============
     列表（今天 / 待办箱）这一路的滚动容器是 **.content**（不是文档，也不是
     某个 :has() 切成 overflow: visible 的时间轴格）—— 库的 AutoScroll
     在这里**有东西可以滚**，所以这一段单独测。 */
  console.log('\\n六、断言：列表里拖一行，整页不跟着滑');
  await evalJs(page, `
    const n = document.querySelector('[data-nav="today"]')
      || [...document.querySelectorAll('.tabbar .tab')].find((b) => /今天/.test(b.textContent));
    if (n) n.click();
    return true;
  `);
  await waitFor(page, `!!document.querySelector('.list-view .task-row')`, '今天列表');
  await sleep(300);

  /* 通用「哪个祖先能滚」探针：拖之前之后各量一次，比对 scrollTop */
  const scrollables = () => evalJs(page, `
    const row = document.querySelector('.list-view .task-row');
    if (!row) return [];
    const out = [];
    let n = row;
    while (n) {
      if (n.scrollHeight > n.clientHeight + 8) {
        out.push({ 名: n.className || n.tagName, 顶: n.scrollTop, 高: n.scrollHeight, 视: n.clientHeight });
      }
      n = n.parentElement;
    }
    const se = document.scrollingElement;
    if (se && se.scrollHeight > se.clientHeight + 8) {
      out.push({ 名: 'scrollingElement', 顶: se.scrollTop, 高: se.scrollHeight, 视: se.clientHeight });
    }
    return out;
  `);

  /* 先把页面滚到中段：AutoScroll 只在**靠近边缘**的阈值区出手，
     停在 0 时它往下滚、滚到顶时它往上滚 —— 起点留中间才两头都测得到 */
  const pre = await evalJs(page, `
    const row = document.querySelector('.list-view .task-row');
    let n = row;
    while (n && !(n.scrollHeight > n.clientHeight + 8)) n = n.parentElement;
    if (!n) return null;
    n.scrollTop = Math.round((n.scrollHeight - n.clientHeight) / 2);
    return { 名: n.className || n.tagName, 顶: n.scrollTop };
  `);
  console.log('    滚动容器：' + JSON.stringify(pre));
  const before = await scrollables();

  const rowStart = await evalJs(page, `
    const scroller = (() => {
      let n = document.querySelector('.list-view .task-row');
      while (n && !(n.scrollHeight > n.clientHeight + 8)) n = n.parentElement;
      return n;
    })();
    const rows = [...document.querySelector('.list-view').querySelectorAll('.task-row')];
    const box = scroller.getBoundingClientRect();
    /* 挑**离底边最近的那一行**：正是 AutoScroll 的触发区 */
    let best = null, bestD = 1e9;
    for (const el of rows) {
      const b = el.getBoundingClientRect();
      if (b.top < box.top || b.bottom > box.bottom) continue;
      const d = box.bottom - b.bottom;
      if (d >= 0 && d < bestD) { bestD = d; best = el; }
    }
    const b = (best || rows[rows.length - 1]).getBoundingClientRect();
    return { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2),
             到底: Math.round(box.bottom - b.bottom) };
  `);
  console.log('    拖这一行：' + JSON.stringify(rowStart) + '（离容器底 ' + rowStart.到底 + 'px）');

  await touch('touchStart', rowStart.x, rowStart.y);
  await sleep(380);
  /* 一直往底边蹭，再蹭出去：AutoScroll 是按 interval 轮询的，挪够久才看得出它出手 */
  for (let i = 1; i <= 14; i++) {
    await touch('touchMove', rowStart.x, rowStart.y + i * 4);
    await sleep(70);
  }
  const rowState = await evalJs(page, `
    return { dragging: !!document.querySelector('.task-row.dragging, .task-el.dragging, .drag-overlay'),
             overlay: !!document.querySelector('.drag-overlay') };
  `);
  const after = await scrollables();
  await touch('touchEnd', rowStart.x, rowStart.y + 56);
  await sleep(150);

  console.log('    拖前：' + JSON.stringify(before));
  console.log('    拖后：' + JSON.stringify(after));
  ok(rowState.dragging, '列表里长按 380ms 也进入拖拽态');
  const same = before.length === after.length &&
    before.every((b, i) => after[i] && b.名 === after[i].名 && b.顶 === after[i].顶);
  ok(before.length > 0, '这一屏确实有能滚的容器（不然这一段等于没测）');
  ok(same, '拖列表行期间没有任何容器替它滚');

  /* 列表行的文字**本来可以复制**（calendar.css 那条 user-select 特意不收 .task-row）：
     卡片是长按拽起来拖的，列表行是读和复制的地方。这条断言锁住这个决定。 */
  const rowSel = await evalJs(page, `
    const els = [...document.querySelectorAll('.list-view .task-row')].slice(0, 3);
    return els.map((el) => {
      const cs = getComputedStyle(el);
      return { 类: el.className.split(' ')[0], us: cs.userSelect || cs.webkitUserSelect };
    });
  `);
  for (const el of rowSel) {
    ok(el.us !== 'none', el.类 + ' 的文字仍可选中 / 复制（user-select=' + el.us + '）');
  }

  /* C. 卡片上禁文字选中 / 复制 —— 得回日程视图（列表行没有卡片修饰类）：
     日视图量定时卡 / 未定卡 / 就地新建格，月视图量胶囊 */
  console.log('\n七、断言：卡片表面不被文字选中');
  for (const view of ['day', 'month']) {
    await gotoCalendar();
    await evalJs(page, `
      const b = document.querySelector('.view-switch [data-view="${view}"]');
      if (b) b.click();
      return true;
    `);
    const marker = view === 'month' ? '.content-month' : '.content-day';
    await waitFor(page, `!!document.querySelector('${marker}')`, view + ' 视图（选中检查）');
    await sleep(350);
    const sel = await evalJs(page, `
      /* 只收卡片这四种表面：.task-row 也带 .task-el 标记，但它不在⑥的范围里 */
      const els = [...document.querySelectorAll(
        '.content .task-el--timed, .content .task-el--untimed, .content .task-pill, .content .new-cell')];
      return els.map((el) => {
        const cs = getComputedStyle(el);
        return { cls: el.className.split(' ')[0],
                 userSelect: cs.userSelect || cs.webkitUserSelect,
                 webkitUserSelect: cs.webkitUserSelect };
      });
    `);
    ok(sel.length >= (view === 'month' ? 3 : 2),
      view + ' 量到卡片表面 ' + sel.length + ' 张（空列表等于没测）');
    for (const el of sel) {
      ok(el.userSelect === 'none' || el.webkitUserSelect === 'none',
        view + ' ' + el.cls + ' 不被文字选中（user-select=' + el.userSelect
        + ' / -webkit-' + el.webkitUserSelect + '）');
    }
  }
} catch (e) {
  failures++;
  console.error('\n探针中断：', e && e.message ? e.message : e);
  if (e && e.stack) console.error(String(e.stack).split('\n').slice(1, 4).join('\n'));
} finally {
  if (page) { try { page.close(); } catch (_) { /* 已关 */ } }
  cleanup();
}

console.log(failures ? `\n✗ ${failures} 项不对\n` : '\n✓ 卡片几何与手势分工全通过\n');
process.exit(failures ? 1 : 0);

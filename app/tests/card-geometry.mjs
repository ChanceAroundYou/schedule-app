import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHROME, makePorts, ensureDist } from './lib/probe-env.mjs';
import { connect, evalJs, waitFor, dumpPage, touch } from './lib/cdp.mjs';
import { serveDist } from './lib/server.mjs';
import { failures, ok } from './lib/probe-assert.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = process.env.DIST ? path.resolve(process.env.DIST) : path.join(ROOT, 'dist');

const RADIUS_K = 0.28;
const RADIUS_MIN = 2;
const TOL_RATIO = 0.03;
const TOL_PAD = 0.5;
const CHECK_K = 1;
const CHECK_MIN = 9;
const CHECK_MAX = 18;
const WEEK_HEAD = {
  desktop: { dayFontMax: 14, circleMax: 23, headMax: 56 },
  narrow: { dayFontMax: 13, circleMax: 21, headMax: 48 },
};
const num = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };

const TOUCH_DRAG_DELAY = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = mkdtempSync(path.join(tmpdir(), 'sched-geom-'));
const procs = [];
function track(p) { procs.push(p); return p; }
function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch (_) {} }
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (_) {}
}
process.on('exit', cleanup);

const VIEWPORTS = [
  { name: '桌面 1400', w: 1400, h: 900, mobile: false },
  { name: '窄屏 390', w: 390, h: 844, mobile: true },
];
const VIEWS = ['day', 'week', 'month'];

let page = null;
try {
  const fs = await import('node:fs');
  ensureDist(ROOT, DIST, path.join(ROOT,'app'));
  if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME);

  const { api: API_PORT, web: WEB_PORT, cdp: CDP_PORT } = await makePorts();

  track(spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
    env: { ...process.env, PORT: String(API_PORT), SCHEDULE_DATA_DIR: dataDir },
    stdio: 'ignore',
  }));
  const { srv: web } = await serveDist({ webPort: WEB_PORT, apiPort: API_PORT, dist: DIST, mime: MIME, listenFree: (srv, port) => new Promise((res) => srv.listen(port, '127.0.0.1', () => res(port))) });
  procs.push({ kill: () => { try { web.close(); } catch (_) {} } });

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${API_PORT}/api/health`)).ok) break; } catch (_) {}
    await sleep(100);
  }

  track(spawn(CHROME, [
    '--headless=new', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(dataDir, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1440,940', 'about:blank',
  ], { stdio: 'ignore' }));

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch (_) {}
    if (!target) await sleep(150);
  }
  if (!target) throw new Error('Chrome 没开起来');

  page = await connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  try { await waitFor(page, `!!document.querySelector('#root')`, '应用外壳挂上'); }
  catch (e) { await dumpPage(page); throw e; }

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

  const SEED_TIMED = [
    { id: 't_geom_timed', time: '09:00', duration: 120, title: '定时两小时' },
    { id: 't_geom_t90', time: '13:00', duration: 90, title: '定时九十分钟' },
    { id: 't_geom_t75', time: '15:00', duration: 75, title: '定时七十五分' },
    { id: 't_geom_t61', time: '17:00', duration: 61, title: '定时六十一分' },
    { id: 't_geom_t60', time: '19:00', duration: 60, title: '定时整一小时' },
    { id: 't_geom_t45', time: '21:00', duration: 45, title: '定时四十五分' },
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

  await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    st.ui.cal = ${JSON.stringify(seed.calId)};
    st.ui.cals = [${JSON.stringify(seed.calId)}];
    localStorage.setItem('schedule-app-v4', JSON.stringify(st));
    return true;
  `);
  await page.send('Page.reload');
  await waitFor(page, `!!document.querySelector('.main')`, '重载后外壳', 15000);

  const gotoCalendar = async () => {
    await evalJs(page, `
      const n = document.querySelector('[data-nav="calendar"]')
        || [...document.querySelectorAll('.tabbar .tab')].find((b) => /日程/.test(b.textContent));
      if (n) n.click();
      return !!n;
    `);
    await waitFor(page, `!!document.querySelector('.content-day, .content-month')`, '日程页');
  };
  await gotoCalendar();

  const ctx = {
    page, errors: [],
    ok: ok,
    state: {
      RADIUS_K, RADIUS_MIN, TOL_RATIO, TOL_PAD, CHECK_K, CHECK_MIN, CHECK_MAX, WEEK_HEAD, DUR,
      VIEWPORTS, VIEWS, table: {}, detail: {},
    },
    helpers: {
      evalJs, waitFor, sleep, num, WEB_PORT, TOUCH_DRAG_DELAY, gotoCalendar, touch: (type, x, y) => touch(page, type, { x, y }),
      openCalMenu: null, waitCalMenu: null, closeCalMenu: null, withCals: (fn) => fn(), shown: null,
      clickCal: null, waitShownCount: null, focusCal: null, inbox: null, a11y: null, collect: null,
      fmt: null, apiPort: API_PORT, api: null,
    },
  };

  const sectionFiles = [
    './sections/geom/00-measure.mjs',
    './sections/geom/01-geometry.mjs',
    './sections/geom/02-radius-pad.mjs',
    './sections/geom/03-time-fit.mjs',
    './sections/geom/04-week-head.mjs',
    './sections/geom/05-longpress-drag.mjs',
    './sections/geom/06-list-drag-scroll.mjs',
    './sections/geom/07-user-select.mjs',
  ];
  for (const f of sectionFiles) {
    const mod = await import(f);
    await mod.run(ctx);
  }

  console.log(failures ? `\n✗ ${failures} 项不对\n` : '\n✓ 卡片几何与手势分工全通过\n');
  process.exit(failures ? 1 : 0);
} catch (e) {
  console.error('\n探针中断：', e && e.message ? e.message : e);
  if (e && e.stack) console.error(String(e.stack).split('\n').slice(1, 4).join('\n'));
  process.exit(1);
} finally {
  if (page) { try { page.close(); } catch (_) {} }
  cleanup();
}

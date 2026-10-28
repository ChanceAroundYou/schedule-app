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
import { registerUser, firstCal, inviteAndAccept, pushTasks, loginInPage, nudgeSync, repeatNone, repeatWeek } from './lib/seed.mjs';
import { makeDisplaySwitch } from './lib/display-switch.mjs';

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
  catch (e) { await dumpPage(page, '外壳'); throw e; }

  /* 账户从 Node 侧开（`lib/seed`），再把登录态塞进 localStorage ——
     为什么不在浏览器里造数据，见 seed.mjs 顶上那段。塞完必须再导航一次，
     应用才会在启动时读到它。 */
  const probeUser = await registerUser(API_PORT, { name: '几何探针', password: 'geom-pw-123' });
  await loginInPage(page, probeUser);

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
  /* 「别人建的」定时卡也进这张表：第三节按它分桶 —— 不在表里的卡被当未定时，
     会拿「未定时卡没有时间行」去考一张有时间的卡（实测误报 4 条）。
     ⏰ 特意排在 22:00（21:45 之后）：定时卡**不许互相层叠**是探针自己的前提 ——
     上一版排在 10:00，正好压住 09:00–11:00 那张，层叠把两张都压窄，
     于是「时间行没被横向裁」在周视图红了 2px / 窄屏红了 26px，
     圆角也跟着从应算的 10.78 漂到 12.01（红的是探针造的堆叠，不是卡片）。 */
  const SEED_FOREIGN_TIMED = [
    { id: 't_geom_foreign_timed', time: '22:00', duration: 90, title: '别人建的定时任务' },
  ];
  /* 「别人建的」那批（第八节量的就是它们）：来源 tag 只在**别人建**的任务上出现
     （createdBy 由服务端在创建时钉死，客户端 op 改不动），所以种子是
     「另一个账号建在另一个集里」的任务。标题特意起得长：重叠就发生在
     「标题长到顶到卡片右沿」的那张卡上。
     ⚠️ 超长那条是「长标题真的从角标底下穿过去」这条断言的**证人**：短标题根本走不到
     角标那一段，断言会空过（上一轮量到的越界全是负数 = 其实什么都没测到）。
     44 个字 × 12.5px ≈ 550 > 331 可用宽 → 一定被裁在右沿上。 */
  const SEED_FOREIGN = [
    { id: 't_geom_foreign_long', title: '别人建的长标题任务要顶到卡片右沿看会不会撞上角标', time: null, duration: null, repeat: repeatNone() },
    { id: 't_geom_foreign_verylong', title: '别人建的超长标题任务要一路顶到右沿好看看是文字让步还是角标让步', time: null, duration: null, repeat: repeatNone() },
    { id: 't_geom_foreign_rep', title: '别人建的重复任务', time: null, duration: null, repeat: repeatWeek() },
    ...SEED_FOREIGN_TIMED.map((r) => ({ ...r, repeat: repeatNone() })),
  ];
  const DUR = Object.fromEntries([...SEED_TIMED, ...SEED_FOREIGN_TIMED].map((r) => [r.id, r.duration]));
  /* 造自己的那批：开账户、拿默认集、拆字段 op、推 /api/sync 全走 `lib/seed` ——
     字段表和「今天」的算法只在那儿有一份（原先这段写在注入浏览器的模板里，
     与 browser-cards 那份是两份拷贝，改一边不会同步另一边）。 */
  const cal = await firstCal(API_PORT, probeUser.token);
  const UNTIMED = Array.from({ length: 25 }, (_, i) => (
    { id: 't_geom_untimed_' + i, time: null, duration: null, title: '未定时刻' + (i + 1) }
  ));
  const seed = await pushTasks(API_PORT, {
    token: probeUser.token, calId: cal.id, deviceId: 'geom-probe',
    rows: [...SEED_TIMED, ...UNTIMED],
  });
  if (seed.applied !== seed.ops) throw new Error('造任务没全落库：' + JSON.stringify(seed));
  console.log('  已造任务：定时 ' + SEED_TIMED.map((r) => r.duration).join('/') + ' 分钟各一条'
    + ' + 未定 25 条（' + seed.date + '，日程集「' + cal.name + '」，' + seed.applied + ' 个字段）');

  /* ── 再造「别人建的」任务：来源 tag 只在**别人建**的任务上出现（createdBy 由服务端
     在创建时钉死，客户端 op 改不动），所以必须真开第二个账号、真邀请、真接受。
     第八节（右上角那两枚角标）量的就是这批卡，种子在上面的 SEED_FOREIGN。 */
  const other = await registerUser(API_PORT, { name: '来源探针', password: 'foreign-pw-123' });
  const otherCal = await firstCal(API_PORT, other.token);
  await inviteAndAccept(API_PORT, {
    calId: otherCal.id, name: probeUser.user.name, role: 'editor',
    ownerToken: other.token, joinerToken: probeUser.token,
  });
  const foreign = await pushTasks(API_PORT, {
    token: other.token, calId: otherCal.id, deviceId: 'foreign-probe',
    rows: SEED_FOREIGN, opPrefix: 'opfx',
  });
  console.log('  已造「别人建的」任务：' + otherCal.name + '（' + other.user.name + ' 建）里 '
    + foreign.applied + ' 个字段落库（长标题 / 重复 / 定时各一条）');

  /* 催同步引擎拉一趟（它平时 15 秒一轮，窗口重获焦点时立刻跑）：不催就得干等，
     而且「本地副本落盘」那条等待会等到超时 */
  await nudgeSync(page);
  /* 本地副本要等一次同步落盘才存在（persist 有 250ms 防抖，而接受邀请后客户端
     还得多拉一趟快照才知道自己进了新集）—— 立刻读会拿到 null */
  try {
    await waitFor(page, `!!localStorage.getItem('schedule-app-v4')`, '本地副本落盘', 20000);
  } catch (err) {
    const dbg = await evalJs(page, `
      return { keys: Object.keys(localStorage),
               cals: (JSON.parse(localStorage.getItem('schedule-app-v4') || 'null') || {}).cals };
    `);
    console.error('  [诊断] ' + JSON.stringify(dbg)); throw err;
  }
  /* 勾上「别人的集」不能写 localStorage 再 reload：reload 时 pagehide → flushPersist
     会拿内存里那份旧的把字写回去（深浅那档踩过同一件事，见 docs/踩坑）。
     改用 CDP 的「新文档里最早的脚本」—— 它跑在应用读 localStorage 之前，每趟导航都生效。 */
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { const k = 'schedule-app-v4'; const raw = localStorage.getItem(k);
      if (raw) { const p = JSON.parse(raw);
        if (p && p.ui && Array.isArray(p.cals)) { p.ui.cals = p.cals.map((c) => c.id); localStorage.setItem(k, JSON.stringify(p)); }
      } } catch (_) {}`,
  });
  await page.send('Page.reload');
  await waitFor(page, `!!document.querySelector('.main')`, '重载后外壳', 15000);
  /* 新集的历史全在游标后面（AGENTS 同步那条）→ 客户端要多拉一次才看得见这个集。
     等它真进了本地 cals，否则第八节量到的 tag 数会是 0（等于没测）。 */
  try {
    await waitFor(page, `(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks || {})
      ['t_geom_foreign_long'] ? 1 : null`, '别人的任务进了本地副本', 25000);
  } catch (err) {
    const dbg = await evalJs(page, `
      const st = JSON.parse(localStorage.getItem('schedule-app-v4') || '{}');
      return { cals: (st.cals || []).map((c) => c.name), uiCals: (st.ui || {}).cals,
               cursor: st.cursor, tasks: Object.keys(st.tasks || {}).length };
    `);
    console.error('  [诊断] ' + JSON.stringify(dbg)); throw err;
  }

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

  /* 设置页「显示」那一排的路径（进设置 → 点 tab → 点某一排芯片）：
     与 browser-cards 共用 `lib/display-switch.mjs`，第九节和它第四节走的是同一条路。 */
  const display = makeDisplaySwitch({ page, evalJs, waitFor });

  const ctx = {
    page, errors: [],
    ok: ok,
    state: {
      RADIUS_K, RADIUS_MIN, TOL_RATIO, TOL_PAD, CHECK_K, CHECK_MIN, CHECK_MAX, WEEK_HEAD, DUR,
      VIEWPORTS, VIEWS, table: {}, detail: {},
    },
    helpers: {
      evalJs, waitFor, sleep, num, WEB_PORT, TOUCH_DRAG_DELAY, gotoCalendar, touch: (type, x, y) => touch(page, type, { x, y }),
      openSettings: display.openSettings, openDisplayTab: display.openDisplayTab, pickChip: display.pickChip,
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
    './sections/geom/08-corner-tags.mjs',
    './sections/geom/09-card-font-scale.mjs',
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

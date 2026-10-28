/**
 * browser-cards.mjs —— 卡片版面回归探针
 *
 *   node app/tests/browser-cards.mjs        # CHROME=/path/to/chrome 可指定浏览器
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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHROME, makePorts, makeDataDir, cleanupDataDir, ensureDist } from './lib/probe-env.mjs';
import { connect, evalJs, waitFor, dumpPage } from './lib/cdp.mjs';
import { serveDist } from './lib/server.mjs';
import { registerUser, firstCal, pushTasks, loginInPage, nudgeSync } from './lib/seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = process.env.DIST ? path.resolve(process.env.DIST) : path.join(ROOT, 'dist');
/* 端口 / Chrome / 临时目录 / dist 是否要重建，全在 lib/probe-env.mjs；
   CDP 连接与求值在 lib/cdp.mjs；静态服务 + /api 反代在 lib/server.mjs。
   这三样原先在本文件里各有一份拷贝，与 browser-smoke / card-geometry 同尺寸 ——
   改一处要记得改三处，正是最容易漏的那类（踩坑 29 那条「evalJs 要自己 return」
   当年就是靠三份拷贝各自踩出来的）。 */

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ 主流程 */

const dataDir = makeDataDir();
const procs = [];
function track(p) { procs.push(p); return p; }
function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch (_) { /* 已经没了 */ } }
  cleanupDataDir(dataDir);
}
process.on('exit', cleanup);

let page = null;
try {
  ensureDist(ROOT, DIST, path.join(ROOT, 'app'));
  if (!existsSync(CHROME)) {
    throw new Error('找不到 Chrome：' + CHROME + '（可用 CHROME 环境变量指定）');
  }

  const { api: API_PORT, web: WEB_PORT, cdp: CDP_PORT } = await makePorts();

  track(spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
    env: { ...process.env, PORT: String(API_PORT), SCHEDULE_DATA_DIR: dataDir },
    stdio: 'ignore',
  }));
  const { srv: web } = await serveDist({
    webPort: WEB_PORT, apiPort: API_PORT, dist: DIST, mime: MIME,
    listenFree: (srv, port) => new Promise((res) => srv.listen(port, '127.0.0.1', () => res(port))),
  });
  procs.push({ kill: () => { try { web.close(); } catch (_) { /* 已关 */ } } });

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${API_PORT}/api/health`)).ok) break; } catch (_) { /* 等 */ }
    await sleep(100);
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
    await dumpPage(page, '外壳');
    throw e;
  }

  /* 注册一个账户、把登录态写进 localStorage（等价于登录成功后的状态）。
     走接口而不是点界面：这个探针要盯的是**版面**，不是注册流程
     —— 注册流程由 browser-smoke 覆盖，这里少一步就少一处会坏的地方。
     账户在 Node 侧开（`lib/seed`）：造数据不需要浏览器，写在浏览器里只是让同一段
     逻辑以字符串形态存在一份、在 card-geometry 里再存在一份。 */
  const probeUser = await registerUser(API_PORT, { name: '版面探针', password: 'cards-pw-123' });
  await loginInPage(page, probeUser);

  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  await waitFor(page, `!!document.querySelector('[data-nav="inbox"]')`,
    '登录后的外壳（有导航）', 15000);

  /* ---- 造一条任务 ----
     走**接口**建、再重载让 App 自己拉下来。为什么不点界面上的快速输入框：
     账户刚注册时默认日程集还在同步路上，落在那个窗口里建任务是会丢的
     （实测「输入框被清空、列表里没有、服务端也没有」）。这里要盯的是**版面**，
     造数据这一步越确定越好 —— 快速添加的行为由 browser-smoke 覆盖。 */
  const cal = await firstCal(API_PORT, probeUser.token);
  const seed = await pushTasks(API_PORT, {
    token: probeUser.token, calId: cal.id, deviceId: 'cards-probe',
    rows: [{ id: 't_cards_probe', title: '卡片版面探针', time: null, duration: null }],
  });
  console.log('  已造任务（' + seed.date + '，日程集「' + cal.name + '」，' + seed.applied + ' 个字段）');

  /* 等本地副本落盘之后再动它 —— 下面那段是往这份副本上写，它还不存在就是 null。
     造数据挪到 Node 侧（lib/seed）之前不会撞这一条：那会儿造数据在浏览器里跑，
     耗的那一会儿应用已经把副本存下来了；现在快了一个来回，必须显式等。
     催一下同步引擎（它平时 15 秒一轮，窗口重获焦点时立刻跑），别干等。 */
  await nudgeSync(page);
  await waitFor(page, `!!localStorage.getItem('schedule-app-v4')`, '本地副本落盘', 20000);

  /* 新账户的 ui.cal / ui.cals 是空的（App 不会自动勾上一个集），
     于是列表全是空的。探针自己把它指到刚建任务的那个集上 —— 这一步是
     **环境准备**，不是被测行为。 */
  await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    st.ui.cal = ${JSON.stringify(cal.id)};
    st.ui.cals = [${JSON.stringify(cal.id)}];
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

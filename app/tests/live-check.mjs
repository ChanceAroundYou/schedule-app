/**
 * live-check.mjs —— 线上（生产）端到端实测
 *
 * 用途：**发布之后**证明「线上真的变成新的了、而且没坏」。
 * 和 browser-smoke.mjs 分工不同：
 *   · browser-smoke —— 起隔离环境（临时库 + 临时后端 + 真实 Chrome），
 *     深测全部交互流程；写数据无所谓，反正库是临时的。
 *   · live-check   —— 打**生产 URL**，只做「加载 + 登录 + 视图 + 本轮改动的
 *     定点断言」，写操作只有机器人账号自己日程集里的那一条（跑完就结束掉系列）。
 *
 *   node app/tests/live-check.mjs
 *   node app/tests/live-check.mjs --features core,now-line,week,repeat,drag
 *
 * 环境变量：
 *   LIVE_URL   默认 https://home.xiaokubao.space/schedule/
 *   LIVE_USER  机器人账号，默认 e2e-bot（首次自动注册，之后登录）
 *   LIVE_PASS  默认 e2e-bot-2026
 *   CHROME     浏览器可执行文件；默认找系统 Chrome，找不到退回 Playwright 自带
 *   HEADED=1   有头模式（调试用）
 *
 * 退出码：0 全过；1 有断言失败（会打印哪一条、实际值是什么）。
 */

import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const BASE = (process.env.LIVE_URL || 'https://home.xiaokubao.space/schedule/').replace(/\/?$/, '/');
const USER = process.env.LIVE_USER || 'e2e-bot';
const PASS = process.env.LIVE_PASS || 'e2e-bot-2026';
const HEADED = process.env.HEADED === '1';

/** 支持 --features a,b,c；默认跑全部 */
const argv = process.argv.slice(2);
const featArg = argv.find((a) => a.startsWith('--features=')) || argv[argv.indexOf('--features') + 1];
const FEATURES = new Set(
  (featArg ? String(featArg).replace(/^--features=/, '') : 'core,now-line,week,repeat,drag,download')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

const CHROME_CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const failures = [];
let checks = 0;

function ok(name, detail) {
  checks++;
  console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`);
}
function bad(name, detail) {
  checks++;
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}
function assertOk(cond, name, detail) {
  if (cond) ok(name, detail); else bad(name, detail);
}

function launchOptions() {
  const hit = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (hit) return { executablePath: hit, args: ['--no-first-run', '--no-default-browser-check'] };
  return {};   // 退回 Playwright 自带 chromium（需要 npx playwright install chromium）
}

/** 登一个能用的账号：先试注册（首次），失败就登录（之后每次） */
async function ensureLogin(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.auth-card', { timeout: 20000 });

  const fill = async () => {
    await page.fill('input[autocomplete="username"]', USER);
    await page.fill('input[type="password"]', PASS);
  };

  // 先按「登录」提交（账号已存在时的常态）
  await fill();
  await page.click('.auth-card button[type="submit"]');
  // 成功 → 卡片消失；失败 → .auth-err 出现
  const outcome = await Promise.race([
    page.waitForSelector('.auth-card', { state: 'detached', timeout: 8000 }).then(() => 'in'),
    page.waitForSelector('.auth-err', { timeout: 8000 }).then(() => 'err'),
  ]).catch(() => 'timeout');

  if (outcome === 'in') return 'login';

  // 登录失败 → 切到注册（首次跑）/ 密码不对就直接报错
  const errText = await page.textContent('.auth-err').catch(() => '');
  await page.click('.auth-foot button');
  await fill();
  await page.click('.auth-card button[type="submit"]');
  await page.waitForSelector('.auth-card', { state: 'detached', timeout: 10000 })
    .catch(() => { throw new Error(`注册也失败了（登录时报：${errText}）`); });
  return 'register';
}

/**
 * 等应用外壳就绪。
 *
 * ⚠️ 登录后默认落在「今天」（列表页，空账号显示「今天没有安排」）——
 * 时间轴和日/周/月视图切换都在「日程」页（`[data-nav="calendar"]`）的副 header 上。
 * 第一版直接等 `.timeline` 等了个空，就是漏了这一步。
 */
async function waitShell(page) {
  await page.click('[data-nav="calendar"]');
  await page.waitForSelector('button[data-view="day"]', { timeout: 15000 });
  /* 上一段检查可能把视图停在周 / 月（ui.view 是记住的）—— 日视图那根时间轴
     只有 view=day 时存在。等不到就显式切回日视图。 */
  await page.waitForSelector('.timeline', { timeout: 3000 }).catch(async () => {
    await page.click('button[data-view="day"]');
    await page.waitForSelector('.timeline', { timeout: 10000 });
  });
}

/** 切视图 */
async function switchView(page, v) {
  await page.click(`button[data-view="${v}"]`);
  await page.waitForTimeout(350);
}

/* ------------------------------------------------------------ 各项检查 */

/** core：外壳、三个视图、零控制台报错 */
async function checkCore(page, consoleErrors) {
  await waitShell(page);
  ok('登录后进入应用外壳（时间轴出现）');

  const hasToday = await page.$('.timeline');
  assertOk(!!hasToday, '日视图时间轴存在');

  await switchView(page, 'week');
  const week = await page.$('.week-grid, .week, [data-zone-id^="week:"]');
  assertOk(!!week, '周视图渲染');

  await switchView(page, 'month');
  const monthCells = await page.$$('[data-date]');
  assertOk(monthCells.length >= 28, '月视图渲染（日期格 ≥28）', `${monthCells.length} 格`);

  await switchView(page, 'day');
  assertOk(consoleErrors.length === 0, '零控制台报错',
    consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '无');
}

/** download：网页版「下载 App」必须指向清单里的最新安装包，且清单不许被 SW 缓存 */
async function checkDownload(page) {
  const manifest = await page.evaluate(async (base) => {
    const r = await fetch(base + 'dl/version.json', { cache: 'no-store' });
    return r.ok ? r.json() : null;
  }, BASE);
  if (!manifest || !manifest.url) { bad('读到 dl/version.json'); return; }
  ok('读到更新清单', `v${manifest.versionCode} / ${manifest.versionName} → ${manifest.url}`);

  // **核心回归**：清单一旦进了 Cache Storage，下载按钮就永远指向缓存那天的版本
  // （2026-10-22：用户从网页下载到 2.1.4 就是这个原因，SW 把它当普通
  //  同源 GET 用 staleWhileRevalidate 存了一份）。
  const where = await page.evaluate(async (base) => {
    const abs = new URL('dl/version.json', base).href;
    for (const k of await caches.keys()) {
      try {
        if (await (await caches.open(k)).match(abs)) return k;
      } catch (_) { /* 打不开这个缓存就跳过 */ }
    }
    return null;
  }, BASE);
  assertOk(where === null, '下载清单没被 Service Worker 缓存',
    where ? `仍留在 ${where}` : '未缓存');

  // 侧栏与底栏各有一个「设置」入口，宽屏时底栏是隐藏的 —— 只点看得见的那个
  await page.locator('[data-nav="settings"]:visible').first().click();
  await page.locator('[data-settings-tab="about"]').click();
  const link = page.locator('[data-about="apk-download"]');
  await link.waitFor({ state: 'attached', timeout: 10000 });

  const href = await link.getAttribute('href');
  const text = (await link.innerText()).trim();
  assertOk(!!href && href.endsWith('/' + manifest.url), '下载链接指向最新安装包',
    `${href}（清单：${manifest.url}）`);
  assertOk(text.includes(manifest.versionName), '下载链接上写的是最新版本号',
    `「${text}」应含 ${manifest.versionName}`);

  if (href) {
    const res = await page.request.head(new URL(href, BASE).href);
    assertOk(res.status() === 200, '安装包 URL 可下载', `HTTP ${res.status()}`);
  }
}

/** now-line：今天的时间轴「当前时间线」是深绿细线，无圆点、无时刻文字 */
async function checkNowLine(page) {
  await switchView(page, 'day');
  const line = await page.$('.tl-now');
  if (!line) { bad('当前时间线存在（今天、日视图）'); return; }
  ok('当前时间线存在（今天、日视图）');

  const info = await line.evaluate((el) => {
    const cs = getComputedStyle(el);
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement('div');
    probe.style.color = 'var(--ok)';
    document.body.appendChild(probe);
    const okColor = getComputedStyle(probe).color;
    probe.remove();
    return {
      borderColor: cs.borderTopColor,
      borderWidth: cs.borderTopWidth,
      okColor,
      children: el.children.length,
      text: (el.textContent || '').trim(),
      theme: document.documentElement.dataset.theme,
    };
  });

  assertOk(info.borderColor === info.okColor,
    '线条是 --ok 深绿', `实际 ${info.borderColor}，--ok=${info.okColor}（主题 ${info.theme}）`);
  assertOk(info.children === 0 && info.text === '',
    '只有一根线：无圆点、无时刻文字', `子元素 ${info.children}、文本「${info.text}」`);
}

/**
 * week：周视图 = 一根锁单屏的日视图时间轴（2026-10-17 改版）。
 *
 * 断言四件事：
 *   1. 纵向不滚 —— 整天摊在一屏里，scrollHeight 不该超过 clientHeight；
 *   2. 七列齐整 —— 每列都是一根「时间轴」（带 data-from/to）；
 *   3. 事件卡是日视图那张（.task-el--timed，带勾选圈），不是旧的紧凑块；
 *   4. 「现在」这条线只在今天那一列，不横跨七天。
 */
async function checkWeek(page) {
  await switchView(page, 'week');
  await page.waitForSelector('.week-cols', { timeout: 10000 });

  const noScroll = await page.$eval('.week-view', (el) => ({
    sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth,
  }));
  assertOk(noScroll.sh <= noScroll.ch + 2, '周视图纵向不滚动（一屏装下）',
    `scrollHeight ${noScroll.sh} vs clientHeight ${noScroll.ch}`);

  const cols = await page.$$eval('.week-col', (els) => els.length);
  assertOk(cols === 7, '七天七列', `${cols} 列`);

  const gutted = await page.$$eval('.week-gutter .tl-label', (els) => els.length);
  assertOk(gutted >= 8, '左侧刻度复用日视图的 .tl-label', `${gutted} 条`);

  const nowLines = await page.$$eval('.week-col .tl-now', (els) => els.length);
  assertOk(nowLines <= 1, '「现在」这条线只画在今天那一列', `${nowLines} 条`);

  /* 定时任务渲染成日视图那张卡：建一条 → 看列里有 .task-el--timed → 删掉 */
  const token = await page.evaluate(() => localStorage.getItem('schedule-app-token') || '');
  if (!token) { bad('能取到登录 token（周视图建卡用）'); return; }
  const calId = await page.evaluate(async (t) => {
    const r = await fetch('api/me', { headers: { Authorization: 'Bearer ' + t } });
    const j = await r.json().catch(() => null);
    return j && j.cals && j.cals[0] && j.cals[0].id;
  }, token);
  const title = 'e2e周卡-' + Date.now().toString(36);
  const id = 't_e2e_wk_' + Date.now().toString(36);
  const now = Date.now();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const td = new Date();
  const iso = `${td.getFullYear()}-${pad(td.getMonth() + 1)}-${pad(td.getDate())}`;
  const st = await page.evaluate(async ({ t, calId, id, title, now, date }) => {
    const r = await fetch('api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({
        cursor: 1,
        ops: [{
          opId: 'e2e-wk-' + id, deviceId: 'e2e-live', ts: now, entity: 'task',
          entityId: id, calId, fields: { title, date, time: '10:00', duration: 60 },
        }],
      }),
    });
    return r.status;
  }, { t: token, calId, id, title, now, date: iso });
  assertOk(st === 200, '周视图用例：测试任务已建', 'HTTP ' + st);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.click('[data-nav="calendar"]');
  await page.waitForSelector('.week-cols', { timeout: 15000 });
  const card = page.locator('.week-col .task-el--timed', { hasText: title }).first();
  const found = await card.count();
  assertOk(found === 1, '周视图里的定时任务就是日视图那张卡（.task-el--timed）',
    found ? '找到' : '没找到');

  if (found) {
    const del = await page.evaluate(async ({ t, id, calId, now }) => {
      const r = await fetch('api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
        body: JSON.stringify({
          cursor: 1,
          ops: [{
            opId: 'e2e-wk-del-' + id, deviceId: 'e2e-live', ts: now, entity: 'task',
            entityId: id, calId, fields: { deleted: true, deletedAt: now },
          }],
        }),
      });
      return r.status;
    }, { t: token, id, calId, now: Date.now() });
    assertOk(del === 200, '收尾：周视图测试任务已删除', 'HTTP ' + del);
  }
}

/**
 * repeat：线上真实新建一条「每周五、六」的重复任务，看周五和周六都出现。
 *
 * 走 API 建（避开选择器的脆性），但**后端派生 + 前端渲染整条链路都真跑**：
 * 建完刷新 → 客户端同步 → ensureRepeatOccurrences 补实例 → 月视图断言。
 * 跑完立刻把系列结束掉（repeatUntil=今天），机器人日程集不留垃圾。
 */
async function checkRepeat(page) {
  const title = 'e2e重复检查-' + Date.now().toString(36);
  const rootId = 't_e2e_rpt_' + Date.now().toString(36);
  const today = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  // ① 拿到 token + calId（页面里就存着，省一次登录）
  const token = await page.evaluate(() => localStorage.getItem('schedule-app-token') || '');
  if (!token) { bad('能从页面取到登录 token'); return; }
  ok('能从页面取到登录 token');

  const me = await page.evaluate(async (t) => {
    const r = await fetch('api/me', { headers: { Authorization: 'Bearer ' + t } });
    return r.ok ? r.json() : null;
  }, token);
  const calId = me && me.cals && me.cals[0] && me.cals[0].id;
  if (!calId) { bad('能取到机器人自己的日程集'); return; }
  ok('能取到机器人自己的日程集', calId);

  const push = (ops) => page.evaluate(async ({ t, ops }) => {
    const r = await fetch('api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ cursor: 1, ops }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { t: token, ops });

  // ② 建「每周五、六」的系列根（与用户在 App 里建的同一套字段）
  const now = Date.now();
  const r1 = await push([{
    opId: 'e2e-' + rootId, deviceId: 'e2e-live', ts: now, entity: 'task',
    entityId: rootId, calId,
    fields: {
      title, note: '', date: iso, time: null, reminder: null, duration: null,
      done: false, doneAt: null,
      repeat: { unit: 'week', n: 1, weekdays: [5, 6], monthday: 1, yearMonth: 1, end: null },
      repeatSeq: 0, seriesId: rootId, order: null, ord: null, createdAt: now, source: null,
    },
  }]);
  assertOk(r1.status === 200 && (r1.body?.applied?.length ?? 0) > 0,
    '线上能创建重复任务', r1.body?.rejected?.length ? JSON.stringify(r1.body.rejected[0]) : 'ok');

  // ③ 刷新 → 同步 → 客户端补齐实例；看月视图
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitShell(page);
  await switchView(page, 'month');

  const dates = await page.$$eval('[data-date]', (cells, t) => cells
    .filter((c) => (c.textContent || '').includes(t))
    .map((c) => c.getAttribute('data-date')), title);

  const wd = (d) => new Date(d + 'T00:00:00').getDay();
  const fri = dates.filter((d) => wd(d) === 5);
  const sat = dates.filter((d) => wd(d) === 6);

  console.log(`       月视图里这条重复任务落在: ${dates.join(', ') || '(无)'}`);
  assertOk(dates.length >= 2, '实例出现在月视图', `${dates.length} 天`);
  assertOk(fri.length >= 1, '周五有实例（#105b 的修法）', `周五 ${fri.length} 天`);
  assertOk(sat.length >= 1, '周六有实例', `周六 ${sat.length} 天`);

  /* 用户报「2027-01-23 之后彻底消失」（窗口按次数算 + 改规则顶超）。
     现在窗口按时间铺 120 天：翻到 3 个月后的月份，实例必须还在。 */
  for (let i = 0; i < 3; i++) await page.click('button[title="下一个"]');
  await page.waitForTimeout(400);
  const farDates = await page.$$eval('[data-date]', (cells, t) => cells
    .filter((c) => (c.textContent || '').includes(t))
    .map((c) => c.getAttribute('data-date')), title);
  console.log(`       翻 3 个月后那个月的实例: ${farDates.join(', ') || '(无)'}`);
  assertOk(farDates.length >= 8,
    '翻到 3 个月后仍有实例（窗口按时间铺，不再按次数）', `${farDates.length} 天`);

  // ④ 收尾：结束系列（repeatUntil=今天），实例由级联清掉
  const r2 = await push([{
    opId: 'e2e-end-' + rootId, deviceId: 'e2e-live', ts: now + 1, entity: 'task',
    entityId: rootId, calId, fields: { repeatUntil: iso },
  }]);
  assertOk(r2.status === 200, '收尾：系列已结束（repeatUntil=今天）');
}

/**
 * drag：在时间轴上**按住拉出一段时间**就地新建（2026-10-17 加的能力）。
 *
 * 这是唯一能证明「鼠标拖拽 + 时长落成」整条链路的办法 —— 坐标换算、15 分钟
 * 吸附、30 分钟下限、松手开草稿、回车落成全都在这几下里跑过一遍。
 * 挑一个**当前没有任务**的时段动手（卡片会吃掉 pointerdown，那是刻意的），
 * 跑完把这条任务删掉，机器人日程集不留垃圾。
 */
async function checkDrag(page) {
  /* 不能直接复用 waitShell：上一段检查把视图停在了月视图（还翻了三个月），
     而 waitShell 只等日视图那根时间轴 —— 在月视图里它会干等到超时。 */
  await page.click('[data-nav="calendar"]');
  await page.waitForSelector('button[data-view="day"]', { timeout: 10000 });
  await switchView(page, 'day');
  await page.waitForSelector('.timeline', { timeout: 15000 });
  /* ⚠️ 2026-10-22：这里原来假设「时间轴 = 24 小时、且布局已经稳」，实测会飘 45 分钟。
     两个原因：
       ① 窗口是**数据驱动**的（coverWindow = 设置窗 ∪ 任务），不能写死 24；
       ② 刚切到日视图时同步可能还在往回拉数据，未定时那一行一旦长高，
          时间轴会被整体推下去 —— 先量再拖就拖偏了。
     所以：等布局稳定 + 从 data-from/data-to 读真实窗口 + **拖之前重新量一次**。 */
  await page.waitForTimeout(1200);
  const win = await page.$eval('.timeline', (el) => ({
    from: Number(el.dataset.from), to: Number(el.dataset.to),
  }));
  const span = win.to - win.from;
  const boxNow = async () => page.locator('.tl-events').boundingBox();
  let tl = await boxNow();
  const yOf = (min) => tl.y + ((min - win.from) / span) * tl.height;
  const x = tl.x + tl.width / 2;

  /* 找一个竖着都没被占的一小时半：中心那条竖线上没有卡片挡着才行 */
  const busy = await page.$$eval('.tl-events .task-el', (els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }));
  let startHour = -1;
  for (const h of [9, 14, 3, 19, 7, 21]) {
    const top = yOf(h * 60);
    const bottom = yOf((h + 1.5) * 60);
    const hit = busy.some((b) => b.left < x && b.right > x && b.bottom > top && b.top < bottom);
    if (!hit) { startHour = h; break; }
  }
  if (startHour < 0) { bad('时间轴上找得到一段空白用于拖拽'); return; }

  /* 拖之前再量一次：上面找空位那几步之间布局可能又动了 */
  tl = await boxNow();
  await page.mouse.move(x, yOf(startHour * 60));
  await page.mouse.down();
  await page.mouse.move(x, yOf((startHour + 1.5) * 60), { steps: 14 });
  const preview = (await page.locator('.drag-range span').first().innerText()).trim();
  const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${m % 60 === 0 ? '00' : '30'}`;
  const endMin = (startHour + 1.5) * 60;
  const expect = `${hhmm(startHour * 60)} – ${endMin >= 1440 ? '次日 ' : ''}${hhmm(endMin)}`;
  assertOk(preview === expect, '拖拽预览框跟着拉出的那段长', `${preview}（期望 ${expect}）`);
  await page.mouse.up();

  await page.waitForSelector('.new-cell', { timeout: 5000 });
  ok('松手后在拉出的那一段上开出草稿框');

  const title = 'e2e拖拽-' + Date.now().toString(36);
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);

  const card = page.locator('.tl-events .task-el', { hasText: title }).first();
  assertOk(await card.count() === 1, '回车落成一条定时任务');
  const info = await card.getAttribute('title').catch(() => null);
  assertOk(!!info && info.includes(hhmm(startHour * 60)) && /1小时30分/.test(info),
    '落下来的任务带上「开始时间 + 90 分钟时长」', info || '(没有 title)');

  /* 收尾：删掉这条。用数据通道（不在界面上找删除按钮），跑完不留垃圾 */
  const id = await card.getAttribute('data-id');
  const token = await page.evaluate(() => localStorage.getItem('schedule-app-token') || '');
  if (id && token) {
    const calId = await page.evaluate(async (t) => {
      const r = await fetch('api/me', { headers: { Authorization: 'Bearer ' + t } });
      const j = await r.json().catch(() => null);
      return j && j.cals && j.cals[0] && j.cals[0].id;
    }, token);
    const now = Date.now();
    const res = await page.evaluate(async ({ t, id, calId, now }) => {
      const r = await fetch('api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
        body: JSON.stringify({
          cursor: 1,
          ops: [{
            opId: 'e2e-del-' + id, deviceId: 'e2e-live', ts: now, entity: 'task',
            entityId: id, calId, fields: { deleted: true, deletedAt: now },
          }],
        }),
      });
      return r.status;
    }, { t: token, id, calId, now });
    assertOk(res === 200, '收尾：这条测试任务已删除', 'HTTP ' + res);
  }
}

/* ------------------------------------------------------------------ 主流程 */

(async () => {
  console.log(`\n== 线上实测 ${BASE}（features: ${[...FEATURES].join(', ')}）`);
  const browser = await chromium.launch({ headless: !HEADED, ...launchOptions() });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  try {
    const how = await ensureLogin(page);
    ok(`登录成功（${how === 'register' ? '首次注册了机器人账号' : '用已有机器人账号登录'}）`);

    if (FEATURES.has('core')) await checkCore(page, consoleErrors);
    if (FEATURES.has('download')) await checkDownload(page);
    if (FEATURES.has('now-line')) await checkNowLine(page);
    if (FEATURES.has('week')) await checkWeek(page);
    if (FEATURES.has('repeat')) await checkRepeat(page);
    if (FEATURES.has('drag')) await checkDrag(page);

    // 收尾再扫一遍报错（写操作之后也可能冒）
    if (FEATURES.has('core')) {
      assertOk(consoleErrors.length === 0, '全流程零控制台报错',
        consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '无');
    }
  } catch (e) {
    bad('脚本执行中断', e && e.message);
  } finally {
    await browser.close();
  }

  console.log(`\n== 结果：${checks - failures.length}/${checks} 通过`);
  if (failures.length) {
    console.log('未通过：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 全通过\n');
})();

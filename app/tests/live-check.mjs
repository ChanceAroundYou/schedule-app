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
 *   node app/tests/live-check.mjs --features core,now-line,repeat
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
  (featArg ? String(featArg).replace(/^--features=/, '') : 'core,now-line,repeat')
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
  await page.waitForSelector('.timeline', { timeout: 15000 });
  await page.waitForSelector('button[data-view="day"]', { timeout: 10000 });
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

  // ④ 收尾：结束系列（repeatUntil=今天），实例由级联清掉
  const r2 = await push([{
    opId: 'e2e-end-' + rootId, deviceId: 'e2e-live', ts: now + 1, entity: 'task',
    entityId: rootId, calId, fields: { repeatUntil: iso },
  }]);
  assertOk(r2.status === 200, '收尾：系列已结束（repeatUntil=今天）');
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
    if (FEATURES.has('now-line')) await checkNowLine(page);
    if (FEATURES.has('repeat')) await checkRepeat(page);

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

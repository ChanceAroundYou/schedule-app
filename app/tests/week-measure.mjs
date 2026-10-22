/**
 * week-measure.mjs —— 量「未定时任务把时间轴挤扁」这件事
 *
 * 用户 2026-10-22 报：周视图的未定时区**不滚**，任务一多就把下面的时间轴顶矮；
 * 日视图（手机）已经是对的，要按同一套来，电脑端也是同一份逻辑。
 *
 * browser-smoke 只能断言「有没有 max-height」，量不出「行高到底长了多少」。
 * 这个脚本打**线上 URL**、用测试账号 e2e-bot 自己的日程集造 1/4/8 条未定时任务，
 * 把三行数字抄下来：未定时行高 / 单格 scrollHeight vs clientHeight / 时间轴高度。
 * 跑完把造出来的任务删掉，不碰别人的日程集。
 *
 *   node app/tests/week-measure.mjs
 *   W=360 H=792 node app/tests/week-measure.mjs     # 窄屏
 *   LIVE_URL=http://127.0.0.1:5199/ node app/tests/week-measure.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = (process.env.LIVE_URL || 'https://home.xiaokubao.space/schedule/').replace(/\/?$/, '/');
const USER = process.env.LIVE_USER || 'e2e-bot';
const PASS = process.env.LIVE_PASS || 'e2e-bot-2026';
const VW = +(process.env.W || 1280);
const VH = +(process.env.H || 860);
/* VIEW=day 时量日视图的未定时区（手机端那个「已经很好」的基准），用来对齐周视图 */
const VIEW = process.env.VIEW || 'week';

const CHROME_CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].filter(Boolean);

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.auth-card', { timeout: 20000 });
  const fill = async () => {
    await page.fill('input[autocomplete="username"]', USER);
    await page.fill('input[type="password"]', PASS);
  };
  await fill();
  await page.click('.auth-card button[type="submit"]');
  const outcome = await Promise.race([
    page.waitForSelector('.auth-card', { state: 'detached', timeout: 8000 }).then(() => 'in'),
    page.waitForSelector('.auth-err', { timeout: 8000 }).then(() => 'err'),
  ]).catch(() => 'timeout');
  if (outcome === 'in') return;
  await page.click('.auth-foot button');
  await fill();
  await page.click('.auth-card button[type="submit"]');
  await page.waitForSelector('.auth-card', { state: 'detached', timeout: 10000 });
}

const SNAP = () => {
  if (document.querySelector('.allday-zone')) {
    const z = document.querySelector('.allday-zone');
    const tl = document.querySelector('.timeline') || document.querySelector('.tl-wrap');
    return {
      rowH: Math.round(z.getBoundingClientRect().height),
      gridH: tl ? Math.round(tl.getBoundingClientRect().height) : -1,
      vh: window.innerHeight,
      cells: 1,
      busiest: {
        n: z.querySelectorAll('.task-el--untimed').length,
        h: Math.round(z.getBoundingClientRect().height),
        sh: z.scrollHeight, ch: z.clientHeight,
        maxH: getComputedStyle(z).maxHeight, ov: getComputedStyle(z).overflowY,
        blanks: z.querySelectorAll('.allday-blank').length,
        cardH: (() => { const c = z.querySelector('.task-el--untimed'); return c ? Math.round(c.getBoundingClientRect().height) : -1; })(),
      },
    };
  }
  const row = document.querySelector('.week-un-row');
  const cells = [...document.querySelectorAll('.wun-cell')];
  const grid = document.querySelector('.week-grid');
  const busiest = cells
    .map((c) => ({
      n: c.querySelectorAll('.task-el--untimed').length,
      h: Math.round(c.getBoundingClientRect().height),
      sh: c.scrollHeight,
      ch: c.clientHeight,
      maxH: getComputedStyle(c).maxHeight,
      ov: getComputedStyle(c).overflowY,
    }))
    .sort((a, b) => b.sh - a.sh)[0] || null;
  return {
    rowH: row ? Math.round(row.getBoundingClientRect().height) : -1,
    gridH: grid ? Math.round(grid.getBoundingClientRect().height) : -1,
    vh: window.innerHeight,
    cells: cells.length,
    busiest,
  };
};

async function main() {
  const hit = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const browser = await chromium.launch(hit ? { executablePath: hit } : {});
  const page = await browser.newPage({ viewport: { width: VW, height: VH } });
  console.log(`\n视口 ${VW}×${VH} · ${BASE}`);

  await login(page);
  /* 桌面壳的导航是侧栏 `[data-nav=calendar]`；窄屏是底部 `button.tab`（文字「日程」）。
     两套都要照顾，否则窄屏会卡在点击上（2026-10-22 白等过 5 分钟）。 */
  await page.locator('[data-nav="calendar"], button.tab', { hasText: '日程' }).first().click({ timeout: 15000 }).catch(async () => {
    await page.click('[data-nav="calendar"]', { timeout: 5000 });
  });
  await page.waitForSelector(`button[data-view="${VIEW}"]`, { timeout: 15000 });
  await page.click(`button[data-view="${VIEW}"]`);
  await page.waitForSelector(VIEW === 'day' ? '.allday-zone' : '.week-un-row', { timeout: 15000 });
  await page.waitForTimeout(600);

  const report = {};
  for (const want of [1, 4, 8]) {
    const ids = await page.evaluate(async (n) => {
      const token = localStorage.getItem('schedule-app-token');
      const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
      const u = (JSON.parse(localStorage.getItem('schedule-app-v4') || '{}').ui) || {};
      const d = new Date();
      const pad = (x) => (x < 10 ? '0' + x : '' + x);
      const date = u.cursor || (d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
      const out = [];
      const ops = [];
      for (let i = 0; i < n; i++) {
        const id = 't_wm_' + n + '_' + i + '_' + Date.now().toString(36);
        out.push(id);
        ops.push({ opId: 'o' + id, deviceId: 'wm', ts: Date.now() + i, entity: 'task', entityId: id, calId: me.cals[0].id, fields: { title: '挤一下 ' + (i + 1), date } });
      }
      await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ cursor: 1, ops }) });
      window.dispatchEvent(new Event('focus'));
      return out;
    }, want);
    await page.waitForTimeout(2200);
    report[want] = await page.evaluate(SNAP);

    await page.evaluate(async (delIds) => {
      const token = localStorage.getItem('schedule-app-token');
      const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
      const ops = delIds.map((id) => ({ opId: 'd' + id, deviceId: 'wm', ts: Date.now(), entity: 'task', entityId: id, calId: me.cals[0].id, fields: { deleted: true, deletedAt: Date.now() } }));
      await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ cursor: 1, ops }) });
      window.dispatchEvent(new Event('focus'));
    }, ids);
    await page.waitForTimeout(1600);
  }

  for (const [n, r] of Object.entries(report)) {
    const b = r.busiest || {};
    console.log(`  ${n} 条：未定时行 ${r.rowH}px · 格高 ${b.h}px（内容 ${b.sh} / 可见 ${b.ch}，max-h ${b.maxH}，overflow ${b.ov}）· 时间轴 ${r.gridH}px · 视口 ${r.vh}`);
  }
  await browser.close();
}

main().catch((e) => { console.error('崩了：', e.message); process.exitCode = 1; });

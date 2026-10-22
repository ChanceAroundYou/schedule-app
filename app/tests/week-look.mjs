/**
 * week-look.mjs —— 手机端周视图的「字体与时间行」体检
 *
 * 用户 2026-10-22 晚报的两条，都属于「看着不对但代码里读不出来」的：
 *   ① 顶部未定时任务的字比下面已定时任务**大一点**；
 *   ② 手机端周视图太窄，定时卡不该再显示时间，只留任务名。
 *
 * 字号到底是多少、时间行到底显不显示，只有量 computed style 才算数
 * （`--ev-title-size` 是变量，光读 CSS 会以为两边都是 10px —— 实际未定时那张
 *  根本没吃到这个变量，回退成 :root 的 12px）。
 *
 *   node app/tests/week-look.mjs
 *   W=390 node app/tests/week-look.mjs
 *
 * 打线上 URL、用 e2e-bot 自己的日程集；若那天的未定时区是空的，会临时建一条
 * 「量字号」并量完删掉。**不做修改类断言**，只打印数字 + 存一张截图。
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = (process.env.LIVE_URL || 'https://home.xiaokubao.space/schedule/').replace(/\/?$/, '/');
const USER = process.env.LIVE_USER || 'e2e-bot';
const PASS = process.env.LIVE_PASS || 'e2e-bot-2026';
const VW = +(process.env.W || 360);
const VH = +(process.env.H || 792);
const SHOT = process.env.SHOT || 'C:/Users/小哭包/AppData/Local/Temp/week-look.png';

const CHROME = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome']
  .find((p) => { try { return p && fs.existsSync(p); } catch { return false; } });

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.auth-card', { timeout: 20000 });
  const fill = async () => {
    await page.fill('input[autocomplete="username"]', USER);
    await page.fill('input[type="password"]', PASS);
  };
  await fill();
  await page.click('.auth-card button[type="submit"]');
  const out = await Promise.race([
    page.waitForSelector('.auth-card', { state: 'detached', timeout: 8000 }).then(() => 'in'),
    page.waitForSelector('.auth-err', { timeout: 8000 }).then(() => 'err'),
  ]).catch(() => 'timeout');
  if (out === 'in') return;
  await page.click('.auth-foot button');
  await fill();
  await page.click('.auth-card button[type="submit"]');
  await page.waitForSelector('.auth-card', { state: 'detached', timeout: 10000 });
}

async function main() {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2 });
  await login(page);
  await page.locator('[data-nav="calendar"], button.tab', { hasText: '日程' }).first().click({ timeout: 15000 });
  await page.waitForSelector('button[data-view="week"]', { timeout: 15000 });
  await page.click('button[data-view="week"]');
  await page.waitForSelector('.week-cols', { timeout: 15000 });
  await page.waitForTimeout(700);

  /* 未定时区空着就临时建一条，否则量不到字号 */
  const made = await page.evaluate(async () => {
    if (document.querySelector('.wun-cell .task-el--untimed')) return null;
    const token = localStorage.getItem('schedule-app-token');
    const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
    const u = (JSON.parse(localStorage.getItem('schedule-app-v4') || '{}').ui) || {};
    const id = 't_look_' + Date.now().toString(36);
    const idT = 't_lookt_' + Date.now().toString(36);
    await fetch('api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ cursor: 1, ops: [
        { opId: 'o' + id, deviceId: 'look', ts: Date.now(), entity: 'task', entityId: id, calId: me.cals[0].id, fields: { title: '量字号的任务', date: u.cursor } },
        { opId: 'o' + idT, deviceId: 'look', ts: Date.now() + 1, entity: 'task', entityId: idT, calId: me.cals[0].id, fields: { title: '定时三小时', date: u.cursor, time: '09:00', duration: 180 } },
      ] }),
    });
    window.dispatchEvent(new Event('focus'));
    return [id, idT];
  });
  if (made) { await page.waitForTimeout(2800); }

  const info = await page.evaluate(() => {
    const px = (el) => (el ? getComputedStyle(el).fontSize : null);
    const un = document.querySelector('.wun-cell .task-el--untimed .ev-title');
    const timed = [...document.querySelectorAll('.week-col .task-el--timed')]
      .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
    const timedTitle = timed ? timed.querySelector('.ev-title') : null;
    const timedTime = timed ? timed.querySelector('.ev-time') : null;
    const colW = (() => { const c = document.querySelector('.week-col'); return c ? Math.round(c.getBoundingClientRect().width) : 0; })();
    const gutter = document.querySelector('.week-gutter');
    const gW = gutter ? Math.round(gutter.getBoundingClientRect().width) : 0;
    return {
      colW,
      daysVisible: colW ? Math.round(((window.innerWidth - gW) / colW) * 10) / 10 : 0,
      未定时标题: px(un),
      定时标题: px(timedTitle),
      定时卡时间行: timedTime ? (getComputedStyle(timedTime).display === 'none' ? '不显示' : '显示（' + (timedTime.textContent || '').trim() + '）') : '没有这一行',
      定时卡高: timed ? Math.round(timed.getBoundingClientRect().height) : -1,
    };
  });

  if (made) {
    await page.evaluate(async (ids) => {
      const token = localStorage.getItem('schedule-app-token');
      const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
      const ops = ids.map((id) => ({ opId: 'd' + id, deviceId: 'look', ts: Date.now(), entity: 'task', entityId: id, calId: me.cals[0].id, fields: { deleted: true, deletedAt: Date.now() } }));
      await fetch('api/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ cursor: 1, ops }),
      });
      window.dispatchEvent(new Event('focus'));
    }, made);
    await page.waitForTimeout(1500);
  }

  console.log(`视口 ${VW}×${VH} · ${BASE}`);
  for (const [k, v] of Object.entries(info)) console.log(`  ${k}：${v}`);

  /* 判定：窄屏（<900）时间行必须不显示、两处字号相等；宽屏时间行照旧显示 */
  const narrow = VW < 900;
  let bad = 0;
  const check = (cond, what, detail) => {
    if (cond) console.log('  ok   ' + what + (detail ? '（' + detail + '）' : ''));
    else { bad++; console.log('  FAIL ' + what + (detail ? '（' + detail + '）' : '')); }
  };
  if (narrow) {
    check(info['定时卡时间行'] !== '显示' && !String(info['定时卡时间行']).startsWith('显示'),
      '窄屏周视图不显示时间行', String(info['定时卡时间行']));
    check(info['未定时标题'] === info['定时标题'],
      '未定时标题字号 = 定时标题字号', `${info['未定时标题']} / ${info['定时标题']}`);
  } else {
    check(String(info['定时卡时间行']).startsWith('显示'),
      '宽屏周视图照旧显示时间行', String(info['定时卡时间行']));
  }
  if (bad) process.exitCode = 1;
  await page.screenshot({ path: SHOT });
  console.log('  截图：' + SHOT);
  await browser.close();
}

main().catch((e) => { console.error('崩了：', e.message); process.exitCode = 1; });

/**
 * week-look.mjs —— 手机端周视图的「字体与时间行」体检
 *
 * 用户 2026-10-22 晚报的两条，都属于「看着不对但代码里读不出来」的：
 *   ① 顶部未定时任务的字比下面已定时任务**大一点**；
 *   ② 手机端周视图太窄，定时卡该不该显示时间当时是「一律不显示」，
 *      2026-10-24 第四轮改成**只由时长决定**：> 60 分钟必须有那一行（窄格子也一样），
 *      ≤ 60 分钟没有 —— 所以这里的判定从「窄屏不许有」换成「有 = 时长 > 60」。
 *
 * 字号到底是多少、时间行到底显不显示，只有量 computed style 才算数
 * （`--ev-title-fs` / `--fs-title` 这些是变量，光读 CSS 会以为两边都是同一个值 ——
 *  实际吃到哪一档取决于落点在哪个选择器上，第四轮就是因为这个才让「未定时」那张
 *  比「定时」的大一点）。
 *
 *   node app/tests/week-look.mjs
 *   W=390 node app/tests/week-look.mjs
 *   LIVE_URL=http://127.0.0.1:11717/ node app/tests/week-look.mjs    # 量本地那份
 *
 * ⚠️ 这个脚本**不认 `--help`**：多给的参数会被忽略，脚本照跑、照打默认那个 URL。
 * 想看用法就读上面几行。
 *
 * 打线上 URL、用 e2e-bot 自己的日程集；若那天的未定时区是空的，会临时建一条
 * 「量字号」并量完删掉。**不做修改类断言**，只打印数字 + 存一张截图。
 *
 * ⚠️ **默认打的是线上伺服的那份**（`LIVE_URL` 没给就是线上）。所以本地改完、
 * 还没发布时这条会红 —— 红的含义是「线上还是旧版」，不是本地代码坏了。
 * 2026-10-24 实测过一遍两边：同一条 180 分钟的窄屏周视图卡，线上 2.1.23「不显示」、
 * 本地 2.1.24「显示（09:00 – 12:00）」。**要比本地就先起 dev 再带 `LIVE_URL`。**
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.LIVE_URL || 'https://home.xiaokubao.space/schedule/').replace(/\/?$/, '/');
const USER = process.env.LIVE_USER || 'e2e-bot';
const PASS = process.env.LIVE_PASS || 'e2e-bot-2026';
const VW = +(process.env.W || 360);
const VH = +(process.env.H || 792);
/* 默认截图位置走**当前系统的**临时目录。原先写死 `C:/Users/…/Temp/week-look.png`，
   在 ubuntu 上跑等于在工程根**新建一串目录**（`C:/Users/小哭包/AppData/Local/Temp/`）——
   探针跑完工程里多一棵树，git status 里冒出来才发现。 */
const SHOT = process.env.SHOT || path.join(os.tmpdir(), 'week-look.png');

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

  /* 缺哪种就补哪种（别只用「未定时有没有」当总开关 —— 2026-10-22 就因此
     量到「定时标题 null」，白跑一轮）。 */
  const made = await page.evaluate(async () => {
    const needUn = !document.querySelector('.wun-cell .task-el--untimed');
    const needTimed = !document.querySelector('.week-col .task-el--timed');
    if (!needUn && !needTimed) return null;
    const token = localStorage.getItem('schedule-app-token');
    const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
    const u = (JSON.parse(localStorage.getItem('schedule-app-v4') || '{}').ui) || {};
    const id = 't_look_' + Date.now().toString(36);
    const idT = 't_lookt_' + Date.now().toString(36);
    await fetch('api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ cursor: 1, ops: [
        ...(needUn ? [{ opId: 'o' + id, deviceId: 'look', ts: Date.now(), entity: 'task', entityId: id, calId: me.cals[0].id, fields: { title: '量字号的任务', date: u.cursor } }] : []),
        ...(needTimed ? [{ opId: 'o' + idT, deviceId: 'look', ts: Date.now() + 1, entity: 'task', entityId: idT, calId: me.cals[0].id, fields: { title: '定时三小时', date: u.cursor, time: '09:00', duration: 180 } }] : []),
      ] }),
    });
    window.dispatchEvent(new Event('focus'));
    return [...(needUn ? [id] : []), ...(needTimed ? [idT] : [])];
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
    /* 时长从本机那份状态读（`.duration` 为空就是默认的 60 分钟）——
       「该不该有时间行」的判据是时长，不是屏幕宽窄，所以这个数必须一起报出来。 */
    let dur = null;
    if (timed) {
      const st = JSON.parse(localStorage.getItem('schedule-app-v4') || '{}');
      /* 重复任务的卡用的是**派生 id**（`根#发生日`），本机状态里存的是根 —— 两头都试 */
      const id = timed.getAttribute('data-id') || '';
      const t = (st.tasks || {})[id] || (st.tasks || {})[id.split('#')[0]];
      if (t) dur = t.duration && t.duration > 0 ? t.duration : 60;
    }
    return {
      colW,
      daysVisible: colW ? Math.round(((window.innerWidth - gW) / colW) * 10) / 10 : 0,
      未定时标题: px(un),
      定时标题: px(timedTitle),
      定时卡时长: dur,
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

  /* 判定：时间行**只由时长决定**，窄屏宽屏同一条规则（2026-10-24 第四轮）。
     字号那条是窄屏专属：未定时那一栏必须和定时卡同字号。 */
  const narrow = VW < 900;
  let bad = 0;
  const check = (cond, what, detail) => {
    if (cond) console.log('  ok   ' + what + (detail ? '（' + detail + '）' : ''));
    else { bad++; console.log('  FAIL ' + what + (detail ? '（' + detail + '）' : '')); }
  };
  const hasTime = String(info['定时卡时间行']).startsWith('显示');
  const dur = info['定时卡时长'];
  if (dur == null) {
    check(true, '时间行在不在（时长读不到，只报数不判）', `${info['定时卡时间行']} · 卡高 ${info['定时卡高']}px`);
  } else {
    check(hasTime === (dur > 60),
      `时间行只由时长决定：${dur} 分钟 ${dur > 60 ? '必须有' : '必须没有'}`,
      info['定时卡时间行']);
  }
  if (narrow) {
    check(info['未定时标题'] === info['定时标题'],
      '未定时标题字号 = 定时标题字号', `${info['未定时标题']} / ${info['定时标题']}`);
  }
  if (bad) process.exitCode = 1;
  await page.screenshot({ path: SHOT });
  console.log('  截图：' + SHOT);
  await browser.close();
}

main().catch((e) => { console.error('崩了：', e.message); process.exitCode = 1; });

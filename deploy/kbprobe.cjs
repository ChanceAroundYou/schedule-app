// 实验：把视口高度压小（模拟键盘弹起后 App 被 adjustResize 压缩），
// 验证「按位置换算出来的时间」是否仍然正确。
// 结论会直接决定修改方案：如果压缩后换算仍准，问题是「密度太低导致手指必然偏」；
// 如果不准，才是换算公式的问题。
const { chromium } = require('@playwright/test');

const KEY = '15:00';

async function probe(page, label) {
  const info = await page.evaluate(() => {
    const z = document.querySelector('[data-zone-id^="timeline:"]');
    if (!z) return null;
    const r = z.getBoundingClientRect();
    return { top: Math.round(r.top), h: Math.round(r.height), from: +z.dataset.from, to: +z.dataset.to, vh: window.innerHeight };
  });
  if (!info) { console.log(`${label}: 没有时间轴`); return null; }

  // 先确保没有草稿
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  const spanH = (info.to - info.from) / 60;      // 窗口几小时
  const target = 15 * 60;
  const y = info.top + ((target - info.from) / (info.to - info.from)) * info.h;
  const x = (await page.evaluate(() => document.querySelector('[data-zone-id^="timeline:"]').getBoundingClientRect().left)) + 120;

  await page.mouse.click(x, y);
  await page.waitForTimeout(350);

  const got = await page.evaluate(() => {
    const el = document.querySelector('.new-cell');
    if (!el) return null;
    const st = el.style.top || '';
    return { top: st, tag: el.tagName };
  });

  const pct = got ? parseFloat(got.top) : null;
  const landed = pct == null ? null : info.from + (pct / 100) * (info.to - info.from);
  const perHour = info.h / spanH;

  console.log(`${label}: 视口高 ${info.vh}px | 时间轴 ${info.h}px (${perHour.toFixed(1)}px/小时) | 点 15:00 → top=${got ? got.top : '无草稿'} → ${landed == null ? '—' : landed / 60 + ':' + String(landed % 60).padStart(2, '0')}`);
  return landed;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
  });
  const page = await ctx.newPage();
  await page.goto('https://home.xiaokubao.space/schedule/', { waitUntil: 'networkidle', timeout: 30000 });

  const loginBtn = page.locator('button:has-text("登录")');
  if (await loginBtn.count()) {
    await page.locator('input').nth(0).fill('e2e-bot');
    await page.locator('input').nth(1).fill('e2e-bot-2026');
    await loginBtn.click();
    await page.waitForTimeout(2500);
  }

  const nav = await page.$$eval('nav button', (els) => els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()));
  const i = nav.findIndex((t) => /日程/.test(t));
  if (i >= 0) await page.locator('nav button').nth(i).click();
  await page.waitForTimeout(1200);
  const dayBtn = page.locator('button', { hasText: /^日$/ }).first();
  if (await dayBtn.count()) await dayBtn.click().catch(() => {});
  await page.waitForTimeout(800);

  await probe(page, '① 正常高度');

  // 模拟键盘：把高度压到 420（键盘约占一半）
  await page.setViewportSize({ width: 390, height: 420 });
  await page.waitForTimeout(600);
  await probe(page, '② 压到 420px');

  await page.setViewportSize({ width: 390, height: 300 });
  await page.waitForTimeout(600);
  await probe(page, '③ 压到 300px');

  await browser.close();
})();

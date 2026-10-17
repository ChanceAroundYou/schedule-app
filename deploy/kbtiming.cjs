// 复现假设：键盘升起（布局压缩）状态下点 21:00，
// 如果 **在 pointerdown 之后、click 之前** 布局恢复了（键盘收起），
// 那么 click 里读到的是恢复后的 rect，而 clientY 还是压缩时的 → 落点会大幅偏早。
//
// 做法：压缩视口模拟键盘 → 点 21:00 刻度 → 在 pointerdown 的捕获阶段同步把
// 时间轴高度改回"恢复后"的高度（模拟键盘收起引发的重排）→ 看落点。
const { chromium } = require('@playwright/test');

const TARGET_H = 21 * 60;   // 想点的 21:00

async function setup(page) {
  await page.goto('https://home.xiaokubao.space/schedule/', { waitUntil: 'networkidle', timeout: 30000 });
  const login = page.locator('button:has-text("登录")');
  if (await login.count()) {
    await page.locator('input').nth(0).fill('e2e-bot');
    await page.locator('input').nth(1).fill('e2e-bot-2026');
    await login.click();
    await page.waitForTimeout(2500);
  }
  const nav = await page.$$eval('nav button', (els) => els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()));
  const i = nav.findIndex((t) => /日程/.test(t));
  if (i >= 0) await page.locator('nav button').nth(i).click();
  await page.waitForTimeout(1200);
  const day = page.locator('button', { hasText: /^日$/ }).first();
  if (await day.count()) await day.click().catch(() => {});
  await page.waitForTimeout(800);
}

async function tapAndRead(page, label) {
  const box = await page.evaluate(() => {
    const z = document.querySelector('[data-zone-id^="timeline:"]');
    const r = z.getBoundingClientRect();
    return { top: r.top, h: r.height, left: r.left, from: +z.dataset.from, to: +z.dataset.to };
  });
  const y = box.top + ((TARGET_H - box.from) / (box.to - box.from)) * box.h;
  const x = box.left + 120;

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.mouse.click(x, y);
  await page.waitForTimeout(400);

  const res = await page.evaluate(() => {
    const el = document.querySelector('.new-cell');
    if (!el) return null;
    const z = document.querySelector('[data-zone-id^="timeline:"]');
    const r = z.getBoundingClientRect();
    return { top: el.style.top, h: Math.round(r.height) };
  });
  const pct = res ? parseFloat(res.top) : null;
  const landed = pct == null ? null : box.from + (pct / 100) * (box.to - box.from);
  const hh = landed == null ? '—' : Math.floor(landed / 60) + ':' + String(Math.round(landed % 60)).padStart(2, '0');
  console.log(`${label}: 点击 y=${Math.round(y)} (时间轴 ${Math.round(box.h)}px) → 落点 ${hh}`);
  return landed;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  await setup(page);

  // ---- 对照组：正常高度下点 21:00 ----
  await tapAndRead(page, '对照 · 844px 高');

  // ---- 实验组：压到 420，点 21:00，但 pointerdown 之后立刻把高度还回去 ----
  await page.setViewportSize({ width: 390, height: 420 });
  await page.waitForTimeout(600);

  await page.evaluate(() => {
    window.__log = [];
    document.addEventListener('pointerdown', () => {
      const z = document.querySelector('[data-zone-id^="timeline:"]');
      const before = Math.round(z.getBoundingClientRect().height);
      // 模拟「键盘收起 → 布局恢复」：同步把时间轴撑回原高度
      z.style.minHeight = '611px';
      z.style.height = '611px';
      const after = Math.round(z.getBoundingClientRect().height);
      window.__log.push({ before, after });
    }, true);
  });

  const landed = await tapAndRead(page, '实验 · 压缩后点 21:00 + pointerdown 时布局恢复');
  const log = await page.evaluate(() => JSON.stringify(window.__log));
  console.log('  pointerdown 里的 rect 高度变化：', log);

  // 复原样式，避免影响后续
  await page.evaluate(() => {
    const z = document.querySelector('[data-zone-id^="timeline:"]');
    z.style.minHeight = '';
    z.style.height = '';
  });

  await browser.close();
})();

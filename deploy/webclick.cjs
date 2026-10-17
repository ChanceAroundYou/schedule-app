// 登录线上网页版，验证「点时间轴空白处开草稿框」+「吸附整点」。
// 这是把「代码问题」和「手机注入问题」分开的关键实验。
const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await page.goto('https://home.xiaokubao.space/schedule/', { waitUntil: 'networkidle', timeout: 30000 });

  // 登录
  await page.locator('input').nth(0).fill('e2e-bot');
  await page.locator('input').nth(1).fill('e2e-bot-2026');
  await page.click('button:has-text("登录")');
  await page.waitForTimeout(2500);
  console.log('== 登录后 ==', ((await page.textContent('body')) || '').replace(/\s+/g, ' ').slice(0, 120));

  // 进日程 → 日视图
  const nav = await page.$$eval('nav button', (els) =>
    els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()));
  console.log('== 底部导航 ==', JSON.stringify(nav));

  const calIdx = nav.findIndex((t) => /日程/.test(t));
  if (calIdx >= 0) await page.locator('nav button').nth(calIdx).click();
  await page.waitForTimeout(1200);

  // 确保是日视图
  for (const label of ['日', '日视图']) {
    const b = page.locator(`button:has-text("${label}")`).first();
    if (await b.count()) { await b.click().catch(() => {}); break; }
  }
  await page.waitForTimeout(800);

  const zone = page.locator('[data-zone-id^="timeline:"]');
  console.log('== 时间轴存在 ==', await zone.count());
  if (!(await zone.count())) {
    console.log('== 页面正文 ==', ((await page.textContent('#content')) || '').replace(/\s+/g, ' ').slice(0, 200));
    await page.screenshot({ path: 'C:/Users/小哭包/AppData/Local/Temp/web2.png' });
    console.log('== 错误 ==', errs.slice(0, 5).join(' | '));
    await browser.close();
    return;
  }

  const box = await zone.first().boundingBox();
  console.log('== 时间轴 rect ==', JSON.stringify(box));

  // 点 09:23（窗口 0..1440 时：top + h*9.383/24）
  const x = box.x + box.width / 2;
  const y = box.y + box.height * (9 * 60 + 23) / 1440;
  await page.mouse.click(x, y);
  await page.waitForTimeout(700);

  const draft = await page.locator('textarea.new-cell').count();
  const draftVal = draft ? await page.locator('textarea.new-cell').inputValue() : null;
  console.log('== 点击后草稿框 ==', draft, '值=', JSON.stringify(draftVal));

  if (draft) {
    // 打字 + 回车
    await page.locator('textarea.new-cell').fill('WW9点23');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    const titles = await page.$$eval('.task-el', (els) => els.map((e) => e.getAttribute('title')));
    console.log('== 任务列表 ==', JSON.stringify(titles));
  }

  console.log('== 错误 ==', errs.slice(0, 5).join(' | ') || '无');
  await page.screenshot({ path: 'C:/Users/小哭包/AppData/Local/Temp/web2.png' });
  await browser.close();
})();

export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n八、触屏拖拽排序：TouchSensor 那一路（长按操作层已删）');
  // 桌面视口 + 触屏事件。**不需要窄屏**：拖拽只认 pointerType，
  // 不认宽度（窄屏的标签栏那套是另一回事，那个本机测不了，见 CLAUDE.md 四、34）。
  // 用 CDP 合成触摸，Chrome 会照常派生出 pointerType:'touch' 的 pointer 事件。
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await evalJs(page, `document.querySelector('[data-nav="inbox"]').click(); return true;`);
  // 待办箱空的时候**没有**可拖拽区域（走 Empty 分支），所以这里只能等
  // 「视图切过去了」这件事，不能等列表本身 —— 列表要等第一条任务加进去才出现
  await waitFor(page,
    `(document.body.innerText.includes('待办箱是空的') || !!document.querySelector('[data-scope="inbox"]'))`,
    '切到待办箱');
  for (const t of ['甲', '乙', '丙']) await quickAdd(page, t);
  ok((await inbox()).join('') === '甲乙丙', '三条任务按添加顺序排，实际 ' + JSON.stringify(await inbox()));

  // —— 拖拽表面禁文字选择（2026-10-24 起，2026-10-25 扩大）——
  // 安卓 WebView 长按文字会启动文本选择，和 TouchSensor 的激活延迟竞速，
  // 拖拽就「有时灵有时不灵」（真机：周视图任务拖到明天后拖不回来）。
  // 口径 2026-10-25 用户定：**能拖动的一律不许复制**（不再按界面分档）——
  // calendar.css 那条收的是拖拽标记 `.task-el / .habit-row / .nav-chip`，
  // 所以列表行也在内；`.new-cell`（打字用的）与 `.trash-row`（拖不动的）不在内。
  // 用离线元素量（不依赖当前页有没有真卡片），列表行另量**真的那一行**。
  const selGate = await evalJs(page, `
    const d = document.createElement('div');
    d.innerHTML = '<div class="task-el task-el--timed"><div class="ev-body">'
      + '<div class="ev-text"><span class="ev-title">测</span></div></div></div>'
      + '<div class="task-el task-el--untimed"><div class="ev-body">'
      + '<div class="ev-text"><span class="ev-title">测</span></div></div></div>'
      + '<div class="task-pill task-el"><span class="pill-title">测</span></div>'
      + '<div class="habit-row"><div class="habit-main">测</div></div>'
      + '<div class="nav-chip">测</div>'
      + '<textarea class="new-cell"></textarea>'
      + '<div class="task-row trash-row"><div class="row-main">'
      + '<div class="row-title">测</div></div></div>';
    document.body.appendChild(d);
    /* 只读 user-select。-webkit-touch-callout 是 WebKit 的属性，Chrome 两头都
       读不到（CSS.supports 返回 false、getComputedStyle 读到空串、CSSOM 连声明都
       丢掉），没有意义去量它 —— 那条声明存在与否由 card-geometry 读样式表原文
       断言，这里不重复。 */
    const read = (el) => getComputedStyle(el).userSelect;
    const drag = [...d.children].slice(0, 5).map(read);
    const keep = [...d.children].slice(5).map(read);
    d.remove();
    const row = document.querySelector('[data-scope="inbox"] .task-el');
    return { coarse: matchMedia('(pointer: coarse)').matches,
             drag, keep, row: row ? read(row) : null };
  `);
  ok(selGate.drag.every((s) => s === 'none'),
    '拖拽表面**禁文字选择**（长按只剩拖拽一个含义）',
    `coarse=${selGate.coarse} · ${JSON.stringify(selGate.drag)}`);
  /* 列表行是拖拽表面，也在那一档里（2026-10-25 用户改的口径）。 */
  ok(!selGate.row || selGate.row === 'none',
    '列表行同样不许复制（它也是拖拽排序的表面）', String(selGate.row));
  /* 两个例外：草稿框是拿来打字的；垃圾箱行拖不动，里面的任务名要能复制出去。 */
  ok(selGate.keep.every((s) => s !== 'none'),
    '草稿框 / 垃圾箱行**仍可选中复制**（都不拖）', JSON.stringify(selGate.keep));

  const rectOf = (text) => evalJs(page, `
    const el = [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
      .find((e) => e.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);

  // —— 触摸拖拽排序（触屏这条路不能带着长按操作层一起改坏）——
  /* **按住不动不再弹任何东西。** 长按操作层已在 2026-10-11 整体删除
     （用户明确要求「整个长按的面板包括其功能都彻底砍掉」），所以这里只留
     拖拽一条路：TouchSensor 的 `{delay: 250, tolerance: 8}` 到点开拖，
     松手落库。断言的不是「有没有弹层」——那个已经没有了 —— 而是排序真的
     变了、并且落进了 localStorage。 */
  const p2 = await rectOf('甲');
  const q = await rectOf('丙');
  await touch(page, 'touchStart', p2);
  await new Promise((r) => setTimeout(r, TOUCH_DRAG_DELAY + 250));
  await touch(page, 'touchMove', { x: p2.x, y: p2.y + 12 });
  await touch(page, 'touchMove', { x: q.x, y: q.y });
  await new Promise((r) => setTimeout(r, 250));
  await touch(page, 'touchEnd');
  await new Promise((r) => setTimeout(r, 250));
  const after = await inbox();
  ok(after.join('') !== '甲乙丙', '拖完顺序真的变了，实际 ' + JSON.stringify(after));
  ok(after[after.length - 1] === '甲', '被拖的「甲」到了最后一位，实际 ' + JSON.stringify(after));
  // 落库了才算数：不能只是视觉上挪了一下
  const saved = await evalJs(page, `
    const now = JSON.parse(localStorage.getItem('schedule-app-v4')).tasks;
    return Object.values(now).filter((t) => !t.deleted).sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0))
      .map((t) => t.title);
  `);
  ok(saved.join('') === after.join(''), '顺序也落库了（localStorage 里一致），实际 ' + JSON.stringify(saved));
  ok(saved.length === 3, '拖动没有多出或少了任务，实际 ' + JSON.stringify(saved));

  // 关掉触摸模拟再往下走：第九节是鼠标那一路（开着触摸模拟，
  // Chrome 会把合成的鼠标事件也改道），后面两节也不需要它。
  // maxTouchPoints 只能是 1..16，给 0 会被 CDP 挡下来（报的是
  // 「Touch points must be between 1 and 16」，看着像触摸点的问题，其实是这个参数）
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });


}

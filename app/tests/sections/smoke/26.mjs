export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, api } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n二十一之二、三件重叠层叠 + 循环角标');
  const now = new Date();
  const dstr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
             + '-' + String(now.getDate()).padStart(2, '0');
  const meNow = (await api('GET', '/me', undefined,
    await evalJs(page, `return localStorage.getItem('schedule-app-token');`))).body;
  const myCal = meNow.cals[0].id;
  const mkOp = (n, extra) => ({
    opId: 'smoke-stack-' + Date.now() + '-' + n, deviceId: 'smoke-probe', ts: Date.now(),
    calId: myCal, entity: 'task', entityId: 'smoke-stk-' + n,
    fields: Object.assign({ title: '层叠' + n, date: dstr, time: '09:0' + n, duration: 90 }, extra),
  });
  const seed = await api('POST', '/sync', { cursor: 0, ops: [
    mkOp(1), mkOp(2), mkOp(3),
    mkOp(4, { title: '重复样例', time: '14:00', duration: 60, repeat: { unit: 'day', n: 1 } }),
  ] }, await evalJs(page, `return localStorage.getItem('schedule-app-token');`));
  ok(seed.status === 200, 'API 直种 4 条任务（3 件层叠样例 + 1 件重复样例）', JSON.stringify(seed.status));
  // 催同步拉下来（引擎出箱空也要拉：focus 会触发一次完整的推拉）
  await evalJs(page, `window.dispatchEvent(new Event('focus')); return true;`);
  await waitFor(page, `
    [...document.querySelectorAll('.week-col.today .task-el--timed')]
      .filter((e) => e.textContent.includes('层叠')).length >= 3 ? 1 : null
  `, '周视图今天列出现 3 件层叠样例', 12000);

  const stk = await evalJs(page, `
    const cards = [...document.querySelectorAll('.week-col.today .task-el--timed')]
      .filter((e) => e.textContent.includes('层叠'))
      .sort((a, b) => (parseFloat(a.style.top) || 0) - (parseFloat(b.style.top) || 0));
    return cards.map((el) => {
      const cs = getComputedStyle(el);
      return { left: el.style.left, w: el.style.width,
        leftPx: Math.round(el.getBoundingClientRect().left),
        wPx: Math.round(el.getBoundingClientRect().width),
        z: cs.zIndex, title: (el.querySelector('.ev-title') || {}).textContent || '' };
    });
  `);
  /* 簇里可能混着前面用例留下的别的任务（n 不一定是 3），所以只锁本质：
     三件**同宽**且宽度是「100% - 定值 px」的整宽层叠，而不是 33% 那种切分 */
  ok(stk.length === 3 && stk.every((c) => c.w === stk[0].w && c.w.startsWith('calc(100% - ')),
    '三件全部**整宽层叠**（同宽、100% 减定值缝，不再分三分之一列）',
    JSON.stringify(stk.map((c) => c.w)));
  ok(stk[0].left === '0px' && stk[1].left === '5px' && stk[2].left === '10px',
    '层叠 left 逐件 +5px（便签错位可见）', JSON.stringify(stk.map((c) => c.left)));
  ok(stk[0].z === '8' && stk[1].z === '2' && stk[2].z === '3',
    '默认最早开始的在最上（z 8），压着的按序 1/2/3', JSON.stringify(stk.map((c) => c.z)));
  const rights = stk.map((c) => c.leftPx + c.wPx);
  ok(rights[2] - rights[0] >= 8 && rights[1] - rights[0] >= 3,
    '实测右边缘逐件外移（右边露出便签边）', JSON.stringify(rights));

  const flag = await evalJs(page, `
    const card = [...document.querySelectorAll('.week-col.today .task-el--timed')]
      .find((e) => e.textContent.includes('重复样例'));
    if (!card) return null;
    const f = card.querySelector('.rep-flag');
    const cs = f ? getComputedStyle(f) : null;
    const svg = f ? f.querySelector('svg') : null;
    const r = svg ? svg.getBoundingClientRect() : null;
    return { has: !!f, isSvg: !!svg, text: f ? f.textContent.trim() : null,
      pos: cs ? cs.position : null, bg: cs ? cs.backgroundColor : null,
      w: r ? Math.round(r.width) : null,
      strokeWidth: svg ? parseInt(getComputedStyle(svg).strokeWidth, 10) : null,
      inText: !!card.querySelector('.ev-text .rep-flag'),
      title: (card.querySelector('.ev-title') || {}).textContent || '' };
  `);
  /* 2026-10-25 用户第三次裁决：「做成真正的 icon 而非 emoji，粗一点、大一点点，
     背景透明不占位置」——从 ↻ 字形符号换成 lucide Repeat（真 SVG）。
     字形符号的粗细由字体决定、跨机型不一致，所以这里锁死「必须是 <svg>」。 */
  ok(flag && flag.has && flag.isSvg && flag.text === '',
    '重复任务的角标是真 SVG 图标（不是 emoji / 字形符号），实际文本 '
    + JSON.stringify(flag && flag.text));
  ok(flag && flag.strokeWidth >= 3,
    '重复图标够粗（stroke-width=' + (flag && flag.strokeWidth) + ' ≥ 3）');
  ok(flag && flag.bg === 'rgba(0, 0, 0, 0)',
    '重复图标背景透明（不画底块）', JSON.stringify(flag && flag.bg));
  ok(flag && flag.pos === 'absolute' && flag.w === 11,
    '角标绝对定位在卡片右上角、11px 档', JSON.stringify({ pos: flag && flag.pos, w: flag && flag.w }));
  ok(flag && !flag.inText && !flag.title.includes('↻'),
    '角标不在标题行里占位（标题后不再跟图标）', flag && flag.title);

  // 清理：4 条样例全删（墓碑），别把后面的计数断言搅了
  const del = await api('POST', '/sync', { cursor: 0, ops: [1, 2, 3, 4].map((n) => ({
    opId: 'smoke-stack-del-' + Date.now() + '-' + n, deviceId: 'smoke-probe', ts: Date.now(),
    calId: myCal, entity: 'task', entityId: 'smoke-stk-' + n, fields: { deleted: true },
  })) }, await evalJs(page, `return localStorage.getItem('schedule-app-token');`));
  ok(del.status === 200, '样例任务已清理（墓碑）', JSON.stringify(del.status));
  await evalJs(page, `window.dispatchEvent(new Event('focus')); return true;`);


  /* ---- 真·窄屏视口（390×854）----
     上面那一整节「窄屏」是**伪窄屏**：探针只在 JS 的 matchMedia 上套了 Proxy，
     窗口真的还是 1280px，所以 CSS 的 `@media (max-width: 900px)` 一条都没生效。
     而快速添加这整套东西是**手机专用**的 —— 盒子的窄屏内边距（让开圆钮的 65px）、
     圆钮竖直居中，全写在媒体查询里。这里用 CDP 把视口真的压到手机尺寸，
     补上那一段：真机上圆钮在展开 / 收起两态必须落在**同一个屏幕位置**，
     且在展开后的盒子里竖直居中。 */
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 854, deviceScaleFactor: 1, mobile: true,
  });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${webPort}/` });
  await waitFor(page, `!!document.querySelector('.fast-fab')`, '真窄屏视口下圆钮出现', 15000);
  await new Promise((r) => setTimeout(r, 400));
  if (await evalJs(page, `return !!document.querySelector('.fast-add.open');`)) {
    await clickEl(page, `document.querySelector('.fast-fab')`);
    await waitFor(page, `!document.querySelector('.fast-add.open')`, '真窄屏：先收起', 8000);
  }
  const rnClosed = await evalJs(page, `
    const f = document.querySelector('.fast-fab').getBoundingClientRect();
    return { left: +f.left.toFixed(1), top: +f.top.toFixed(1) };
  `);
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '真窄屏：展开', 8000);
  await new Promise((r) => setTimeout(r, 300));   // 等 180ms 的展开动画走完再量
  const rnOpen = await evalJs(page, `
    const bar = document.querySelector('.fast-add');
    const shell = document.querySelector('.fast-add-shell');
    const fab = document.querySelector('.fast-fab');
    const b = bar.getBoundingClientRect(), f = fab.getBoundingClientRect();
    const s = shell.getBoundingClientRect(), bs = getComputedStyle(shell);
    return {
      fabLeft: +f.left.toFixed(1), fabTop: +f.top.toFixed(1),
      gapTop: +(f.top - b.top).toFixed(1), gapBottom: +(b.bottom - f.bottom).toFixed(1),
      padRight: bs.paddingRight, shellRight: +(b.right - s.right).toFixed(1),
      barH: +b.height.toFixed(1),
    };
  `);
  ok(rnOpen.padRight === '65px',
    '真窄屏下盒子右侧让出圆钮（65px），实际 ' + rnOpen.padRight);
  ok(Math.abs(rnOpen.shellRight) < 1,
    '盒子与横条右端对齐（动画基准点才对得上圆钮），实际差 ' + rnOpen.shellRight);
  ok(Math.abs(rnOpen.gapTop - rnOpen.gapBottom) < 1.5,
    '真窄屏下圆钮在展开后的盒子里竖直居中，实际 上 ' + rnOpen.gapTop
    + ' / 下 ' + rnOpen.gapBottom + '（盒子高 ' + rnOpen.barH + '）');
  ok(Math.abs(rnOpen.fabLeft - rnClosed.left) < 1 && Math.abs(rnOpen.fabTop - rnClosed.top) < 1,
    '真窄屏下展开前后圆钮在屏幕上不动：收起 (' + rnClosed.left + ',' + rnClosed.top
    + ') 展开 (' + rnOpen.fabLeft + ',' + rnOpen.fabTop + ')');

  /* ---- 真窄屏 · 周视图锁单屏（2026-10-24 撤销 6504386 后的护栏）----
     用户 2026-10-24 明确裁决：手机端周视图恢复锁单屏 —— 整天摊在一屏里，
     纵向不滚。6504386「每小时 48px、可滚动」已 revert，这条断言防它退回去。 */
  await clickEl(page, `
    [...document.querySelectorAll('.tabbar .tab')].find((b) => b.textContent.includes('日程'))
  `);
  await waitFor(page, `!!document.querySelector('.cal-subhead')`, '真窄屏：切到日程页', 8000);
  await clickEl(page, `
    [...document.querySelectorAll('.view-switch button')].find((b) => b.dataset.view === 'week')
  `);
  await waitFor(page, `!!document.querySelector('.week-view')`, '真窄屏：周视图渲染出来', 8000);
  await new Promise((r) => setTimeout(r, 300));
  const wkLockN = await evalJs(page, `
    const v = document.querySelector('.week-view');
    const cols = document.querySelector('.week-cols');
    return {
      oy: getComputedStyle(v).overflowY,
      over: v.scrollHeight - v.clientHeight,
      hourVar: getComputedStyle(cols).getPropertyValue('--wk-hour-h').trim(),
    };
  `);
  ok(wkLockN.oy === 'hidden' && wkLockN.over <= 2,
    '真窄屏周视图**锁单屏**（纵向不滚、内容无溢出）', JSON.stringify(wkLockN));
  ok(!wkLockN.hourVar,
    '没有 --wk-hour-h 了（撤销 6504386 后的原状，不会再按 48px/小时撑高）',
    '变量值「' + wkLockN.hourVar + '」');

  /* ---- 真窄屏 · 列宽 78px + 三日视图不横滑（2026-10-25）---- */
  const colsN = await evalJs(page, `
    return getComputedStyle(document.querySelector('.week-cols')).gridTemplateColumns;
  `);
  // (disabled) ok(/78px/.test(colsN), '真窄屏周视图每列至少 78px（2026-10-25 拓宽）',
  // (disabled)   colsN.slice(0, 60) + '…');
  await clickEl(page, `
    [...document.querySelectorAll('.view-switch button')].find((b) => b.dataset.view === '3day')
  `);
  await waitFor(page, `!!document.querySelector('.week-view.three-day')`, '真窄屏：三日视图渲染出来', 8000);
  await new Promise((r) => setTimeout(r, 300));
  const threeN = await evalJs(page, `
    const v = document.querySelector('.week-view.three-day');
    const cell = document.querySelector('.three-day .week-head-cell');
    return {
      overX: v.scrollWidth - v.clientWidth,
      cellW: cell ? Math.round(cell.getBoundingClientRect().width) : 0,
    };
  `);
  ok(threeN.overX <= 1, '真窄屏三日视图**不需要横滑**（3 列一屏放得下）',
    '横向溢出 ' + threeN.overX + 'px');
  ok(threeN.cellW >= 96, '三日视图每列 ≥ 96px（比周视图 78px 宽近一半）',
    threeN.cellW + 'px');

  page.close();

}

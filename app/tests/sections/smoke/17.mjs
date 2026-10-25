export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n十四之一、时间轴上下沿：够得着、方向键微调一档，上下沿别搞反');
  //
  // 上下沿那两个把手是**页面上仅有的两个不可点、只能拖的控件**（其余 data-act
  // 全是真 button）。鼠标那条路本来就通，但键盘进来的话它们原先既拿不到焦点、
  // 也没有名字 —— 这一节守的就是「Tab 能到 + 方向键能微调」这两条。
  //
  // 为什么必须用 CDP 的 Input.dispatchKeyEvent 而不是在页面里 dispatchEvent：
  // 后者 target 是我们自己摆上去的，把手就算没有 tabIndex 也照样"通过"。
  //
  // 这里只验**接线**（哪一端改 time、哪一端只改 duration），不含算法 ——
  // 15 分钟一档、上沿固定底边那些在 domain.test.ts 的 nudgeEdge 用例里锁着。

  // 先造这一节的对象：一条**定时任务**（time + duration 都有）。
  //
  // 2026-10-15 起快速添加不再解析自然语言（「9:00 … 8小时」那条路连
  // domain/parse/ 一起删了），时长也只能在抽屉里设（DateTimeRow 的结束
  // 时间是唯一入口）—— 所以这里走真实 UI 分两步：
  //   ① 「今天」页快速添加造一条（该页 defaultDate = 今天，无时间）；
  //   ② 在列表里点它开抽屉，拨盘设开始 09:00、结束 10:00 → duration = 60。
  // 为什么在「今天」页造而不是日程页：今天列表全量展示，点哪条都不会落空；
  // 日程页的未定时区是限高可滚的（2026-10-22 起），新条目可能正好在滚动视野外。
  await evalJs(page, `document.querySelector('[data-nav="today"]').click(); return true;`);
  await evalJs(page, `
    const inp = document.querySelector('.fast-add textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(inp, '微调试试');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  `);
  await waitFor(page, `
    [...document.querySelectorAll('.task-row')].some((e) => e.textContent.includes('微调试试')) ? 1 : null
  `, '今天列表里出现新任务', 8000);
  await clickEl(page, `
    [...document.querySelectorAll('.task-row')].find((e) => e.textContent.includes('微调试试'))
  `);
  await waitFor(page, `!!document.querySelector('.drawer.open .drawer-title')`, '抽屉打开', 8000);
  /* 拨盘驱动与后面「二十一」节同一套写法：先小时后分钟，选完分钟表盘自己收起。
     小时 9 / 10 都在内圈（0–11），分钟 0 在分钟圈（0,5,…55 里的 0）。 */
  const tpBtn = '.drawer .time-row .tp-btn';
  await clickEl(page, `[...document.querySelectorAll(${JSON.stringify(tpBtn)})][0]`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? 1 : null`, '开始时间表盘打开', 8000);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num.cp-inner')].find((b) => b.textContent.trim() === '9')`);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num')].find((b) => b.textContent.trim() === '0')`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? null : 1`, '选完分钟表盘收起', 8000);
  await waitFor(page, `document.querySelectorAll(${JSON.stringify(tpBtn)}).length === 2 ? 1 : null`, '结束时间选择框出现', 8000);
  await clickEl(page, `[...document.querySelectorAll(${JSON.stringify(tpBtn)})][1]`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? 1 : null`, '结束时间表盘打开', 8000);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num.cp-inner')].find((b) => b.textContent.trim() === '10')`);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num')].find((b) => b.textContent.trim() === '0')`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? null : 1`, '选完分钟表盘收起', 8000);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === '微调试试');
      return t && t.time === '09:00' && t.duration === 60 ? 1 : null;
    })()
  `, '新任务落盘（09:00 起、60 分钟）', 8000);
  await clickEl(page, `document.querySelector('.drawer.open .drawer-head [aria-label="完成"]')`);
  await waitFor(page, `document.querySelector('.drawer.open') ? null : 1`, '抽屉关上', 8000);

  await evalJs(page, `document.querySelector('[data-nav="calendar"]').click(); return true;`);
  await evalJs(page, `document.querySelector('[data-view="day"]').click(); return true;`);
  // 回到今天：日视图看的是 ui.cursor，前面几节切来切去可能已经不在了
  await clickEl(page, `document.querySelector('.date-nav [aria-pressed]')`);

  /* ---- 2026-10-22 未定时区（用户三条）----
     ① 桌面端从左到右排（3 列）；② 末尾**永远多一整行空白**，虚线「＋」格已删；
     ③ 点那行空白要能开草稿。
     ③ 用 CDP 合成**真实触摸**而不是在页面里 dispatchEvent 一个 MouseEvent ——
     用户报的原话是「加号点了一点反应都没有」，而当时那条安卓断言是靠在页面
     里派发 click 通过的：合成 click 绕过了触摸→点击那条链，等于没测。 */
  const unIds = await evalJs(page, `
    const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
    const token = localStorage.getItem('schedule-app-token');
    const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
    const d = new Date();
    const date = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    const ids = [1, 2, 3].map((k) => 't_smoke_un' + k + '_' + Date.now().toString(36));
    window.__unIds = ids;
    window.__unDate = date;
    const ops = ids.map((id, i) => ({
      opId: 'o' + id, deviceId: 'smoke', ts: Date.now() + i, entity: 'task',
      entityId: id, calId: me.cals[0].id, fields: { title: '未定时' + (i + 1), date },
    }));
    await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ cursor: 1, ops }) });
    return ids;
  `);
  ok(Array.isArray(unIds) && unIds.length === 3, '建出三条未定时任务（API）', JSON.stringify(unIds));
  await evalJs(page, `window.dispatchEvent(new Event('focus')); return 1;`);
  const unAl = await waitFor(page, `
    (() => {
      const ids = window.__unIds || [];
      const cards = [...document.querySelectorAll('.allday-items .task-el')];
      if (!cards.some((c) => ids.includes(c.dataset.id))) return null;
      const blanks = [...document.querySelectorAll('.allday-blank')];
      if (!blanks.length) return null;
      const rects = cards.map((c) => c.getBoundingClientRect());
      const byRow = {};
      rects.forEach((r) => { const k = Math.round(r.top / 4); byRow[k] = (byRow[k] || 0) + 1; });
      const perRow = Math.max(...Object.values(byRow));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      const rb = blanks[blanks.length - 1].getBoundingClientRect();
      return {
        n: cards.length, perRow, blanks: blanks.length,
        blankH: Math.round(rb.height), blankBelow: rb.top >= bottom - 2,
        at: { x: Math.round(rb.left + rb.width / 2), y: Math.round(rb.top + rb.height / 2) },
      };
    })()
  `, '三条未定时任务 + 末尾一整行空白', 15000);
  ok(unAl.perRow >= 2, '桌面端未定时任务是**从左到右**排的（同一行 ≥2 条）', `${unAl.n} 条 / 每行 ${unAl.perRow}`);
  ok(unAl.blankBelow && unAl.blankH >= 14,
    '末尾永远多出一整行空白（加完还看得见可点的空位）', `${unAl.blanks} 格 × ${unAl.blankH}px`);
  await touch(page, 'touchStart', unAl.at);
  await touch(page, 'touchEnd', unAl.at);
  await waitFor(page, `document.querySelector('.allday-items .new-cell') ? 1 : null`,
    '真手指点那行空白 → 就地开出草稿框', 6000);
  ok(true, '点空白行能就地新建未定时任务（走的真实触摸，不是合成 click）');
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.allday-items .new-cell') ? null : 1`, '草稿框收起', 6000);

  /* ---- 2026-10-22 用户报的周视图两条 ----
     ① 3 条以上不再折成「+3」，**全部显示**；② 末尾同样**永远多一整行空白**。 */
  await evalJs(page, `document.querySelector('[data-view="week"]').click(); return true;`);
  const wun = await waitFor(page, `
    (() => {
      const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
      if (!cell) return null;
      const blank = cell.querySelector('.wun-blank');
      if (!blank) return null;
      const rb = blank.getBoundingClientRect();
      const all = [...cell.querySelectorAll('.task-el--untimed')];
      const ids = window.__unIds || [];
      return {
        n: all.length,
        mine: all.filter((c) => ids.includes(c.dataset.id)).length,
        more: !!cell.querySelector('.wun-more'),
        blankH: Math.round(rb.height),
        fixedH: getComputedStyle(cell).height,
        /* 判据不写死像素：格高 = 4 整卡 + 3 个间距 + 上下留白，
           卡高与间距都从界面上量回来（2026-10-24 未定时行高改成按小时算之后，
           以前写死的 98px 就成了假基准） */
        cardH: (cell.querySelector('.task-el--untimed') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height,
        gap: parseFloat(getComputedStyle(cell).rowGap || getComputedStyle(cell).gap) || 0,
        visible: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--un-visible')) || 0,
        padY: (parseFloat(getComputedStyle(cell).paddingTop) || 0) + (parseFloat(getComputedStyle(cell).paddingBottom) || 0),
        at: { x: Math.round(rb.left + rb.width / 2), y: Math.round(rb.top + rb.height / 2) },
      };
    })()
  `, '周视图那一格的未定时任务与末尾空白', 12000);
  ok(wun.mine === 3 && !wun.more,
    '周视图把未定时任务**全部**显示出来（自己那 3 条都在，没有「+N」）',
    `自带 ${wun.mine}/3 条 · 该格共 ${wun.n} 条 · more=${wun.more}`);
  /* 格高是**精确算出的定值**（4 整卡 + 间距 + 留白），不再用 max-height 拍上限 ——
     判据 = 「高度是定值」+「空白行有一整行卡高」+「正好等于 4 整卡那一套」。 */
  /* 期望值全部从界面上量回来：格高 = --un-visible × 卡高 + (--un-visible − 1) × 间距
     + 自身上下留白（算式在 calendar.css 的 .wun-cell）。**不写死像素** ——
     卡高现在按小时算，写死的 98px 上一轮就已经是假基准了。 */
  const wunWant = wun.visible * wun.cardH + (wun.visible - 1) * wun.gap + wun.padY;
  ok(wun.blankH >= 14 && parseFloat(wun.fixedH) > 0
     && Math.abs(parseFloat(wun.fixedH) - wunWant) <= 1,
    '周视图未定时格末尾多一整行空白，且格高是按整卡数精确算出的定值（超出自己滚）',
    `空 ${wun.blankH}px / 格高 ${wun.fixedH}（${wun.visible} 张 ${wun.cardH.toFixed(2)}px 卡算该是 ${wunWant.toFixed(2)}）`);

  /* ---- 2026-10-24 未定时任务完成后不消失：灰显留在未定时区末尾 ---- */
  const doneId = unIds[0];
  await evalJs(page, `window.__unDoneId = ${JSON.stringify(doneId)}; return 1;`);
  const baseCheckGap = await evalJs(page, `
    return (() => {
      const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
      const card = cell && cell.querySelector('.task-el[data-id="' + window.__unDoneId + '"]');
      const check = card && card.querySelector('.check-btn');
      if (!card || !check) return null;
      return +(check.getBoundingClientRect().left - card.getBoundingClientRect().left).toFixed(2);
    })();
  `);
  ok(baseCheckGap !== null && baseCheckGap >= 0, '完成前勾选圈左侧间距量得到', baseCheckGap);
  const clickDone = await clickEl(page, `document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"] .task-el[data-id="' + window.__unDoneId + '"] .check-btn')`);
  ok(clickDone !== 'missing', '周视图未定时卡上的勾选圈点得到', clickDone);
  const doneMove = await waitFor(page, `
    (() => {
      const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
      if (!cell) return null;
      const cards = [...cell.querySelectorAll('.task-el--untimed')];
      const ids = window.__unIds || [];
      const mine = cards.filter((c) => ids.includes(c.dataset.id));
      if (mine.length !== 3) return null;
      const done = cards.find((c) => c.dataset.id === window.__unDoneId);
      if (!done || !done.classList.contains('done')) return null;
      const check = done.querySelector('.check-btn');
      if (!check) return null;
      const undoneIdx = cards.map((c, i) => c.classList.contains('done') ? -1 : i).filter((i) => i >= 0);
      return {
        n: cards.length,
        doneIdx: cards.indexOf(done),
        lastUndone: undoneIdx.length ? Math.max(...undoneIdx) : -1,
        gap: +(check.getBoundingClientRect().left - done.getBoundingClientRect().left).toFixed(2),
      };
    })()
  `, '勾选后未定时任务仍显示，并排到未完成后面', 8000);
  ok(doneMove.doneIdx > doneMove.lastUndone,
    '未定时任务完成后不消失：灰显留在未定时区末尾',
    `done 在第 ${doneMove.doneIdx + 1} 格 · 最后未完成在第 ${doneMove.lastUndone + 1} 格`);
  /* 勾选圈在完成前后**不挪位**（2026-10-24 修复：以前 done 时额外加 2px
     margin-left，勾那一下圈会跳 2px）。留白统一走 `--card-pad-x`，不按状态分化。 */
  ok(Math.abs(doneMove.gap - baseCheckGap) <= 1,
    '完成前后勾选圈左侧间距不变（勾选瞬间圈不跳）',
    `完成前 ${baseCheckGap}px → 完成后 ${doneMove.gap}px`);
  await clickEl(page, `document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"] .task-el[data-id="' + window.__unDoneId + '"] .check-btn')`);
  await waitFor(page, `
    (() => {
      const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
      if (!cell) return null;
      const done = cell.querySelector('.task-el[data-id="' + window.__unDoneId + '"]');
      return done && !done.classList.contains('done') ? 1 : null;
    })()
  `, '取消完成后还原为未完成任务', 8000);

  /* 坐标**现量**：上面刚往这格里加了 5 条又删掉，`wun.at` 是那之前算的
     （2026-10-22 就栽在这 —— 拿着旧坐标去点，点到了任务卡上）。 */
  const blankAt = await evalJs(page, `
    const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
    /* 3 条 + 末尾空白已经顶到上限了，空白行在可见区**下面** —— 真实用户也是
       先滑到底再点它，所以这里照做（2026-10-22：不滑的话点的是被裁掉的区域，
       事件落到隔壁，永远开不出草稿）。 */
    if (cell) cell.scrollTop = cell.scrollHeight;
    const b = cell && cell.querySelector('.wun-blank');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `);
  await touch(page, 'touchStart', blankAt);
  await touch(page, 'touchEnd', blankAt);
  await waitFor(page, `document.querySelector('.wun-cell .new-cell') ? 1 : null`,
    '点周视图那行空白 → 就地开出草稿框', 6000);
  ok(true, '周视图点空白行也能就地新建未定时任务（真实触摸）');
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.wun-cell .new-cell') ? null : 1`, '周视图草稿框收起', 6000);

  /* ---- 2026-10-22 第二轮（用户：周视图的「格子里滚」没生效，电脑端也要）----
     光有 max-height 不算数：flex 列默认会把卡片**压扁**塞进限高里，
     scrollHeight 恒等于 clientHeight，「溢出滚动」永远不触发。
     这里再加 5 条（共 8 条，肯定超过上限），断言三件事：
       ① 内容真的溢出（scrollHeight 明显大于 clientHeight）→ 才滚得起来；
       ② 格高被上限拦住（不超过 max-height）；
       ③ 时间轴高度一点没变 —— 这才是用户真正要的。 */
  const gridBefore = await evalJs(page, `return Math.round(document.querySelector('.week-grid').getBoundingClientRect().height);`);
  await evalJs(page, `
    const token = localStorage.getItem('schedule-app-token');
    const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
    const ids = [0, 1, 2, 3, 4].map((i) => 't_smoke_wunmore' + i + '_' + Date.now().toString(36));
    window.__unMore = ids;
    const ops = ids.map((id, i) => ({
      opId: 'o' + id, deviceId: 'smoke', ts: Date.now() + i, entity: 'task',
      entityId: id, calId: me.cals[0].id, fields: { title: '挤' + (i + 1), date: window.__unDate },
    }));
    await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ cursor: 1, ops }) });
    window.dispatchEvent(new Event('focus'));
    return 1;
  `);
  const ovf = await waitFor(page, `
    (() => {
      const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
      if (!cell) return null;
      const n = cell.querySelectorAll('.task-el--untimed').length;
      if (n < 8) return null;
      const cs = getComputedStyle(cell);
      cell.scrollTop = 60;                       // 真能滚的话它会停在 60
      const scrolled = cell.scrollTop;
      cell.scrollTop = 0;
      return {
        n,
        sh: cell.scrollHeight, ch: cell.clientHeight,
        h: Math.round(cell.getBoundingClientRect().height),
        fixedH: Math.round(parseFloat(cs.height) || 0),
        cardH: cell.querySelector('.task-el--untimed').getBoundingClientRect().height,
        gap: parseFloat(cs.rowGap || cs.gap) || 0,
        visible: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--un-visible')) || 0,
        padY: (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0),
        scrolled,
        grid: Math.round(document.querySelector('.week-grid').getBoundingClientRect().height),
        shrink: getComputedStyle(cell.querySelector('.task-el--untimed')).flexGrow + '/' + getComputedStyle(cell.querySelector('.task-el--untimed')).flexShrink,
      };
    })()
  `, '8 条未定时任务落进周视图那一格', 15000);
  ok(ovf.sh > ovf.ch + 4,
    '未定时内容真的**溢出**了（不是把卡片压扁塞进去）',
    `内容 ${ovf.sh} / 可见 ${ovf.ch} · 卡片 flex ${ovf.shrink}`);
  const ovfWant = ovf.visible * ovf.cardH + (ovf.visible - 1) * ovf.gap + ovf.padY;
  ok(Math.abs(ovf.h - ovf.fixedH) <= 1 && Math.abs(ovf.fixedH - ovfWant) <= 1,
    '格高是按整卡数精确算出的定值（再多也不往上长）',
    `高 ${ovf.h}px / 定值 ${ovf.fixedH}px（${ovf.visible} 张 ${ovf.cardH.toFixed(2)}px 卡算该是 ${ovfWant.toFixed(2)}）`);
  ok(ovf.scrolled > 0, '这一格**自己滚得动**（scrollTop 能设上去）', `scrollTop=${ovf.scrolled}`);
  ok(Math.abs(ovf.grid - gridBefore) <= 2,
    '任务从 3 条加到 8 条，**时间轴高度一点没变**', `${gridBefore}px → ${ovf.grid}px`);

  /* ---- 橡皮筋阻尼（2026-10-22 用户：滚到头要有阻尼）----
     这里正好是一个**真溢出**的格子，拿它验：滚到顶再往下拖，内容跟手让开
     一段；松手弹回原位；往上拖（还在顶上）不许有位移。
     ⚠️ 触摸模拟在这一节之前已经关掉了（第八节收尾关的），要自己开回来。 */
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const anchor = await evalJs(page, `
    const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
    if (!cell) return null;
    cell.scrollTop = 0;
    const r = cell.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 8),
      top: Math.round(cell.firstElementChild.getBoundingClientRect().top),
    };
  `);
  const readDamp = () => evalJs(page, `
    const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
    return {
      pull: cell.style.getPropertyValue('--pull'),
      live: cell.hasAttribute('data-pull'),
      top: Math.round(cell.firstElementChild.getBoundingClientRect().top),
      scrollTop: Math.round(cell.scrollTop),
    };
  `);

  await touch(page, 'touchStart', { x: anchor.x, y: anchor.y });
  await touch(page, 'touchMove', { x: anchor.x, y: anchor.y + 34 });
  await new Promise((r) => setTimeout(r, 80));   // 位移在 rAF 里写，等一帧
  const pulled = await readDamp();
  ok(pulled.live && parseFloat(pulled.pull) > 6,
    '滚到顶还往下拖：内容被**拉出一段**（阻尼跟手）',
    `--pull=${pulled.pull || '未设置'} · data-pull=${pulled.live}`);
  ok(pulled.top > anchor.top + 5,
    '让开的是**内容**，格子边框没动', `内容顶 ${anchor.top}px → ${pulled.top}px`);
  ok(pulled.top - anchor.top < 34,
    '拖 34px 只让开一点（有阻尼，不是 1:1 硬跟）', `实际让开 ${pulled.top - anchor.top}px`);

  await touch(page, 'touchEnd');
  await new Promise((r) => setTimeout(r, 480));  // 260ms 过渡 + 余量
  const settled = await readDamp();
  ok(!settled.live && Math.abs(settled.top - anchor.top) <= 1,
    '松手后**弹回原位**', `--pull=${settled.pull || '已清'} · 内容顶 ${settled.top}px`);

  // 反方向：还在顶上，往上拖 = 正常滚动，不该有橡皮筋
  await touch(page, 'touchStart', { x: anchor.x, y: anchor.y });
  await touch(page, 'touchMove', { x: anchor.x, y: anchor.y - 30 });
  await new Promise((r) => setTimeout(r, 80));
  const upward = await readDamp();
  ok(!upward.live, '在顶部往上拖（正常滚动方向）**不触发**橡皮筋', `data-pull=${upward.live}`);
  await touch(page, 'touchEnd');
  await new Promise((r) => setTimeout(r, 120));
  await evalJs(page, `const c = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]'); if (c) c.scrollTop = 0; return 1;`);
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  /* ---- 九条规范（2026-10-22）：滚动条不占宽 / 无省略号 / 左对齐 / 整行裁 / 浮条 ---- */
  const nine = await evalJs(page, `
    const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
    if (!cell) return null;
    const card = cell.querySelector('.task-el--untimed');
    const title = card.querySelector('.ev-title');
    const csT = getComputedStyle(title);
    const csC = getComputedStyle(cell);
    const r = cell.getBoundingClientRect();
    // 滚动条若占位，clientWidth 会比「border 内宽」窄一根滚动条的宽度
    //（clientWidth = 内容 + padding，不含 border；border-box 下 = width - 两条边框）
    const innerW = r.width - (parseFloat(csC.borderLeftWidth) || 0) - (parseFloat(csC.borderRightWidth) || 0);
    return {
      gutter: Math.round(innerW - cell.clientWidth),
      clip: csT.textOverflow,
      align: csT.textAlign,
      fw: csT.fontWeight,
      radius: getComputedStyle(card).borderRadius,
      cardH: card.getBoundingClientRect().height,
      mh: parseFloat(title.style.maxHeight) || 0,
      lh: parseFloat(csT.lineHeight) || 0,
    };
  `);
  ok(nine.gutter === 0, '滚动条**不占布局宽度**（浮在卡片上）', `内宽 - clientWidth = ${nine.gutter}px`);
  ok(nine.clip === 'clip', '溢出**不出省略号**（直接裁掉，与月视图同版式）', nine.clip);
  ok(nine.align === 'start' || nine.align === 'left', '文字**左对齐**（周/日/月统一）', nine.align);
  ok(nine.lh > 0 && nine.mh > 0
     && Math.abs(nine.mh / nine.lh - Math.round(nine.mh / nine.lh)) < 0.01,
    '标题按**整行**裁（max-height 钉在行高的整数倍上，不露半截字）',
    `max ${nine.mh}px / 行高 ${nine.lh}px`);
  ok(nine.fw === '400', '字重与月视图任务名一致（400）', nine.fw);
  /* 2026-10-24 三问题第 2 条 + 同源化：圆角不是定值档，是**这张卡自身高的 28%**
     （`--card-r-k`，夹在 2px 与 --r-xl 之间）—— 以前写死 4px，卡一换档就看着不对。
     判据跟着改成「半径 ÷ 卡高 = --card-r-k」。 */
  ok(Math.abs(parseFloat(nine.radius) / nine.cardH - 0.28) < 0.02,
    '圆角 = 自身高的 28%（与定时卡同一条算式）',
    `${nine.radius} / 卡高 ${nine.cardH.toFixed(2)} = ${(parseFloat(nine.radius) / nine.cardH).toFixed(3)}`);
  await evalJs(page, `const c = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]'); if (c) c.scrollTop = 40; return 1;`);
  await new Promise((r) => setTimeout(r, 150));
  const thumbOn = await evalJs(page, `
    const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
    return cell.hasAttribute('data-thumb');
  `);
  ok(thumbOn, '滚动时**浮条出现**（压在卡片上的滚动指示）', 'data-thumb=on');
  /* 浮条必须**跟着滚动一起走**（2026-10-23 用户：「小标一直停在最上面、不跟手」）。
     它是滚动容器自己的 ::after（绝对定位），默认会跟着内容滚出可视区 ——
     JS 里把 scrollTop 补偿进了 --thumb-y。这里量**实际视觉位置**：
     ::after 布局在内容坐标 y=0，视觉 top = -scrollTop + translateY。 */
  const thumbPos = await evalJs(page, `
    const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
    if (!cell) return null;
    const after = getComputedStyle(cell, '::after');
    const m = after.transform.match(/matrix\\(([^)]+)\\)/);
    const ty = m ? parseFloat(m[1].split(',')[5]) : 0;
    return {
      scrollTop: Math.round(cell.scrollTop),
      ty: Math.round(ty),
      visual: Math.round(-cell.scrollTop + ty),
      ch: cell.clientHeight,
    };
  `);
  ok(thumbPos && thumbPos.scrollTop > 20 && thumbPos.visual > 0 && thumbPos.visual < thumbPos.ch,
    '浮条**跟着滚动移动**（不被推出可视区上方）', JSON.stringify(thumbPos));
  await evalJs(page, `const c = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]'); if (c) c.scrollTop = 0; return 1;`);

  /* ---- 2026-10-23 用户：完成的未定时任务不该从日程表消失 ----
     定时任务勾完是「留在原处变灰」，未定时任务以前被 untimedOn / DayView 的
     !t.done 过滤掉、直接消失。现在统一：留下变灰 + 排在未完成后面。
     勾选用 API 落库（确定性；勾选圈→落库那条链别的节锁过），日/周两路各验一次。 */
  await evalJs(page, `
    const token = localStorage.getItem('schedule-app-token');
    const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
    const id = window.__unIds[0];
    await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ cursor: 1, ops: [{ opId: 'o' + id + 'done', deviceId: 'smoke', ts: Date.now(), entity: 'task', entityId: id, calId: me.cals[0].id, fields: { done: true } }] }) });
    window.dispatchEvent(new Event('focus'));
    return 1;
  `);
  const wkDone = await waitFor(page, `
    (() => {
      const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
      if (!cell) return null;
      const cards = [...cell.querySelectorAll('.task-el--untimed')];
      const mine = cards.find((c) => c.dataset.id === window.__unIds[0]);
      if (!mine || !mine.classList.contains('done')) return null;
      const open = cards.find((c) => !c.classList.contains('done'));
      return {
        n: cards.length,
        last: cards[cards.length - 1] === mine,
        bgDiff: !!open && getComputedStyle(mine).backgroundColor !== getComputedStyle(open).backgroundColor,
        titleColor: getComputedStyle(mine.querySelector('.ev-title')).color,
      };
    })()
  `, '周视图：完成的未定时任务留在原地（带 done 类）', 12000);
  ok(wkDone.n >= 8 && wkDone.last,
    '【周视图】完成的未定时任务**不消失**，且排在未完成后面',
    `共 ${wkDone.n} 条 · 是最后一条=${wkDone.last}`);
  ok(wkDone.bgDiff, '【周视图】留下的已完成卡**变灰**了（底色与未完成的不同）', wkDone.titleColor);

  await evalJs(page, `document.querySelector('[data-view="day"]').click(); return true;`);
  const dayDone = await waitFor(page, `
    (() => {
      const cards = [...document.querySelectorAll('.allday-items .task-el')];
      const mine = cards.find((c) => c.dataset.id === window.__unIds[0]);
      if (!mine || !mine.classList.contains('done')) return null;
      return { n: cards.length, last: cards[cards.length - 1] === mine };
    })()
  `, '日视图：完成的未定时任务仍在（以前这里就消失了）', 12000);
  ok(dayDone.n >= 8 && dayDone.last,
    '【日视图】完成的未定时任务**不消失**，排在未完成后面',
    `共 ${dayDone.n} 条 · 是最后一条=${dayDone.last}`);

  // 取消完成 → 回到未完成组（还能再勾），条数不变
  await evalJs(page, `
    const token = localStorage.getItem('schedule-app-token');
    const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
    const id = window.__unIds[0];
    await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ cursor: 1, ops: [{ opId: 'o' + id + 'undone', deviceId: 'smoke', ts: Date.now() + 1, entity: 'task', entityId: id, calId: me.cals[0].id, fields: { done: false } }] }) });
    window.dispatchEvent(new Event('focus'));
    return 1;
  `);
  const backOpen = await waitFor(page, `
    (() => {
      const cards = [...document.querySelectorAll('.allday-items .task-el')];
      const mine = cards.find((c) => c.dataset.id === window.__unIds[0]);
      if (!mine || mine.classList.contains('done')) return null;
      return { n: cards.length };
    })()
  `, '取消完成后回到未完成组', 12000);
  ok(backOpen.n >= 8, '取消完成 → 变回未完成（还能再勾），条数不变', `${backOpen.n} 条`);

  /* ---- 2026-10-23 回归：日/周视图的任务文字大小必须一样 ----
     上一轮「字号收敛」把未定时卡的基础样式切成小格 9px、只给周视图补了大格
     覆盖 → 日视图电脑端 9px、周视图 12.5px（用户：「文字大小不一样了」）。
     用探针卡量四种组合的 computed 字号（不依赖真实数据），电脑端必须全是
     12.5px / 行高 18px —— 与月视图 pill 同一档。 */
  const probeFont = (hostSel, html) => evalJs(page, `
    const host = document.querySelector(${JSON.stringify(hostSel)});
    if (!host) return null;
    const d = document.createElement('div');
    d.innerHTML = ${JSON.stringify(html)};
    host.appendChild(d);
    const t = d.querySelector('.ev-title');
    const st = getComputedStyle(t);
    /* 圈与标题的间距现在挂在 .ev-body 的 column-gap 上（2026-10-24 第四轮：
       .ev-head 那一层已经拆了 —— 标题 / 时间 / 摘要同在 .ev-text 里，
       圈是这一行 flex 的另一件，「圈到文字」的间距因此只剩这一个来源）。
       ⚠️ 这段跑在浏览器里，注释里不能出现反引号（会提前结束模板字符串）。 */
    const out = { size: st.fontSize, lh: st.lineHeight, gap: getComputedStyle(d.querySelector('.ev-body')).columnGap };
    d.remove();
    return out;
  `);
  const UNT_HTML = '<div class="task-el task-el--untimed"><div class="ev-body"><div class="ev-text"><span class="ev-title">测</span></div></div></div>';
  const TMD_HTML = '<div class="task-el task-el--timed"><div class="ev-body"><div class="ev-text"><span class="ev-title">测</span></div></div></div>';
  const dayUn = await probeFont('.allday-items', UNT_HTML);
  const dayTm = await probeFont('.timeline', TMD_HTML);
  await evalJs(page, `document.querySelector('[data-view="week"]').click(); return true;`);
  await new Promise((r) => setTimeout(r, 500));
  const wkUn = await probeFont('.wun-cell', UNT_HTML);
  const wkTm = await probeFont('.week-col', TMD_HTML);
  const fontSizes = [dayUn && dayUn.size, dayTm && dayTm.size, wkUn && wkUn.size, wkTm && wkTm.size];
  ok(fontSizes.every((s) => s === '12.5px'),
    '【字号统一】日/周视图 × 定时/未定时的任务文字**同一大小**（电脑端 12.5px）',
    JSON.stringify({ 日未定时: dayUn, 日定时: dayTm, 周未定时: wkUn, 周定时: wkTm }));
  /* 勾选圈与标题的间距（2026-10-23 用户：6px 太大，2px 就够） */
  const headGaps = [dayUn, dayTm, wkUn, wkTm].map((x) => x && x.gap);
  ok(headGaps.every((g) => g === '2px'),
    '勾选圈与标题的间距是 2px（窄格子把省下的宽度留给字）', JSON.stringify(headGaps));

  /* ---- 2026-10-23 用户：未定时任务「一拖就整个消失」----
     拖拽不用浮层，被拖的是卡片自己；未定时区限高可滚（overflow:auto），
     卡片被拖出边界就被容器裁掉，落点却是对的。现在拖起时改成 fixed +
     原位等高占位块。这里真鼠标拖到时间轴上方，量「半路时卡片还在不在」。 */
  const unDrag = await evalJs(page, `
    const cell = document.querySelector('.wun-cell[data-zone-id="allday:' + window.__unDate + '"]');
    const card = cell && cell.querySelector('.task-el--untimed');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    window.__dragId = card.dataset.id;
    return { id: card.dataset.id, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             ol: card.offsetLeft, ot: card.offsetTop };
  `);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: unDrag.x, y: unDrag.y, button: 'left', clickCount: 1, buttons: 1,
  });
  for (const dy of [12, 60, 140]) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: unDrag.x, y: unDrag.y + dy, button: 'left', buttons: 1,
    });
    await new Promise((r) => setTimeout(r, 50));
  }
  const dragMid = await evalJs(page, `
    const ghost = document.querySelector('.drag-ghost[data-id="' + window.__dragId + '"]');
    const orig = document.querySelector('.task-el[data-id="' + window.__dragId + '"]');
    if (!ghost || !orig) return { ghost: !!ghost, orig: !!orig };
    const r = ghost.getBoundingClientRect();
    const ro = orig.getBoundingClientRect();
    return {
      pos: getComputedStyle(ghost).position,
      cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
      inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
      origVis: getComputedStyle(orig).visibility,
      /* 布局位置用 offsetTop/Left —— 不受 transform 影响，量的是“占位”本身 */
      origLeft: orig.offsetLeft, origTop: orig.offsetTop,
    };
  `);
  ok(dragMid && dragMid.pos === 'fixed' && dragMid.inView,
    '把未定时卡拖出格子时**分身仍然可见**（画在 body 层，不被容器裁掉）',
    JSON.stringify(dragMid));
  /* 卡片是按中心抓起来的 → 拖拽中分身中心必须 ≈ 指针位置。上一版把本体改成
     fixed，dnd-kit 重测量给 transform 加了布局位移补偿（恒定 +24），卡片比
     指针偏一大截（用户 2026-10-23：「点击位置和实际移动位置差一大截」）。 */
  ok(dragMid && Math.abs(dragMid.cx - unDrag.x) <= 8 && Math.abs(dragMid.cy - (unDrag.y + 140)) <= 8,
    '拖拽中**分身中心跟着指针走**（点击位置 = 移动位置，零偏移）',
    `分身中心 (${dragMid.cx},${dragMid.cy}) vs 指针 (${unDrag.x},${unDrag.y + 140})`);
  ok(dragMid && dragMid.origVis === 'hidden' && dragMid.origLeft === unDrag.ol && dragMid.origTop === unDrag.ot,
    '本体**原地隐身**（占位不变，其余卡片不跳动）',
    JSON.stringify(dragMid && { origLeft: dragMid.origLeft, origTop: dragMid.origTop }));
  /* 拖回原处松手：不改任何数据 */
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: unDrag.x, y: unDrag.y, button: 'left', buttons: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: unDrag.x, y: unDrag.y, button: 'left', buttons: 0,
  });
  await new Promise((r) => setTimeout(r, 400));

  await new Promise((r) => setTimeout(r, 300));


  await evalJs(page, `
    const token = localStorage.getItem('schedule-app-token');
    const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
    const ops = (window.__unMore || []).map((id) => ({
      opId: 'd' + id, deviceId: 'smoke', ts: Date.now(), entity: 'task',
      entityId: id, calId: me.cals[0].id, fields: { deleted: true, deletedAt: Date.now() },
    }));
    await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ cursor: 1, ops }) });
    window.dispatchEvent(new Event('focus'));
    return 1;
  `);
  await waitGone(page, `(window.__unMore || []).every((id) => !document.querySelector('.wun-cell .task-el[data-id="' + id + '"]'))`,
    '8 条验证用的未定时任务已收回');
  // 回日视图，后面的节按日视图写的
  await evalJs(page, `document.querySelector('[data-view="day"]').click(); return true;`);
  await waitFor(page, `document.querySelector('.allday-items') ? 1 : null`, '回到日视图', 8000);
  /* 收尾：这两条验证用的任务删掉，别影响后面的节（`.allday-zone` 是
     `flex: 0 0 auto`，多一行就是把时间轴少一行） */
  await evalJs(page, `
    const token2 = localStorage.getItem('schedule-app-token');
    const me2 = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token2 } })).json();
    const ops2 = window.__unIds.map((id) => ({
      opId: 'del' + id, deviceId: 'smoke', ts: Date.now(), entity: 'task',
      entityId: id, calId: me2.cals[0].id, fields: { deleted: true, deletedAt: Date.now() },
    }));
    await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token2 },
      body: JSON.stringify({ cursor: 1, ops: ops2 }) });
    return 1;
  `);
  await waitGone(page, `(window.__unIds || []).every((id) => !document.querySelector('.allday-items .task-el[data-id="' + id + '"]'))`,
    '验证用的未定时任务已从界面上消失');

  const block = await waitFor(page, `
    (() => {
      const e = [...document.querySelectorAll('.task-el--timed')].find((x) => x.textContent.includes('微调试试'));
      if (!e) return null;
      // 上沿的 class 是 "ev-resize ev-resize-top"，所以 '.ev-resize' 会**先命中上沿**
      // （DOM 里它在前面）—— 想拿的是下沿就必须排掉它。
      // 不排的话断言名写着「下沿」，实际查的是上沿，两条形状一样、于是照样"通过"。
      const h = e.querySelector('.ev-resize:not(.ev-resize-top)');
      const th = e.querySelector('.ev-resize-top');
      return h && th ? {
        id: h.dataset.id, tab: h.tabIndex, name: h.getAttribute('aria-label'),
        topTab: th.tabIndex, topName: th.getAttribute('aria-label'),
      } : null;
    })()
  `, '时间轴方块和它的上下两个把手', 8000);
  /* 下一节（十四之二）要拿同一条方块来改时间窗 —— 拆开后两个文件各有各的
     作用域，往 ctx.state 上放一份。 */
  state.block = block;
  ok(block.tab === 0 && block.topTab === 0,
    '两个把手都能被 Tab 够到（下沿 tabIndex=' + block.tab + '，上沿 ' + block.topTab + '）');
  ok(!!block.name && !!block.topName && block.name !== block.topName,
    '两个把手各有名字，且分得清上下：' + JSON.stringify(block.name) + ' / ' + JSON.stringify(block.topName));

  /* ---- 2026-10-19 用户报「没地方拖动改时长」----
     「点一下新建」的任务 duration 是空的（默认 1 小时不等于写死了 1 小时），
     而以前 `resizable={hasEnd}` 让这些卡**一个把手都没有** —— 用户根本没处拖。
     这里真建一条没时长的任务，验证它照样有把手、且看得见。 */
  const nodurMade = await evalJs(page, `
    try {
      const pad = (n) => (n < 10 ? '0' + n : '' + n);
      const token = localStorage.getItem('schedule-app-token');
      const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
      if (!me.cals || !me.cals.length) return 'me 没有日程集：' + JSON.stringify(me).slice(0, 120);
      const d = new Date();
      const id = 't_smoke_nodur_' + Date.now().toString(36);
      window.__nodurId = id;
      const r = await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ cursor: 1, ops: [{ opId: 'o' + id, deviceId: 'smoke', ts: Date.now(), entity: 'task', entityId: id, calId: me.cals[0].id, fields: { title: '没时长的卡', date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), time: '11:00' } }] }) });
      return r.ok ? 'ok' : ('sync ' + r.status + ' ' + (await r.text()).slice(0, 120));
    } catch (e) { return '抛了：' + e.message; }
  `);
  /* ⚠️ 这条以前是 `(async () => {…})()` 包一层就完事 —— evalJs 外面还有一层
     异步壳，里面那个 IIFE 根本没人 await，建失败了也静默。改成直接 await 并
     把失败原因带回来，别让它再装成「等不到元素」。 */
  ok(nodurMade === 'ok', '建出一条没时长的任务（API）', String(nodurMade));
  /* 客户端不是定时拉了：`sync/lifecycle.ts` 的轮询只在 outbox 非空时才 syncNow，
     纯靠 API 建出来的条目没人拉就永远看不见。这里补一次 wake（等同切回前台）。 */
  await evalJs(page, `window.dispatchEvent(new Event('focus')); return 1;`);
  const nodur = await waitFor(page, `
    (() => {
      const e = document.querySelector('.task-el--timed[data-id="' + window.__nodurId + '"]');
      if (!e) return null;
      const h = e.querySelector('.ev-resize:not(.ev-resize-top)');
      return h && h.getBoundingClientRect().height > 0 ? {
        op: parseFloat(getComputedStyle(h).opacity), cursor: getComputedStyle(h).cursor,
      } : null;
    })()
  `, '没设时长的任务也带着把手', 10000);
  ok(nodur.op > 0.1 && nodur.cursor === 'ns-resize',
    '没设时长的任务，把手也常显可拖（opacity ' + nodur.op.toFixed(2) + '，cursor ' + nodur.cursor + '）');
  /* 收尾：这条验证用的任务删掉，别影响后面的节。
     **必须等它真从界面上消失**再往下走 —— 同步是轮询的，删完立刻翻页的话
     下一节「时间窗」还会把它算进 coverWindow（11:00 + 默认 60 分钟 = 12:00
     结束，把一个 11 点截止的窗顶到 12 点）。 */
  await evalJs(page, `
    (async () => {
      const token = localStorage.getItem('schedule-app-token');
      const me = await (await fetch('api/me', { headers: { Authorization: 'Bearer ' + token } })).json();
      await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ cursor: 1, ops: [{ opId: 'del' + window.__nodurId, deviceId: 'smoke', ts: Date.now(), entity: 'task', entityId: window.__nodurId, calId: me.cals[0].id, fields: { deleted: true, deletedAt: Date.now() } }] }) });
      return 1;
    })()
  `);
  await evalJs(page, `window.dispatchEvent(new Event('focus')); return 1;`);
  await waitGone(page, `!document.querySelector('.task-el--timed[data-id="' + window.__nodurId + '"]')`,
    '验证用的无时长任务已从界面上消失');

  const sel = (act) => `document.querySelector('.task-el--timed[data-id=${JSON.stringify(block.id)}] [data-act="${act}"]')`;
  const taskOf = `Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks).find((t) => t.id === ${JSON.stringify(block.id)})`;

  // 真拿焦点（不是造一个 target），并**顺手挂一个按键记录器** ——
  // 这一条失败的原因无非两种：键没进页面，或者进了但没被接住。记录器
  // 一次就能分开：`!prevented` 表示 App 那段处理器**跑到了**（它会 preventDefault），
  // 空数组表示键压根没到。没有它就只能看到一个 null。
  const focused = await evalJs(page, `
    window.__keys = [];
    document.addEventListener('keydown', (e) => {
      if (window.__keys.length < 5) {
        window.__keys.push(e.key + '@' + (e.target.className || e.target.tagName)
          + (e.defaultPrevented ? '!被接住了' : ''));
      }
    });
    const h = ${sel('resize')};
    if (!h) return 'missing';
    h.focus();
    return document.activeElement === h ? 'ok' : ('焦点跑到了 ' + document.activeElement.tagName);
  `);
  ok(focused === 'ok', '把手真能拿到焦点，实际 ' + focused);

  // 先把这条任务等**落盘**再读基准值。store.persist() 是防抖的，刚快速添加完
  // localStorage 里还没有它 —— 直接读会得到 undefined，`undefined + 15` 是 NaN，
  // 下面那条断言就永远等不到（本节的第一次失败正是这个：按键其实全对，
  // 诊断里 `目标时长 undefined` 才是真线索）。
  const t0 = await waitFor(page, `
    (() => { const t = ${taskOf}; return t ? { duration: t.duration, time: t.time } : null; })()
  `, '新任务落盘', 8000);
  const before = t0.duration;
  ok(before > 0 && t0.time === '09:00', '新任务落盘：09:00 起、' + before + ' 分钟');
  await key(page, 'ArrowDown', 'ArrowDown', 40);
  const kdiag = await evalJs(page, `return {
    keys: window.__keys,
    active: document.activeElement && (document.activeElement.className || document.activeElement.tagName),
    dur: (${taskOf} || {}).duration,
    time: (${taskOf} || {}).time,
  };`);
  console.log('    诊断：目标时长 ' + before + ' → ' + JSON.stringify(kdiag)
    + '（keys 为空 = 按键没进页面；有条目但没有「!被接住了」 = 进了但没被接住）');
  // 等**落盘**再读：store.persist() 是防抖的，改完立刻读拿到的是上一版（四、41）
  const nudged = await waitFor(page, `
    (() => { const t = ${taskOf}; return t && t.duration === ${before} + 15 ? t.duration : null; })()
  `, '下沿按 ↓ 把时长加了一档', 8000);
  ok(nudged === before + 15, '下沿按 ↓：时长 ' + before + ' → ' + nudged + '（+15 分钟）');

  // 下沿**不该动 time** —— 这是「哪一端接哪一边」的核心断言
  ok(await evalJs(page, `return (${taskOf} || {}).time === '09:00';`),
    '下沿只改时长，开始时间仍是 09:00');

  await key(page, 'ArrowUp', 'ArrowUp', 38);
  const back = await waitFor(page, `
    (() => { const t = ${taskOf}; return t && t.duration === ${before} ? t.duration : null; })()
  `, '↑ 又把它调回来', 8000);
  ok(back === before, '再按 ↑ 回到 ' + back + '（同一档来回，不会漂）');

  // 换到上沿：固定底边 ⇒ time 变早、duration 变长
  const topFocused = await evalJs(page, `
    const h = ${sel('resize-top')};
    if (!h) return 'missing';
    h.focus();
    return document.activeElement === h ? 'ok' : 'no';
  `);
  ok(topFocused === 'ok', '上沿把手也能拿到焦点');
  await key(page, 'ArrowUp', 'ArrowUp', 38);
  const top = await waitFor(page, `
    (() => { const t = ${taskOf}; return t && t.time === '08:45' ? { time: t.time, duration: t.duration } : null; })()
  `, '上沿按 ↑ 把开始时间提前 15 分钟', 8000);
  ok(top.duration === before + 15, '上沿按 ↑ 时底边固定：开始 09:00 → ' + top.time + '，时长 ' + before + ' → ' + top.duration);

  // 收尾：把这条恢复原样，别给后面的断言留个挪过位置的方块
  await evalJs(page, `
    const h = ${sel('resize')};
    h && h.focus();
    return true;
  `);
  await key(page, 'ArrowDown', 'ArrowDown', 40);


}

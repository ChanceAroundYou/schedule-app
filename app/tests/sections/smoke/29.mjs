/**
 * 29.mjs —— 「这天还有没做完的」那颗小圆点（2026-11-06 用户要求：电脑端 / 手机端 / 桌面小组件统一）
 *
 * 要证明的五件事：
 *   1. 周视图日期头：有没做完任务的那天，日期数字**正下方**点亮一颗小圆点；
 *   2. 只加一条**已完成**的那格不亮 —— 「做完了的不算」这条口径真的接在界面上；
 *   3. 那颗点**绝对定位、不进流**：点亮之后七格高度与不亮时完全一致，
 *      表头总高一分不长（周视图锁单屏，表头长一像素时间网格就短一像素 ——
 *      card-geometry 的 48 / 56px 上限量的就是这件事）；
 *   4. 日视图没有日期头，判据要落到顶栏标题下方（`.vt-dot`）：点日期头跳过去，
 *      那一天的标题下也得亮；
 *   5. 打勾之后圆点**当场收回**（周视图、日视图两头都收）—— 判据是活的，不是种下去就不动。
 *
 * 顺带锁一条同源：顶栏「找日期」面板那本小月历的密度短横（`.jp-cell.has`）
 * 与圆点吃的是**同一份** domain 口径（`undoneLoads`）。各写一份判据迟早漂移。
 *
 * ⚠️ 造数据只在**当前勾选的那个日程集**里（从界面读 `data-cal-row`，不猜 cals[0]），
 *    id 全是 `smoke-und-*`，收尾 **无论前面成败都删干净**（try/finally）——
 *    探针留在用户日程集里的数据就是「11月7日那两条重复的探针任务」的来历。
 *
 * ⚠️ 这一节在 `index.mjs` 里排在 **26 之前**：26 是收尾节（换真窄屏 + 关页面）。
 */
export async function run(ctx) {
  const { page } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, openCalMenu, waitCalMenu, closeCalMenu, api } = helpers;
  const ok = ctx.ok;

  console.log('\n二十九、日期下方的「还有没做完的」小圆点（日 / 周 / 找日期月历 同源）');

  const token = await evalJs(page, `return localStorage.getItem('schedule-app-token');`);
  ok(!!token, '探针账户的票还在（造数据要它）');

  /* ---------- 回到日程页周视图 ----------
     入口两条都试：前面几节在伪窄屏 / 宽屏之间来回切（22 节那个开关），
     到这一节时到底是侧栏还是底栏不一定。 */
  const navEntry = await evalJs(page, `return (() => {
    const side = document.querySelector('.sidebar [data-nav="calendar"]');
    if (side) { side.click(); return 'side'; }
    const tab = [...document.querySelectorAll('.tabbar .tab')]
      .find((b) => b.textContent.replace(/\\s+/g, '') === '日程');
    if (tab) { tab.click(); return 'tab'; }
    const more = [...document.querySelectorAll('.tabbar .tab')].find((b) => b.textContent.includes('更多'));
    if (!more) return 'none';
    more.click();
    return 'more';
  })()`);
  ok(navEntry !== 'none', '找得到日程页的入口', navEntry);
  if (navEntry === 'more') {
    await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开', 4000);
    await clickEl(page, `[...document.querySelectorAll('.more-sheet .ms-item')]
      .find((b) => b.textContent.replace(/\\s+/g, '') === '日程')`);
  }
  await waitFor(page, `!!document.querySelector('[data-view="week"]')`, '日程页的视图切换按钮', 8000);
  await evalJs(page, `document.querySelector('[data-view="week"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.week-view .week-head-cell')`, '周视图的日期头', 8000);

  /** 日期头现状：哪天亮、哪天不亮、每格多高 */
  const head = () => evalJs(page, `return (() => {
    const cells = [...document.querySelectorAll('.week-view .week-head-cell')];
    return {
      today: (document.querySelector('.week-head-cell.today') || {}).dataset?.jump || null,
      lit: cells.filter((c) => !!c.querySelector('.wh-dot')).map((c) => c.dataset.jump),
      dates: cells.map((c) => c.dataset.jump),
      heights: cells.map((c) => Math.round(c.getBoundingClientRect().height)),
      /* 每一格的高度必须**跟加这颗点之前一样** —— 点绝对定位、不进流。
         这里不比对旧版本，比对的是「点亮的那格和不亮的格一样高」：
         只要点进了流，点亮那格就会比别的格高 6px，这一条当场红。 */
      litHeights: cells.filter((c) => c.querySelector('.wh-dot'))
                       .map((c) => Math.round(c.getBoundingClientRect().height)),
      dot: (() => { const c = cells.find((x) => x.querySelector('.wh-dot'));
        if (!c) return null;
        const d = c.querySelector('.wh-dot').getBoundingClientRect();
        const day = c.querySelector('.wh-day').getBoundingClientRect();
        const cell = c.getBoundingClientRect();
        return { w: Math.round(d.width), h: Math.round(d.height),
          pos: getComputedStyle(c.querySelector('.wh-dot')).position,
          bg: getComputedStyle(c.querySelector('.wh-dot')).backgroundColor,
          underDay: d.top >= day.bottom - 1, insideCell: d.bottom <= cell.bottom + 0.5,
          centered: Math.abs((d.left + d.width / 2) - (cell.left + cell.width / 2)) <= 1 }; })(),
    };
  })()`);

  const before = await head();
  ok(before.dates.length === 7, '周视图日期头七格都在', String(before.dates.length));
  ok(new Set(before.heights).size === 1, '不亮状态下七格等高', JSON.stringify(before.heights));

  /* ---------- 挑两个对照组日子 ----------
     只在「不是今天、现在也不亮」的格子里挑：
     · 不能是今天 —— 今天还有没打的卡也算没做完（口径），拿今天做对照组的话
       「打勾之后收回」那条会被打卡顶着，永远假红；
     · 必须本来不亮 —— 这样我们种下去的那条任务才是这格亮 / 不亮的**唯一变量**。
     优先挑靠后的：种在过去的那天会被算进逾期，给后面的计数添变量。 */
  const cand = before.dates.filter((d) => d !== before.today && !before.lit.includes(d)).sort();
  ok(cand.length >= 2, '日期头里至少有两格既不是今天也不亮（能当对照组）',
    JSON.stringify({ dates: before.dates, lit: before.lit, today: before.today }));
  const dayB = cand[cand.length - 1];
  const dayA = cand[cand.length - 2];
  ok(!!dayA && !!dayB && dayA !== dayB, '拿到对照组两个日子', JSON.stringify([dayA, dayB]));
  if (!dayA || !dayB) return;

  /* ---------- 造数据落在**界面正勾着、且有写权限**的那个集 ----------
     不点顶栏那个日程集下拉：第二十二节给 `matchMedia` 套了伪窄屏 Proxy，
     后面几节没有全部关回去 —— 窄屏下 `CalMenu` 压根不渲染，`[data-cal-menu]`
     是 null（第一次跑就红在这）。也不猜 `cals[0]`：第六节把它改过名、
     第八节把它共享了出去，cals[0] 完全可能是只读的那个（写进去会被
     `canWrite(roleOf(...))` 静默挡下）。
     直接读界面那份状态：`ui.cals` 就是「正勾着的集」，日程视图拿的
     `useScopedState` 按它过滤 —— 种子落在这几个里的任意一个，界面一定看得见。 */
  const calId = await evalJs(page, `return (() => {
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    const canWrite = (r) => r === 'owner' || r === 'editor';
    const picked = (st.ui.cals || []).find((id) => {
      const cal = (st.cals || []).find((c) => c.id === id);
      return cal && canWrite(cal.role);
    });
    return picked || null;
  })()`);
  ok(!!calId, '拿到一个「界面正勾着 + 有写权限」的日程集（种子落这里才一定看得见）', String(calId));
  if (!calId) return;

  const mkOp = (id, fields) => ({
    opId: 'smoke-und-' + id + '-' + Date.now(), deviceId: 'smoke-probe', ts: Date.now(),
    calId, entity: 'task', entityId: id,
    fields: Object.assign({ note: '', time: null, duration: null, reminder: null,
      repeat: { unit: 'none', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null },
      repeatSeq: 0 }, fields),
  });
  /** 墓碑只要这两个字段，别把整张字段表再灌一遍（LWW 逐字段，多余的字段是多余的写入） */
  const delOp = (id) => ({
    opId: 'smoke-und-del-' + id + '-' + Date.now(), deviceId: 'smoke-probe', ts: Date.now(),
    calId, entity: 'task', entityId: id, fields: { deleted: true, deletedAt: Date.now() },
  });

  const nudge = () => evalJs(page, `window.dispatchEvent(new Event('focus')); return true;`);

  try {
    const seed = await api('POST', '/sync', { cursor: 0, ops: [
      mkOp('smoke-und-open', { title: '小点探针·没做完', date: dayA, done: false, doneAt: null }),
      mkOp('smoke-und-done', { title: '小点探针·已做完', date: dayB, done: true, doneAt: Date.now() }),
    ] }, token);
    ok(seed.status === 200, 'API 直种两条任务（一条没做完 / 一条已做完）', JSON.stringify(seed.status));
    await nudge();

    /* ---------- 1 + 2. 该亮的亮、只有一条已完成的不亮 ---------- */
    const litA = await waitFor(page, `(() => {
      const c = document.querySelector('.week-view .week-head-cell[data-jump="${dayA}"]');
      if (!c) return null;
      return c.classList.contains('has-undone') && !!c.querySelector('.wh-dot') ? 1 : null;
    })()`, '种了未完成任务的那天，日期下方点亮小圆点', 12000).catch(() => null);
    ok(!!litA, '有没做完任务的那天，日期数字正下方有小圆点（' + dayA + '）');

    const dot = await head();
    ok(!!dot.dot && dot.dot.w === 4 && dot.dot.h === 4 && dot.dot.pos === 'absolute',
      '那颗点是 4×4 的**绝对定位**圆点（不进流，所以不可能把格子撑高）', JSON.stringify(dot.dot));
    ok(!!dot.dot && dot.dot.underDay && dot.dot.insideCell && dot.dot.centered,
      '点落在日期数字正下方、横向居中、且不越出这一格', JSON.stringify(dot.dot));

    const bCell = await evalJs(page, `return (() => {
      const c = document.querySelector('.week-view .week-head-cell[data-jump="${dayB}"]');
      if (!c) return null;
      return { cls: c.className, hasDot: !!c.querySelector('.wh-dot'),
        hasUndone: c.classList.contains('has-undone'), title: c.getAttribute('title') };
    })()`);
    ok(!!bCell && !bCell.hasUndone && !bCell.hasDot,
      '只有一条**已完成**任务的那天不亮（做完了的不算这条口径接在界面上）',
      JSON.stringify(bCell));

    /* ---------- 3. 高度恒定：点亮之后七格仍然一样高 ---------- */
    const afterSeed = await head();
    ok(new Set(afterSeed.heights).size === 1,
      '点亮之后七格高度仍然完全一致（点绝对定位、不进流，撑不高任何一格）',
      JSON.stringify(afterSeed.heights));
    ok(afterSeed.lit.includes(dayA) && !afterSeed.lit.includes(dayB),
      '亮的那几格里，新种的这天在、对照组那天不在', JSON.stringify(afterSeed.lit));

    /* ---------- 4. 日视图：判据落到顶栏标题下方 ---------- */
    await clickEl(page, `document.querySelector('.week-view .week-head-cell[data-jump="${dayA}"]')`);
    await waitFor(page, `!!document.querySelector('[data-view="day"].on')`, '点日期头跳到那天的日视图', 8000);
    /* 2026-11-06 用户：「日视图下不需要小圆点」。这一端**反过来锁**：
       标题上不许再出现 `.vt-dot`，也不许再挂「这天还有没做完的」的 title。
       周 / 三日视图的日期头、月格子、桌面小组件照旧亮（本节前半段已经验过周视图）。 */
    const day = await evalJs(page, `return (() => {
      const h = document.querySelector('.topbar .view-title');
      const d = h && h.querySelector('.vt-dot');
      const hr = h ? h.getBoundingClientRect() : null;
      return { title: h ? h.textContent.trim() : null, titleTip: h ? h.getAttribute('title') : null,
        has: !!d, titleH: hr ? Math.round(hr.height) : null,
        topbarPos: (() => { const t = document.querySelector('.topbar'); return t ? getComputedStyle(t).position : null; })() };
    })()`);
    ok(!!day && !day.has,
      '日视图顶栏标题上**不再有**小圆点（用户 2026-11-06 定）', JSON.stringify(day));
    ok(!!day && !day.titleTip,
      '标题也不再挂「这天还有没做完的」的 title（点没了，说明也该走）', JSON.stringify(day));
    ok(!!day && day.topbarPos === 'static',
      '顶栏本体仍然是 static（不许加 position / sticky / z-index）',
      JSON.stringify({ topbar: day && day.topbarPos }));

    /* ---------- 5a. 找日期面板那本小月历：与圆点同一份口径 ---------- */
    await clickEl(page, `document.querySelector('.jump-wrap .btn, .jump-wrap button')`);
    await waitFor(page, `(() => { const p = document.querySelector('.jump-pop');
      return p && getComputedStyle(p).visibility === 'visible' ? 1 : null; })()`, '找日期浮层打开', 8000);
    const mini = await evalJs(page, `return (() => {
      /* 格子没有日期用的 data 属性，但有 data-jump（点了就是去那天的日视图）——
         按它取，不猜 title 里的日期字符串格式。 */
      const cells = [...document.querySelectorAll('.jump-pop .jp-cell')];
      const a = cells.find((c) => c.dataset.jump === ${JSON.stringify(dayA)});
      const b = cells.find((c) => c.dataset.jump === ${JSON.stringify(dayB)});
      const of = (c) => c ? { cls: c.className, title: c.getAttribute('title'),
        has: c.classList.contains('has'),
        barW: (() => { const cs = getComputedStyle(c, '::after'); return cs.width; })() } : null;
      return { total: cells.length, a: of(a), b: of(b) };
    })()`);
    ok(mini.total >= 28, '小月历格子渲染全了', String(mini.total));
    ok(!!mini.a && mini.a.has, '月历里「几条没做完」的密度短横与圆点同源（这天被标成有负载）',
      JSON.stringify(mini.a));
    ok(!!mini.b && !mini.b.has, '只有已完成任务的那天，月历里同样不算负载（同一份判据）',
      JSON.stringify(mini.b));
    await clickEl(page, `document.querySelector('.jump-wrap .btn, .jump-wrap button')`);
    await waitFor(page, `!document.querySelector('.jump-pop') ? 1 : null`, '关掉找日期浮层', 8000);

    /* ---------- 5b. 打勾 → 圆点当场收回（日视图 + 周视图两头都收） ---------- */
    const doneUpd = await api('POST', '/sync', { cursor: 0, ops: [
      mkOp('smoke-und-open', { title: '小点探针·没做完', date: dayA, done: true, doneAt: Date.now() }),
    ] }, token);
    ok(doneUpd.status === 200, 'API 把那条任务改成已完成', JSON.stringify(doneUpd.status));
    await nudge();
    const dayOff = await waitFor(page, `(() => {
      const h = document.querySelector('.topbar .view-title');
      return h && !h.querySelector('.vt-dot') ? 1 : null;
    })()`, '全部做完后，日视图标题下的圆点收回', 12000).catch(() => null);
    ok(!!dayOff, '打勾之后日视图那颗点收回了（判据是活的，不是种下去就不动）');

    await evalJs(page, `document.querySelector('[data-view="week"]').click(); return true;`);
    await waitFor(page, `!!document.querySelector('.week-view .week-head-cell')`, '切回周视图', 8000);
    const weekOff = await waitFor(page, `(() => {
      const c = document.querySelector('.week-view .week-head-cell[data-jump="${dayA}"]');
      return c && !c.classList.contains('has-undone') && !c.querySelector('.wh-dot') ? 1 : null;
    })()`, '切回周视图：那格的圆点也收回', 12000).catch(() => null);
    ok(!!weekOff, '打勾之后周视图那格也收回');
    const back = await head();
    ok(new Set(back.heights).size === 1 && back.heights[0] === before.heights[0],
      '点亮 / 收回全程七格高度与起步时完全一致（绝对定位不进流，高度天生恒定）',
      JSON.stringify({ now: back.heights, 起步: before.heights }));
  } finally {
    /* 收尾：无论前面红成什么样，两条探针任务都得从用户的日程集里清掉。
       只写在成功路径的清理 = 下一个人打开应用看见「小点探针·没做完」。 */
    const del = await api('POST', '/sync', { cursor: 0, ops: [delOp('smoke-und-open'), delOp('smoke-und-done')] }, token);
    ok(del.status === 200, '收尾：两条探针任务已删除（无论前面成败）', JSON.stringify(del.status));
    await nudge();
    const gone = await waitFor(page, `(() => {
      const dots = [...document.querySelectorAll('.week-view .week-head-cell')]
        .filter((c) => c.dataset.jump === ${JSON.stringify(dayA)} || c.dataset.jump === ${JSON.stringify(dayB)});
      return dots.every((c) => !c.classList.contains('has-undone')) ? 1 : null;
    })()`, '收尾：两格都回到不亮（探针数据确实清干净了）', 12000).catch(() => null);
    ok(!!gone, '收尾：探针留下的两个日子都不再亮', JSON.stringify(before.lit));
  }
}

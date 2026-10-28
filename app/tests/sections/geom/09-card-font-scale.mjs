export async function run(ctx) {
  const { page } = ctx;
  const { evalJs, waitFor, gotoCalendar, WEB_PORT } = ctx.helpers || {};
  const { CHECK_MIN, CHECK_MAX } = ctx.state;
  const ok = ctx.ok;

  /* 这一节锁的是 2026-10-28 加的设置页「显示 → 任务卡字号」三档。
     锁六件事：
       ① 默认档（md）**必须等于原基准** —— 卡片字号仍等于 --fs-title。
          这条是这次改动最容易翻车的地方：新加的那条规则一开始写成给 .task-el 直接
          定 font-size，同特异度后写赢（踩坑 17），把 .task-el--timed / --untimed
          自己的那条顶掉，默认档下勾选圈 11 → 13px，card-geometry 当场红 84 条。
          档位只做倍率（tokens.css 的 --card-font-scale），卡片自己那条算式去乘它，
          才守得住六屏全量表。
       ② 三档的倍率就是令牌里写的那三个值（.875 / 1 / 1.125），换算发生在 CSS 里。
       ③ 勾选圈跟着任务名一起大一起小（直径 = 所在行字号 × --check-k，lists.css），
          且不许比任务名大 —— 这一条是 2026-10-24 定的红线，换档不许破。
       ④ 只有任务卡吃这一档：列表行（.row-title 走 --fs-row）不跟着变；
          第二个消费点月视图胶囊（`.task-pill`，窄屏另有自己的 10px 小档基准）
          挂中档等于没挂档、lg 档跟着放大 —— 窄屏那条 responsive.css 覆盖特异度更高，
          漏乘倍率就是「宽屏吃、窄屏不吃」。
       ⑤ 「挂中档 = 压根没挂档」：档位只写在 [data-card-font] 而 :root 没有默认值时，
          calc() 引用不存在的变量会让整条 font-size 失效（字号掉回继承值）。
       ⑥ 换档不刷新就生效（全程只点导航、不 reload —— 见 pickScale 那段）。
     顺带把同一页那三排开关（来源标记 / 重复标记 / 现在时刻线）各锁两条：
     关掉 → 那个元素归零、开回 → 回来，全程不刷新（三排都是 2026-10-28 新加的，
     之前一条覆盖都没有）。
     两个视口各跑一趟：窄屏那趟 --fs-title 被 responsive.css 切成 11，只有它会逼近
     --check-min(9) 那道地板；桌面那趟是 12.5，往 --check-max(18) 那边去。
     三排开关只在桌面那一趟查 —— 来源标记按规则只在宽屏 3 日档画，窄屏上
     「关掉就归零」本来就成立，测了等于没测。 */

  const SCALE = { sm: 0.875, md: 1, lg: 1.125 };
  const TOL = 0.06;
  const LEGS = [
    { name: '窄屏 390', w: 390, h: 844, mobile: true },
    { name: '桌面 1400', w: 1400, h: 900, mobile: false },
  ];

  /* 自己定视口，不蹭前五节留下的那一档：前五节最后一个改视口的是第五节（390），
     顺序一动这一节量到的屏就跟着漂，而断言里没有任何东西会报警。 */
  const setViewport = async (vp) => {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w, height: vp.h, deviceScaleFactor: vp.mobile ? 2 : 1, mobile: vp.mobile,
    });
    await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
    await waitFor(page, `!!document.querySelector('.main')`, vp.name + ' 外壳', 15000);
  };

  const gotoView = async (v) => {
    await gotoCalendar();
    await evalJs(page, `
      const b = document.querySelector('.view-switch [data-view="${v}"]');
      if (b) b.click();
      return !!b;
    `);
    await waitFor(page, `!!document.querySelector('.content-day, .content-month')`, '日程页的 ' + v + ' 档');
  };

  const gotoDay = async () => {
    await gotoView('day');
    await waitFor(page, `!!document.querySelector('.task-el--timed, .task-el--untimed')`, '日视图里的任务卡');
  };

  /* `noAttr` = 先把 `<html data-card-font>` 摘掉再量：这是「挂默认档」与「压根没挂档」
     的对照。档位要是只写在 `[data-card-font="…"]` 而没有 `:root` 的默认值，摘掉之后
     `calc(var(--fs-title) * var(--card-font-scale))` 引用了一个不存在的变量 → 整条
     font-size 失效、字号掉回继承值。tokens.css 里那条 `--card-font-scale: 1`
     是**默认值**、不是 `var()` 的兜底值，这条就是钉它的。 */
  const READ = `
    const html = document.documentElement;
    const keep = html.dataset.cardFont;
    const root = getComputedStyle(html);
  `;
  const readCard = (noAttr) => evalJs(page, `
    ${READ}
    if (${noAttr ? 'true' : 'false'}) delete html.dataset.cardFont;
    const card = document.querySelector('.task-el--timed') || document.querySelector('.task-el--untimed');
    if (!card) { if (keep) html.dataset.cardFont = keep; return { missing: true }; }
    const dot = card.querySelector('.check-btn');
    const out = {
      attr: html.dataset.cardFont || null,
      scale: parseFloat(root.getPropertyValue('--card-font-scale')),
      fsTitle: parseFloat(root.getPropertyValue('--fs-title')),
      fontSize: parseFloat(getComputedStyle(card).fontSize),
      dotSize: dot ? parseFloat(getComputedStyle(dot).width) : null,
      cls: card.className,
    };
    if (keep) html.dataset.cardFont = keep;
    return out;
  `);

  const readRow = () => evalJs(page, `
    const row = document.querySelector('.list-view .row-title');
    return row ? parseFloat(getComputedStyle(row).fontSize) : null;
  `);

  /* 月视图的胶囊是这一档的**第二个消费点**（calendar.css 的 `.task-pill`）：
     只量 `.task-el` 的话，「以后有人给胶囊补一条 font-size 把倍率漏掉」不会红。 */
  const readPill = (noAttr) => evalJs(page, `
    ${READ}
    if (${noAttr ? 'true' : 'false'}) delete html.dataset.cardFont;
    const p = document.querySelector('.task-pill');
    if (!p) { if (keep) html.dataset.cardFont = keep; return null; }
    const out = { fontSize: parseFloat(getComputedStyle(p).fontSize),
                  h: +p.getBoundingClientRect().height.toFixed(2),
                  fsTitle: parseFloat(root.getPropertyValue('--fs-title')) };
    if (keep) html.dataset.cardFont = keep;
    return out;
  `);

  /* 列表行量「今天」页那一条，不走去待办箱：这一探针的种子任务**都有日期**，
     待办箱（date === null 的未完成任务）是空的，等 .row-title 会等到超时。 */
  const gotoList = async () => {
    await evalJs(page, `
      const n = document.querySelector('[data-nav="today"]')
        || [...document.querySelectorAll('.tabbar .tab')].find((b) => /今天/.test(b.textContent));
      if (n) n.click();
      return !!n;
    `);
    await waitFor(page, `!!document.querySelector('.list-view .row-title')`, '「今天」页的列表行');
    return readRow();
  };

  /* 进设置页：窄屏侧栏整个不渲染（Shell.tsx 的 narrow 分支），而 settings 恒不在
     ui.tabs 里（CUSTOMIZABLE 排掉了它）→ 窄屏唯一的入口是底栏「更多」抽屉里那格。
     宽屏反过来在侧栏 footer。两条都试，别按当前屏猜：这一节自己定视口，
     但入口路径写死成一条的话，换视口跑就红在「等不到设置页」这种跟被测行为
     毫无关系的地方（上一版就栽在窄屏这一半）。 */
  const openSettings = async () => {
    const where = await evalJs(page, `
      const s = document.querySelector('.sidebar [data-nav="settings"]');
      if (s) { s.click(); return 'sidebar'; }
      const inSheet = document.querySelector('.more-sheet [data-nav="settings"]');
      if (inSheet) { inSheet.click(); return 'more-sheet'; }
      const more = [...document.querySelectorAll('.tabbar .tab')].find((b) => /更多/.test(b.textContent));
      if (more) { more.click(); return 'tabbar'; }
      return null;
    `);
    if (where === 'tabbar') {
      await waitFor(page, `!!document.querySelector('.more-sheet [data-nav="settings"]')`, '「更多」抽屉里的「设置」那格');
      await evalJs(page, `document.querySelector('.more-sheet [data-nav="settings"]').click(); return true;`);
    } else if (where === null) {
      throw new Error('进不去设置页：侧栏、底栏「更多」抽屉里都没有「设置」入口');
    }
    return where;
  };

  const openDisplayTab = async () => {
    await openSettings();
    await waitFor(page, `!!document.querySelector('[data-settings-tab="display"]')`, '设置页的「显示」那一排 tab');
    await evalJs(page, `document.querySelector('[data-settings-tab="display"]').click(); return true;`);
  };

  /* 走界面换档（不是往 localStorage 里塞）：这条断言要证的就是「用户在设置页点一下，
     屏幕立刻跟着变」，绕过去就等于没测。 */
  const pickScale = async (k) => {
    await openDisplayTab();
    /* 「显示」tab 里只有这一排用 sm / md / lg 三个 key（同一页那张日视图时间窗走
       Dropdown，不是 Chips），所以 data-pick 在这页里是唯一的。 */
    await waitFor(page, `!!document.querySelector('[data-pick="${k}"]')`, '「任务卡字号」那一排里的 ' + k);
    await evalJs(page, `document.querySelector('[data-pick="${k}"]').click(); return true;`);
    await waitFor(page, `document.documentElement.dataset.cardFont === '${k}'`,
      'html 上的 data-card-font 换成 ' + k + '（不刷新就生效）');
    await gotoDay();
  };

  /**
   * 「显示」页里那三排开关（来源标记 / 重复标记 / 现在时刻线）都叫 on / off，
   * 所以 `[data-pick="off"]` 在这一页里有三个 —— 只按属性取会点错排。
   * 按 Field 的文字认那一排（Field 没有 data-*，外层 div 的文字里有标签）。
   */
  const pickChip = async (labelText, key) => {
    await openDisplayTab();
    const hit = await evalJs(page, `
      const g = [...document.querySelectorAll('[role="group"]')].find((el) => {
        const owner = el.parentElement;
        return owner && owner.textContent.includes(${JSON.stringify(labelText)});
      });
      const btn = g && g.querySelector('[data-pick=${JSON.stringify(key)}]');
      if (!btn) return false;
      btn.click();
      return true;
    `);
    if (!hit) throw new Error('「显示」页里找不到「' + labelText + '」那一排的 ' + key);
  };

  console.log('\n九、断言：设置页「显示」—— 任务卡字号三档 + 三排开关');
  console.log('    ① 默认档 = 原基准（--fs-title）② 倍率 = .875 / 1 / 1.125 ③ 圈跟任务名一起大小、且不比它大');
  console.log('    ④ 列表行不吃这一档、月胶囊吃 ⑤ 挂「中」档 = 压根没挂档 ⑥ 换档不刷新就生效');
  console.log('    另：来源标记 / 重复标记 / 现在时刻线 —— 关掉归零、开回就回来（宽屏那一趟）');

  for (const vp of LEGS) {
    const at = (s) => vp.name + ' ' + s;
    await setViewport(vp);

    await gotoDay();
    const md = await readCard();
    if (md.missing) { ok(false, at('这一屏没有任务卡可量（第九节找不到 .task-el）')); continue; }
    console.log('  [当场读数 ' + vp.name + '] ' + JSON.stringify(md));

    ok(md.attr === 'md', at('默认档是「中」，实际 data-card-font=' + md.attr));
    ok(Math.abs(md.scale - SCALE.md) <= 0.001, at('md 档的倍率 = 1，实际 ' + md.scale));
    ok(Math.abs(md.fontSize - md.fsTitle) <= 0.01,
      at('md 档卡片字号 = --fs-title（档位默认值不许改变现状）：卡 ' + md.fontSize + ' vs 令牌 ' + md.fsTitle));
    ok(md.dotSize !== null && Math.abs(md.dotSize - md.fontSize) <= 0.5,
      at('圈径跟这一行字号一致（--check-k = 1）：圈 ' + md.dotSize + ' vs 字号 ' + md.fontSize));

    const mdPlain = await readCard(true);
    ok(Math.abs(mdPlain.fontSize - md.fontSize) <= 0.01
      && mdPlain.dotSize !== null && Math.abs(mdPlain.dotSize - md.dotSize) <= 0.5,
      at('挂「中」档等于压根没挂档（摘掉 data-card-font 再量）：卡 ' + mdPlain.fontSize + ' / 圈 ' + mdPlain.dotSize
        + ' vs 挂档的 ' + md.fontSize + ' / ' + md.dotSize));

    await gotoView('month');
    const pillMd = await readPill();
    const pillPlain = await readPill(true);
    console.log('  [月胶囊 ' + vp.name + '] ' + JSON.stringify(pillMd));
    ok(pillMd !== null && pillPlain !== null && Math.abs(pillMd.fontSize - pillPlain.fontSize) <= 0.01,
      at('月胶囊同样「挂中档 = 没挂档」（窄屏胶囊有自己的小档基准，这里只锁倍率不锁基准）：'
        + (pillMd && pillMd.fontSize) + ' vs ' + (pillPlain && pillPlain.fontSize)));
    await gotoDay();

    const rowAtMd = await gotoList();

    await pickScale('lg');
    const lg = await readCard();
    console.log('  [lg 读数 ' + vp.name + '] ' + JSON.stringify(lg));
    const ratioLg = lg.fontSize / md.fontSize;
    ok(Math.abs(ratioLg - SCALE.lg) <= TOL, at('lg 档 = md × 1.125，实际 ×' + ratioLg.toFixed(3)));
    ok(Math.abs(lg.scale - SCALE.lg) <= 0.001, at('倍率写在令牌里（lg）：' + lg.scale));
    ok(lg.dotSize !== null && lg.dotSize <= lg.fontSize + 0.5,
      at('lg 档圈仍不比任务名大（2026-10-24 那条红线）：圈 ' + lg.dotSize + ' vs 字号 ' + lg.fontSize));
    ok(lg.dotSize !== null && Math.abs(lg.dotSize - lg.fontSize) <= 0.5,
      at('lg 档圈跟着任务名一起放大：圈 ' + lg.dotSize + ' vs 字号 ' + lg.fontSize));
    ok(lg.dotSize !== null && lg.dotSize <= CHECK_MAX + 0.5,
      at('lg 档没顶到 --check-max(' + CHECK_MAX + ') 那道天花板：圈 ' + lg.dotSize));

    await gotoView('month');
    const pillLg = await readPill();
    ok(pillLg !== null && pillMd !== null
      && Math.abs(pillLg.fontSize / pillMd.fontSize - SCALE.lg) <= TOL,
      at('月胶囊跟着这一档放大（第二个消费点没漏）：' + (pillLg && pillLg.fontSize) + ' / ' + (pillMd && pillMd.fontSize)));
    ok(pillLg !== null && pillMd !== null && pillLg.h <= pillMd.h + 0.5,
      at('字放大了胶囊不许跟着长高（胶囊高由 --pill-h 自己算，「装不下只压不加长」）：'
        + (pillLg && pillLg.h) + ' vs ' + (pillMd && pillMd.h)));
    await gotoDay();

    await pickScale('sm');
    const sm = await readCard();
    console.log('  [sm 读数 ' + vp.name + '] ' + JSON.stringify(sm));
    const ratioSm = sm.fontSize / md.fontSize;
    ok(Math.abs(ratioSm - SCALE.sm) <= TOL, at('sm 档 = md × 0.875，实际 ×' + ratioSm.toFixed(3)));
    ok(sm.dotSize !== null && Math.abs(sm.dotSize - sm.fontSize) <= 0.5,
      at('sm 档圈跟着任务名一起缩小：圈 ' + sm.dotSize + ' vs 字号 ' + sm.fontSize));
    ok(sm.dotSize !== null && sm.dotSize >= CHECK_MIN - 0.5,
      at('sm 档没掉到 --check-min(' + CHECK_MIN + ') 那道地板以下：圈 ' + sm.dotSize));

    /* 列表行不在这一档的作用范围里（它走 --fs-row）—— 锁住范围，不然以后一处改会漂成两处。
       pickScale 最后停在日历页，所以要再去一趟列表页才量得到那一行。 */
    await gotoList();
    const rowAtSm = await readRow();
    ok(rowAtMd !== null && rowAtSm !== null && Math.abs(rowAtSm - rowAtMd) <= 0.01,
      at('列表行字号不跟着这一档变：md ' + rowAtMd + ' → sm ' + rowAtSm));

    await pickScale('md');
    const back = await readCard();
    ok(Math.abs(back.fontSize - md.fontSize) <= 0.01, at('换回 md 后字号回到基准：' + back.fontSize));

    /* ── 同一页那三排开关：新加的，之前一条覆盖都没有 ──
       判据统一成「关掉 → 那个元素数量归零；打开 → 回来」，而且**不刷新**。
       `TaskCard` 读的是 `store.get().ui.showRepeatMark`（不是 prop），所以这一趟
       同时锁的是「改了 ui 之后日历那一整棵树真的重渲染了」。
       只在宽屏这一趟跑：来源标记按规则只在**宽屏 3 日档**画（WeekView 的
       `dayCount === 3 && !isNarrowNow()`），窄屏上「关掉归零」本来就成立 —— 假通过。 */
    if (!vp.mobile) {
      const count = (sel) => evalJs(page, `return document.querySelectorAll(${JSON.stringify(sel)}).length;`);

      await gotoDay();
      const rep0 = await count('.rep-flag--corner');
      ok(rep0 > 0, at('开关动之前先有东西可关：日视图上有重复角标 ' + rep0 + ' 枚（0 枚等于没测）'));
      await pickChip('重复标记', 'off');
      await gotoDay();
      await waitFor(page, `document.querySelectorAll('.rep-flag--corner').length === 0`, '关掉「重复标记」后卡上没有角标');
      ok(true, at('关掉「重复标记」→ 卡上角标归零（不刷新，开关前 ' + rep0 + ' 枚）'));
      await pickChip('重复标记', 'on');
      await gotoDay();
      await waitFor(page, `document.querySelectorAll('.rep-flag--corner').length > 0`, '开回「重复标记」后角标回来');
      ok(true, at('开回「重复标记」→ 角标恢复'));

      const now0 = await evalJs(page, `
        return { line: document.querySelectorAll('.tl-now').length,
                 ball: document.querySelectorAll('.tl-now-ball').length };
      `);
      ok(now0.line > 0 && now0.ball > 0,
        at('今天那根现在时刻线本来在（线 ' + now0.line + ' 条、球 ' + now0.ball + ' 颗）'));
      await pickChip('现在时刻线', 'off');
      await gotoDay();
      await waitFor(page, `document.querySelectorAll('.tl-now, .tl-now-ball').length === 0`, '关掉「现在时刻线」后线和球都没了');
      ok(true, at('关掉「现在时刻线」→ 线与球一起消失（不刷新）'));
      await pickChip('现在时刻线', 'on');
      await gotoDay();
      await waitFor(page, `document.querySelectorAll('.tl-now').length > 0`, '开回「现在时刻线」后线回来');
      ok(true, at('开回「现在时刻线」→ 线恢复'));

      await gotoView('3day');
      const tag0 = await count('.creator-tag');
      ok(tag0 > 0, at('宽屏 3 日档本来有来源 tag ' + tag0 + ' 枚（0 枚等于没测这一排）'));
      await pickChip('来源标记', 'off');
      await gotoView('3day');
      await waitFor(page, `document.querySelectorAll('.creator-tag').length === 0`, '关掉「来源标记」后 tag 归零');
      ok(true, at('关掉「来源标记」→ 宽屏 3 日档的 tag 归零（不刷新，开关前 ' + tag0 + ' 枚）'));
      await pickChip('来源标记', 'on');
      await gotoView('3day');
      await waitFor(page, `document.querySelectorAll('.creator-tag').length > 0`, '开回「来源标记」后 tag 回来');
      ok(true, at('开回「来源标记」→ tag 恢复'));
    }
  }
}

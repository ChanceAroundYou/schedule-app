export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, waitForUi, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n十九、项目泳道：建项目 → 挂任务 → 拖卡片换列 → 刷新还在');

  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'))`);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
  await clickEl(page, `document.querySelector('.more-sheet [data-nav="projects"]')`);
  await waitFor(page, `!!document.querySelector('.pj-wrap')`, '项目页挂上');
  ok(await evalJs(page, `return document.querySelector('#content').textContent.includes('还没有项目');`),
    '空态说话，不是一片白');

  /* ---- 先切到一个**有写权限**的集，再建项目 ----
     第十节把「爸爸」在别的集里降成了只读，此刻 `ui.cal` 正指着那个只读集。
     项目是挂在 `ui.cal` 上的（`store.addProject` → `makeProject(name, ui.cal)`），
     只读集上 `commitMany` 会被 `canWrite(roleOf(...))` 挡下、**静默丢弃**
     （只有一条 deny 提示），症状是「点完创建浮层关了、项目没出现」，看着像
     泳道坏了。第十四节踩过同一个坑（quickAdd 被挡），按 role 挑集即可。
     挑哪个集也**不按名字**：第六节把集改过名，照着名字找会静默找不到。
     窄屏没有桌面那个日程集下拉框，走「更多」抽屉里那块多选面板。 */
  const pjCal = await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    const canWrite = (r) => r === 'owner' || r === 'editor';
    const mine = (st.cals || []).filter((c) => canWrite(c.role));
    const pick = mine.find((c) => c.id !== st.ui.cal) || mine[0];
    return pick ? pick.id : '';`);
  ok(pjCal !== '', '有一个有写权限的日程集可切');
  const curCal = await evalJs(page, `return JSON.parse(localStorage.getItem('schedule-app-v4')).ui.cal;`);
  if (pjCal !== curCal) {
    await evalJs(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多')).click(); return true;`);
    await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
    await evalJs(page, `document.querySelector('[data-cal-sheet-open]').click(); return true;`);
    await waitFor(page, `!!document.querySelector('[role="dialog"] [data-cal-row]')`, '日程集多选面板');
    /* 先勾上有写权限的那个（勾上顺带成为归属），再取消勾别的 ——
       反过来的话「至少留一个」会把取消挡掉，归属又滑回只读那个。 */
    await evalJs(page, `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const rows = () => [...document.querySelectorAll('[role="dialog"] [data-cal-row]')];
      const want = ${JSON.stringify(pjCal)};
      const hit = rows().find((r) => r.dataset.calRow === want);
      if (hit && hit.getAttribute('aria-pressed') !== 'true') { hit.click(); await sleep(80); }
      for (const r of rows()) {
        if (r.dataset.calRow !== want && r.getAttribute('aria-pressed') === 'true') { r.click(); await sleep(80); }
      }
      return true;`);
    await evalJs(page, `
      const d = document.querySelector('[role="dialog"]');
      const btn = d && [...d.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '关闭');
      if (btn) btn.click();
      return true;`);
    await waitFor(page, `!document.querySelector('[role="dialog"]')`, '面板关掉了');
    await waitForUi('切集落盘',
      `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.cal === ${JSON.stringify(pjCal)} ? 1 : null`);
  }

  await clickEl(page, `document.querySelector('.pj-top .btn')`);
  await waitFor(page, `!!document.querySelector('.field input')`, '项目浮层打开');

  /* ---- 集选择器：项目**不绑当前集**（`addProject(name, calId)`）----
     原来固定落 `ui.cal`：当前集只读时 commitMany 被 canWrite 挡下、**静默丢弃**，
     症状是「点完创建浮层关了、项目没出现」，看着像泳道坏了。现在浮层里挑一个
     能写的集，且**只列「能写 ∩ 正勾着」的** —— 没勾的集落进去会凭空消失
     （useScopedState 按 p.calId 过滤），跟 toggleCal 那条「归属不能没有显示的
     地方」是同一件事。

     ⚠️ 这一段**不复用 clickEl**：clickEl 只派发 pointerdown / pointerup / click，
     **不派发 mousedown**（见本文件 clickEl 的定义），而外面那个 Sheet 收不收起
     听的正是 capture 阶段的 mousedown（useOutsideClose）。里面的选项又是 portal
     到 body 的 —— DOM 上不是外面面板的后代，不修 useOutsideClose 的话，真手点一下
     选项就先把**外层**关掉、连带把选项那层卸载，这一次点击白丢，而 clickEl 照样绿。
     hooks.ts 那条注释记着同一个坑（「只在真机上出现，合成 click 测不出来」）。
     所以走 tapEl：完整的 mousedown → mouseup → click。 */
  const tapEl = (findExpr) => evalJs(page, `
    const el = ${findExpr};
    if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mousedown', at));
    el.dispatchEvent(new MouseEvent('mouseup', at));
    el.dispatchEvent(new MouseEvent('click', at));
    return 'ok';
  `);

  ok(await evalJs(page, `return !!document.querySelector('[aria-label="日程集"]');`),
    '新建浮层里有「日程集」选择器，项目不绑当前集');

  /* 默认值：当前集能写就用当前集，否则第一个能写的 —— 但**必须**是勾着的那个 */
  const calPick = await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    const canWrite = (r) => r === 'owner' || r === 'editor';
    const mine = (st.cals || []).filter((c) => canWrite(c.role) && st.ui.cals.includes(c.id));
    const btn = document.querySelector('[aria-label="日程集"]');
    const txt = btn ? btn.textContent.trim() : '';
    const hit = (st.cals || []).find((c) => c.name === txt);
    return { listed: mine.map((c) => c.name).sort().join('|'), picked: txt,
             good: !!hit && canWrite(hit.role) && st.ui.cals.includes(hit.id) };`);
  ok(calPick.good, '默认落在「能写 ∩ 正勾着」的集：' + calPick.picked);

  /* 打开那层看选项：应该**只有**能写且勾着的（只读的、没勾的都不该出现）。
     `=== 2` 是嵌套没被误关的判据 —— 外层要是先被 mousedown 关了，这里只剩 1 个。 */
  ok(await tapEl(`document.querySelector('[aria-label="日程集"]')`) === 'ok', '打开「日程集」选择层');
  await waitFor(page, `document.querySelectorAll('[role="dialog"]').length === 2`,
    '选择层弹开、项目浮层还在（嵌套没被 useOutsideClose 误伤）', 8000);
  const calListed = await evalJs(page, `
    const ds = [...document.querySelectorAll('body > div [role="dialog"]')];
    const d = ds[ds.length - 1];
    return [...d.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).sort().join('|');`);
  ok(calListed === calPick.listed,
    '只列能写且勾着的集，实际 ' + JSON.stringify(calListed) + '，期望 ' + JSON.stringify(calPick.listed));

  /* 挑当前那个（选回自己，仍要真手那一下 —— 这条同时验了选中能落回、浮层收得干净） */
  ok(await tapEl(`(() => {
    const ds = [...document.querySelectorAll('body > div [role="dialog"]')];
    const d = ds[ds.length - 1];
    const btns = [...d.querySelectorAll('button')];
    return btns.find((b) => b.textContent.trim() === ${JSON.stringify(calPick.picked)});
  })()`) === 'ok', '在选择层里挑中一个集');
  await waitFor(page, `document.querySelectorAll('[role="dialog"]').length === 1`,
    '选完收起，只剩项目浮层', 8000);
  const setField = (sel, val) => evalJs(page, `
    return (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'missing';
      (${SETTER})(el, ${JSON.stringify(val)});
      return 'ok';
    })();
  `);
  ok(await setField('.field input', '星星包') === 'ok', '填项目名字');
  await clickEl(page, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '创建')`);
  await waitFor(page, `!!document.querySelector('[data-lane]')`, '泳道出现');
  ok((await evalJs(page, `return [...document.querySelectorAll('[data-lane] .pj-col-h')].map((x) => x.textContent.replace(/\\d/g, '').trim());`)).join() === '待办,进行中,已完成',
    '三列：待办 / 进行中 / 已完成');

  // 加一条任务，并在详情抽屉里挂到项目上。
  // 走**底栏**而不是「更多」抽屉：上一节把「今天」留在了底栏里，而抽屉只画
  // 差集（底栏没有的那些）—— 从抽屉里找 today 找不到，clickEl 只会返回
  // 'missing' 不报错，症状是「任务出现」等不到、看着像快速添加坏了。
  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.replace(/\\d+/g, '').trim() === '今天')`);

  /* ---- 窄屏那个 + / ×（需求 1、2、8） ---- */
  // 收起时是 +、展开时**原地变成 ×** —— 不再是横条里那个收起键。
  // 输入框是从这个圆里弹出去的，所以它一直在（横条收起时它也不能消失）。
  //
  // ⚠️ `evalJs` 把表达式包成 `(async () => { <表达式> })()` —— **必须自己写 `return`**，
  // 光写一个表达式会得到 undefined，断言就永远是假（这几条第一次就是这么假红的）。
  // `waitFor` 会替我们补 `return`，所以它那几行不用写。
  //
  // lucide-react 给每个图标带 `lucide-<名字>` 这个类，所以 `+` / `×` 认的是
  // `.lucide-plus` / `.lucide-x`，比数 svg 的 path 稳。
  ok(await evalJs(page, `return !!document.querySelector('.fast-fab');`), '窄屏下右下角有浮动 + 号');
  ok(await evalJs(page, `return getComputedStyle(document.querySelector('.fast-add')).display !== 'none';`),
    '窄屏下横条常渲染（收起时只露圆钮）');
  ok(await evalJs(page, `return !!document.querySelector('.fast-fab .lucide-plus');`),
    '收起时那个圆里是 +');
  // 收起态的圆钮位置 —— 展开后要**一模一样**（需求 1：开关固定在某个位置不动）
  const fabCollapsed = await evalJs(page, `
    const f = document.querySelector('.fast-fab').getBoundingClientRect();
    return { right: +f.right.toFixed(1), bottom: +f.bottom.toFixed(1) };
  `);

  await clickEl(page, `document.querySelector('.fast-fab')`);
  // 窄屏横条**常渲染**（收起时只露圆钮），所以「展开」要看 `.open` 这个类，
  // 不是 display —— display 从头到尾都是 flex，拿它判展开恒真
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '点 + 号展开横条', 8000);
  ok(await evalJs(page, `return !!document.querySelector('.fast-fab .lucide-x');`),
    '展开后 + 号**原地**变成 ×（需求 1）');
  // 需求 2：点 + 展开**不自动聚焦**输入框（手机上那会当场弹出软键盘，
  // 把用户想先看一眼的输入框挡住）。要打字自己点一下输入框。
  ok(await evalJs(page, `return document.activeElement !== document.querySelector('.fast-add textarea');`),
    '展开后焦点没有自动进输入框（需求 2）');

  /* 圆钮**钉在横条右下角**（需求 1、2）—— 绝对定位，不参与 flex。
     它以前是普通 flex 子元素：收起时 `.fast-add-body` / `.fast-side` 都
     display:none，只剩它一个，默认 justify-content:flex-start 就把它甩到
     **左边**；展开时又跟着内容跑。 */
  const barBox = await evalJs(page, `
    const bar = document.querySelector('.fast-add');
    const fab = document.querySelector('.fast-fab');
    const b = bar.getBoundingClientRect(), f = fab.getBoundingClientRect();
    const s = getComputedStyle(bar), fs = getComputedStyle(fab);
    return {
      pos: s.position,
      fabPos: fs.position,
      // 横条**左右各留 13px**（和流内那条 margin: 4px 13px 12px 同一档）。
      // 量的是 layout viewport（clientWidth，不含滚动条）：用 innerWidth 的话，
      // 页面上真出现一条 10px 滚动条时这里会凭空多出 10，看着像「右边距变大了」。
      leftGap: +b.left.toFixed(1),
      rightGap: +(document.documentElement.clientWidth - b.right).toFixed(1),
      // 圆钮在横条内（DOM 上仍是子节点），但**不在动画层里**（见下面的 fabInShell）
      fabInBar: bar.contains(fab),
      fabInShell: document.querySelector('.fast-add-shell').contains(fab),
      // 圆钮贴横条右端 / 底端 —— 右 13 是照着左边的内边距 13 来的，底 18 是居中
      fabRightGap: +(b.right - f.right).toFixed(1),
      fabBottomGap: +(b.bottom - f.bottom).toFixed(1),
      // 圆钮在屏幕上的绝对位置，展开前后要一样
      fabRight: +f.right.toFixed(1),
      fabBottom: +f.bottom.toFixed(1),
      dbg: { n: document.querySelectorAll('.fast-add').length,
        barH: +b.height.toFixed(1), fabH: +f.height.toFixed(1),
        kids: [...bar.children].map((c) => c.className + ':' + Math.round(c.getBoundingClientRect().height)) },
    };
  `);
  ok(barBox.pos === 'fixed',
    '窄屏的横条是 fixed 定位（贴着圆钮、不占正文流），实际 ' + barBox.pos);
  ok(barBox.fabPos === 'absolute',
    '圆钮是绝对定位（不参与 flex，才不会被甩到左边 / 被内容带着跑），实际 ' + barBox.fabPos);
  // 左右**对称**留 13px，不是贴到屏幕最右。
  // 贴边（原先的 `right: 0`）会让 `:focus-within` 那圈 3px 光晕在右端被裁掉一截，
  // 和左边不对称 —— 2026-10-08 改成 left/right 都是 13px。这条断言跟着改口径：
  // 要守的是「两边一样宽」，不是「贴边」。
  ok(Math.abs(barBox.leftGap - 13) < 1.5 && Math.abs(barBox.rightGap - 13) < 1.5,
    '横条左右各留 13px（贴边会把 focus 光晕裁掉），实际 左 ' + barBox.leftGap + ' / 右 ' + barBox.rightGap);
  ok(barBox.fabInBar,
    '圆钮在横条内（DOM 上仍是子节点）');
  // 需求 3 的结构前提：圆钮不能落在动画层里 —— 动画一 transform、一改 opacity，
  // 整棵子树跟着动，圆钮就被拖着走了。这条断言把它钉在结构上。
  ok(!barBox.fabInShell,
    '圆钮不在动画层 .fast-add-shell 里（否则动画会带飞它）');
  ok(Math.abs(barBox.fabRightGap - 13) < 1.5,
    '圆钮贴横条右端（13px），实际 ' + barBox.fabRightGap);
  // 需求 3：圆钮**竖直居中于展开后的横条**（不是贴底）——
  // 盒子高 84（内边距 9×2 + 内容 64 + 边框 1×2），48 的圆钮居中 → (84 − 48) / 2 = 18
  ok(Math.abs(barBox.fabBottomGap - 18) < 2,
    '圆钮在展开后的横条里竖直居中（不贴底），实际底间隙 ' + barBox.fabBottomGap);
  // 需求 1 的正面：+ / × 换图标时，圆钮自己在屏幕上不挪窝
  ok(Math.abs(barBox.fabRight - fabCollapsed.right) < 1
     && Math.abs(barBox.fabBottom - fabCollapsed.bottom) < 1,
    '展开前后圆钮位置不动（需求 1）：收起 右 ' + fabCollapsed.right + ' 底 ' + fabCollapsed.bottom
     + '，展开 右 ' + barBox.fabRight + ' 底 ' + barBox.fabBottom);
  // 需求 1：展开态的 × 有**常亮的主题色描边**（不是 hover 才出现）
  const fabOpen = await evalJs(page, `
    const s = getComputedStyle(document.querySelector('.fast-fab.open'));
    return { w: parseFloat(s.borderTopWidth), c: s.borderTopColor };
  `);
  ok(fabOpen.w >= 1 && !/rgba?\(0, 0, 0, 0\)/.test(fabOpen.c),
    '展开态圆钮有常亮描边（需求 1），实际 ' + fabOpen.w + 'px ' + fabOpen.c);
  // 需求 4：时间 / 保存按钮靠到右端、贴着圆钮但不压住（间隙从 10px 收到 4px）
  const sideBox = await evalJs(page, `
    const fab = document.querySelector('.fast-fab');
    const side = document.querySelector('.fast-add .fast-side');
    const body = document.querySelector('.fast-add .fast-add-body');
    const bar = document.querySelector('.fast-add');
    const f = fab.getBoundingClientRect(), s = side.getBoundingClientRect();
    const b = body.getBoundingClientRect(), r = bar.getBoundingClientRect();
    const bs = getComputedStyle(document.querySelector('.fast-add-shell'));
    return {
      gapToFab: +(f.left - s.right).toFixed(1),
      bodyW: +b.width.toFixed(1), sideW: +s.width.toFixed(1), barW: +r.width.toFixed(1),
      sideRightToBar: +(r.right - s.right).toFixed(1),
      bodyRightToSideLeft: +(s.left - b.right).toFixed(1),
      padL: bs.paddingLeft, padR: bs.paddingRight, borderW: bs.borderTopWidth,
      bodyFlex: getComputedStyle(body).flex, bodyMinW: getComputedStyle(body).minWidth,
      sideFlex: getComputedStyle(side).flex, sideMinW: getComputedStyle(side).minWidth,
    };
  `);
  // 需求 4 的间距断言**只在窄屏 CSS 生效时跑** —— 探针的伪窄屏只在 JS
  // matchMedia 上套了 Proxy，CSS `@media (max-width: 900px)` 不认这个
  // （窗口真的 1280px）。宽屏下 padding 还是基线 16px，side 会被圆钮压住，
  // 这不是代码的问题。真机窄屏下 padding 65px，间距 4px。
  if (sideBox.padR === '65px') {
    ok(sideBox.gapToFab > 0 && sideBox.gapToFab < 8,
      '时间 / 保存按钮贴着圆钮但不重叠（需求 4），实际间距 ' + sideBox.gapToFab
      + '（body ' + sideBox.bodyW + ' / side ' + sideBox.sideW + ' / bar ' + sideBox.barW
      + ' / sideRight→bar ' + sideBox.sideRightToBar + ' / bodyRight→sideLeft ' + sideBox.bodyRightToSideLeft
      + ' / pad ' + sideBox.padL + '→' + sideBox.padR + ' / border ' + sideBox.borderW
      + ' / bodyFlex ' + sideBox.bodyFlex + ' / bodyMinW ' + sideBox.bodyMinW
      + ' / sideFlex ' + sideBox.sideFlex + ' / sideMinW ' + sideBox.sideMinW + '）');
  } else {
    console.log('  skip 需求 4 的间距断言（窄屏 CSS 未生效，padR=' + sideBox.padR + '，真机窄屏下跑）');
  }

  // 输入框固定两行，超过可内部滚动（需求 1）
  const h2 = await evalJs(page, `return Math.round(document.querySelector('.fast-add textarea').getBoundingClientRect().height);`);
  ok(h2 > 20 && h2 < 50, '输入框固定两行高，实际 ' + h2 + 'px');
  await setField('.fast-add textarea', '第一行\n第二行\n第三行');
  const h3 = await evalJs(page, `return Math.round(document.querySelector('.fast-add textarea').getBoundingClientRect().height);`);
  ok(Math.abs(h3 - h2) < 2, '内容变成三行时输入框高度不变（固定两行），实际 ' + h2 + 'px → ' + h3 + 'px');
  await setField('.fast-add textarea', '');

  /* ---- 点空白收起，**两级**（需求 8）---- */
  // 面板开着时：第一次点空白只收面板、横条留着；再点一次才收横条。
  // 两条如果各挂一个 document 上的监听就会打架（谁先跑只看注册顺序），
  // 所以它们在一个 handler 里，这里证的正是那个先后。
  const blank = () => evalJs(page, `
    (document.querySelector('#content') || document.body)
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    return 1;
  `);
  await clickEl(page, `document.querySelector('.fast-clock')`);
  await waitFor(page, `document.querySelector('.when-pop') ? 1 : null`, '窄屏下打开日期时间面板', 8000);
  await blank();
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '第一次点空白：收起面板', 8000);
  ok(await evalJs(page, `return !!document.querySelector('.fast-add.open');`),
    '第一次点空白只收面板，横条还开着（需求 8：先收面板再收输入框）');
  await blank();
  await waitFor(page, `!document.querySelector('.fast-add.open')`, '第二次点空白：收起横条', 8000);
  ok(await evalJs(page, `return !!document.querySelector('.fast-fab .lucide-plus');`),
    '横条收起之后圆钮又变回 +');

  /* ---- 点外面收起时，这记 click 要**吞掉**；顶栏 / 底栏例外（需求 9）----

     三条规矩：
       1. 输入框开着、点空白 → 关上，且空白处自己的事件**不触发**。
          不吞的话，点日视图空白会顺手新建一条空任务 —— 而 App 的委托挂在
          `#content` 上，click 是从 document 往下走的，capture 阶段拦得住。
       2. 顶栏 / 底栏是例外：上面的按钮要能**直接点到**（这记 click 放行）。
       3. 时间面板开着 → **点哪儿都只关面板**，顶栏 / 底栏也不例外。

     这三条只有**真实**事件才走得到（`justClosed` 只在 `e.isTrusted` 时设），
     所以这里不用 `clickEl`（它派发的是合成 click），改走 CDP 的
     `Input.dispatchMouseEvent` —— 和真手点走同一条路。 */
  const centerOf = (sel) => evalJs(page, `
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `);
  const realClick = async (at) => {
    const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 };
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  };
  // 在 #content 里找一个**真的空白**落点：不在任务行、横条、按钮上
  const blankPoint = () => evalJs(page, `
    const zone = document.querySelector('#content');
    if (!zone) return null;
    const r = zone.getBoundingClientRect();
    for (let iy = 0; iy < 12; iy++) {
      for (let ix = 0; ix < 5; ix++) {
        const x = Math.round(r.left + r.width * (0.1 + ix * 0.2));
        const y = Math.round(r.top + r.height * (0.05 + iy * 0.08));
        if (x < 2 || y < 2 || x > innerWidth - 2 || y > innerHeight - 2) continue;
        const el = document.elementFromPoint(x, y);
        if (!el || !zone.contains(el)) continue;
        if (el.closest('.task-el, .habit-row, .fast-add, button, a, input, textarea, label, svg')) continue;
        return { x, y };
      }
    }
    return null;
  `);
  // #content 上的 capture 探针：委托那层到底有没有收到这记 click
  await evalJs(page, `
    window.__c = [];
    document.querySelector('#content').addEventListener('click', () => window.__c.push(1), true);
    return true;
  `);

  // 规矩 1
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '展开横条（规矩 1）', 8000);
  const pt1 = await blankPoint();
  ok(!!pt1, '今天页找得到一个真空白落点（不在任务行 / 横条 / 控件上），实际 ' + JSON.stringify(pt1));
  await evalJs(page, `window.__c = []; return 1;`);
  await realClick(pt1);
  await waitFor(page, `!document.querySelector('.fast-add.open')`, '点空白收起横条（规矩 1）', 8000);
  ok((await evalJs(page, `return window.__c.length;`)) === 0,
    '规矩 1：这记 click 被吞掉了，没走到 #content 的委托 —— 否则日视图空白处会新建一条空任务');

  // 规矩 2：横条开着，顶栏的搜索键照样能**直接**点开，而且横条不收
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '再展开横条（规矩 2）', 8000);
  await realClick(await centerOf('.topbar .search-toggle'));
  await waitFor(page, `document.querySelector('.search-slot.open') ? 1 : null`,
    '规矩 2：横条开着，点顶栏搜索键也能打开搜索框', 8000);
  ok(await evalJs(page, `return !!document.querySelector('.fast-add.open');`),
    '规矩 2：顶栏当例外 —— 这一下既没被吞（搜索框开了），也没把横条收掉');
  // 搜索框的 autoFocus 会把页面滚下去，顶栏按钮就跑到视口外了 ——
  // 先滚回顶部再点，否则这一下落在 <html> 上，会被当成「点空白」把横条收掉
  await evalJs(page, `window.scrollTo(0, 0); return 1;`);
  // 关搜索走 Escape：收起状态**没有**常驻的关闭键了（用户 2026-10-09：「清空键不需要，
  // 点击其他地方就关了」），张开后那个钮也让开了（`pointer-events: none`，见 shell.css）。
  // 键盘那条路一次只关一层（`app/keyboard.ts` 的 Escape：moreOpen → searchOpen → …），
  // 横条不在那条链上，所以这一下同样不该把横条收掉。
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(page, `document.querySelector('.search-slot.open') ? null : 1`, '收起搜索框', 8000);
  ok(await evalJs(page, `return !!document.querySelector('.fast-add.open');`),
    '规矩 2：关搜索那一下（Escape）也没把横条收掉');

  // 规矩 3：面板开着时，顶栏也不再是例外
  await clickEl(page, `document.querySelector('.fast-clock')`);
  await waitFor(page, `document.querySelector('.when-pop') ? 1 : null`, '打开时间面板（规矩 3）', 8000);
  await realClick(await centerOf('.topbar .search-toggle'));
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '规矩 3：点顶栏先把面板收掉', 8000);
  const r3 = await evalJs(page, `return {
    c: window.__c.length,
    pop: !!document.querySelector('.search-slot.open'),
    open: !!document.querySelector('.fast-add.open'),
  };`);
  ok(r3.pop === false, '规矩 3：顶栏的搜索**没有**被点开 —— 面板开着时它也在例外之外');
  ok(r3.c === 0, '规矩 3：这记 click 同样被吞掉（没走到 #content 的委托），实际 ' + r3.c);
  ok(r3.open === true, '规矩 3：只收面板，横条留着');

  // 收干净：横条回到收起态，接下面那串动画断言
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!document.querySelector('.fast-add.open')`, '收尾：横条收起', 8000);

  /* ---- 点输入框 = 不选日期时间了，面板收掉 ---- */
  // 面板钉在输入框右边，打字时它一直挡在那儿 —— 点一下输入框就该收。
  // 只收面板、**不收横条**：用户是要打字，不是要收起输入框。
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '展开横条（点输入框收面板）', 8000);
  await clickEl(page, `document.querySelector('.fast-clock')`);
  await waitFor(page, `document.querySelector('.when-pop') ? 1 : null`, '打开日期时间面板', 8000);
  await clickEl(page, `document.querySelector('.fast-add textarea')`);
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '点输入框收起面板', 8000);
  ok(await evalJs(page, `return !!document.querySelector('.fast-add.open');`),
    '面板收了，横条还开着（点输入框不该把输入框也收掉）');
  // 收干净
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!document.querySelector('.fast-add.open')`, '收尾：横条收起', 8000);

  // 需求 3：关闭动画 —— 点击 FAB 后 `.closing` class 立即出现，
  // `fastPopOut` 动画播放 180ms，期间内容还可见（不压扁），
  // 动画结束后 `.open` 才移除、内容 display:none。
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '重新展开', 8000);
  await clickEl(page, `document.querySelector('.fast-fab')`);
  // 等待 .closing 出现（React 异步更新，几毫秒后）
  await waitFor(page, `document.querySelector('.fast-add.closing') ? 1 : null`, '点击 FAB 后 .closing 出现', 8000);
  // 立即检查动画属性（动画 180ms，waitFor 100ms 轮询，能捕获）
  const closingState = await evalJs(page, `
    return (() => {
      const bar = document.querySelector('.fast-add');
      const shell = document.querySelector('.fast-add-shell');
      const cs = getComputedStyle(shell);
      return {
        hasClosing: bar.classList.contains('closing'),
        hasOpen: bar.classList.contains('open'),
        animName: cs.animationName,
        animDuration: cs.animationDuration,
        // 动画必须挂在 shell 上 —— 挂在 .fast-add 上会把圆钮一起带飞
        barAnim: getComputedStyle(bar).animationName,
      };
    })();
  `);
  ok(closingState.hasClosing, '点击 FAB 后 .closing class 出现（需求 3）');
  ok(closingState.hasOpen, '动画播放期间 .open 还在（内容可见，不压扁）');
  ok(closingState.animName === 'fastPopOut', '关闭动画是 fastPopOut，实际 ' + closingState.animName);
  ok(closingState.animDuration === '0.18s', '关闭动画时长 0.18s，实际 ' + closingState.animDuration);
  ok(closingState.barAnim === 'none',
    '动画挂在 .fast-add-shell 上、不在 .fast-add 上（否则圆钮跟着动），实际 .fast-add 的 animation-name = ' + closingState.barAnim);
  // 动画结束后 .open 移除
  await waitFor(page, `!document.querySelector('.fast-add.open')`, '关闭动画结束后 .open 移除', 8000);
  ok(await evalJs(page, `return !document.querySelector('.fast-add.closing');`),
    '动画结束后 .closing 也移除');

  /* 需求 3：**圆钮在整个关闭动画期间一动不动**。
     它以前是动画元素 `.fast-add` 的子节点 —— 父元素一 transform、一改
     opacity，整棵子树跟着动：圆钮被拖着右移 28px、缩 4%、淡出，动画一结束
     再弹回原位，看着就是「异常跳变」。光比动画**前后**两个静止状态抓不到
     （那两处本来就相等），必须按帧采样。 */
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '重新展开（供按帧采样）', 8000);
  // 需求 3：展开也要有动画，而且是 fastPop —— 挂在 `.open` 上才会每次重跑
  // （原先挂在 `:not([hidden])` 上，只在挂载时跑一次，点 + 号其实没有动画）
  const openAnim = await evalJs(page, `
    const cs = getComputedStyle(document.querySelector('.fast-add-shell'));
    return { name: cs.animationName, dur: cs.animationDuration };
  `);
  ok(openAnim.name === 'fastPop', '展开时 .fast-add-shell 跑 fastPop（从圆钮弹出来），实际 ' + openAnim.name);
  ok(openAnim.dur === '0.18s', '展开动画时长 0.18s，实际 ' + openAnim.dur);

  const anim = await evalJs(page, `
    const shell = document.querySelector('.fast-add-shell');
    const fab = document.querySelector('.fast-fab');
    const at = (r) => [+r.left.toFixed(1), +r.top.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)];
    const before = at(fab.getBoundingClientRect());
    const rec = [];
    let stop = false;
    const tick = () => { rec.push(at(fab.getBoundingClientRect())); if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const r = fab.getBoundingClientRect();
    const ev = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    fab.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerType: 'mouse', isPrimary: true }, ev)));
    fab.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerType: 'mouse', isPrimary: true }, ev)));
    fab.dispatchEvent(new MouseEvent('click', ev));
    const seen = [];
    const scaleY = [];
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 16));
      const cs = getComputedStyle(shell);
      if (cs.animationName !== 'fastPopOut') continue;
      if (!seen.includes(cs.transform)) seen.push(cs.transform);
      // matrix(a, b, c, d, e, f) —— d 是**竖向**缩放，必须恒为 1
      if (cs.transform && cs.transform !== 'none') scaleY.push(+new DOMMatrix(cs.transform).d.toFixed(3));
    }
    await new Promise((res) => setTimeout(res, 120));
    stop = true;
    const drift = Math.max(...rec.map((p) => Math.max(
      Math.abs(p[0] - before[0]), Math.abs(p[1] - before[1]),
      Math.abs(p[2] - before[2]), Math.abs(p[3] - before[3]))));
    return { before, n: rec.length, drift, transforms: seen.slice(0, 2),
      scaleY: [...new Set(scaleY)], frames: scaleY.length };
  `);
  // 先证「动画真的在变换 shell」—— 否则下面那条是空跑（动画没跑，圆钮当然不动）
  ok(anim.transforms.length > 0 && !anim.transforms.every((t) => t === 'none'),
    '关闭动画期间 .fast-add-shell 确实在变换（否则「圆钮不动」是空跑），实际 ' + JSON.stringify(anim.transforms));
  ok(anim.drift < 1,
    '圆钮在整个关闭动画期间一动不动（需求 3），实际最大偏移 ' + anim.drift
    + 'px / 采样 ' + anim.n + ' 帧 / 起始 ' + JSON.stringify(anim.before));
  // 需求 3：**只做横向收紧，竖向不缩放**。原先的 `scale(.96)` 把 a 和 d 一起缩，
  // 那正是「竖直方向压扁」的来源 —— 这条断言把 scaleY 钉死在 1。
  ok(anim.frames > 0 && anim.scaleY.every((v) => v === 1),
    '关闭动画只做横向收紧，竖向不缩放（需求 3），实际 scaleY 取值 ' + JSON.stringify(anim.scaleY)
    + ' / ' + anim.frames + ' 帧');

  // 重新展开，继续后面几节
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add textarea')`, '重新展开');

  await setField('.fast-add textarea', '写方案');
  await evalJs(page, `
    return (() => {
      const i = document.querySelector('.fast-add textarea');
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'ok';
    })();
  `);
  await waitFor(page, `[...document.querySelectorAll('.task-el')].some((x) => x.textContent.includes('写方案'))`, '任务出现');
  // 交完就收起（窄屏）：任务已经落盘，横条还开着只是占地方。
  // 宽屏不收 —— 那边没有圆钮，横条是常驻的，收起来就点不回来。
  await waitFor(page, `!document.querySelector('.fast-add.open')`, '回车交完之后横条自动收起', 8000);
  ok(await evalJs(page, `return !!document.querySelector('.fast-fab .lucide-plus');`),
    '收起之后圆钮变回 +');

  /* ---- 「保存」是个 ✓，和日期按钮上下叠放（需求 4） ---- */
  // 上一节交完把横条收掉了，重新展开再测保存键
  await clickEl(page, `document.querySelector('.fast-fab')`);
  await waitFor(page, `!!document.querySelector('.fast-add.open')`, '重新展开（测保存键）', 8000);
  // 时间在上，保存在下，固定位置。这一条证的是按钮在、位置对、高度和日期按钮齐平、
  // 点了真能交、空着的时候禁用。
  const saveBtn = await evalJs(page, `
    const b = document.querySelector('.fast-add .fast-save');
    if (!b) return null;
    const s = getComputedStyle(b);
    const c = document.querySelector('.fast-add .fast-clock').getBoundingClientRect();
    const r = b.getBoundingClientRect();
    return {
      disabled: b.disabled,
      text: b.textContent.trim(),
      hasCheck: !!b.querySelector('.lucide-check'),
      display: s.display,
      // 保存挨着日期按钮**右边**（2026-10-19 起横排）：单行小条参考打卡页，
      // 原来是上下叠放——那一版把整条撑成两行高，用户报「框太大」
      besideClock: r.left >= c.right - 0.5,
      // 日期按钮和 ✓ 一样高
      h: Math.round(r.height), clockH: Math.round(c.height),
    };
  `);
  ok(saveBtn && saveBtn.hasCheck, '横条上那个保存键是个 ✓ 图标，实际 ' + JSON.stringify(saveBtn));
  ok(saveBtn && saveBtn.text === '', '它只有图标，没有「保存」两个字（一行里三个文字按钮太吵）');
  ok(saveBtn && saveBtn.display !== 'none', '「保存」按钮看得见（不是 display:none）');
  ok(saveBtn && saveBtn.besideClock, '✓ 摆在日期按钮**右边**（单行小条，不再上下叠放）');
  ok(saveBtn && saveBtn.h === saveBtn.clockH,
    '✓ 和日期按钮一样高（需求 3：那个按钮要摆两行小字，高度不能变），实际 ' + JSON.stringify([saveBtn && saveBtn.h, saveBtn && saveBtn.clockH]));
  // 空着的时候禁用：一个点下去没反应的按钮，比没有按钮更让人犯嘀咕
  await setField('.fast-add textarea', '');
  ok(await evalJs(page, `return document.querySelector('.fast-add .fast-save').disabled;`),
    '没写字的时候「保存」是禁用的');
  await setField('.fast-add textarea', '点保存交的');
  ok(await evalJs(page, `return !document.querySelector('.fast-add .fast-save').disabled;`),
    '写了字之后「保存」就能点了');
  const nBefore = await evalJs(page, `return document.querySelectorAll('.task-el').length;`);
  await clickEl(page, `document.querySelector('.fast-add .fast-save')`);
  await waitFor(page, `document.querySelectorAll('.task-el').length > ${nBefore}`, '点「保存」任务出现', 8000);
  const savedByBtn = await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === '点保存交的');
      return t ? t.title : null;
    })()
  `, '点「保存」的任务落盘', 8000);
  ok(savedByBtn === '点保存交的', '「保存」真的把任务交出去了（不是只清输入框），实际 ' + JSON.stringify(savedByBtn));
  // 交完之后输入框清空、按钮回到禁用态
  ok(await evalJs(page, `return document.querySelector('.fast-add textarea').value === '';`),
    '交完之后输入框清空');
  ok(await evalJs(page, `return document.querySelector('.fast-add .fast-save').disabled;`),
    '交完之后「保存」又回到禁用态');

  await clickEl(page, `[...document.querySelectorAll('.task-el')].find((x) => x.textContent.includes('写方案'))`);
  await waitFor(page, `!!document.querySelector('button[aria-label="项目"]')`, '抽屉里的项目选择器');
  await clickEl(page, `document.querySelector('button[aria-label="项目"]')`);
  // 项目和日程集**用同一个下拉框**（2026-10-11）：选项是 role="option" 的
  // 按钮，就渲染在抽屉里，不再弹一张 portal 出去的 Sheet。
  await waitFor(page, `document.querySelector('.drawer.open [role="listbox"][aria-label="项目"]') ? 1 : null`, '项目下拉展开', 8000);
  const pickResult = await evalJs(page, `
    return (() => {
      const opts = [...document.querySelectorAll('.drawer.open [role="listbox"][aria-label="项目"] [role="option"]')];
      const o = opts.find((x) => x.textContent.trim().includes('星星包'));
      if (o) { o.click(); return 'ok'; }
      return 'missing:' + opts.length;
    })();
  `);
  ok(pickResult === 'ok', '项目选择器里选得到「星星包」，实际 ' + JSON.stringify(pickResult));
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === '写方案');
      return t && t.projectId ? t.projectId : null;
    })()
  `, '项目落库', 8000);
  await new Promise((r) => setTimeout(r, 250));
  await clickEl(page, `document.querySelector('.drawer.open [aria-label="完成"]')`);
  await new Promise((r) => setTimeout(r, 300));

  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'))`);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
  await clickEl(page, `document.querySelector('.more-sheet [data-nav="projects"]')`);
  await waitFor(page, `!!document.querySelector('.pj-card')`, '卡片出现在泳道里');
  ok((await evalJs(page, `return document.querySelectorAll('.pj-col[data-scope$=":todo"] .pj-card').length;`)) === 1,
    '任务落在「待办」列');

  // 拖卡片换列：和第九节同一套合成鼠标事件，**两次** move ——
  // 第一次只挪 12px 越过 MouseSensor 的 distance:8，第二次才去目标列。
  const pjCard = `document.querySelector('.pj-col[data-scope$=":todo"] .pj-card')`;
  const pjDst = `document.querySelector('.pj-col[data-scope$=":doing"] .pj-col-b')`;
  const pjSrc = await evalJs(page, `
    const r = ${pjCard}.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  await evalJs(page, `
    ${pjCard}.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, clientX: ${pjSrc.x}, clientY: ${pjSrc.y} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 70));
  await evalJs(page, `
    const el = document.elementFromPoint(${pjSrc.x}, ${pjSrc.y + 12});
    el.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, clientX: ${pjSrc.x}, clientY: ${pjSrc.y + 12} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 70));
  const pjDstXY = await evalJs(page, `
    const r = ${pjDst}.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  await evalJs(page, `
    const el = document.elementFromPoint(${pjDstXY.x}, ${pjDstXY.y});
    el.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, clientX: ${pjDstXY.x}, clientY: ${pjDstXY.y} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 70));
  await evalJs(page, `
    const el = document.elementFromPoint(${pjDstXY.x}, ${pjDstXY.y});
    el.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, clientX: ${pjDstXY.x}, clientY: ${pjDstXY.y} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 350));
  // 按标题找**这一条**，不能拿 `Object.values(tasks)[0]` —— 前面几节
  // （十～十三）也加了任务，[0] 是它们中的某一条，doing 当然是 undefined
  await waitForUi('doing 落库',
    `(() => { const s = JSON.parse(localStorage.getItem('schedule-app-v4'));
      const t = Object.values(s.tasks).find((x) => x.title === '写方案');
      return t && t.doing === true ? 1 : null; })()`);
  const projCols = await evalJs(page, `
    return [...document.querySelectorAll('[data-lane] .pj-col')].map((c) => c.querySelectorAll('.pj-card').length);
  `);
  ok(JSON.stringify(projCols) === JSON.stringify([0, 1, 0]),
    '卡片挪到了「进行中」列，实际 ' + JSON.stringify(projCols));
  ok(await evalJs(page, `return !document.querySelector('.pj-col[data-scope$=":doing"] .pj-card.done');`),
    'done 没被顺手改掉 —— 做/没做和做没做完是两回事');

  await page.send('Page.navigate', { url: `http://127.0.0.1:${webPort}/` });
  await waitFor(page, `!!document.querySelector('.tabbar')`, '刷新后底栏还在');
  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'))`);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
  await clickEl(page, `document.querySelector('.more-sheet [data-nav="projects"]')`);
  await waitFor(page, `!!document.querySelector('[data-lane]')`, '刷新后泳道还在');
  ok((await evalJs(page, `return document.querySelector('[data-lane] .pj-name').textContent.trim();`)) === '星星包',
    '刷新后项目还在');
  ok((await evalJs(page, `return document.querySelector('[data-lane] .pj-col[data-scope$=":doing"] .pj-card') ? 1 : null;`)) === 1,
    '刷新后卡片还在「进行中」列');

  /* ---------- 一个能写的集都没有时：那一句提示得真的出现 ----------
     勾选切到一个只读集之后，新建项目浮层里选择器是空的、创建按钮禁用 ——
     而**禁用的按钮本身不解释任何事**，用户只看到「点不动」。所以开浮层要弹
     一句 toast。锁三件事：真的弹了、说的是那一句、浮层开着时它盖得住
     （`ToastHost` 挂在 Shell 外面、z-90 > 浮层的 z-70）。

     放这一节**最后**是必须的：勾选决定项目可见性（`useScopedState` 按
     `p.calId` 过滤），中途切走会让泳道上的项目消失，后面拖拽与刷新的断言
     全断。做完再切回有写权限的集。 */

  const roCal = await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    const canWrite = (r) => r === 'owner' || r === 'editor';
    const ro = (st.cals || []).find((c) => !canWrite(c.role));
    return ro ? ro.id : '';`);
  ok(roCal !== '', '有一个只读日程集可用来制造「无处可建」');

  if (roCal !== '') {
    await evalJs(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多')).click(); return true;`);
    await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
    await evalJs(page, `document.querySelector('[data-cal-sheet-open]').click(); return true;`);
    await waitFor(page, `!!document.querySelector('[role="dialog"] [data-cal-row]')`, '日程集多选面板');
    /* 先勾上只读那个，再取消勾别的 —— 反过来的话「至少留一个」会把取消挡下 */
    await evalJs(page, `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const rows = () => [...document.querySelectorAll('[role="dialog"] [data-cal-row]')];
      const want = ${JSON.stringify(roCal)};
      const hit = rows().find((r) => r.dataset.calRow === want);
      if (hit && hit.getAttribute('aria-pressed') !== 'true') { hit.click(); await sleep(80); }
      for (const r of rows()) {
        if (r.dataset.calRow !== want && r.getAttribute('aria-pressed') === 'true') { r.click(); await sleep(80); }
      }
      return true;`);
    await evalJs(page, `
      const d = document.querySelector('[role="dialog"]');
      const btn = d && [...d.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '关闭');
      if (btn) btn.click();
      return true;`);
    await waitFor(page, `!document.querySelector('[role="dialog"]')`, '面板关掉了');
    await waitForUi('只读集成了唯一勾着的',
      `(() => {
        const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
        const ro = (st.cals || []).find((c) => c.id === ${JSON.stringify(roCal)});
        const writable = ro && (ro.role === 'owner' || ro.role === 'editor');
        return ro && !writable && st.ui.cals.length === 1 && st.ui.cals[0] === ${JSON.stringify(roCal)}
          ? 1 : null;
      })()`);

    await clickEl(page, `document.querySelector('.pj-top .btn')`);
    await waitFor(page, `!!document.querySelector('.field input')`, '项目浮层又打开了');
    /* 那句话是**逐字**的：用户照着这句去排查，差一个字就指错方向。
       纯通知的 toast 只活 2.6 秒，waitFor 每 100ms 轮询一次，抓得到。 */
    const toastText = await waitFor(page, `
      [...document.querySelectorAll('[role="status"]')].map((t) => t.textContent)
        .find((t) => t.includes('写入权限')) || null`,
      '弹出「无写入权限」那一句 toast');
    ok(toastText.includes('所选日程集均无写入权限，无法新建项目'),
      '弹的是那一句，逐字：' + JSON.stringify(toastText));
    ok(await evalJs(page, `
      const t = [...document.querySelectorAll('[role="status"]')].find((x) => x.textContent.includes('写入权限'));
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? 1 : null;`),
    'toast 浮层开着时也看得见（盖在浮层之上，不是被遮住）');
    ok(await evalJs(page, `
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '创建');
      return b && b.disabled ? 1 : null;`),
    '一个能写的集都没有时，创建是禁用的');
    await evalJs(page, `
      const d = document.querySelector('[role="dialog"]');
      const btn = d && [...d.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '关闭');
      if (btn) btn.click();
      return true;`);
    await waitFor(page, `!document.querySelector('[role="dialog"]')`, '浮层关掉了');

    // 切回有写权限的集 —— 后面的节还要在上面改东西
    await evalJs(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多')).click(); return true;`);
    await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
    await evalJs(page, `document.querySelector('[data-cal-sheet-open]').click(); return true;`);
    await waitFor(page, `!!document.querySelector('[role="dialog"] [data-cal-row]')`, '日程集多选面板');
    await evalJs(page, `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const rows = () => [...document.querySelectorAll('[role="dialog"] [data-cal-row]')];
      const want = ${JSON.stringify(pjCal)};
      const hit = rows().find((r) => r.dataset.calRow === want);
      if (hit && hit.getAttribute('aria-pressed') !== 'true') { hit.click(); await sleep(80); }
      for (const r of rows()) {
        if (r.dataset.calRow !== want && r.getAttribute('aria-pressed') === 'true') { r.click(); await sleep(80); }
      }
      return true;`);
    await evalJs(page, `
      const d = document.querySelector('[role="dialog"]');
      const btn = d && [...d.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '关闭');
      if (btn) btn.click();
      return true;`);
    await waitFor(page, `!document.querySelector('[role="dialog"]')`, '面板关掉了');
    await waitForUi('切回有写权限的集',
      `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.cal === ${JSON.stringify(pjCal)} ? 1 : null`);

    /* ---- 「下一步」走 data-act 委托（不是 onBlur 回调）----
       这条路径原先是 views/ 里的 onBlur prop，行被换掉就丢。现在输入框只带
       data-act，落库在 clickDispatch 里。**必须实测**：委托与 React 的
       onChange 谁先跑、受控 input 的 DOM value 读不读得到，都是猜不出来的。 */
    const nextBox = `document.querySelector('.pj-next-i')`;
    ok(await evalJs(page, `return !!${nextBox};`), '泳道上有「下一步」输入框');
    ok(await evalJs(page, `return ${nextBox}.getAttribute('data-act') === 'next-project';`),
      '「下一步」带 data-act，不是 onBlur 回调');
    await setField('.pj-next-i', '周五前出第一版');
    await evalJs(page, `${nextBox}.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    /* 查询**按内容**而不是按 id：探针不该假设「刚建的那个项目就在这」，
       上游任何一步漏了这条断言就该红，而不是因为 id 找不着而崩。
       判据是「有一条项目的 next = 我刚填的那句」。 */
    await waitForUi('「下一步」落库',
      `(() => {
         const s = JSON.parse(localStorage.getItem('schedule-app-v4'));
         if (!s || !s.projects) return null;
         return Object.values(s.projects).some((p) => p && p.next === '周五前出第一版') ? 1 : null; })()`);
    ok(await evalJs(page, `return document.querySelector('.pj-next-i').value === '周五前出第一版';`),
      '输入框显示刚填的那句（受控值同步回来了）');

    /* ---- 「编辑」按钮走 data-act，打开的是那个浮层 ---- */
    await evalJs(page, `document.querySelector('.pj-more').click(); return true;`);
    await waitFor(page, `!!document.querySelector('.field input')`, '点「编辑」打开了项目浮层');
    ok(await evalJs(page, `return document.querySelector('.sheet-title, [role="dialog"] h2, [role="dialog"] .field') !== null;`),
      '浮层里是编辑表单');
    await evalJs(page, `
      const d = document.querySelector('[role="dialog"]');
      const btn = d && [...d.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '关闭');
      if (btn) btn.click();
      return true;`);
    await waitFor(page, `!document.querySelector('[role="dialog"]')`, '编辑浮层关掉了');
  }


}

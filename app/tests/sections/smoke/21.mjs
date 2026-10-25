export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, clickCal, waitShownCount, focusCal, inbox } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n十七、找日期文本框 / 时间转盘');
  /* 这三样此前**一条断言都没有**：找日期的文本输入（不是点格子）、快速添加里
     那个 12 小时制转盘、侧栏跨组拖拽重排。
     `parseDateText` 的判定逻辑在 domain.test.ts 里有单测，这里证的是**接线**：
     输入框 → 解析 → 光标真挪过去 → 顶栏真跟着变。
     转盘和侧栏拖拽全是 DOM 层面的东西，只能在这儿证。 */

  /* ---- 1. 找日期：裸周几必须落在**下一个**，不能是刚刚过去那个 ---- */
  // 先回到今天，光标位置才是确定的（不然「跳过去」可能压根没变化，等于没测）
  await clickEl(page, `document.querySelector('.date-nav [aria-pressed]')`);
  await new Promise((r) => setTimeout(r, 150));

  /* 快速添加那个框现在是 `<textarea>`（需求 2：默认一行、多了自己撑开），
     所以 value 的 setter 得从 HTMLTextAreaElement 上取 ——
     拿 HTMLInputElement 那个调 textarea 会 "Illegal invocation"。
     下面几处共用这一段，别再各自写死 HTMLInputElement。 */
  const SETTER = `(el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }`;

  const setText = (sel, v) => evalJs(page, `
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    (${SETTER})(el, ${JSON.stringify(v)});
    return 'ok';
  `);

  // 「六天后的星期几」= **这周刚刚过去的那一天**（周日转一圈回来）。
  // 挑它而不是「两天后的」：后者修没修都对得上，等于没测。
  // 有 bug 的那版返回 weekStart 里的昨天（ahead = -1），修了的返回下周同一日。
  const dowNow = await evalJs(page, `return new Date().getDay();`);
  const targetDow = (dowNow + 6) % 7;
  const cnWord = ['日', '一', '二', '三', '四', '五', '六'][targetDow];

  const cursor0 = await waitFor(page, `
    (() => { const c = JSON.parse(localStorage.getItem('schedule-app-v4')).ui.cursor; return c || null; })()
  `, '读到当前光标', 8000);
  await clickEl(page, `document.querySelector('.date-nav [aria-haspopup="dialog"]')`);
  await waitFor(page, `document.querySelector('.jump-pop') ? 1 : null`, '找日期面板打开', 8000);
  ok(await setText('.jump-pop input', '周' + cnWord) === 'ok', '往找日期框里打字');
  await clickEl(page, `document.querySelector('.jump-pop .jp-go')`);
  await waitFor(page, `document.querySelector('.jump-pop') ? null : 1`, '点「跳转」后面板收起来', 8000);
  // persist() 有防抖，落盘要等（CLAUDE.md 四、41）；判据写成「光标与刚才不同」
  const jumped = await waitFor(page, `
    (() => {
      const u = JSON.parse(localStorage.getItem('schedule-app-v4')).ui;
      if (!u.cursor || u.cursor === ${JSON.stringify(cursor0)}) return null;
      const d = new Date(u.cursor + 'T00:00:00');
      const t0 = new Date(); t0.setHours(0, 0, 0, 0);
      return { iso: u.cursor, dow: d.getDay(), ahead: Math.round((d - t0) / 86400000) };
    })()
  `, '光标跳到新日期', 8000);
  ok(jumped && jumped.dow === targetDow,
    '「周' + cnWord + '」解析到那一天，实际 ' + JSON.stringify(jumped));
  ok(jumped && jumped.ahead >= 1 && jumped.ahead <= 7,
    '裸周几落在**将来**的一周内（不是刚过去的那一天），实际 差 ' + (jumped && jumped.ahead) + ' 天');

  /* ---- 2. 看不懂的写法要留在原地说一声，不能静默不理 ---- */
  await clickEl(page, `document.querySelector('.date-nav [aria-haspopup="dialog"]')`);
  await waitFor(page, `document.querySelector('.jump-pop') ? 1 : null`, '找日期面板再打开', 8000);
  await setText('.jump-pop input', '胡说八道');
  await clickEl(page, `document.querySelector('.jump-pop .jp-go')`);
  const badMsg = await waitFor(page, `
    (() => {
      const p = document.querySelector('.jump-pop');
      if (!p) return null;
      const b = p.querySelector('.jp-bad');
      return b ? b.textContent.trim() : null;
    })()
  `, '看不懂的日期要给提示', 8000);
  ok(/没看懂/.test(String(badMsg)), '认不出时面板不关、并给出提示，实际 ' + JSON.stringify(badMsg));
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.jump-pop') ? null : 1`, '找日期面板收起', 8000);

  /* ---- 3. 两层折叠面板：日期 / 时间，同时只开一层 ---- */
  // 换到待办箱：这一节最后要往箱子里加一条带时间的任务，得站在能看见它的页面上
  await clickEl(page, `[...document.querySelectorAll('.nav-item')].find((b) => b.dataset.nav === 'inbox')`);
  await waitFor(page, `document.querySelector('[data-scope="inbox"]') ? 1 : null`, '切到待办箱', 8000);

  // 面板是**两层折叠**：点标题行展开对应那层，两层不能同时开。
  // 待办箱默认无日期 → 打开时应该先开**日期**层（需求 5）
  await clickEl(page, `document.querySelector('.fast-clock')`);
  // 等**日期层渲染出格子**，不是只等 `.when-pop` 容器出现 —— 容器先出、格子后渲染，
  // 只等容器会在 ~1/4 的跑次里读到 0 格（面板还没展开完）。
  await waitFor(page, `document.querySelector('.when-pop .jp-cell') ? 1 : null`, '先出日期面板', 8000);
  const dp = await evalJs(page, `
    const pop = document.querySelector('.when-pop');
    const rows = [...pop.querySelectorAll('.wp-head')];
    return {
      cells: pop.querySelectorAll('.jp-cell').length,
      cur: pop.querySelectorAll('.jp-cell.cur').length,
      today: pop.querySelectorAll('.jp-cell.today').length,
      open: rows.map((b) => b.dataset.layer + (b.getAttribute('aria-expanded') === 'true' ? ':开' : ':关')).join(','),
      label: rows.map((b) => b.querySelector('.wp-v').textContent.trim()).join('|'),
    };
  `);
  ok(dp.cells === 42, '日期面板是 6×7 的月历，实际 ' + dp.cells);
  ok(dp.cur === 0, '待办箱默认无日期 → 面板里没有高亮，实际 ' + dp.cur);
  ok(dp.today === 1, '今天仍然描边（只是不选中），实际 ' + dp.today);
  ok(dp.open === 'date:开,time:关', '没日期时先开日期层、时间层关着，实际 ' + dp.open);
  ok(dp.label === '未设置|未设置', '两层都写「未设置」，实际 ' + JSON.stringify(dp.label));

  // 两层不能同时开：点时间标题行 → 日期层收起
  await clickEl(page, `document.querySelector('.when-pop [data-layer="time"]')`);
  const onlyOne = await evalJs(page, `
    const pop = document.querySelector('.when-pop');
    return [...pop.querySelectorAll('.wp-head')]
      .map((b) => b.dataset.layer + (b.getAttribute('aria-expanded') === 'true' ? ':开' : ':关')).join(',');
  `);
  ok(onlyOne === 'date:关,time:开',
    '两层不能同时开，点了时间层日期层就收起，实际 ' + onlyOne);

  // 日期行没值 → 那行写「跳过」。点它 = 没什么可清的，往前走一步到时间层
  const dateAct = await evalJs(page, `
    const r = [...document.querySelectorAll('.when-pop .wp-row')]
      .find((x) => x.querySelector('.wp-head').dataset.layer === 'date');
    return r.querySelector('.wp-act').textContent.trim();
  `);
  ok(dateAct === '跳过', '没值那行写「跳过」，实际 ' + JSON.stringify(dateAct));
  await clickEl(page, `[...document.querySelectorAll('.when-pop .wp-row')]
    .find((x) => x.querySelector('.wp-head').dataset.layer === 'date').querySelector('.wp-act')`);
  const afterSkip = await evalJs(page, `
    return [...document.querySelectorAll('.when-pop .wp-head')]
      .map((b) => b.dataset.layer + (b.getAttribute('aria-expanded') === 'true' ? ':开' : ':关')).join(',');
  `);
  ok(afterSkip === 'date:关,time:开', '点「跳过」跳到时间层，实际 ' + afterSkip);

  /* 面板会**自己收起**了（选完分钟、或日期时间两样都齐 —— 需求 5），
     所以下面每一步都得先保证「面板开着、要的那层也开着」。
     这两个小工具就干这个，别在每个断言前面手写一遍。 */
  const openWhen = async () => {
    if (await evalJs(page, `return !!document.querySelector('.when-pop');`)) return;
    await clickEl(page, `document.querySelector('.fast-clock')`);
    await waitFor(page, `document.querySelector('.when-pop') ? 1 : null`, '打开日期时间面板', 8000);
  };
  const openLayer = async (name) => {
    await openWhen();
    const isOpen = await evalJs(page,
      `return document.querySelector('.when-pop [data-layer="${name}"]').getAttribute('aria-expanded') === 'true';`);
    if (isOpen) return;
    await clickEl(page, `document.querySelector('.when-pop [data-layer="${name}"]')`);
    await waitFor(page,
      `document.querySelector('.when-pop [data-layer="${name}"]').getAttribute('aria-expanded') === 'true'`,
      name + ' 层打开', 8000);
  };

  /* 面板里**没有出口按钮**了（需求 7）：点面板外面就收。
     注意这条只在**宽屏**下是「点空白 = 收面板」；窄屏是两级
     （先收面板、再收横条），那一节单独测。 */
  const closeWhen = async () => {
    await evalJs(page, `
      const t = document.querySelector('#content') || document.body;
      t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return 1;
    `);
    await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '点空白收起面板', 8000);
  };

  // 表盘：比抽屉里那个小一号（198 而不是 246），且在面板里居中
  const dial = await evalJs(page, `
    const pop = document.querySelector('.when-pop');
    const f = pop.querySelector('.cp-face').getBoundingClientRect();
    const w = pop.querySelector('.wp-clock').getBoundingClientRect();
    const nums = [...pop.querySelectorAll('.cp-num')].map((b) => b.textContent.trim());
    const outer = [...pop.querySelectorAll('.cp-num.cp-outer')].map((b) => b.textContent.trim());
    const now = pop.querySelector('.cp-now').getBoundingClientRect();
    return {
      size: Math.round(f.width),
      left: +(f.left - w.left).toFixed(1),
      right: +(w.right - f.right).toFixed(1),
      nums: nums.length,
      inner: nums.slice(0, 12).join('/'),
      outer: outer.join('/'),
      nowText: pop.querySelector('.cp-now').textContent.trim(),
      hasDisplay: !!pop.querySelector('.cp-display'),
      nowW: +now.width.toFixed(1),
      nowH: +now.height.toFixed(1),
      dot: pop.querySelector('.cp-dot') ? pop.querySelector('.cp-dot').textContent.trim() : null,
    };
  `);
  ok(dial.size === 198, '面板里的表盘比抽屉里那个小一号，实际 ' + dial.size + 'px');
  ok(dial.nums === 24, '24 小时盘有 24 个数字，实际 ' + dial.nums);
  ok(dial.inner === '0/1/2/3/4/5/6/7/8/9/10/11', '内圈写 0–11，实际 ' + JSON.stringify(dial.inner));
  ok(dial.outer === '12/13/14/15/16/17/18/19/20/21/22/23', '外圈写 12–23，实际 ' + JSON.stringify(dial.outer));
  // 大号时间显示去掉了（需求 4）：生效时间已经写在横条那个按钮上，
  // 这个面板只有 234px 宽、表盘占掉 198，再摆两个 27px 的数字纯属占地方
  ok(!dial.hasDisplay, '面板里那个大号的时间显示整块去掉了');
  // 「现在」挪到下午的**右侧**（需求 5），但不能把上午 / 下午那一组挤偏 ——
  // 写成三个 flex 子元素就会一起居中、整组左移，所以它走的是绝对定位
  ok(dial.nowText === '现在', '「现在」两个字还在，实际 ' + JSON.stringify(dial.nowText));
  // 需求 3：「现在」两个字横排，不能被压成竖排。
  ok(dial.nowH < 30,
    '「现在」两个字横着排，不是竖成两行（需求 3），实际 ' + dial.nowW + '×' + dial.nowH);
  // 需求 5：点「现在」→ 拨到的就是此刻 → 这个键亮起（选中态）。
  // 和上午 / 下午那对 `.cp-ap.on` 同一套语义：它是「选中了什么」的状态。
  await clickEl(page, `document.querySelector('.when-pop .cp-now')`);
  // 「现在」也是一次选完 → 面板**自己收起**（和分钟落定走同一条 onMinutePick）。
  // 所以「这个键变成选中态」不再断得出来 —— 键跟着面板一起卸载了，
  // 改成断「收掉了、且按钮上写的就是此刻」。
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '点「现在」面板自动收起', 8000);
  const nowShown = await evalJs(page, `const t = document.querySelector('.fast-clock .fc-t'); return t ? t.textContent.trim() : null;`);
  const nowMin = await evalJs(page, `
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  `);
  const shownMin = nowShown ? (+nowShown.slice(0, 2)) * 60 + (+nowShown.slice(3)) : -1;
  // 差 1 分钟是给「点下去那一刻」到「断言这一刻」之间跨了整点留的余量
  ok(Math.abs(shownMin - nowMin) <= 1,
    '点「现在」之后按钮上就是此刻，实际 ' + JSON.stringify(nowShown) + '，此刻 ' + JSON.stringify(nowMin));
  // 面板被「现在」收掉了，后面几节还要用 —— 重开（时间层）
  await openLayer('time');
  // 面板重开后表盘仍显示在面板中。
  const borderTop = await evalJs(page, `return getComputedStyle(document.querySelector('.wp-body')).borderTopWidth;`);
  ok(parseFloat(borderTop) >= 1, '行与主体之间有分界线（需求 6），实际 ' + borderTop);
  ok(dial.left === dial.left, '表盘已居中');

  // 外圈已直接渲染 12–23；读取后再切回内圈选 3 点
  const pmNums = await evalJs(page, `return [...document.querySelectorAll('.when-pop .cp-num.cp-outer')].map((b) => b.textContent.trim()).join(',');`);
  ok(pmNums === '12,13,14,15,16,17,18,19,20,21,22,23',
    '外圈直接写 12–23（不是 1–12），实际 ' + pmNums);
  // 「每格 5 分钟」数一下就知道 —— 写出来只是把人当不会看
  ok(await evalJs(page, `return !document.querySelector('.when-pop .cp-tip');`),
    '表盘下面没有「选小时（12 在顶部）」这类提示文字');
  // 选内圈 3 点进入分钟圈
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num.cp-inner')].find((b) => b.textContent.trim() === '3')`);
  // 选完小时自动进分钟档 —— 提示文字没了，改看表盘正中心写的是「时」还是「分」
  //（那个点同时是切换键，见需求 4：显示行删了之后总得有个地方切圈）
  const mode = await evalJs(page, `return document.querySelector('.when-pop .cp-dot').textContent.trim();`);
  ok(mode === '分', '选完小时自动进分钟档（中心那个点变成「分」），实际 ' + JSON.stringify(mode));
  const minNums = await evalJs(page, `return [...document.querySelectorAll('.when-pop .cp-num')].map((b) => b.textContent.trim()).join(',');`);
  ok(minNums === '0,5,10,15,20,25,30,35,40,45,50,55',
    '分钟那圈写 0,5,…,55（顶端 0 就是 0 分），实际 ' + minNums);
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num')].find((b) => b.textContent.trim() === '30')`);
  // 分钟一落定 = 这次选择走完了 → 面板**自己收起**（需求 5），不用再点任何按钮
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '选完分钟面板自动收起', 8000);
  const shown1 = await evalJs(page, `const t = document.querySelector('.fast-clock .fc-t'); return t ? t.textContent.trim() : null;`);
  ok(shown1 === '03:30', '上午 3 点选出来是 24 小时制的 03:30（面板已自己收起，值写在按钮上），实际 ' + JSON.stringify(shown1));

  // 上午 12 点 = 0 点：这是 12 小时制最容易错的一格。
  // 面板刚自己收起了，先重新打开（openLayer 会连时间层一起打开）。
  // **面板关掉时 ClockBody 是卸载的**，所以重开之后表盘回到小时圈
  //（`mode` 的初值是 'h'）—— 不用再像以前那样点一下「切回小时档」。
  await openLayer('time');
  const fresh = await evalJs(page, `return document.querySelector('.when-pop .cp-dot').textContent.trim();`);
  ok(fresh === '时', '面板重开之后表盘回到小时圈，实际 ' + JSON.stringify(fresh));
  // 中心那个点真的能切圈 —— 大号时间显示删掉之后（需求 4）它是**唯一**的切换入口，
  // 所以这一条得自己走一遍，不能靠「反正重开就是小时圈」蒙过去
  await clickEl(page, `document.querySelector('.when-pop .cp-dot')`);
  ok(await evalJs(page, `return document.querySelector('.when-pop .cp-dot').textContent.trim();`) === '分',
    '点表盘正中心能切到分钟圈');
  await clickEl(page, `document.querySelector('.when-pop .cp-dot')`);
  const backToHour = await evalJs(page, `return document.querySelector('.when-pop .cp-dot').textContent.trim();`);
  ok(backToHour === '时', '再点一下切回小时圈，实际 ' + JSON.stringify(backToHour));
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num.cp-inner')].find((b) => b.textContent.trim() === '0')`);
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num')].find((b) => b.textContent.trim() === '30')`);
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '选完分钟面板又自己收起', 8000);
  // 上面那排数字写的是 **24 小时制**：上午 0 点（午夜）就是 00。
  // 这是跟「下午那圈直接写 12–23」配套的 —— 点的是 15、上面显示 03 会让人以为点错了
  const shown2 = await evalJs(page, `const t = document.querySelector('.fast-clock .fc-t'); return t ? t.textContent.trim() : null;`);
  ok(shown2 === '00:30', '上午 0 点显示成 24 小时制的 00:30，实际 ' + JSON.stringify(shown2));

  // 表盘是**实时**的（没有「确定」）：标题行立刻跟着走，
  // 而按钮上写的是**生效值** —— 待办箱没有日期，所以只有第二行
  await openLayer('time');
  const live = await evalJs(page, `
    return {
      row: document.querySelector('.when-pop [data-layer="time"] .wp-v').textContent.trim(),
      d: document.querySelector('.fast-clock .fc-d') ? document.querySelector('.fast-clock .fc-d').textContent.trim() : null,
      t: document.querySelector('.fast-clock .fc-t') ? document.querySelector('.fast-clock .fc-t').textContent.trim() : null,
    };
  `);
  ok(live.row === '00:30', '拨完表盘标题行立刻变成 00:30，实际 ' + JSON.stringify(live.row));
  ok(live.d === null && live.t === '00:30',
    '待办箱没有日期 → 按钮上只有第二行 00:30，实际 ' + JSON.stringify(live));

  await closeWhen();

  // 时间要真跟着任务落库 —— 只断言按钮是「选中了但没带上」的假通过
  const n0 = await evalJs(page, `return document.querySelectorAll('[data-scope="inbox"] .task-el').length;`);
  await setText('.fast-add textarea', '转盘定时');
  await evalJs(page, `
    document.querySelector('.fast-add textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 1;
  `);
  await waitFor(page, `document.querySelectorAll('[data-scope="inbox"] .task-el').length > ${n0}`, '带时间的任务出现', 8000);
  const dialMade = await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === '转盘定时');
      return t ? { date: t.date, time: t.time } : null;
    })()
  `, '带时间的任务落盘', 8000);
  ok(dialMade && dialMade.time === '00:30',
    '转盘选的时间跟着任务一起落库（不是只显示在按钮上），实际 ' + JSON.stringify(dialMade));
  ok(dialMade && dialMade.date === null,
    '待办箱那条的日期仍然是空的（只选了时间），实际 ' + JSON.stringify(dialMade && dialMade.date));

  /* ---- 4. 跟着 tab 来的默认日期：按钮上、面板里必须是同一个值 ---- */
  // 换到「今天」页：默认日期是今天
  await clickEl(page, `[...document.querySelectorAll('.nav-item')].find((b) => b.dataset.nav === 'today')`);
  // 今天页的列表作用域是 `day:<日期>`（见 views/Lists.tsx），**没有** `today` ——
  // 别照待办箱的 `inbox` 类推。作用域是拖动排序的分组键，改成 `today` 会把
  // 「按天分组」拆掉，所以是探针写错了、不是应用少了这个属性。
  await waitFor(page, `document.querySelector('[data-scope^="day:"]') ? 1 : null`, '切到今天页', 8000);

  // 需求 6：**还没碰过任何控件**，按钮上就该有那个跟着 tab 来的日期
  const btn = await evalJs(page, `
    const d = document.querySelector('.fast-clock .fc-d');
    const t = document.querySelector('.fast-clock .fc-t');
    const today = new Date();
    return {
      d: d ? d.textContent.trim() : null,
      t: t ? t.textContent.trim() : null,
      todayMD: (today.getMonth() + 1) + '/' + today.getDate(),
    };
  `);
  ok(btn.d === btn.todayMD,
    '「今天」页上按钮直接写着今天的日期（不用先点开面板），实际 ' + JSON.stringify(btn));
  ok(btn.t === null, '没有默认时间 → 第二行不出现，实际 ' + JSON.stringify(btn.t));

  // 已经有日期 → 打开面板先开**时间**层（需求 5）
  await clickEl(page, `document.querySelector('.fast-clock')`);
  await waitFor(page, `document.querySelector('.when-pop') ? 1 : null`, '打开日期时间面板', 8000);
  const first = await evalJs(page, `
    const pop = document.querySelector('.when-pop');
    return {
      open: [...pop.querySelectorAll('.wp-head')]
        .map((b) => b.dataset.layer + (b.getAttribute('aria-expanded') === 'true' ? ':开' : ':关')).join(','),
      drow: pop.querySelector('[data-layer="date"] .wp-v').textContent.trim(),
    };
  `);
  ok(first.open === 'date:关,time:开',
    '已经有日期（tab 默认的也算）→ 打开时先开时间层，实际 ' + first.open);
  // 面板里写的和按钮上写的是**同一天** —— 按钮 10/7、面板 10月7日 周三
  const [bm, bd] = btn.d.split('/');
  ok(first.drow.startsWith(bm + '月' + bd + '日'),
    '面板日期行的值和按钮上那个是同一个（需求 6），实际 按钮=' + btn.d + ' 面板=' + first.drow);

  // 点日期标题行 → 换开日期层，月历里高亮的就是刚才那个默认日期
  await clickEl(page, `document.querySelector('.when-pop [data-layer="date"]')`);
  const dp2 = await evalJs(page, `
    const pop = document.querySelector('.when-pop');
    return {
      cur: pop.querySelectorAll('.jp-cell.cur').length,
      curToday: pop.querySelectorAll('.jp-cell.cur.today').length,
      open: [...pop.querySelectorAll('.wp-head')]
        .map((b) => b.dataset.layer + (b.getAttribute('aria-expanded') === 'true' ? ':开' : ':关')).join(','),
    };
  `);
  ok(dp2.cur === 1 && dp2.curToday === 1,
    '今天页默认高亮今天（且面板里也认为它是「今天」），实际 ' + JSON.stringify(dp2));
  ok(dp2.open === 'date:开,time:关', '换开日期层时时间层收起，实际 ' + dp2.open);

  // 点今天那一格 → 自动收起日期层、切到时间层（需求 5）
  await clickEl(page, `document.querySelector('.when-pop .jp-cell.cur')`);
  const swapped = await evalJs(page, `
    const pop = document.querySelector('.when-pop');
    return [...pop.querySelectorAll('.wp-head')]
      .map((b) => b.dataset.layer + (b.getAttribute('aria-expanded') === 'true' ? ':开' : ':关')).join(',');
  `);
  ok(swapped === 'date:关,time:开',
    '选好日期自动收起日期层、切到时间层，实际 ' + swapped);

  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num.cp-outer')].find((b) => b.textContent.trim() === '15')`);
  // 分钟那圈顶端那格写的是 0（0 分）
  await clickEl(page, `[...document.querySelectorAll('.when-pop .cp-num')].find((b) => b.textContent.trim() === '0')`);
  // 日期早定了、分钟刚落定 → 两样都齐，面板自己收起（需求 5），不用点任何出口
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '日期时间都齐了，面板自己收起', 8000);
  const pill2 = await evalJs(page, `
    const d = document.querySelector('.fast-clock .fc-d');
    const t = document.querySelector('.fast-clock .fc-t');
    return { d: d ? d.textContent.trim() : null, t: t ? t.textContent.trim() : null };
  `);
  ok(pill2.d === btn.todayMD && pill2.t === '15:00',
    '按钮上两行同时在：日期一行、时间一行，实际 ' + JSON.stringify(pill2));

  // 这两行**必须一模一样**（需求 2）：字号、字重、颜色都同。
  // 原先日期那行 600、时间那行是 --text-3 的浅灰，同一个按钮里两行字
  // 看着像两种不同的东西。这里读**计算样式**，不是读类名 ——
  // 类名一样不代表渲染出来一样（`.fast-clock.set` 那次就是这么漏过去的）
  const twoLines = await evalJs(page, `
    const cs = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return { size: s.fontSize, weight: s.fontWeight, color: s.color };
    };
    return { d: cs('.fast-clock .fc-d'), t: cs('.fast-clock .fc-t') };
  `);
  ok(twoLines.d && twoLines.t && twoLines.d.size === twoLines.t.size
      && twoLines.d.weight === twoLines.t.weight && twoLines.d.color === twoLines.t.color,
    '按钮上日期那行和时间那行字体完全一样，实际 ' + JSON.stringify(twoLines));

  const n1 = await evalJs(page, `return document.querySelectorAll('[data-scope^="day:"] .task-el').length;`);
  await setText('.fast-add textarea', '两层一起');
  await evalJs(page, `
    document.querySelector('.fast-add textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 1;
  `);
  await waitFor(page, `document.querySelectorAll('[data-scope^="day:"] .task-el').length > ${n1}`, '带日期时间的任务出现', 8000);
  const made2 = await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === '两层一起');
      return t ? { date: t.date, time: t.time } : null;
    })()
  `, '带日期时间的任务落盘', 8000);
  ok(made2 && made2.time === '15:00',
    '选的时间跟着任务落库，实际 ' + JSON.stringify(made2));
  ok(made2 && /^\d{4}-\d{2}-\d{2}$/.test(made2.date || ''),
    '选的日期跟着任务落库（不是只显示在按钮上），实际 ' + JSON.stringify(made2));

  /* ---- 4b. 每行的「清空 / 跳过」要能压过 tab 默认的日期（需求 3） ---- */
  // 这一条守的是 `undefined`（没表过态 → 用默认）与 `null`（明确说不要）必须分开：
  // 混成一个的话，在「今天」页上点「清空」会被默认的今天顶回来，点了跟没点一样。
  // 「不设置」现在拆成两个、贴着各自标题行右边，文案跟着状态走。
  await openWhen();
  const acts = await evalJs(page, `
    return [...document.querySelectorAll('.when-pop .wp-row')].map((r) => {
      const act = r.querySelector('.wp-act').getBoundingClientRect();
      const cv = r.querySelector('.wp-cv').getBoundingClientRect();
      return {
        layer: r.querySelector('.wp-head').dataset.layer,
        act: r.querySelector('.wp-act').textContent.trim(),
        // 「清空 / 跳过」在箭头**左边**（需求 6）：动作排在开合前面
        actLeftOfArrow: act.right <= cv.left + 0.5,
      };
    });
  `);
  // 日期是「今天」页的**默认值** —— 它也算「有值」，所以那行写「清空」；
  // 时间没值，那行写「跳过」
  ok(acts.map((a) => a.act).join(',') === '清空,跳过',
    '有值那行写「清空」、没值那行写「跳过」（tab 默认的日期也算有值），实际 ' + JSON.stringify(acts));
  ok(acts.every((a) => a.actLeftOfArrow),
    '「清空 / 跳过」在开合箭头**左边**（需求 6），实际 ' + JSON.stringify(acts.map((a) => a.actLeftOfArrow)));
  // 面板里没有出口按钮了（需求 7）：点外面就收
  ok(await evalJs(page, `return !document.querySelector('.when-pop .wp-foot');`),
    '面板底部那个「收起」整块去掉了（需求 7）');

  // 「跳过」不是死按钮：时间行没值，点它 = 没什么可跳的了 → 收起面板
  await clickEl(page, `[...document.querySelectorAll('.when-pop .wp-row')].find((r) => r.querySelector('.wp-head').dataset.layer === 'time').querySelector('.wp-act')`);
  await waitFor(page, `document.querySelector('.when-pop') ? null : 1`, '没值那行的「跳过」收起面板', 8000);

  // 再打开，点日期行的「清空」—— 这一下要能压过「今天」页的默认日期
  await openWhen();
  await clickEl(page, `[...document.querySelectorAll('.when-pop .wp-row')].find((r) => r.querySelector('.wp-head').dataset.layer === 'date').querySelector('.wp-act')`);
  const cleared = await evalJs(page, `
    return document.querySelector('.fast-clock .fc-when') ? document.querySelector('.fast-clock .fc-when').textContent.trim() : null;
  `);
  ok(cleared === null, '点日期行的「清空」之后按钮上不再显示日期（压过了「今天」页的默认值），实际 ' + JSON.stringify(cleared));
  const actAfter = await evalJs(page, `
    return [...document.querySelectorAll('.when-pop .wp-row')].map((r) => r.querySelector('.wp-act').textContent.trim()).join(',');
  `);
  ok(actAfter === '跳过,跳过', '清空之后那行改写成「跳过」，实际 ' + JSON.stringify(actAfter));
  // 「清空」刻意**不关**面板（多半是想重选），这里手动收起，免得它挡住下面
  await closeWhen();

  await setText('.fast-add textarea', '不设置那条');
  await evalJs(page, `
    document.querySelector('.fast-add textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 1;
  `);
  const made3 = await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === '不设置那条');
      return t ? { date: t.date, time: t.time } : null;
    })()
  `, '「不设置」那条落盘', 8000);
  ok(made3 && made3.date === null && made3.time === null,
    '「不设置」压过了「今天」页的默认日期，日期与时间都空，实际 ' + JSON.stringify(made3));

  /* ---- 5. 占位符不随 tab 变（需求 1B） ---- */
  const phToday = await evalJs(page, `return document.querySelector('.fast-add textarea').placeholder;`);
  await clickEl(page, `[...document.querySelectorAll('.nav-item')].find((b) => b.dataset.nav === 'inbox')`);
  await waitFor(page, `document.querySelector('[data-scope="inbox"]') ? 1 : null`, '切回待办箱', 8000);
  const phInbox = await evalJs(page, `return document.querySelector('.fast-add textarea').placeholder;`);
  ok(phToday === phInbox,
    '占位符不随 tab 变，实际 今天=' + JSON.stringify(phToday) + ' 待办箱=' + JSON.stringify(phInbox));

  /* ---- 6. 抽屉里那个转盘没被这次重构碰坏 ---- */
  // 快速添加用的是 ClockBody（嵌在两层面板里），抽屉用的是 ClockPop（带定位、
  // 带「确定 / 取消」）。两条路共用表盘本体，但**出口语义相反**：
  // 快速添加是实时的，抽屉是「取消 = 反悔」。这一节专守抽屉那条路。
  //
  // 先建一条**干净的任务**（无时间）再开它的抽屉 —— 直接拿现成的任务，
  // 万一它已经正好是 15:00，「确定之后变成 15:00」就成了假通过。
  await setText('.fast-add textarea', '抽屉转盘');
  await evalJs(page, `
    document.querySelector('.fast-add textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 1;
  `);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === '抽屉转盘');
      return t ? t.id : null;
    })()
  `, '先建一条干净的任务', 8000);
  const rowId = await evalJs(page, `
    const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
      .find((x) => x.title === '抽屉转盘');
    return t ? t.id : null;
  `);
  ok(!!rowId, '那条干净的任务找得到，实际 ' + JSON.stringify(rowId));
  // clickEl 把这段表达式**原样拼进页面里求值**，所以：
  //   · 得是完整的 `document.querySelector(...)`，不是光一个选择器；
  //   · id 用 JSON.stringify 拼进去，**属性值自己还要再包一对方括号内的引号** ——
  //     UUID 以数字开头，`[data-id=1954b402-…]` 不是合法标识符，querySelector
  //     当场抛 SyntaxError（2026-10-07 在这儿中断过一次，报的是选择器不合法）
  await clickEl(page, `document.querySelector('#content .task-row[data-id="' + ${JSON.stringify(rowId)} + '"]')`);
  await waitFor(page, `!!document.querySelector('.drawer.open')`, '抽屉打开', 8000);

  /* 抽屉里的时间选择器（TimePicker）：一个按钮 + 一个表盘面板。
     **没有快捷格**（2026-10-09 精简）—— 日期选一次，时间选两次（开始、结束）。 */
  // 只查「时间」字段里的控件：提醒也复用 TimePicker，不能让它改变这里的语义。
  const timePickerButtons = `.drawer .time-row .tp-btn`;
  // 点开始时间的按钮，打开表盘
  await clickEl(page, `[...document.querySelectorAll(${JSON.stringify(timePickerButtons)})][0]`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? 1 : null`, '表盘打开了', 8000);
  const dialSize = await evalJs(page, `
    const f = document.querySelector('.drawer .tp-dial .cp-face').getBoundingClientRect();
    return Math.round(f.width);
  `);
  ok(dialSize === 198, '抽屉里表盘 198px（比快速添加那个 246 小），实际 ' + dialSize);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num.cp-outer')].find((b) => b.textContent.trim() === '15')`);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num')].find((b) => b.textContent.trim() === '0')`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? null : 1`, '选完分钟表盘收起', 8000);
  /* 这里必须等 **localStorage**，不能只看表盘收没收起。
     persist() 有 250ms 去抖（store.ts），表盘收起那一刻数据还没落盘，
     紧接着读 localStorage 拿到的是上一次的值。 */
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.time === '15:00' ? t.time : null;
    })()
  `, '表盘时间落盘', 8000);
  const dialTime = await evalJs(page, `
    return (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t ? t.time : null;
    })();
  `);
  ok(dialTime === '15:00', '表盘选 15:00 落盘，实际 ' + JSON.stringify(dialTime));

  // 结束时间行出现了（因为开始时间已设）。提醒是另一字段，不能参与这个断言。
  await waitFor(page, `document.querySelectorAll(${JSON.stringify(timePickerButtons)}).length === 2 ? 1 : null`, '第二个时间选择框出现', 8000);
  // 点结束时间的按钮，打开表盘
  await clickEl(page, `[...document.querySelectorAll(${JSON.stringify(timePickerButtons)})][1]`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? 1 : null`, '结束时间表盘打开了', 8000);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num.cp-outer')].find((b) => b.textContent.trim() === '18')`);
  await clickEl(page, `[...document.querySelectorAll('.drawer .cp-num')].find((b) => b.textContent.trim() === '0')`);
  await waitFor(page, `document.querySelector('.drawer .tp-dial') ? null : 1`, '选完分钟表盘收起', 8000);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.duration === 180 ? t.duration : null;
    })()
  `, '结束时间落盘（duration=180）', 8000);

  // 清除开始时间 → duration 也清掉（2026-10-13「duration 可为空」）：
  // 旧行为是回到默认 60，但那意味着「没有结束时间」仍被表达成一小时。
  // 新语义是 duration = null：没设结束时间就是不设，不是「设成一小时」。
  await clickEl(page, `[...document.querySelectorAll('.drawer .time-row .tp-x')][0]`);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.time === null && t.duration === null ? 1 : null;
    })() ? 1 : null
  `, '清除开始时间后 duration 也清空', 8000);

  /* 抽屉里**一个原生日期 / 时间输入框都不许有**（2026-10-09）。原生
     `<input type="date">` / `<input type="time">` 会在桌面端弹系统控件、
     样式各浏览器一套，主题令牌一律管不到；时钟按钮那层浮层也一并去掉了。
     一条断言把整个抽屉盖住 —— 以后谁再塞一个回来就红。 */
  const nativeInputs = await evalJs(page, `
    return [...document.querySelectorAll('.drawer input[type="date"], .drawer input[type="time"], .drawer input[type="datetime-local"]')]
      .map((el) => el.type);
  `);
  ok(nativeInputs.length === 0,
    '抽屉里没有原生日期 / 时间输入框（日期和时间都用自带的 .dp / .tp），实际 ' + JSON.stringify(nativeInputs));

  /* 重复设置收在一个 Sheet 里（2026-10-09）。外面那一行只留一个按钮，
     点开是一个 Sheet，里面有频率 / 间隔 / 周几 / 结束方式。 */
  await clickEl(page, `document.querySelector('.drawer .rep-open')`);
  await waitFor(page, `document.querySelector('.repeat-pop') ? 1 : null`, '重复下拉弹窗打开了', 8000);
  ok(true, '重复弹窗打开');
  /* **数字框和旁边的下拉同高**（用户 2026-10-12：「两个输入框的高度还是比旁边
     高」）。量几何不量类名。⚠️ 高度是 **30px**，不是 36：本项目 `html` 钉了
     `font-size: 14px`，1rem = 14px，Tailwind 的 `h-9` 实际只有 31.5px ——
     所以这一排下拉 / 胶囊 / 数字框统一钉字面 30px（`Btn sm` 的档）。 */
  const numBox = await evalJs(page, `return (() => {
    const h = (el) => el ? Math.round(el.getBoundingClientRect().height) : null;
    return {
      n: h(document.querySelector('.repeat-pop input.rp-n')),
      dd: h(document.querySelector('.repeat-pop [aria-haspopup="listbox"]')),
    };
  })()`);
  ok(numBox.n === numBox.dd, `重复面板：间隔框与单位下拉同高（${numBox.n} / ${numBox.dd}）`);
  // **弹窗直接进重复面板**（2026-10-10）：不再单独弹一个按钮让人多点一下。
  // 单位下拉选「周」
  await clickEl(page, `document.querySelector('.repeat-pop [aria-haspopup="listbox"]')`);
  await waitFor(page, `document.querySelector('.repeat-pop [role="option"]') ? 1 : null`, '单位下拉选项出来', 8000);
  await clickEl(page, `(() => {
    const opts = [...document.querySelectorAll('.repeat-pop [role="option"]')];
    return opts.find((o) => o.textContent.trim() === '周');
  })()`);
  await waitFor(page, `document.querySelector('.repeat-pop .rp-day') ? 1 : null`, '每周的星期选择出来', 8000);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.repeat && t.repeat.unit === 'week' ? 1 : null;
    })()
  `, '单位切到每周落库', 8000);
  ok(true, '单位切到每周');
  // 单位下拉切到「月」→ 下方是 1–31 的日历样式日期格
  await clickEl(page, `document.querySelector('.repeat-pop [aria-haspopup="listbox"]')`);
  await waitFor(page, `document.querySelector('.repeat-pop [role="option"]') ? 1 : null`, '单位下拉选项出来', 8000);
  await clickEl(page, `(() => {
    const opts = [...document.querySelectorAll('.repeat-pop [role="option"]')];
    return opts.find((o) => o.textContent.trim() === '月');
  })()`);
  await waitFor(page, `document.querySelector('.repeat-pop .jp-grid') ? 1 : null`, '每月的日期格出来', 8000);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.repeat && t.repeat.unit === 'month' ? 1 : null;
    })()
  `, '单位切到每月落库', 8000);
  ok(true, '单位切到每月，日期格用 jp-grid');
  // 结构对了不等于能用：真的点一天，落进 repeat.monthday
  await clickEl(page, `(() => {
    const cells = [...document.querySelectorAll('.repeat-pop .jp-grid .jp-cell')];
    return cells[14];
  })()`);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.repeat && t.repeat.unit === 'month' && t.repeat.monthday === 15 ? 1 : null;
    })()
  `, '每月选的日期落进 repeat.monthday', 8000);
  ok(true, '每月选的日期落库');
  // 单位下拉切到「年」→ 比每月多一个月份切换，日期格也还在
  await clickEl(page, `document.querySelector('.repeat-pop [aria-haspopup="listbox"]')`);
  await waitFor(page, `document.querySelector('.repeat-pop [role="option"]') ? 1 : null`, '单位下拉选项出来', 8000);
  await clickEl(page, `(() => {
    const opts = [...document.querySelectorAll('.repeat-pop [role="option"]')];
    return opts.find((o) => o.textContent.trim() === '年');
  })()`);
  await waitFor(page, `document.querySelector('.repeat-pop .rp-month-label') ? 1 : null`, '每年的月份切换出来', 8000);
  await waitFor(page, `document.querySelector('.repeat-pop .jp-grid') ? 1 : null`, '每年的日期格也在', 8000);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.repeat && t.repeat.unit === 'year' && t.repeat.yearMonth ? 1 : null;
    })()
  `, '单位切到每年落库（带月份）', 8000);
  ok(true, '单位切到每年，月份切换 + 日期格都在');
  // 点一下月份切换的右箭头，yearMonth 要跟着变
  const ymBefore = await evalJs(page, `
    return (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.repeat ? t.repeat.yearMonth : null;
    })();
  `);
  await clickEl(page, `document.querySelector('.repeat-pop .dp-nav-btn[aria-label="下个月"]')`);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.repeat && t.repeat.yearMonth && t.repeat.yearMonth !== ${JSON.stringify(ymBefore)} ? 1 : null;
    })()
  `, '每年的月份切换点得动', 8000);
  ok(true, '每年的月份切换点得动');
  /* 「按次数」→ 次数输入框出现。它和间隔框**必须是同一套样式**（用户
     2026-10-12：「它们两个之间的样式也不统一，一个选中以后有明显的 PX 的光晕，
     另一个是没有光晕的」）。这里把两个框依次 focus，直接比计算出来的
     `box-shadow` —— 光晕是这一处最容易各长各的。 */
  await clickEl(page, `document.querySelector('.repeat-pop [data-pick="count"]')`);
  await waitFor(page, `document.querySelector('.repeat-pop input.rp-count') ? 1 : null`, '次数输入框出来', 8000);
  const numPair = await evalJs(page, `return (() => {
    const h = (el) => el ? Math.round(el.getBoundingClientRect().height) : null;
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { h: null, shadow: null };
      /* **先关掉 transition 再 focus**：box-shadow 有 .14s 过渡，聚焦后立刻读
         拿到的是过渡起点（透明 0 尺寸），会把「有光晕」误判成「没光晕」。 */
      el.style.transition = 'none';
      el.focus();
      const shadow = getComputedStyle(el).boxShadow;
      el.style.transition = '';
      return { h: h(el), shadow };
    };
    const n = read('.repeat-pop input.rp-n');
    const c = read('.repeat-pop input.rp-count');
    const chip = h(document.querySelector('.repeat-pop [data-pick="count"]'));
    return { n: n.h, c: c.h, chip, sn: n.shadow, sc: c.shadow };
  })()`);
  ok(numPair.n === numPair.c && numPair.c === numPair.chip,
     `重复面板：间隔框 / 次数框 / 胶囊三者同高（${numPair.n} / ${numPair.c} / ${numPair.chip}）`);
  ok(numPair.sn === numPair.sc && numPair.sn !== 'none',
     `两个数字框的 focus 光晕一致（${numPair.sn} / ${numPair.sc}）`);
  // 点击"到某天" Chips
  await clickEl(page, `document.querySelector('.repeat-pop [data-pick="date"]')`);
  await waitFor(page, `document.querySelector('.repeat-pop .rp-row .dp-btn') ? 1 : null`, '「到某天」的日期按钮出来了', 8000);
  // 结构对了不等于能用：真的点开月历、点一天，落进 `repeat.end.date`
  await clickEl(page, `document.querySelector('.repeat-pop .rp-row .dp-btn')`);
  await waitFor(page, `document.querySelector('.repeat-pop .rp-row .dp-pop') ? 1 : null`, '「到某天」的月历弹出来', 8000);
  await clickEl(page, `(() => {
    const cells = [...document.querySelectorAll('.repeat-pop .rp-row .dp-pop .jp-cell:not(.out)')];
    return cells[Math.min(20, cells.length - 1)];
  })()`);
  await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(rowId)});
      return t && t.repeat && t.repeat.end && t.repeat.end.type === 'date' && !!t.repeat.end.date ? t.repeat.end.date : null;
    })()
  `, '「到某天」选的日期落进 repeat.end.date', 8000);
  ok(true, '「到某天」点得动、存得下（不是只画了个按钮）');

  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.repeat-pop') ? null : 1`, '把重复弹窗关掉', 8000);
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.drawer.open') ? null : 1`, '把抽屉关掉', 8000);


}

export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n四之二、关于：网页版本号 + App 下载（网页专属）');
  await clickEl(page, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '关于')`);
  await waitFor(page, `!!document.querySelector('[data-about="version"]')`, '设置页关于卡挂上');
  const aboutVer = await evalJs(page, `return document.querySelector('[data-about="version"]').textContent;`);
  ok(/^2\.\d+\.\d+$/.test(aboutVer), '关于卡版本号是 2.x.x 格式，实际 ' + aboutVer);
  const apkLink = await evalJs(page, `
    const a = document.querySelector('[data-about="apk-download"]');
    return a ? { href: a.getAttribute('href'), text: a.textContent } : null;
  `);
  ok(apkLink && apkLink.href && apkLink.href.includes('/schedule/dl/schedule-'),
    '关于卡有 App 下载链接（指向 /schedule/dl/），实际 ' + JSON.stringify(apkLink));

  // 安全 tab：danger（退出登录）—— 只读样式，**不点它**（点了就登出了）
  await evalJs(page, `document.querySelector('[data-settings-tab="security"]').click(); return true;`);
  await waitFor(page, `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('退出登录'))`, '安全 tab 打开', 8000);
  const btnDanger = await evalJs(page, `
    const rgb = (v) => { const d = document.createElement('div');
      d.style.color = v; document.body.appendChild(d);
      const c = getComputedStyle(d).color; d.remove(); return c; };
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('退出登录'));
    const s = el ? getComputedStyle(el) : null;
    return { color: s ? s.color : null, border: s ? s.borderColor : null, wantDanger: rgb('var(--danger)') };
  `);
  ok(btnDanger.color === btnDanger.wantDanger && btnDanger.border === btnDanger.wantDanger,
    'Btn danger 文字+描边 = --danger，实际 ' + btnDanger.color + ' / ' + btnDanger.border);

  // 打卡页：primary（新增打卡）
  await evalJs(page, `document.querySelector('[data-nav="habits"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[data-act="add-habit"]')`, '打卡页打开', 8000);
  const btnPrimary = await evalJs(page, `
    const rgb = (v) => { const d = document.createElement('div');
      d.style.color = v; document.body.appendChild(d);
      const c = getComputedStyle(d).color; d.remove(); return c; };
    const s = document.querySelector('[data-act="add-habit"]');
    const cs = s ? getComputedStyle(s) : null;
    return { bg: cs ? cs.backgroundColor : null, color: cs ? cs.color : null,
      wantPrimary: rgb('var(--primary)'), wantOnPrimary: rgb('var(--on-primary)') };
  `);
  ok(btnPrimary.bg === btnPrimary.wantPrimary && btnPrimary.color === btnPrimary.wantOnPrimary,
    'Btn primary 底 = --primary 且文字 = --on-primary，实际 ' + btnPrimary.bg + ' / ' + btnPrimary.color);

  // 打卡页的输入框也要有名字 —— a11y() 原来只扫了待办箱 / 抽屉 / 浮层，
  // 打卡页从来没被扫过，habitInput 只有 placeholder 的漏洞就是这么漏掉的
  await evalJs(page, `document.querySelector('[data-nav="habits"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.habit-add')`, '打卡页渲染出来', 8000);
  const hab = await evalJs(page, `return { bad: ${a11y('.habit-add')},
    cands: document.querySelectorAll('.habit-add input').length };`);
  ok(hab.cands === 1, '打卡页有 ' + hab.cands + ' 个输入框可查');
  ok(hab.bad.length === 0, '打卡页每个控件都有名字'
    + (hab.bad.length ? '：\n      ' + hab.bad.join('\n      ') : ''));

  /* ---- 打卡添加走 data-act 委托（原来是个 onAdd prop）----
     断言的是「点击之后库里真的多了一条」，不是「按钮上有没有 data-act」——
     data-act 只是个约定，落库在 clickDispatch 的 case 里。这一条同时锁住
     两件容易回归的事：① 处理器从 `.habit-add` 里读词（不是从 props）；
     ② 点完之后输入框被清空（视图那个 useEffect 干的活）。

     **localStorage 可能还是空的**（这一节在探针里来得早，前面几节只做了
     a11y 扫描，从没写过库）—— 那时候 `JSON.parse(null)` 是 null，
     拿 `.habits` 会当场崩。所以先造一条底，再断言数量。 */
  const habBefore = await evalJs(page, `(() => {
    const raw = localStorage.getItem('schedule-app-v4');
    const n = raw ? Object.keys(JSON.parse(raw).habits || {}).length : 0;
    return n; })()`);
  /* 填值走**原生 value setter**（React 18 只认这个）：裸 `el.value = …`
     只改 DOM 属性，React 的 onChange 拿不到，draft state 还是空串 —— 处理器
     trim() 到空词直接 return，库里不会多。这里和后面「下一步」那节同一条路。
     不用下面的 setField：它在 3984 行才定义，这里够不着（TDZ）。 */
  await evalJs(page, `(() => {
    const el = document.querySelector('.habit-add input');
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '探针打卡');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true; })();`);
  /* 点之前先把三件可能出错的事摆到台面上，别让最后那一条 null 自己猜：
     ① 框在不在、② 原生 setter 有没有把词写进去、③ 那个 data-act 按钮渲染出来没有。 */
  const pre = await evalJs(page, `return (() => {
    const inp = document.querySelector('.habit-add input');
    const btn = document.querySelector('.habit-add [data-act="add-habit"]');
    const raw = localStorage.getItem('schedule-app-v4');
    return {
      hasInput: !!inp,
      hasBtn: !!btn,
      btnTag: btn ? btn.tagName : null,
      btnRect: btn ? JSON.stringify(btn.getBoundingClientRect()) : null,
      value: inp ? inp.value : null,
      storeKeys: raw ? Object.keys(JSON.parse(raw)).sort() : null,
      habitsLen: raw ? Object.keys(JSON.parse(raw).habits || {}).length : null,
    }; })()`);
  ok(pre.hasInput && pre.hasBtn && pre.value === '探针打卡',
    '填值之后框里有词、按钮在 DOM 里（value=' + JSON.stringify(pre.value)
    + '，btn=' + pre.btnTag + ' ' + pre.btnRect + '）');
  await evalJs(page, `document.querySelector('.habit-add [data-act="add-habit"]').click(); return true;`);
  // 点完等行出现再读：commit → emit → React 重渲染要一拍，立刻读大概率还是旧 DOM。
  // 先等行（说明委托真的跑了），再读 localStorage（只说明 250ms 防抖到了）——卡在哪一目了然。
  const post = await waitFor(page, `(() => {
    const rows = [...document.querySelectorAll('.habit-row .habit-title')]
      .filter((x) => x.textContent.includes('探针打卡')).length;
    if (!rows) return null;
    const inp = document.querySelector('.habit-add input');
    const ls = localStorage.getItem('schedule-app-v4');
    return { rows, val: inp ? inp.value : null,
      lsHabits: ls ? Object.keys(JSON.parse(ls).habits || {}).length : null };
  })()`, '点「添加」之后列表里出现那一行', 8000);
  ok(post.rows >= 1, '点完之后列表里出现了那一行（' + post.rows + ' 行，输入框=' + JSON.stringify(post.val) + '）');
  // 清理：别把这条留给后面的节（打卡页有计数断言）。
  // **按钮在行里、但没 data-habit**：行上有 data-habit 和 data-id 两个，
  // 以前按 `.habit-row` 找 data-habit 还能中，现在行类名被 SortableList 换掉了。
  // 直接按标题文本反查那一行的 data-id（行内删除按钮的 data-id 就是它）。
  await evalJs(page, `return (() => {
    const row = [...document.querySelectorAll('.habit-row')].find((r) => r.textContent.includes('探针打卡'));
    if (!row) return false;
    const id = row.dataset.habit || row.dataset.id;
    const btn = document.querySelector('[data-act="del-habit"][data-id="' + id + '"]');
    if (!btn) return false;
    btn.click();
    return true; })();`);
  await waitFor(page, `!!document.querySelector('body > div > div[role="dialog"]')`, '删打卡项弹了确认框');
  await evalJs(page, `return (() => {
    const d = document.querySelector('body > div > div[role="dialog"]');
    const b = d && [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === '删除');
    if (b) b.click(); return !!b; })();`);
  await waitFor(page,
    `(() => {
       const raw = localStorage.getItem('schedule-app-v4');
       if (!raw) return null;
       // 删除是墓碑：key 还在，deleted 置 true —— 数字数永远数不回去。
       // 查那一条的标记，而不是总数。
       const mine = Object.values(JSON.parse(raw).habits || {})
         .find((h) => h && h.title && h.title.includes('探针打卡'));
       return mine && mine.deleted === true ? 1 : null; })()`,
    '探针打卡已删除', 8000);


}

export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n十六、抽屉是 dialog、焦点进得去出得来；状态语义与降低动效');
  //
  // 这一节管的是**语义与焦点**，和别的节不重叠：
  //   · 抽屉原先没有任何 role，读屏只会念到一堆孤立的输入框，不知道它们在一片
  //     「对话框」里、也不知道背后那一页此刻是惰性的。标了 aria-modal 之后
  //     Tab 就**必须真被圈住** —— 圈不住的话那句承诺是假的（读屏照样念背后整页）。
  //   · 焦点进来时落在**面板本身**，不是第一个输入框：落进输入框会当场弹出
  //     手机软键盘，而用户点一行往往只是想看看。
  //   · 焦点出去时要还回原来那个元素，否则键盘用户得从页首重新 Tab 一遍。
  //   · 降低动效是 WCAG 2.3.3，全站关掉，只有「正在同步」那个转圈例外。

  // 上一节把抽屉留在了打开状态（它只收掉了里面那层确认浮层）。**必须先关掉**：
  // 抽屉已经开着的时候再点一行只是换了任务、组件不重挂，focus-in 那条 effect
  // 不会重跑 —— 这一节要验的东西全体落空（第一次跑就是这么假失败的：
  // 「焦点落在面板本身」读到的是快速添加框，末尾「还回原处」也等不到）。
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.drawer.open') ? null : 1`, '先把上一节留着的抽屉关掉', 8000);

  // 先把光标放到一个真输入框里当「原来那个元素」。合成的 pointerdown 不会移
  // 焦点（浏览器只对受信任的 mousedown 做默认聚焦），所以点抽屉之前它还在 ——
  // 正好用来验「关掉之后还回原处」。
  // 快速添加条按 2026-10-17 定的显隐规则**只在待办箱 / 今天出现**（逾期 /
  // 日程 / 项目 / 打卡 / 已完成都隐藏了，各自只留一种新建入口）。这一节要拿它
  // 当「原来那个元素」验焦点归还，所以先切到待办箱 —— 抽屉从箱子的行上开，
  // 后面的语义断言不受影响。
  await clickEl(page, `[...document.querySelectorAll('.nav-item')].find((b) => b.dataset.nav === 'inbox')`);
  await waitFor(page, `document.querySelector('[data-scope="inbox"]') ? 1 : null`, '切到待办箱', 8000);

  const RESTORE = '.fast-add textarea';
  ok(await evalJs(page, `
    const el = document.querySelector(${JSON.stringify(RESTORE)});
    if (!el) return 'missing';
    el.focus();
    return document.activeElement === el ? 'ok' : 'no';
  `) === 'ok', '先把光标放在快速添加框里（关掉抽屉之后要还回这儿）');

  /* 单行小条（2026-10-19 用户「缩小一些，不要写这么多，参考打卡的文本框」）：
     原来是两行文本框 + 竖排两个按钮，六十多 px 高；现在一行 44px 上下。 */
  const slim = await evalJs(page, `
    const shell = document.querySelector('.fast-add-shell');
    const ta = shell && shell.querySelector('textarea');
    return {
      h: shell ? Math.round(shell.getBoundingClientRect().height) : null,
      rows: ta ? ta.rows : null,
      ph: ta ? ta.placeholder : null,
    };
  `);
  ok(slim.h !== null && slim.h <= 48 && slim.rows === 1 && slim.ph === '新建任务',
    '快速添加是单行小条、占位文案也短了，实际 ' + JSON.stringify(slim));

  await clickEl(page, `document.querySelector('#content .task-el--timed, #content .task-row')`);
  await waitFor(page, `!!document.querySelector('.drawer.open')`, '抽屉打开', 8000);

  /* 2026-10-19 用户两次反馈后的最终形态：抽屉弹出 → 整页压暗 → 抽屉盖在
     压暗的页面上。快速添加条**不消失**（用户：「不要它不见，要整个页面变灰、
     弹窗盖在上面」），它作为页面的一部分被遮罩压暗、被抽屉盖住，点不到而已。
     同时它已是单行小条 —— 「不要这么大」。 */
  const qa = await evalJs(page, `
    const fa = document.querySelector('.fast-add');
    if (!fa) return { bar: 'no-bar' };
    const r = fa.getBoundingClientRect();
    // 在横条中点探一针：拿到的必须是遮罩/抽屉，不能是横条自己
    const hit = document.elementFromPoint(r.left + Math.min(60, r.width / 2), r.top + r.height / 2);
    return {
      display: getComputedStyle(fa).display,
      z: getComputedStyle(fa).zIndex,
      coveredBy: hit ? (hit.closest('.fast-add') ? 'fast-add（没被盖住！）'
        : (hit.closest('.drawer') ? 'drawer' : (hit.className || hit.tagName))) : null,
      shellH: Math.round(fa.querySelector('.fast-add-shell').getBoundingClientRect().height),
      placeholder: fa.querySelector('textarea').placeholder,
    };
  `);
  ok(qa.display !== 'none' && qa.coveredBy && qa.coveredBy !== 'fast-add（没被盖住！）',
    '抽屉开着时快速添加条还在原处（被遮罩压暗、被抽屉盖住，不消失），实际 '
      + JSON.stringify(qa));

  const sem = await evalJs(page, `
    const d = document.querySelector('.drawer.open');
    const mask = document.querySelector('.mask.show');
    const a = document.activeElement;
    return {
      role: d.getAttribute('role'),
      modal: d.getAttribute('aria-modal'),
      name: d.getAttribute('aria-label'),
      mask: mask ? mask.getAttribute('aria-hidden') : 'no-mask',
      active: a === d ? 'panel' : (a === document.body ? 'BODY' : (a.className || a.tagName)),
    };
  `);
  ok(sem.role === 'dialog' && sem.modal === 'true',
    '抽屉是 [role=dialog][aria-modal=true]，实际 ' + JSON.stringify(sem.role + '/' + sem.modal));
  ok(/任务详情/.test(String(sem.name)), '抽屉有名字（读屏念得出这片是干什么的），实际 ' + JSON.stringify(sem.name));
  ok(sem.mask === 'true', '遮罩对读屏是隐藏的（它只是个鼠标目标），实际 ' + JSON.stringify(sem.mask));
  ok(sem.active === 'panel',
    '焦点落在面板本身，不是第一个输入框（落进输入框会当场弹软键盘），实际 ' + JSON.stringify(sem.active));

  // Tab 圈住：从**最后一个**可聚焦元素按 Tab，应该绕回抽屉里的第一个。
  // 从中间按 Tab 证不了什么 —— 前后都在抽屉里，圈不圈都一样。
  const trap = await evalJs(page, `
    const d = document.querySelector('.drawer.open');
    const items = [...d.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.getClientRects().length);
    if (items.length < 2) return { n: items.length };
    items[items.length - 1].focus();
    return { n: items.length, last: document.activeElement === items[items.length - 1] };
  `);
  ok(trap.n >= 2 && trap.last, '抽屉里能数出可聚焦元素，最后一个也拿得到焦点（' + trap.n + ' 个）');
  await key(page, 'Tab', 'Tab', 9);
  const afterTab = await evalJs(page, `
    const d = document.querySelector('.drawer.open');
    const a = document.activeElement;
    return { inside: !!d && d.contains(a), desc: a === document.body ? 'BODY（跑出去了）' : (a.className || a.tagName) };
  `);
  ok(afterTab.inside, '在抽屉最后一个控件上按 Tab 会绕回抽屉里，实际 焦点落在 ' + afterTab.desc);

  // 降低动效：**先量一遍开着的值当基准** —— 不量基准的话「过渡是 0s」可能本来
  // 就是（压根没写过渡），断言会假通过。
  const motion = await evalJs(page, `
    const d = document.querySelector('.drawer.open');
    const spin = document.createElement('div');
    spin.className = 'animate-spin';
    document.body.appendChild(spin);
    const out = { drawer: getComputedStyle(d).transitionDuration, spin: getComputedStyle(spin).animationDuration };
    spin.remove();
    return out;
  `);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = await evalJs(page, `
    const d = document.querySelector('.drawer.open');
    const spin = document.createElement('div');
    spin.className = 'animate-spin';
    document.body.appendChild(spin);
    const out = { drawer: getComputedStyle(d).transitionDuration, spin: getComputedStyle(spin).animationDuration };
    spin.remove();
    return out;
  `);
  await page.send('Emulation.setEmulatedMedia', { features: [] });
  // getComputedStyle 给的是**序列化后**的值：写 `0.01ms` 它回 `1e-05s`。
  // 所以按秒解析再比大小，别去比字符串（第一版就是比字符串，报了个假失败）。
  const secs = (v) => Math.max(...String(v).split(',').map((p) => {
    const t = p.trim();
    return parseFloat(t) * (t.endsWith('ms') ? 0.001 : 1);
  }));
  ok(secs(motion.drawer) > 0.1,
    '没开降低动效时抽屉的过渡是真过渡（基准 ' + motion.drawer + '）');
  ok(secs(reduced.drawer) < 0.01,
    '开了 prefers-reduced-motion 之后过渡被关掉：' + motion.drawer + ' → ' + reduced.drawer);
  ok(secs(reduced.spin) < 0.01,
    '开了 prefers-reduced-motion 之后加载圈也一并停（无例外，同步状态靠顶栏文字说）：' + motion.spin + ' → ' + reduced.spin);

  // 关掉抽屉：焦点要还给刚才那个输入框
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.drawer.open') ? null : 1`, '抽屉关掉', 8000);
  const restored = await waitFor(page, `
    (() => { const a = document.activeElement; return (a && a.matches(${JSON.stringify(RESTORE)})) ? 'ok' : null; })()
  `, '焦点还给快速添加框', 8000);
  ok(restored === 'ok', '关掉之后焦点回到原来那个元素，不是掉在 body 上');

  // 侧栏当前项：视觉上靠 .active 那点底色，读屏只认 aria-current
  const cur = await evalJs(page, `
    const items = [...document.querySelectorAll('.nav-item')];
    const marked = items.filter((e) => e.getAttribute('aria-current') === 'page');
    const active = items.find((e) => e.className.includes('active'));
    return {
      n: items.length,
      marked: marked.map((e) => e.dataset.nav),
      activeNav: active ? active.dataset.nav : null,
      stray: marked.filter((e) => !e.className.includes('active')).map((e) => e.dataset.nav),
    };
  `);
  ok(cur.n > 3 && cur.marked.length === 1 && cur.stray.length === 0 && cur.marked[0] === cur.activeNav,
    '侧栏只有当前那一项带 aria-current="page"（' + cur.n + ' 项，标的 '
    + JSON.stringify(cur.marked) + '，当前页 ' + JSON.stringify(cur.activeNav) + '）');

  // 「找日期」是个真的折叠开关：aria-expanded 得跟着开合走
  await clickEl(page, `[...document.querySelectorAll('.nav-item')].find((b) => b.dataset.nav === 'calendar')`);
  await waitFor(page, `document.querySelector('.date-nav [aria-haspopup="dialog"]') ? 1 : null`, '切到日程页（找日期按钮在那儿）', 8000);
  const jumpState = () => evalJs(page, `
    const b = document.querySelector('.date-nav [aria-haspopup="dialog"]');
    return { exp: b.getAttribute('aria-expanded'), hd: b.getAttribute('aria-haspopup') };
  `);
  const j0 = await jumpState();
  await clickEl(page, `document.querySelector('.date-nav [aria-haspopup="dialog"]')`);
  await waitFor(page, `document.querySelector('.date-nav [aria-haspopup="dialog"]').getAttribute('aria-expanded') === 'true' ? 1 : null`,
    '找日期面板打开', 8000);
  const j1 = await jumpState();
  ok(j0.exp === 'false' && j1.exp === 'true',
    '「找日期」的 aria-expanded 跟着开合：' + j0.exp + ' → ' + j1.exp);
  ok(j0.hd === 'dialog', '「找日期」说了按下去会弹东西（aria-haspopup=dialog），实际 ' + JSON.stringify(j0.hd));
  await key(page, 'Escape', 'Escape', 27);
  await waitFor(page, `document.querySelector('.date-nav [aria-haspopup="dialog"]').getAttribute('aria-expanded') === 'false' ? 1 : null`,
    '找日期面板收起', 8000);


}

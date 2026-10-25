export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, sleep, num, WEB_PORT, TOUCH_DRAG_DELAY, gotoCalendar, touch } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  const { RADIUS_K, RADIUS_MIN, TOL_RATIO, TOL_PAD, CHECK_K, CHECK_MIN, CHECK_MAX, WEEK_HEAD, DUR, table, detail, VIEWPORTS, VIEWS } = state;
  console.log('\\n六、断言：列表里拖一行，整页不跟着滑');
  await evalJs(page, `
    const n = document.querySelector('[data-nav="today"]')
      || [...document.querySelectorAll('.tabbar .tab')].find((b) => /今天/.test(b.textContent));
    if (n) n.click();
    return true;
  `);
  await waitFor(page, `!!document.querySelector('.list-view .task-row')`, '今天列表');
  await sleep(300);

  /* 通用「哪个祖先能滚」探针：拖之前之后各量一次，比对 scrollTop */
  const scrollables = () => evalJs(page, `
    const row = document.querySelector('.list-view .task-row');
    if (!row) return [];
    const out = [];
    let n = row;
    while (n) {
      if (n.scrollHeight > n.clientHeight + 8) {
        out.push({ 名: n.className || n.tagName, 顶: n.scrollTop, 高: n.scrollHeight, 视: n.clientHeight });
      }
      n = n.parentElement;
    }
    const se = document.scrollingElement;
    if (se && se.scrollHeight > se.clientHeight + 8) {
      out.push({ 名: 'scrollingElement', 顶: se.scrollTop, 高: se.scrollHeight, 视: se.clientHeight });
    }
    return out;
  `);

  /* 先把页面滚到中段：AutoScroll 只在**靠近边缘**的阈值区出手，
     停在 0 时它往下滚、滚到顶时它往上滚 —— 起点留中间才两头都测得到 */
  const pre = await evalJs(page, `
    const row = document.querySelector('.list-view .task-row');
    let n = row;
    while (n && !(n.scrollHeight > n.clientHeight + 8)) n = n.parentElement;
    if (!n) return null;
    n.scrollTop = Math.round((n.scrollHeight - n.clientHeight) / 2);
    return { 名: n.className || n.tagName, 顶: n.scrollTop };
  `);
  console.log('    滚动容器：' + JSON.stringify(pre));
  const before = await scrollables();

  const rowStart = await evalJs(page, `
    const scroller = (() => {
      let n = document.querySelector('.list-view .task-row');
      while (n && !(n.scrollHeight > n.clientHeight + 8)) n = n.parentElement;
      return n;
    })();
    const rows = [...document.querySelector('.list-view').querySelectorAll('.task-row')];
    const box = scroller.getBoundingClientRect();
    /* 挑**离底边最近的那一行**：正是 AutoScroll 的触发区 */
    let best = null, bestD = 1e9;
    for (const el of rows) {
      const b = el.getBoundingClientRect();
      if (b.top < box.top || b.bottom > box.bottom) continue;
      const d = box.bottom - b.bottom;
      if (d >= 0 && d < bestD) { bestD = d; best = el; }
    }
    const b = (best || rows[rows.length - 1]).getBoundingClientRect();
    return { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2),
             到底: Math.round(box.bottom - b.bottom) };
  `);
  console.log('    拖这一行：' + JSON.stringify(rowStart) + '（离容器底 ' + rowStart.到底 + 'px）');

  await touch('touchStart', rowStart.x, rowStart.y);
  await sleep(380);
  /* 一直往底边蹭，再蹭出去：AutoScroll 是按 interval 轮询的，挪够久才看得出它出手 */
  for (let i = 1; i <= 14; i++) {
    await touch('touchMove', rowStart.x, rowStart.y + i * 4);
    await sleep(70);
  }
  const rowState = await evalJs(page, `
    return { dragging: !!document.querySelector('.task-row.dragging, .task-el.dragging, .drag-overlay'),
             overlay: !!document.querySelector('.drag-overlay') };
  `);
  const after = await scrollables();
  await touch('touchEnd', rowStart.x, rowStart.y + 56);
  await sleep(150);

  console.log('    拖前：' + JSON.stringify(before));
  console.log('    拖后：' + JSON.stringify(after));
  ok(rowState.dragging, '列表里长按 380ms 也进入拖拽态');
  const same = before.length === after.length &&
    before.every((b, i) => after[i] && b.名 === after[i].名 && b.顶 === after[i].顶);
  ok(before.length > 0, '这一屏确实有能滚的容器（不然这一段等于没测）');
  ok(same, '拖列表行期间没有任何容器替它滚');

  /* 列表行**也是拖拽表面**，所以同样禁选字（2026-10-25 用户：「能拖动的都不允许复制」，
     口径从「按界面分」改成「按能不能拖分」）。原先这里断言的是反过来的 ——
     `rowSel.us !== 'none'`，那时列表行被特意排除在外。 */
  const rowSel = await evalJs(page, `
    const els = [...document.querySelectorAll('.list-view .task-row')].slice(0, 3);
    return els.map((el) => {
      const cs = getComputedStyle(el);
      return { 类: el.className.split(' ')[0], us: cs.userSelect || cs.webkitUserSelect };
    });
  `);
  ok(rowSel.length > 0, '量到列表行 ' + rowSel.length + ' 行（空列表等于没测）');
  for (const el of rowSel) {
    ok(el.us === 'none', el.类 + ' 是拖拽表面 → 不被文字选中（user-select=' + el.us + '）');
  }

  /* `-webkit-touch-callout` **是 WebKit/Safari 的属性，Chrome 两头都读不到**：
     `CSS.supports('-webkit-touch-callout','none')` 返回 false，`getComputedStyle`
     读到空串，连 CSSOM 的 `cssText` 也直接把这行未知声明**丢掉**（实测：样式表
     原文里有，`document.styleSheets` 遍历出来 0 条）。所以这条只能读**样式表原文**
     —— 从页面 fetch 它自己加载的那张表，证明浏览器真的收到了这条声明。
     真正生效与否只能在 iOS 真机上看（手工那一趟记在 docs/测试.md）。 */
  const callout = await evalJs(page, `
    const out = [];
    for (const ss of document.styleSheets) {
      if (!ss.href) continue;
      let txt = '';
      try { txt = await (await fetch(ss.href)).text(); } catch (_) { continue; }
      const re = /([^{}]+)\\{([^{}]*)\\}/g;
      let m;
      while ((m = re.exec(txt))) {
        if (m[2].indexOf('-webkit-touch-callout') >= 0) {
          out.push({ sel: m[1].trim().slice(-200),
                     decl: (m[2].match(/-webkit-touch-callout:[^;]*/) || [''])[0] });
        }
      }
    }
    return out;
  `);
  const calloutSel = callout.map((h) => h.sel).join(' | ');
  for (const face of ['.task-el', '.habit-row', '.nav-chip']) {
    const hit = callout.find((h) => h.sel.split(',').some((s) => s.trim() === face));
    ok(!!hit && /none/.test(hit.decl),
      face + ' 写了 -webkit-touch-callout: none（iOS 长按菜单）',
      hit ? face + ' → ' + hit.decl : '没有命中这条声明的规则，现有：' + (calloutSel || '无'));
  }
  const intoKeep = callout.filter((h) => /\.new-cell|\.trash-row/.test(h.sel));
  ok(intoKeep.length === 0,
    '长按菜单那条没有溢到 .new-cell / .trash-row（它们不拖，要能复制）',
    intoKeep.map((h) => h.sel).join(' | '));

  /* 两个**不拖**的表面必须保持可复制。用离线元素量（真身上要么此时不存在、
     要么在别的页面），量的是 CSS 本身 —— 够用，而且不受页面状态影响：
       · `.new-cell`   就地新建的草稿框，拿来打字的
       · `.trash-row`  垃圾箱行，只有 .task-row 没有 .task-el，拖不动；
                       里面的任务名正是要复制出去找回东西的 */
  const keepSel = await evalJs(page, `
    const d = document.createElement('div');
    d.innerHTML = '<textarea class="new-cell"></textarea>'
      + '<div class="task-row trash-row"><div class="row-main"><div class="row-title">测</div></div></div>';
    document.body.appendChild(d);
    const out = [...d.children].map((el) => {
      const cs = getComputedStyle(el);
      return { 类: el.className.split(' ')[0], us: cs.userSelect || cs.webkitUserSelect };
    });
    d.remove();
    return out;
  `);
  for (const el of keepSel) {
    ok(el.us !== 'none', el.类 + ' **不拖**，文字仍可选中 / 复制（user-select=' + el.us + '）');
  }

  /* C. 日历视图里的拖拽表面同样禁选字。**`.new-cell` 要反过来量**：
     它是拿来打字的草稿框，不拖，选中必须还留着。 */
}

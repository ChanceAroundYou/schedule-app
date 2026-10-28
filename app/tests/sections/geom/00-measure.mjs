export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, sleep, WEB_PORT } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  const measure = () => evalJs(page, `
    const box = (el) => {
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      const num = (s) => parseFloat(s) || 0;
      const check = el.querySelector('.check-btn');
      const title = el.querySelector('.ev-title, .pill-title');
      /* display:none 的元素 rect 全是 0 —— 窄屏月 pill 不画勾选圈，别把「没有」
         读成「偏到卡片左边 277px」 */
      const cb = check && check.getBoundingClientRect().width > 0 ? check.getBoundingClientRect() : null;
      const tb = title ? title.getBoundingClientRect() : null;
      return {
        cls: el.className,
        h: +b.height.toFixed(2), w: +b.width.toFixed(2), x: +b.left.toFixed(2),
        /* 月视图：胶囊挤在格子里，格子有多宽、标题实际能用多宽都要量 ——
           responsive.css 那段「一格能显示几个汉字」的注释全靠这两个数 */
        cellW: (() => { const c = el.closest('.month-cell'); return c ? +c.getBoundingClientRect().width.toFixed(2) : null; })(),
        titleW: tb ? +tb.width.toFixed(2) : null,
        padL: num(cs.paddingLeft), padR: num(cs.paddingRight),
        borderL: num(cs.borderLeftWidth),
        radius: num(cs.borderTopLeftRadius),
        /* 打勾圈左侧的间距：卡片**外**左边界到勾选圈**外**左边界 */
        checkGap: cb ? +(cb.left - b.left).toFixed(2) : null,
        titleGap: (cb && tb) ? +(tb.left - cb.right).toFixed(2) : null,
        fontSize: num(cs.fontSize),
        rXl: num(cs.getPropertyValue('--r-xl')),
        padX: cs.getPropertyValue('--card-pad-x').trim() || null,
        cardPx: cs.getPropertyValue('--card-px').trim() || null,
        row: cs.getPropertyValue('--row').trim() || null,
      };
    };
    const pick = (sel) => { const el = document.querySelector(sel); return el ? box(el) : null; };
    const head = document.querySelector('.week-head');
    const hb = head ? head.getBoundingClientRect() : null;
    const day = document.querySelector('.week-head-cell .wh-day');
    const cell = document.querySelector('.week-head-cell');
    return {
      timed: pick('.content .task-el--timed'),
      untimed: pick('.content .task-el--untimed'),
      pill: pick('.content .task-pill'),
      weekHead: hb ? +hb.height.toFixed(2) : null,
      whDayFont: day ? parseFloat(getComputedStyle(day).fontSize) : null,
      whDayW: day ? +day.getBoundingClientRect().width.toFixed(2) : null,
      whCellPad: cell ? getComputedStyle(cell).padding : null,
      narrow: matchMedia('(max-width: 720px)').matches,
    };
  `);

  /** 进日程页：宽屏点侧栏，窄屏侧栏不渲染、点底栏那一格（`.tab` 上没有 data-nav，只有文字） */
  const gotoCalendar = async () => {
    await evalJs(page, `
      const n = document.querySelector('[data-nav="calendar"]')
        || [...document.querySelectorAll('.tabbar .tab')].find((b) => /日程/.test(b.textContent));
      if (n) n.click();
      return !!n;
    `);
    await waitFor(page, `!!document.querySelector('.content-day, .content-month')`, '日程页');
  };

  /** 逐张卡的细节（第三节全靠它）：时间行在不在、在不在卡里、圈多大、圈中心对没对上文字块中心 */
  const measureDetail = () => evalJs(page, `
    const R = (el) => {
      const b = el.getBoundingClientRect();
      return { l: +b.left.toFixed(2), t: +b.top.toFixed(2), b: +b.bottom.toFixed(2),
               w: +b.width.toFixed(2), h: +b.height.toFixed(2) };
    };
    const one = (el) => {
      const title = el.querySelector('.ev-title');
      const time = el.querySelector('.ev-time');
      const note = el.querySelector('.ev-note');
      const check = el.querySelector('.check-btn');
      const text = el.querySelector('.ev-text');
      const cb = check ? R(check) : null;
      const tb = title ? R(title) : null;
      const mr = time ? R(time) : null;
      const nr = note ? R(note) : null;
      const texts = [tb, mr, nr].filter(Boolean);
      const body = el.querySelector('.ev-body');
      return {
        id: el.getAttribute('data-id'),
        card: R(el),
        titleFs: title ? +parseFloat(getComputedStyle(title).fontSize).toFixed(2) : null,
        timeFs: time ? +parseFloat(getComputedStyle(time).fontSize).toFixed(2) : null,
        /* display:none 与「没有这个元素」是两件事：前者是 CSS 藏掉了，后者是没渲染 */
        timeDisplay: time ? getComputedStyle(time).display : null,
        timeText: time ? (time.textContent || '').trim() : null,
        /* **横向有没有被裁**：scrollWidth 大于 clientWidth 就是文字超出可用宽，
           CSS 的 text-overflow 会把尾巴换成省略号 —— 用户看到的「时间显示不全」。
           只读 DOM 属性，不靠猜 CSS。（这段跑在浏览器里，注释里不能出现反引号） */
        timeClip: time ? Math.round(time.scrollWidth - time.clientWidth) : null,
        titleClip: title ? Math.round(title.scrollWidth - title.clientWidth) : null,
        timeW: time ? +time.clientWidth.toFixed(2) : null,
        timeAvail: time ? +time.parentElement.clientWidth.toFixed(2) : null,
        /* **纵向有没有溢出**读的是**文字块自己**（ev-text）而不是 ev-body：
           勾选圈那块 24×24 命中区（靠 ::before 撑）是**故意**超出矮卡的（WCAG 2.5.8），
           把它算进 scrollHeight 会让每一张矮卡都「溢出」—— 第一版就是这么误报的。
           判据：文字块自己的内容高 ≤ 内容层可用高。 */
        bodyCH: body ? body.clientHeight : null,
        textCH: text ? text.clientHeight : null,
        textSH: text ? text.scrollHeight : null,
        /* 卡片自身的 CSS 地板（calendar.css 给定时卡写的 min-height: 12px）。
           它是**旧的**、不是压缩阶梯给的：30 分钟的卡在窄屏只有 9.5px，
           这条把它顶到 12px。报出来，别让它藏在「卡高 = 时长」这条断言背后。 */
        cssMinH: (function () {
          const x = parseFloat(getComputedStyle(el).minHeight);
          return Number.isFinite(x) ? x : 0;
        })(),
        titleH: title ? +title.getBoundingClientRect().height.toFixed(2) : null,
        timeH: time ? +time.getBoundingClientRect().height.toFixed(2) : null,
        titleLh: title ? getComputedStyle(title).lineHeight : null,
        timeLh: time ? getComputedStyle(time).lineHeight : null,
        hourPx: (function () {
          /* --row-hour 是 DayView / WeekView 写在**未定时容器**上的内联值
             （:root 上没有这条，从 documentElement 读恒 0 —— 上一轮就误读成 0.00）。
             定时卡不在那个容器里（它站在时间轴上），所以要退到页面上找那一个容器：
             「这一屏上的一小时」是整屏一个数，不是每张卡一个数。 */
          const host = el.closest('.allday-zone') || el.closest('.wun-cell')
            || document.querySelector('.allday-zone') || document.querySelector('.wun-cell');
          if (!host) return null;
          const x = parseFloat(getComputedStyle(host).getPropertyValue('--row-hour'));
          return Number.isFinite(x) ? +x.toFixed(2) : null;
        })(),
        /* **压缩阶梯落在第几档**（0 = 宽松）。判据在 TaskCard 的 useCardFit，
           这里只报读数：哪一屏需要压到第几档，是要能看见的 */
        fit: el.getAttribute('data-fit') || null,
        /* TimedCard 报给圆角算式的那个数 = 这张卡按时长该有的高（百分比 × 容器实高 − 缝）。
           渲染高与它不等 = 有人偷偷给卡加长了（第五轮撤掉的正是这个） */
        cardPx: (function () {
          const x = parseFloat(getComputedStyle(el).getPropertyValue('--card-px'));
          return Number.isFinite(x) ? +x.toFixed(2) : null;
        })(),
        titleL: tb ? tb.l : null, timeL: mr ? mr.l : null,
        timeTop: mr ? mr.t : null, timeBottom: mr ? mr.b : null,
        checkW: cb ? cb.w : null,
        checkCy: cb ? +(cb.t + cb.h / 2).toFixed(2) : null,
        textTop: texts.length ? Math.min(...texts.map((x) => x.t)) : null,
        textBottom: texts.length ? Math.max(...texts.map((x) => x.b)) : null,
        bodyAlign: body ? getComputedStyle(body).alignContent : null,
        titleMaxH: title ? (title.style.maxHeight || null) : null,
        minHeight: el.style.minHeight || null,
      };
    };
    return {
      timed: [...document.querySelectorAll('.content .task-el--timed')].map(one),
      untimed: [...document.querySelectorAll('.content .task-el--untimed')].map(one),
      pills: [...document.querySelectorAll('.content .task-pill')].map((el) => {
        const c = el.querySelector('.check-btn');
        const cb = c ? c.getBoundingClientRect() : null;
        const t = el.querySelector('.pill-title');
        return {
          id: el.getAttribute('data-id'),
          untimed: el.getAttribute('data-untimed') === '1',
          hasTimeEl: !!el.querySelector('.pill-time, .ev-time'),
          tip: el.getAttribute('title') || '',
          checkW: cb && cb.width > 0 ? +cb.width.toFixed(2) : null,
          titleFs: t ? +parseFloat(getComputedStyle(t).fontSize).toFixed(2) : null,
        };
      }),
      /* 全页扫一遍：「.pill-time」这个元素现在**根本不该存在**（CompactCard 不画）
         —— 注意这段跑在浏览器里，注释里不能出现反引号（会把外层模板截断） */
      pillTimeEls: document.querySelectorAll('.pill-time').length,
      evTimeEls: document.querySelectorAll('.ev-time').length,
    };
  `);

  const VIEWPORTS = [
    { name: '桌面 1400', w: 1400, h: 900, mobile: false },
    { name: '窄屏 390', w: 390, h: 844, mobile: true },
  ];
  const VIEWS = ['day', 'week', 'month'];
  const table = {};
  /** 逐张卡的读数（第三节用），与 table 同一套 key */
  const detail = {};

  for (const vp of VIEWPORTS) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w, height: vp.h, deviceScaleFactor: vp.mobile ? 2 : 1, mobile: vp.mobile,
    });
    /* matchMedia 变了要靠一次重载让 React 的 narrow 分支重算 */
    await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
    try { await waitFor(page, `!!document.querySelector('.main')`, vp.name + ' 外壳', 15000); }
    catch (err) {
      const dbg = await evalJs(page, `
        return { href: location.href, ready: document.readyState,
                 rootChildren: (document.querySelector('#root') || {}).childElementCount,
                 navs: [...document.querySelectorAll('[data-nav]')].map((e) => e.getAttribute('data-nav')),
                 tabs: [...document.querySelectorAll('.tabs, .tabbar, .bottom-tabs')].map((e) => e.className),
                 bodyStart: document.body ? document.body.innerHTML.slice(0, 300) : null };
      `);
      console.error('  [诊断] ' + JSON.stringify(dbg, null, 1)); throw err;
    }

    await gotoCalendar();

    for (const view of VIEWS) {
      await evalJs(page, `
        const b = document.querySelector('.view-switch [data-view="${view}"]');
        if (b) b.click();
        return true;
      `);
      const marker = view === 'month' ? `.content-month` : `.content-day`;
      try { await waitFor(page, `!!document.querySelector('${marker}')`, vp.name + ' / ' + view + ' 视图'); }
      catch (err) {
        const dbg = await evalJs(page, `
          const st = JSON.parse(localStorage.getItem('schedule-app-v4') || 'null');
          return { ui: st && st.ui, contentCls: [...document.querySelectorAll('.content')].map((e) => e.className),
                   views: [...document.querySelectorAll('.view-switch button')].map((b) => b.className + '/' + b.textContent),
                   navs: [...document.querySelectorAll('[data-nav]')].map((e) => e.getAttribute('data-nav')),
                   taskEls: document.querySelectorAll('.task-el').length };
        `);
        console.error('  [诊断] ' + JSON.stringify(dbg, null, 1)); throw err;
      }
      /* 卡片几何在 JS 量完容器高度后才落定（--row-hour / --card-px），多等一拍 */
      await sleep(450);
      const key = vp.name + ' / ' + view;
      table[key] = await measure();
      detail[key] = await measureDetail();
    }
  }

  /* ── 3 日宽屏档专趟：卡片**右上角那两枚角标**（重复角标 + 来源 tag）只在这一档出现
     （判据在 `views/calendar/WeekView.tsx`：dayCount === 3 且非窄屏且设置里开着），
     上面三档（日 / 周 / 月）根本画不出来 —— 上一轮「tag 把卡片改坏了」就是这一档的事，
     而这套探针当时压根没 visits 这一档，所以全绿也没拦住。
     量的核心是**面积重叠**：角标是绝对定位、不占文字宽度（用户 2026-10-25 定的），
     于是标题长到顶到右沿时就会从角标**底下**穿过去 —— 相交面积 > 0 就是撞上了。 */
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  await waitFor(page, `!!document.querySelector('.main')`, '桌面 1400 / 3日 外壳', 15000);
  await gotoCalendar();
  await evalJs(page, `
    const b = document.querySelector('.view-switch [data-view="3day"]');
    if (b) b.click();
    return true;
  `);
  await waitFor(page, `!!document.querySelector('.content-day')`, '桌面 1400 / 3日 视图');
  await sleep(700);
  const corner = await evalJs(page, `
    const R = (el) => { const b = el.getBoundingClientRect();
      return { l: +b.left.toFixed(2), t: +b.top.toFixed(2), r: +b.right.toFixed(2),
               b: +b.bottom.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) }; };
    /* 两个矩形相交面积：0 = 各站各的；> 0 = 压在彼此头上（角标是半透明的，压在文字上
       就是用户看到的那团糊） */
    const area = (a, b) => (!a || !b) ? null
      : +(Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l))
          * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t))).toFixed(2);
    /* **墨迹右端**在哪：.ev-title 是个 grid item，矩形永远撑满可用宽 ——
       拿它当「文字到哪」会把「没撞上」误报成「撞上了」。用 Range 量真正的文字端
       （Range 的 client rect 跟着字形走，不受 grid 拉伸影响）。
       ⚠️ Range 的 rect **不受祖先 overflow:hidden 裁剪**：标题被裁时它照报全长
       （实测被裁 74px 的那条报出卡外 58px）—— 所以「看得见的墨迹」取
       min(Range 右端, 元素自己的右端)：overflow 只可能让墨迹更短，不会更长。 */
    const inkR = (el) => {
      if (!el) return null;
      const rg = document.createRange(); rg.selectNodeContents(el);
      const rs = rg.getClientRects(); let mx = null;
      for (let i = 0; i < rs.length; i++) { if (mx === null || rs[i].right > mx) mx = rs[i].right; }
      if (mx === null) return null;
      const box = el.getBoundingClientRect();
      return +Math.min(mx, box.right).toFixed(2);
    };
    /* 看得见的墨迹占的那块：右端取上面那个 min，左右之外沿用元素自己的矩形。
       与角标求**相交面积**才是「压没压」—— 只看水平会漏（角标可能整条在文字行上方），
       只看矩形会把 grid 拉伸的空档也算成文字。 */
    const inkBox = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect(); const r = inkR(el);
      if (r === null) return null;
      return { l: +b.left.toFixed(2), t: +b.top.toFixed(2), r, b: +b.bottom.toFixed(2),
               w: +(r - b.left).toFixed(2), h: +b.height.toFixed(2) };
    };
    const cards = [...document.querySelectorAll('.content .task-el')].map((el) => {
      const tag = el.querySelector('.creator-tag');
      const rep = el.querySelector('.rep-flag--corner');
      const title = el.querySelector('.ev-title');
      const text = el.querySelector('.ev-text');
      const card = R(el);
      const tr = tag ? R(tag) : null;
      const rr = rep ? R(rep) : null;
      const xr = text ? R(text) : null;
      const ti = title ? R(title) : null;
      return {
        id: el.getAttribute('data-id'), card, tag: tr, rep: rr, text: xr, title: ti,
        /* 角标离卡片右沿多远：判「贴右沿 / 让到角标左边」两条摆法落没落对 */
        tagFromRight: tr ? +(card.r - tr.r).toFixed(2) : null,
        tagFromTop: tr ? +(tr.t - card.t).toFixed(2) : null,
        repFromRight: rr ? +(card.r - rr.r).toFixed(2) : null,
        gapTagRep: (tr && rr) ? +(rr.l - tr.r).toFixed(2) : null,
        tagVsText: area(tr, xr), tagVsTitle: area(tr, ti), tagVsRep: area(tr, rr),
        repVsText: area(rr, xr), repVsTitle: area(rr, ti),
        /* 真正的撞没撞：墨迹右端越过角标左沿多少像素（负数 = 还留着缝） */
        /* 真正的撞没撞：墨迹块与角标的**相交面积**（0 = 各站各的） */
        inkTagArea: area(inkBox(title), tr), inkRepArea: area(inkBox(title), rr),
        /* 角标那一横条与标题那一行的竖直重叠：<= 0 说明两者不同行，
           那时「面积 0」是白判，得说出来 */
        bandTagY: (tr && ti) ? +(Math.min(ti.b, tr.b) - Math.max(ti.t, tr.t)).toFixed(2) : null,
        titleInkR: inkR(title),
        inkIntoTag: (tr && inkR(title) != null) ? +(inkR(title) - tr.l).toFixed(2) : null,
        inkIntoRep: (rr && inkR(title) != null) ? +(inkR(title) - rr.l).toFixed(2) : null,
        /* 文字块右沿到 tag 左沿的净空：负数就是文字伸到角标下面了 */
        clearance: (tr && xr) ? +(tr.l - xr.r).toFixed(2) : null,
        /* 「让位」有没有真的落在内容层上（CSS 里那条 --corner-inset） */
        bodyPadR: (function () { const b = el.querySelector('.ev-body');
          return b ? +parseFloat(getComputedStyle(b).paddingRight).toFixed(2) : null; })(),
        titleClip: title ? Math.round(title.scrollWidth - title.clientWidth) : null,
        titleFs: title ? +parseFloat(getComputedStyle(title).fontSize).toFixed(2) : null,
        tagW: tr ? tr.w : null,
      };
    });
    return {
      cards,
      tagEls: document.querySelectorAll('.creator-tag').length,
      repEls: document.querySelectorAll('.rep-flag--corner').length,
      narrow: matchMedia('(max-width: 900px)').matches,
      /* 量不到 tag 时有两种原因、方向相反：数据没到（跨集口径没勾上 / 同步没拉到）
         还是界面没画（窄屏判定 / 那个开关）。当场把两边读数都留下 */
      diag: (function () {
        const st = JSON.parse(localStorage.getItem('schedule-app-v4') || '{}');
        return { uiCals: (st.ui || {}).cals, calNames: (st.cals || []).map((c) => c.name),
                 meId: st.meId, foreign: Object.keys(st.tasks || {}).filter((k) => /foreign/.test(k)),
                 users: Object.keys(st.users || {}).length, switchOn: (st.ui || {}).showCreatorTag,
                 view: (st.ui || {}).view, taskEls: document.querySelectorAll('.task-el').length };
      })(),
    };
  `);

  Object.assign(state, { table, detail, VIEWPORTS, VIEWS, corner });
}

/**
 * 目标卡节点分类纯函数（Reviewer 第 4 轮 findings A，本轮 Worker 定点返工）。
 * 只吃「节点描述符」（由 00 的浏览器采样 evalJs 采集后回传 Node），不碰 DOM、
 * 不依赖 page / ctx，因此可被系统临时目录里的既有负注入脚本直接 import，
 * 用伪造描述符做单元级故障注入 —— 覆盖的正是**生产实际在用的**分类函数本体。
 *
 * 分类判据全部来自组件源码里「源头明确」的标识，绝不再用
 * closest('.month-ghost,.drag-ghost') 这类宽泛祖先匹配（旧版会把祖先容器内
 * 所有 selector 卡一并排除，且未实证容器只含合法 shadow）：
 *   · drag-ghost 分身：元素**自身**带 .drag-ghost 类 + aria-hidden="true"
 *     （TaskCard.tsx:410/421、685/693，createPortal 到 body 的那一份）；
 *   · month-ghost 预览影子层 pill：住在**明确的** .month-ghost[aria-hidden="true"]
 *     根（MonthView.tsx:144 MonthGhost 的 month-view 副本）内，且节点自身是
 *     「无 data-id 的纯预览 pill」（MonthView.tsx:164 只给 data-cal-color，
 *     真实卡一律带 data-id）—— 确认月 pill 确实会在 .month-ghost 容器出现，
 *     这里显式识别并**只排除这一影子层的元素**；
 *   · 其余全部计入 expected：包括「任意祖先是 ghost 容器、但节点自身不是
 *     shadow 标识」的真实任务（负向样本），它们必须因 display:none / 零尺寸
 *     被 00 直接判 FAIL，不得被祖先匹配悄悄排除。
 * 因此 ghost/影子层判据**只排除这两类影子元素**，绝不用宽泛祖先匹配吞掉带
 * data-id 的真实任务；expected 节点真实性另由 02 的 sourceTaskIds / domIds /
 * expectedIds 三集合独立对账闭环（见 02-radius-pad.mjs evaluateCell），本函数
 * 不参与真值表判定 —— 负注入 import 的也是这同一份生产分类逻辑。
 * 返回 { bucket:'shadow'|'expected', marker, reason }。
 */
export function classifyCardDescriptor(d) {
  const f = d.flags || {};
  const root = d.shadowRoot || null;
  if (f.selfDragGhost === true && f.selfAriaHidden === true) {
    return { bucket: 'shadow', marker: 'drag-ghost-self',
      reason: '元素自身 .drag-ghost + aria-hidden="true"（TaskCard 拖拽分身，源头明确标志）' };
  }
  if (root && /(^|\s)month-ghost(\s|$)/.test(root.className || '')
      && root.ariaHidden === true && d.hasDataId === false) {
    return { bucket: 'shadow', marker: 'month-ghost-preview-pill',
      reason: 'month-ghost 影子层预览 pill（根 aria-hidden="true"、节点自身无 data-id），MonthView.tsx:144/164' };
  }
  return { bucket: 'expected', marker: 'real-card',
    reason: '非合法 ghost/影子层标识的真实目标卡，计入 expected（含祖先 ghost 但自身非 shadow 的负向样本）' };
}

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

  /* ── 圆角契约矩阵（2026-11-08，界面规则第 4 条；Reviewer 第 1 轮返工）────────
     把「半径 = min(--r-xl, max(2px, 短边 × --card-r-k))」摊成矩阵逐格验：
     风格（soft / flat / notion）× 视图（日 / 三日 / 周 / 月）× 卡型
     （定时 / 未定时 / 月胶囊）× 两档视口。只往 state 写，不动 table / detail
     —— 那张六屏表是第三节（时间行 / 压缩阶梯）的读数源，key 一改后面 03 / 04 节跟着漂。

     Reviewer 第 1 轮两条阻断、一条次要，全部落在这段（旧行为是把预期适用组合
     静默抹成「不适用」，02 只剩 1 soft + 1 flat 守卫就假绿）：
       · 旧代码「点不到视图按钮」=整行判不适用（拿任意 selector 缺失当产品能力），
         「activeView 没切到目标」也只判不适用，activeView=null 更直接放行用别档读数；
       · 现改为先**从界面读能力**（枚举 .view-switch 里真实渲染的 data-view 按钮）：
         产品 UI 确实没给这一档，才允许「视图级不适用」且 reason 写明 UI 提供的档；
         UI 给了这一档却点不到 / 点了没生效 / activeView≠目标 / 预期适用组合没真实样本
         —— 一律记 violation（applicable:false + violation:true + reason），由 02 的
         逐组合覆盖断言判 FAIL，绝不静默算不适用；
       · 读数时 activeView 必须严格 === 目标，null / 其它档都不接受；
       · 卡型级不适用（月视图不画定时/未定时、日/三日/周不画月胶囊）用**常量**
         定义 reason 并标 constantUnsupported，02 逐格断言原因来自常量；
       · 取全部真实卡元素（不只首个），每个适用风格×视图×卡型确保 ≥1 个真实样本、
         可见且有真实尺寸；同一视图缺测试数据只用编排已有的 seed fixture，不临场造文件。
     风格只临时改 documentElement.dataset.style，在同一趟 evalJs 里量完还原；
     紧接其后的 3 日宽屏角标专趟会重新导航，把视口 / 视图 / 风格一并还原。

     Reviewer 第 2 轮阻断 1（本轮定点返工）：旧 one() 每个矩阵格只读 els[0]
     的 radius/尺寸，sampleCount 只记数，全量卡形又只采 w/h —— 于是每格只有
     **首卡**受 02 断言，其余真实卡全在断言之外。现改为逐张真实可见卡采样：
       · readCard() 对每张可见卡一次采齐 6 个量：computed radius、宽、高、
         --r-xl、--card-h、k(--card-r-k)；不掺任何 createElement 人造探针；
       · 每个适用格留 samples[]（逐张完整读数）+ sampleCount + totalCount，
         02 遍历 samples 逐张做短边契约断言，缺任一张都不再是「有数就算过」；
       · 每格缺真实样本仍记 violation（applicable:false + violation:true），
         并把可见张数 / DOM 总数 / 原因写进日志，可审计、不可静默不适用；
       · 不扩大、不改动编排里的 seed fixture（card-geometry.mjs 不属本轮授权），
         样本全部来自真实 DOM；顶层标量只取首卡作摘要，供 01 节既有打印沿用。 */
  const STYLES = ['soft', 'flat', 'notion'];
  const KINDS = ['timed', 'untimed', 'pill'];
  // 界面/编排确认的四个视图：Topbar.tsx:137-141 的 view-switch 无条件渲染四档按钮；
  // Calendar.tsx:34 3day 复用 WeekView；Shell.tsx:74 day/3day/week 挂 .content-day、month 挂 .content-month。
  const MATRIX_VIEWS = ['day', '3day', 'week', 'month'];
  const VIEW_MARKER = { day: '.content-day', '3day': '.content-day', week: '.content-day', month: '.content-month' };
  // 产品 UI 真实 DOM 能力：每个视图画哪些卡型（来自各视图组件真实渲染路径，非 selector 猜测）
  const VIEW_KINDS = {
    day: ['timed', 'untimed'],
    '3day': ['timed', 'untimed'],
    week: ['timed', 'untimed'],
    month: ['pill'],
  };
  const KIND_SEL = {
    timed: '.content .task-el--timed',
    untimed: '.content .task-el--untimed',
    pill: '.content .task-pill',
  };
  // 卡型级不适用组合的**常量**原因（02 逐格断言 reason 必须原样来自这里）
  const UNSUPPORTED_REASON = {};
  for (const view of MATRIX_VIEWS) {
    for (const kind of KINDS) {
      if (!VIEW_KINDS[view].includes(kind)) {
        UNSUPPORTED_REASON[view + '/' + kind] = view + ' 视图按真实 DOM 不画 ' + kind + ' 卡型（常量定义）';
      }
    }
  }
  // 常量 / 界面能力 / 真实卡全量采样都挂到 state，供 02 逐组合断言共享（不新增文件）
  state.matrixSpec = {
    STYLES, KINDS, KIND_SEL, MATRIX_VIEWS, VIEW_MARKER, VIEW_KINDS, UNSUPPORTED_REASON,
    VIEWPORTS: VIEWPORTS.map((v) => v.name),
    // Reviewer 第 4 轮 findings C：编排 card-geometry.mjs:45-48 传入的 2 个固定
    // viewport 常量（名字/尺寸），02 用它对「实际成功配置的 viewport」做逐项精确匹配，
    // 不再只靠 mx.length===totalCells 这类二维总数自洽。
    EXPECT_VIEWPORTS: (state.VIEWPORTS || VIEWPORTS).map((v) => ({ name: v.name, w: v.w, h: v.h })),
  };
  state.viewCapability = {};
  // 逐 viewport 记录「实际成功下发配置 + 矩阵循环逐项完成」的审计证据（C）
  state.viewportConfig = {};

  /* 分类纯函数自检（findings A 的负向样本，运行时留痕）：用伪造描述符证明
     「任意祖先是 ghost 容器、但节点自身不是 shadow 标识的真实任务」计入
     expected（并因 display:none/零尺寸在组装时直接判 FAIL），而两种源码明确
     的合法 shadow 被显式识别。系统临时目录里的既有负注入脚本 import 的也是
     同一个 classifyCardDescriptor 本体，二者覆盖的是同一份生产分类逻辑。 */
  const SELFTEST_GHOST_ROOT = { tag: 'div', className: 'month-view month-ghost', ariaHidden: true };
  const selftestBase = {
    sel: '.content .task-pill', tag: 'div', className: 'task-pill',
    dataAttrs: { 'data-id': 't_real_in_ghost_ancestor', 'data-cal-color': '#888' },
    hasDataId: true,
    flags: { selfDragGhost: false, selfAriaHidden: false, selfIsClone: false },
    shadowRoot: SELFTEST_GHOST_ROOT,
    ghostAncestors: [{ tag: 'div', className: 'month-view month-ghost', ariaHidden: true }],
    visible: { display: 'none', visibility: 'visible', w: 0, h: 0, ok: false },
  };
  const selftestCases = [
    { name: '负向：祖先 month-ghost 但自身真实任务(有 data-id/无 shadow 标志) → 计 expected 且不可见 FAIL',
      d: selftestBase, want: 'expected' },
    { name: '正向：month-ghost 影子层预览 pill(根 aria-hidden/自身无 data-id) → 显式排除',
      d: { ...selftestBase, hasDataId: false, dataAttrs: { 'data-cal-color': '#888' } }, want: 'shadow' },
    { name: '正向：drag-ghost 分身(自身 .drag-ghost + aria-hidden) → 显式排除',
      d: { ...selftestBase, flags: { selfDragGhost: true, selfAriaHidden: true, selfIsClone: false }, shadowRoot: null }, want: 'shadow' },
    { name: '负向：仅祖先 class 含 ghost 字样(非明确影子根)的真实任务 → 计 expected',
      d: { ...selftestBase, shadowRoot: null,
        ghostAncestors: [{ tag: 'div', className: 'some-ghost-wrapper', ariaHidden: false }] }, want: 'expected' },
  ];
  for (const c of selftestCases) {
    const got = classifyCardDescriptor(c.d);
    console.log('  [分类纯函数自检] ' + c.name + ' → ' + got.bucket + '/' + got.marker);
    ok(got.bucket === c.want, '分类纯函数自检：' + c.name + ' → ' + c.want);
  }
  const radiusMatrix = [];
  const cardShapes = [];   // 真实卡全量 w/h 采样（非人造探针），用于实证「生产输入 = 短边」
  // 整行（该视口该视图所有 style×kind）记违规：02 判 FAIL，绝不静默不适用
  const markViolation = (vp, view, reason) => {
    for (const style of STYLES) for (const kind of KINDS) {
      radiusMatrix.push({ vp, view, style, kind, applicable: false, violation: true, reason });
    }
  };
  for (const vp of VIEWPORTS) {
    // C：逐 viewport 的审计记录（成功下发配置 / 矩阵循环逐项完成 / 采到的格数）
    const vpCfg = { name: vp.name, w: vp.w, h: vp.h, metricsConfigured: false,
      viewsCompleted: [], stylesCompleted: [...STYLES], kindsCompleted: [...KINDS], matrixCells: 0 };
    state.viewportConfig[vp.name] = vpCfg;
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w, height: vp.h, deviceScaleFactor: vp.mobile ? 2 : 1, mobile: vp.mobile,
    });
    vpCfg.metricsConfigured = true;
    await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
    await waitFor(page, `!!document.querySelector('.main')`, vp.name + ' 契约矩阵外壳', 15000);
    await gotoCalendar();

    /* ── 界面能力确认：枚举视图切换器里**真实渲染**的按钮，不以任意 selector 缺失作依据 ──
       这是「该视口产品 UI 支持哪些视图」的唯一来源；连容器/一个按钮都没渲染 = 能力
       无法确认，不能据此宣称「产品不支持」。 */
    const cap = await evalJs(page, `
      const sw = document.querySelector('.view-switch');
      const btns = sw ? [...sw.querySelectorAll('[data-view]')] : [];
      return { hasSwitch: !!sw, uiViews: btns.map((b) => b.getAttribute('data-view')), uiViewCount: btns.length };
    `);
    state.viewCapability[vp.name] = {
      uiViews: cap.uiViews, uiViewCount: cap.uiViewCount, hasSwitch: cap.hasSwitch,
    };
    console.log('  [界面能力] ' + vp.name + '：视图切换器 ' + (cap.hasSwitch ? '在' : '不在')
      + '，UI 提供 ' + cap.uiViewCount + ' 档 [' + cap.uiViews.join(', ') + ']');

    /* Reviewer 第 3 轮（本轮定点返工）：Topbar.tsx:137-142 的 .view-switch
       **无条件渲染四档按钮**（day/3day/week/month）；窄屏只是少画 CreatorFilter，
       responsive.css 仅改按钮高度/布局，不隐藏任何一档 —— 项目规则与组件源码
       都确认「不存在合法的视图级不适用」，两视口实测也都是 4 档齐全。
       因此删掉旧的 capComplete / capabilityConfirmed「视图级不适用」分支：
       任一视口缺任一目标视图一律整行违规 → 02 判 FAIL。unsupported 只允许
       00 里常量定义的「卡型级不适用」（UNSUPPORTED_REASON[view/kind]）。 */
    for (const view of MATRIX_VIEWS) {
      vpCfg.viewsCompleted.push(view);   // C：矩阵循环逐视图完成留痕（逐项，非总数自洽）
      const uiProvides = cap.uiViews.includes(view);
      if (!uiProvides) {
        // 缺档 / 无切换器 / 无按钮：一律违规 → 02 判 FAIL，绝不静默算不适用
        markViolation(vp.name, view, '界面能力确认失败：视图切换器未完整提供四档 ['
          + MATRIX_VIEWS.join(',') + ']（实际 [' + cap.uiViews.join(',') + ']），'
          + view + ' 档缺失不得判不适用（Topbar 无条件渲染四档，无合法视图级不适用）');
        continue;
      }

      // UI 支持该视图 → 必须点到按钮、切到目标、拿到真实样本
      const hit = await evalJs(page, `
        const b = document.querySelector('.view-switch [data-view="${view}"]');
        if (b) b.click();
        return !!b;
      `);
      if (!hit) {
        // 按钮清单里有却点不到 = selector 与真实属性不符 / 渲染异常 → FAIL 路径，不判不适用
        markViolation(vp.name, view, 'UI 已提供 ' + view + ' 档按钮，但探针未能点击（selector 缺失/渲染异常），不得判不适用');
        continue;
      }
      // 等 activeView 严格切到目标：.on 按钮的 data-view 即 ui.view（Topbar.tsx:138-141 同步渲染）
      const activeExpr = `(() => { const b = document.querySelector('.view-switch [data-view].on'); return b && b.getAttribute('data-view') === '${view}' ? 1 : null; })()`;
      let switched = true;
      try { await waitFor(page, activeExpr, vp.name + ' / ' + view + ' 切到目标 activeView', 6000); }
      catch (e) { switched = false; }
      try {
        await waitFor(page, `!!document.querySelector('${VIEW_MARKER[view]}')`,
          vp.name + ' / ' + view + ' 内容容器', 6000);
      } catch (e) { /* 仍读一次 shot，由 activeView 严格校验兜底 */ }
      await sleep(350);

      /* ── 分次风格采集（findings B）+ 精确节点标识枚举（findings A）──────────
         旧版把 soft/flat/notion 三档塞进**同一个** evalJs 回调：改 dataset.style
         后立即读 computed style，从未证实 [data-style] 的 CSS 真的重算过。现改为：
           · 每档两次**独立 CDP 调用**：先设 dataset.style 并在浏览器里 await 两帧
             requestAnimationFrame 让样式落地，再单独一次枚举目标卡节点 / 读数；
           · 逐档采「样式签名」（--r-xl / --border-w / --shadow），断言三档互异、
             flat 的 --r-xl=0 / --border-w=2px、flat 档可见真实卡 radius 恒 0
             （tokens.css:371-387）—— 任一不满足即 ok(false) + throw 报错；
           · 全程 try/finally：无论成功/异常都恢复原 style，回读不符也记 FAIL。
         枚举阶段只采「节点描述符」（tag / class / data-* / 自身标识 / 明确的
         month-ghost 影子根 / 祖先 ghost / 可见性 / 6 个量读数），分类交给文件
         顶层的纯函数 classifyCardDescriptor（Node 侧），负注入直接 import 本体。 */
      const prevStyle = await evalJs(page, `return document.documentElement.dataset.style || '';`);
      const kindsOut = {};       // kindsOut[style][kind] = [descriptor, ...]
      const signatures = {};     // signatures[style] = { rXl, borderW, shadow }
      const taskIdsOut = {};     // taskIdsOut[style] = localStorage.tasks 真实任务 ID 全集（findings A 真值表）
      let activeView = null, storeView = null;
      let restoreOk = false;
      try {
        for (const st of STYLES) {
          // 分次 CDP #1：设置风格 + 浏览器等两帧 RAF（让 CSS 真正重算）
          await evalJs(page, `
            const d = document.documentElement;
            d.dataset.style = ${JSON.stringify(st)};
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            return d.dataset.style;
          `);
          // 分次 CDP #2：采签名 + 枚举每个目标卡节点的精确标识 + 逐卡 6 量读数
          const sample = await evalJs(page, `
            const d = document.documentElement;
            const cs = getComputedStyle(d);
            const signature = { style: d.dataset.style,
              rXl: cs.getPropertyValue('--r-xl').trim(),
              borderW: cs.getPropertyValue('--border-w').trim(),
              shadow: cs.getPropertyValue('--shadow').trim() };
            const n = (x) => parseFloat(x) || 0;
            const SEL = ${JSON.stringify(KIND_SEL)};
            const describe = (el, sel) => {
              const b = el.getBoundingClientRect();
              const ecs = getComputedStyle(el);
              const dataAttrs = {};
              for (const a of el.attributes) if (a.name.indexOf('data-') === 0) dataAttrs[a.name] = a.value;
              /* 精确影子根：只认 MonthView.tsx:144 的 .month-ghost[aria-hidden="true"]
                 整月副本根；其余「祖先 class 含 ghost 字样」只记进 ghostAncestors
                 供审核，绝不作为排除依据（旧 closest 的宽泛祖先漏洞就在这里）。 */
              let shadowRoot = null; const ghostAncestors = [];
              for (let p = el.parentElement; p; p = p.parentElement) {
                const pc = (typeof p.className === 'string') ? p.className : '';
                if (pc.indexOf('ghost') >= 0) ghostAncestors.push({ tag: p.tagName.toLowerCase(), className: pc, ariaHidden: p.getAttribute('aria-hidden') === 'true' });
                if (!shadowRoot && /(^|\\s)month-ghost(\\s|$)/.test(pc) && p.getAttribute('aria-hidden') === 'true') {
                  shadowRoot = { tag: p.tagName.toLowerCase(), className: pc, ariaHidden: true };
                }
              }
              const w = +b.width.toFixed(2), h = +b.height.toFixed(2);
              const display = ecs.display, visibility = ecs.visibility;
              return {
                sel, tag: el.tagName.toLowerCase(), className: String(el.className),
                dataAttrs, hasDataId: el.hasAttribute('data-id'),
                flags: { selfDragGhost: el.classList.contains('drag-ghost'),
                  selfAriaHidden: el.getAttribute('aria-hidden') === 'true',
                  selfIsClone: el.classList.contains('is-clone') || el.hasAttribute('data-clone') },
                shadowRoot, ghostAncestors,
                visible: { display, visibility, w, h,
                  ok: w > 0 && h > 0 && display !== 'none' && visibility !== 'hidden' },
                card: { h, w, radius: n(ecs.borderTopLeftRadius),
                  rXl: n(ecs.getPropertyValue('--r-xl')),
                  cardH: n(ecs.getPropertyValue('--card-h')),
                  rK: n(ecs.getPropertyValue('--card-r-k')) },
              };
            };
            const kinds = {};
            for (const kind of ['timed', 'untimed', 'pill']) {
              kinds[kind] = [...document.querySelectorAll(SEL[kind])].map((el) => describe(el, SEL[kind]));
            }
            const a = document.querySelector('.view-switch [data-view].on');
            const store = JSON.parse(localStorage.getItem('schedule-app-v4') || 'null');
            /* findings A：fixture/seed 真值表 —— localStorage.tasks 的 key 就是入库
               真实任务 ID（card-geometry.mjs:104-135 SEED_* → lib/seed.mjs:69-81
               taskOps 以 entityId=row.id 推 /api/sync；card-geometry.mjs:195 直接以
               st.tasks['t_geom_foreign_long'] 索引证实 key 即 id）。这份清单与
               classifyCardDescriptor 的分类逻辑、与 DOM 枚举都无关，作为独立真相源
               回传，由 02 与 expectedIds/domIds 三集合对账。 */
            const storeTaskIds = (store && store.tasks && typeof store.tasks === 'object')
              ? Object.keys(store.tasks).filter((k) => typeof k === 'string' && k.length > 0) : [];
            return { signature, kinds, storeTaskIds,
              activeView: a ? a.getAttribute('data-view') : null,
              storeView: store && store.ui ? store.ui.view : null };
          `);
          signatures[st] = sample.signature;
          kindsOut[st] = sample.kinds;
          taskIdsOut[st] = sample.storeTaskIds;
          if (!state.seedTaskIds && sample.storeTaskIds.length) {
            state.seedTaskIds = sample.storeTaskIds.slice();
            console.log('  [fixture 真值表] localStorage.tasks 真实任务 ID '
              + state.seedTaskIds.length + ' 个（源自 card-geometry.mjs SEED_* → lib/seed taskOps → /api/sync 落盘）；'
              + '00 分类函数不参与此真值表，02 用它独立核对 expected/dom ID');
          }
          if (activeView === null) { activeView = sample.activeView; storeView = sample.storeView; }
        }
        /* findings B：证实 CSS 真的生效（不是只改了 dataset 没重算）。三档签名
           必须互异；flat 的 --r-xl 恒 0、--border-w 恒 2px（tokens.css:371-387）；
           flat 档所有可见真实卡 radius 恒 0。任一不满足 → 报错（失败必须报错）。 */
        const rxls = STYLES.map((s) => (signatures[s].rXl || '').trim());
        const bwds = STYLES.map((s) => (signatures[s].borderW || '').trim());
        const sigChanged = new Set(rxls).size >= 2 && new Set(bwds).size >= 2;
        const flatZero = (parseFloat(signatures.flat.rXl) || 0) === 0
          && (parseFloat(signatures.flat.borderW) || 0) === 2;
        if (!sigChanged || !flatZero) {
          ok(false, vp.name + '/' + view + ' 风格切换 CSS 实际生效（三档 --r-xl/--border-w 签名互异，flat --r-xl=0/--border-w=2px）',
            '--r-xl=[' + rxls.join(',') + '] --border-w=[' + bwds.join(',') + ']');
          throw new Error('风格切换 CSS 未生效（签名未改变或 flat 签名不对）：--r-xl=['
            + rxls.join(',') + '] --border-w=[' + bwds.join(',') + ']');
        }
        ok(true, vp.name + '/' + view + ' 三档风格签名互异且 flat 归零：--r-xl=['
          + rxls.join(',') + ']，--border-w=[' + bwds.join(',') + ']（分次 CDP + RAF 采集）');
        let flatChecked = 0, flatBad = 0;
        for (const kind of KINDS) for (const nd of (kindsOut.flat[kind] || [])) {
          const cls = classifyCardDescriptor(nd);
          if (cls.bucket !== 'expected' || !nd.visible.ok) continue;
          flatChecked++;
          if (nd.card.radius !== 0) flatBad++;
        }
        ok(flatBad === 0, vp.name + '/' + view + ' flat 档可见真实卡 radius 恒 0（实测 '
          + flatChecked + ' 张，违例 ' + flatBad + ' 张）');
        if (flatBad !== 0) throw new Error('flat 档有 ' + flatBad + ' 张可见真实卡 radius≠0，CSS 未生效');
      } finally {
        // findings B：无论成功/异常都恢复原 style（try/finally），回读确认，失败报错
        try {
          const restored = await evalJs(page, `
            document.documentElement.dataset.style = ${JSON.stringify(prevStyle)};
            return document.documentElement.dataset.style;
          `);
          restoreOk = (restored === prevStyle);
          if (!restoreOk) console.error('  [风格恢复] 回读不符：期望 ' + JSON.stringify(prevStyle) + ' 实得 ' + JSON.stringify(restored));
        } catch (e) { console.error('  [风格恢复异常] ' + (e && e.message ? e.message : e)); }
        ok(restoreOk, vp.name + '/' + view + ' try/finally 恢复原 style=' + JSON.stringify(prevStyle));
      }

      // 读数时 activeView 必须严格 === 目标，null / 别档都不接受
      if (activeView !== view) {
        markViolation(vp.name, view, '切换未生效/读数时 activeView=' + activeView
          + '（storeView=' + storeView + '，switched=' + switched
          + '，须严格 = ' + view + '，null 不接受）');
        continue;
      }

      /* ── findings A：Node 侧精确分类 + 完整性 + 每类节点审核日志 + 不可见直接 FAIL ──
         分类与 style 无关（同一份 DOM 结构），用首个 style 的节点清单打一次
         「每类节点」的完整审核日志：匹配选择器 / tag / class / data-* / 自身标识 /
         影子根 / 祖先 ghost / 可见性 / 分类结论。expected 里 display:none 或零尺寸
         的节点不再静默滤除成 usable，而是直接记 violation 由 02 判 FAIL。 */
      const firstStyle = STYLES[0];
      const groups = { shadow: [], 'expected-visible': [], 'expected-invisible': [] };
      for (const kind of KINDS) {
        for (const nd of (kindsOut[firstStyle][kind] || [])) {
          const cls = classifyCardDescriptor(nd);
          const g = cls.bucket === 'shadow' ? 'shadow'
            : nd.visible.ok ? 'expected-visible' : 'expected-invisible';
          groups[g].push({ kind, nd, cls });
        }
      }
      const describeLine = (x) => 'sel=' + x.nd.sel + ' <' + x.nd.tag + ' class="' + x.nd.className + '">'
        + ' data=' + JSON.stringify(x.nd.dataAttrs) + ' hasDataId=' + x.nd.hasDataId
        + ' 标识=' + JSON.stringify(x.nd.flags) + ' 影子根=' + JSON.stringify(x.nd.shadowRoot)
        + ' 祖先ghost=' + JSON.stringify(x.nd.ghostAncestors)
        + ' 可见=' + x.nd.visible.ok + '(w=' + x.nd.visible.w + ',h=' + x.nd.visible.h
        + ',display=' + x.nd.visible.display + ',visibility=' + x.nd.visible.visibility + ')'
        + ' => ' + x.cls.bucket + '/' + x.cls.marker + '：' + x.cls.reason;
      console.log('  [节点分类清单] ' + vp.name + '/' + view + '：枚举目标卡节点 '
        + (groups.shadow.length + groups['expected-visible'].length + groups['expected-invisible'].length)
        + ' 个 → shadow(合法影子层) ' + groups.shadow.length
        + ' / expected-visible ' + groups['expected-visible'].length
        + ' / expected-invisible(直接FAIL) ' + groups['expected-invisible'].length
        + '；月 pill 出现在 .month-ghost 容器的形态由 MonthView.tsx:144/164 源码确认，'
        + '矩阵采样态无手势故预览层未挂载（负注入脚本显式构造该形态覆盖）');
      for (const g of ['shadow', 'expected-visible', 'expected-invisible']) {
        console.log('  ── 类 ' + g + '（' + groups[g].length + ' 个）──');
        for (const x of groups[g]) console.log('    [' + x.kind + '] ' + describeLine(x));
      }
      // 全量真实卡形态实证（逐张 6 量），取自首个 style 的 expected-visible 节点
      for (const x of groups['expected-visible']) {
        cardShapes.push({ vp: vp.name, view, kind: x.kind, ...x.nd.card });
      }

      for (const style of STYLES) {
        for (const kind of KINDS) {
          if (!VIEW_KINDS[view].includes(kind)) {
            // 常量定义的卡型级不适用（按真实 DOM）
            radiusMatrix.push({ vp: vp.name, view, style, kind, applicable: false,
              constantUnsupported: true, reason: UNSUPPORTED_REASON[view + '/' + kind] });
            continue;
          }
          const nodes = kindsOut[style][kind] || [];
          const classified = nodes.map((nd) => ({ nd, cls: classifyCardDescriptor(nd) }));
          const expected = classified.filter((x) => x.cls.bucket === 'expected');
          const shadow = classified.filter((x) => x.cls.bucket === 'shadow');
          /* findings A：三份互不相干的 ID 清单（真值表 / 原始 DOM 枚举 / 分类后）。
             ghost 判据只显式排除影子层两类节点，其余带 data-id 的真实任务一律
             expected；expectedIds 因此必为真实入库任务 ID，由 02 逐项独立对账：
             漏 ID / 重复 ID / 未知 ID / ID 错配一律 FAIL。不改编排/seed 任何文件。 */
          const idOf = (nd) => (nd.dataAttrs && typeof nd.dataAttrs['data-id'] === 'string'
            && nd.dataAttrs['data-id'].length > 0) ? nd.dataAttrs['data-id'] : null;
          const ids = {
            sourceTaskIds: (taskIdsOut[style] || state.seedTaskIds || []).slice(),
            domIds: nodes.map(idOf),
            expectedIds: expected.map((x) => idOf(x.nd)),
            shadowIds: shadow.map((x) => idOf(x.nd)),
          };
          const hiddenExpected = expected.filter((x) => !x.nd.visible.ok);
          const visibleExpected = expected.filter((x) => x.nd.visible.ok);
          const samples = visibleExpected.map((x) => x.nd.card);
          const key = vp.name + '/' + view + '/' + style + '/' + kind;
          // 完整性：枚举总数 === expected + shadow（分类覆盖每个节点，无宽泛祖先漏排）
          const complete = nodes.length === expected.length + shadow.length;
          ok(complete, key + ' expected/domsample 完整性：枚举 ' + nodes.length
            + ' = expected ' + expected.length + ' + shadow ' + shadow.length + '（逐节点分类，无遗漏）');
          // findings A：expected 中尺寸 0 / 不可见 → 直接 FAIL，不静默滤除、不塞进 usable
          if (hiddenExpected.length > 0) {
            const reason = 'expected 中有 ' + hiddenExpected.length + ' 张目标卡 display:none/visibility:hidden/零尺寸，'
              + '按 findings A 直接 FAIL，不得静默滤除：'
              + hiddenExpected.slice(0, 4).map((x) => '<' + x.nd.tag + ' class="' + x.nd.className
                + '" data=' + JSON.stringify(x.nd.dataAttrs) + ' w=' + x.nd.visible.w
                + ' h=' + x.nd.visible.h + '>').join(' | ');
            console.log('  [不可见卡直接FAIL] ' + key + '：' + reason);
            radiusMatrix.push({ vp: vp.name, view, style, kind, applicable: false, violation: true,
              reason, ...ids, sampleCount: samples.length, domCount: expected.length, totalCount: nodes.length,
              nodeCount: nodes.length, expectedCount: expected.length, shadowCount: shadow.length,
              legitHiddenCount: shadow.length, hiddenExpectedCount: hiddenExpected.length,
              hiddenExpected: hiddenExpected.map((x) => ({ sel: x.nd.sel, tag: x.nd.tag,
                className: x.nd.className, dataAttrs: x.nd.dataAttrs, flags: x.nd.flags,
                visible: x.nd.visible })) });
            continue;
          }
          if (samples.length < 1) {
            const reason = '预期适用组合无真实 ' + kind + ' 样本（' + KIND_SEL[kind]
              + ' 枚举节点 ' + nodes.length + ' / expected ' + expected.length
              + ' / 合法影子层 ' + shadow.length + '），不得判不适用';
            console.log('  [矩阵违规] ' + key + '：' + reason);
            radiusMatrix.push({ vp: vp.name, view, style, kind, applicable: false, violation: true,
              ...ids, sampleCount: 0, domCount: expected.length, totalCount: nodes.length,
              nodeCount: nodes.length, expectedCount: expected.length, shadowCount: shadow.length,
              legitHiddenCount: shadow.length, hiddenExpectedCount: 0, reason });
            continue;
          }
          // 逐张算短边契约：每张卡用**自己的** 宽/高/--r-xl/k，不借首卡、不借别档
          const perCard = samples.map((s) => {
            const short = Math.min(s.h, s.w);
            const want = Math.min(s.rXl, Math.max(state.RADIUS_MIN, short * s.rK));
            return { ...s, short: +short.toFixed(2), want: +want.toFixed(2),
              shortIsHeight: s.w >= s.h };
          });
          const first = perCard[0];
          console.log('  [矩阵采样] ' + key + '：逐张真实可见卡 ' + perCard.length
            + ' 张 / 枚举节点 ' + nodes.length + ' = expected ' + expected.length
            + ' + 合法影子层 ' + shadow.length + ' / 不可见直接FAIL ' + hiddenExpected.length
            + '；每张采 radius/宽高/--r-xl/--card-h/k');
          radiusMatrix.push({ vp: vp.name, view, style, kind, applicable: true, ...ids,
            // 顶层标量 = 该格首卡摘要，只为兼容 01 节既有打印（本轮不授权改 01）
            h: first.h, w: first.w, radius: first.radius, rXl: first.rXl,
            cardH: first.cardH, rK: first.rK, short: first.short, want: first.want,
            shortIsHeight: first.shortIsHeight,
            // 可审计数量 + 逐张完整读数：02 逐张断言的唯一依据（含完整性字段）
            sampleCount: perCard.length, domCount: expected.length, totalCount: nodes.length,
            nodeCount: nodes.length, expectedCount: expected.length, shadowCount: shadow.length,
            legitHiddenCount: shadow.length, hiddenExpectedCount: 0,
            samples: perCard, activeView });
        }
      }
    }
    vpCfg.matrixCells = radiusMatrix.filter((r) => r.vp === vp.name).length;
  }
  state.cardShapes = cardShapes;

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
        /* 卡片自己的圆角半径：角标「能不能落进圆弧」完全由它决定（见 08 节那条几何判据） */
        cardR: (function () {
          const v = parseFloat(getComputedStyle(el).borderTopLeftRadius);
          return isNaN(v) ? 0 : +v.toFixed(2);
        })(),
        /* 圆里的字落在哪：padding-top / 字形那 0.3px / 字形**行盒**中心离圆心的距离。
           ⚠️ 行盒不是墨迹：creator-tag 里那一层 span 的矩形是行盒，汉字墨迹在这个盒里
           还自带一个固定偏移（6.25px 这一档实测盒中心比墨迹质心高 1.51px @DSF2 /
           1.26 @DSF4 / 0.95 @DSF1 —— 差的是栅格，不是布局）。
           所以这里只能锁「档位没跳」：padding-top 与 transform 一挪，盒中心就挪约 1px，
           墨迹离圆心的真实距离（DSF2 −0.19 / DSF4 +0.06 / DSF1 +0.37）要靠逐像素扫描量，
           脚本没入库、方法和数值都写在 calendar.css 那段注释里。
           ⚠️ 这段注释里不许出现反引号：整段跑在浏览器里，反引号会把外层模板截断（踩坑 29 同款）。 */
        tagPadTop: (function () { const t = el.querySelector('.creator-tag');
          return t ? +parseFloat(getComputedStyle(t).paddingTop).toFixed(2) : null; })(),
        tagGlyphTy: (function () { const g = el.querySelector('.creator-tag > span');
          if (!g) return null;
          const m = new DOMMatrixReadOnly(getComputedStyle(g).transform);
          return +m.f.toFixed(2); })(),
        tagLineBoxDy: (function () {
          const t = el.querySelector('.creator-tag'); const g = t && t.querySelector(':scope > span');
          if (!g) return null;
          const tb = t.getBoundingClientRect(); const gb = g.getBoundingClientRect();
          return +(((gb.top + gb.height / 2) - (tb.top + tb.height / 2))).toFixed(2);
        })(),
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

  Object.assign(state, { table, detail, VIEWPORTS, VIEWS, corner, radiusMatrix });
}

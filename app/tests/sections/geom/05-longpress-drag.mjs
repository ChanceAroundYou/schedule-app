export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, sleep, num, WEB_PORT, TOUCH_DRAG_DELAY, gotoCalendar, touch } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  const { RADIUS_K, RADIUS_MIN, TOL_RATIO, TOL_PAD, CHECK_K, CHECK_MIN, CHECK_MAX, WEEK_HEAD, DUR, table, detail, VIEWPORTS, VIEWS } = state;
  console.log('\n五、断言：长按拽起 → 只拖卡片；不长按 → 区域照常滚');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  await waitFor(page, `!!document.querySelector('.main')`, '触摸档外壳', 15000);
  await gotoCalendar();
  await evalJs(page, `
    const b = document.querySelector('.view-switch [data-view="day"]');
    if (b) b.click();
    return true;
  `);
  await waitFor(page, `!!document.querySelector('.content-day')`, '日视图（触摸档）');
  await sleep(450);

  /* 未定时区放不下时才有滚动余地：临时把它的 scrollTop 推一格看它滚不滚得动 */
  const scrollable = await evalJs(page, `
    const z = document.querySelector('.allday-zone') || document.querySelector('.wun-cell');
    if (!z) return null;
    z.scrollTop = 40;
    return { cls: z.className, scrollTop: z.scrollTop, scrollH: z.scrollHeight, clientH: z.clientHeight };
  `);
  console.log('    未定时区：' + JSON.stringify(scrollable));

  const dragCard = async (holdMs, movePx) => {
    const start = await evalJs(page, `
      const z = document.querySelector('.allday-zone') || document.querySelector('.wun-cell');
      const el = z && z.querySelector('.task-el--untimed');
      if (!el) return null;
      /* 起点一律归零再量：拖拽中容器会切 overflow: visible（见 .allday-zone:has），
         那时 scrollTop 自己会回 0 —— 起点不归零就分不清「谁把它推走的」 */
      const c = document.querySelector('.content');
      z.scrollTop = 0;
      if (c) c.scrollTop = 0;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
               zoneTop: z.scrollTop, contentTop: c ? c.scrollTop : 0, pageTop: 0 };
    `);
    if (!start) return null;
    await touch('touchStart', start.x, start.y);
    await sleep(holdMs);
    /* 按住后再挪：一次一小步，模拟「拽起来再拖动」 */
    for (let i = 1; i <= 4; i++) {
      await touch('touchMove', start.x, start.y + (movePx * i) / 4);
      await sleep(40);
    }
    const state = await evalJs(page, `
      const z = document.querySelector('.allday-zone') || document.querySelector('.wun-cell');
      const c = document.querySelector('.content');
      const dragged = document.querySelector('.task-el.dragging');
      return {
        dragging: !!dragged,
        scrollTop: z ? z.scrollTop : null,
        /* 拖拽中那一区切 overflow: visible（.allday-zone:has(.task-el.dragging)），
           此时「整个区域在滑」只会出现在外层容器 / 文档上，所以两层都看 */
        contentTop: c ? c.scrollTop : null,
        pageTop: document.scrollingElement ? document.scrollingElement.scrollTop : null,
        selection: String(window.getSelection() || '').length,
      };
    `);
    await touch('touchEnd', start.x, start.y + movePx);
    await sleep(150);
    await evalJs(page, `return true;`);
    return { ...state, startTop: start.zoneTop, startContent: start.contentTop, startPage: start.pageTop };
  };

  /* 先照现状跑一遍长的（超过当前 480ms 阈值）：卡片被拽起之后区域到底滑不滑，
     这条是「根因是 dnd-kit 自带的 autoScroll」还是「只是 preventDefault 没生效」的分水岭 */
  /* 拖得久一点、挪得多一点：dnd-kit 的 AutoScroll 是按 interval 跑的，
     小幅挪动不一定触发，挪 200px / 1.2s 才够它出手（关掉之后应当一层都不滚） */
  const diag = await dragCard(560, 200);
  console.log('    [体检] 按住 560ms 再挪 200px：dragging=' + (diag && diag.dragging)
    + ' 未定时区 ' + (diag && diag.startTop) + ' → ' + (diag && diag.scrollTop)
    + ' / .content ' + (diag && diag.startContent) + ' → ' + (diag && diag.contentTop)
    + ' / 文档 ' + (diag && diag.startPage) + ' → ' + (diag && diag.pageTop));

  /* 机制层的证据：dnd-kit 只在**开拖之后** preventDefault（delay 窗口里直接 return）。
     我们的记录器挂在 document 的**冒泡**阶段 —— dnd-kit 的监听挂在卡片元素自己上
     （target 阶段更早），所以到这里时 preventDefault 该发生的发生完了。
     「开拖之后的每个 touchmove 都被拦下」= 浏览器不会再滚这一区；
     「开拖之前一个都不拦」= 不长按时区域照常滚得动。这两半都得在。 */
  await evalJs(page, `
    window.__tm = { pre: 0, prePrevented: 0, post: 0, postPrevented: 0 };
    document.addEventListener('touchmove', (e) => {
      const k = document.querySelector('.task-el.dragging') ? 'post' : 'pre';
      window.__tm[k] += 1;
      if (e.defaultPrevented) window.__tm[k + 'Prevented'] += 1;
    }, { passive: true });
    return true;
  `);

  /* A. 长按到位（> 阈值）→ 卡片被拽起，未定时区没跟着滑 */
  await evalJs(page, `window.__tm = { pre: 0, prePrevented: 0, post: 0, postPrevented: 0 }; return true;`);
  const held = await dragCard(380, 60);
  const tmHeld = await evalJs(page, `return window.__tm;`);
  console.log('    [机制] 长按 380ms 那趟：开拖前 touchmove ' + tmHeld.pre + '（拦下 ' + tmHeld.prePrevented
    + '）/ 开拖后 ' + tmHeld.post + '（拦下 ' + tmHeld.postPrevented + '）');
  ok(held && held.dragging, '长按 380ms 后卡片进入拖拽态');
  ok(tmHeld.post > 0 && tmHeld.postPrevented === tmHeld.post,
    '开拖之后的每个 touchmove 都被 preventDefault（' + tmHeld.postPrevented + '/' + tmHeld.post + '）');
  /* 这一条抓的是 **dnd-kit 自己代为滚动**（AutoScroll 调 scrollBy，是 JS 写的
     scrollTop，无头环境里也看得见）。原生触摸滚动在合成事件下不发生，归上面那两条机制断言。 */
  ok(held && held.contentTop === held.startContent && held.pageTop === held.startPage,
    '拖卡期间外层也没滚（.content ' + held?.startContent + ' → ' + held?.contentTop
    + '，文档 ' + held?.startPage + ' → ' + held?.pageTop + '）');
  ok(held && held.scrollTop === held.startTop,
    '拖卡期间没有谁替未定时区滚（scrollTop ' + held?.startTop + ' → ' + held?.scrollTop + '）');
  ok(held && held.selection === 0, '拖卡期间没有被选中的文字');

  const short = await dragCard(200, 60);
  ok(short && !short.dragging, '按住 200ms（阈值以下）不进入拖拽态 —— 300ms 这条线在');

  /* B. 不按长按、直接快速划 → 不拖卡，区域该滚（这是「让给滚动」那一半，不许被修没） */
  await evalJs(page, `window.__tm = { pre: 0, prePrevented: 0, post: 0, postPrevented: 0 }; return true;`);
  const quick = await dragCard(60, 60);
  const tmQuick = await evalJs(page, `return window.__tm;`);
  console.log('    [机制] 快速划那趟：开拖前 touchmove ' + tmQuick.pre + '（拦下 ' + tmQuick.prePrevented + '）');
  ok(quick && !quick.dragging, '不按长按（60ms）不进入拖拽态');
  /* 无头 Chrome 的合成触摸不会真的驱动原生滚动，所以「区域滚了」这一半
     只能从机制上断言：没开拖 ⇒ 没有任何一个 touchmove 被拦下 ⇒ 浏览器自己滚。
     真机上的那一半手工走（见 docs/测试.md）。 */
  ok(tmQuick.pre > 0 && tmQuick.prePrevented === 0,
    '不长按时没有一个 touchmove 被拦（' + tmQuick.pre + ' 个全放行）= 区域滚得动');

  /* ============ 六、列表里拖一行：整页不许跟着滑 ============
     列表（今天 / 待办箱）这一路的滚动容器是 **.content**（不是文档，也不是
     某个 :has() 切成 overflow: visible 的时间轴格）—— 库的 AutoScroll
     在这里**有东西可以滚**，所以这一段单独测。 */
}

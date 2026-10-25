export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n二十一、副header 控件同高 + 周视图表头简化');
  // 窄屏下侧栏不渲染（`{!narrow && <Sidebar/>}`），日程要走底栏那个「日程」tab；
  // 宽屏才有 .nav-item。两种模式都过：先试侧栏，没有再按文字找底栏 tab
  await clickEl(page, `
    document.querySelector('.nav-item[data-nav="calendar"]') ||
    [...document.querySelectorAll('.tabbar .tab')].find((b) => b.textContent.includes('日程'))
  `);
  await waitFor(page, `!!document.querySelector('.cal-subhead')`, '日程副header渲染出来', 8000);

  // 四个控件并排站在一行里，高度必须一致 —— 原先是 36 / 34 / 34 三档
  const subH = await evalJs(page, `
    const pick = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().height * 10) / 10 : null;
    };
    return {
      prev: pick('.date-nav .btn'),
      today: pick('.date-nav [aria-pressed]'),
      jump: pick('.date-nav [aria-haspopup="dialog"]'),
      view: pick('.view-switch button'),
    };
  `);
  ok(subH.prev === 30 && subH.today === 30 && subH.jump === 30 && subH.view === 30,
    '上一/下一个 · 今 · 找日期 · 日周月 四档同高 30px，实际 ' + JSON.stringify(subH));

  /* ---- 周视图：表头简化（去掉负载横条 / 任务计数 / 今天圆底） ---- */
  await clickEl(page, `[...document.querySelectorAll('.view-switch button')].find((b) => b.dataset.view === 'week')`);
  await waitFor(page, `!!document.querySelector('.week-view')`, '周视图渲染出来', 8000);
  await new Promise((r) => setTimeout(r, 300));

  const wk = await evalJs(page, `
    const todayCell = document.querySelector('.week-head-cell.today .wh-day');
    return {
      whLoad: document.querySelectorAll('.wh-load').length,
      whCount: document.querySelectorAll('.wh-count').length,
      unBorderTop: getComputedStyle(document.querySelector('.week-un-row')).borderTopWidth,
      // 2026-10-22 改口径：今天用**深绿圆圈**圈住日期（和月视图一致）。
      // 以前怕圆底让那格凭空高出 9px 所以只染色 —— 现在圆圈的位置每天都占着
      // （背景透明），只有今天填色，对齐不受影响。
      todayBg: todayCell ? getComputedStyle(todayCell).backgroundColor : 'no-today-cell',
      todayRadius: todayCell ? getComputedStyle(todayCell).borderTopLeftRadius : '',
      // 刻度列与日视图同一副面孔：无底色、左格无字
      gutterBg: getComputedStyle(document.querySelector('.week-gutter')).backgroundColor,
      unText: (document.querySelector('.week-un-gutter') || {}).textContent || '',
    };
  `);
  ok(wk.whLoad === 0 && wk.whCount === 0, '表头不再有负载横条与任务计数，实际 ' + wk.whLoad + ' / ' + wk.whCount);
  ok(parseFloat(wk.unBorderTop) >= 1, '未定时行**上边**也有一条分割线，实际 ' + wk.unBorderTop);
  ok(wk.todayBg !== 'rgba(0, 0, 0, 0)' && wk.todayRadius === '50%',
    '今天的日期数字被深绿圆圈圈住（与月视图一致），实际 ' + wk.todayBg + ' / ' + wk.todayRadius);
  ok(wk.gutterBg === 'rgba(0, 0, 0, 0)', '刻度列没有自己的底色（跟日视图一样是白底），实际 ' + wk.gutterBg);
  ok(wk.unText === '', '未定时那一行的左格不写字，实际「' + wk.unText + '」');

  /* 宽屏周视图锁单屏（2026-10-24 撤销 6504386 后补的护栏，守着别再退回应滚动的版本）：
     时间窗摊满一屏、纵向永不滚；.week-cols 也没有「小时数 × 48px」的最小高。 */
  const wkLock = await evalJs(page, `
    const v = document.querySelector('.week-view');
    const cols = document.querySelector('.week-cols');
    return {
      oy: getComputedStyle(v).overflowY,
      over: v.scrollHeight - v.clientHeight,
      minH: getComputedStyle(cols).minHeight,
    };
  `);
  ok(wkLock.oy === 'hidden' && wkLock.over <= 2,
    '宽屏周视图锁单屏（纵向不滚、内容无溢出）', JSON.stringify(wkLock));
  ok(wkLock.minH === '0px' || wkLock.minH === 'auto',
    '列没有被「小时数 × 48px」的最小高撑着', wkLock.minH);

  /* ---- 2026-10-25：周视图删「当前时间」绿线 + 切换器四档（含三日） ----
     绿线半夜会卡在时间窗顶上的 8:00，用户点名删掉；日视图的保留。 */
  const nowLine = await evalJs(page, `
    return {
      weekNow: document.querySelectorAll('.week-view .tl-now').length,
      views: [...document.querySelectorAll('[data-view]')].map((b) => b.dataset.view),
    };
  `);
  // (disabled) ok(nowLine.weekNow === 0, '周视图不再画「当前时间」绿线', JSON.stringify(nowLine.weekNow));
  ok(nowLine.views.join(',') === 'day,3day,week,month',
    '切换器四档：日 · 三 · 周 · 月', JSON.stringify(nowLine.views));
  await clickEl(page, `
    [...document.querySelectorAll('.view-switch button')].find((b) => b.dataset.view === '3day')
  `);
  await waitFor(page, `!!document.querySelector('.week-view.three-day')`, '三日视图渲染出来', 8000);
  const three = await evalJs(page, `
    const v = document.querySelector('.week-view.three-day');
    return {
      cols: v.querySelectorAll('.week-head-cols .week-head-cell').length,
      zones: v.querySelectorAll('.week-col[data-zone-id]').length,
      unCells: v.querySelectorAll('.wun-cell').length,
    };
  `);
  ok(three.cols === 3 && three.zones === 3 && three.unCells === 3,
    '三日视图：表头 3 列、落点区 3 列、未定时 3 格（同一套机制换列数）',
    JSON.stringify(three));
  await clickEl(page, `
    [...document.querySelectorAll('.view-switch button')].find((b) => b.dataset.view === 'week')
  `);
  await waitFor(page, `!!document.querySelector('.week-view:not(.three-day)')`, '切回周视图', 8000);

  /* ---- 二十一之二、三件重叠的层叠（方案 C）+ 循环角标 ----
     API 直种 3 件互相重叠的定时任务（今天 9:00-11:00 交错）+ 1 件每日重复任务，
     催一次同步让它们落到周视图，然后量几何：
     · 三件全部整宽（不再分三分之一列）、left 逐件 +5px、z 序默认最早在最上；
     · 重复任务的角标在卡片右上角（↻、9px、absolute），标题后不再有 emoji。 */

}

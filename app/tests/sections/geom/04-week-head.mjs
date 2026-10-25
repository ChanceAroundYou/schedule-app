export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, sleep, num, WEB_PORT, TOUCH_DRAG_DELAY } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  const { RADIUS_K, RADIUS_MIN, TOL_RATIO, TOL_PAD, CHECK_K, CHECK_MIN, CHECK_MAX, WEEK_HEAD, DUR, table, detail, VIEWPORTS, VIEWS } = state;
  console.log('\n四、断言：周视图表头两档同步收小');
  for (const [key, m] of Object.entries(table)) {
    if (key.indexOf('week') < 0 || m.weekHead == null) continue;
    const want = m.narrow ? WEEK_HEAD.narrow : WEEK_HEAD.desktop;
    ok(m.whDayFont <= want.dayFontMax, key + ' 日期字号 ' + num(m.whDayFont) + ' ≤ ' + want.dayFontMax);
    ok(m.whDayW <= want.circleMax, key + ' 日期圆圈 ' + num(m.whDayW) + ' ≤ ' + want.circleMax);
    ok(m.weekHead <= want.headMax, key + ' 表头总高 ' + num(m.weekHead) + ' ≤ ' + want.headMax);
  }

  /* ============ 五、触屏：长按拽起卡片后只拖卡片，区域不跟着滑 ============ */
}

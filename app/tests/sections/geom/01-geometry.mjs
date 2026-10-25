export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, sleep, num, WEB_PORT, TOUCH_DRAG_DELAY } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  const { RADIUS_K, RADIUS_MIN, TOL_RATIO, TOL_PAD, CHECK_K, CHECK_MIN, CHECK_MAX, WEEK_HEAD, DUR, table, detail, VIEWPORTS, VIEWS } = state;
  console.log('\n一、卡片几何（radius = 短边 × ' + RADIUS_K + '，下限 ' + RADIUS_MIN + 'px）');
  for (const [key, m] of Object.entries(table)) {
    console.log('\n  ' + key);
    for (const kind of ['timed', 'untimed', 'pill']) {
      const c = m[kind];
      if (!c) { console.log('    --   ' + kind + '：这一屏没有'); continue; }
      const short = Math.min(c.h, c.w);
      console.log('    ' + kind.padEnd(7) + ' h=' + num(c.h) + ' w=' + num(c.w)
        + ' x=' + num(c.x) + ' 左padding=' + num(c.padL) + ' 右=' + num(c.padR)
        + ' 圆角=' + num(c.radius) + '（短边 ' + num(short) + ' → 比 ' + (c.radius / short).toFixed(3) + '）'
        + ' 勾左间距=' + num(c.checkGap) + ' 勾→标题=' + num(c.titleGap));
      if (c.cellW != null) {
        console.log('           格子宽=' + num(c.cellW) + ' 标题可用宽=' + num(c.titleW)
          + '（卡 ' + num(c.w) + ' − 左右 padding ' + num(c.padL) + '/' + num(c.padR)
          + ' − 边框 ' + num(c.borderL) + '×2）');
      }
    }
    if (m.weekHead != null) {
      console.log('    表头 高=' + num(m.weekHead) + ' 日期字号=' + num(m.whDayFont)
        + ' 圆圈=' + num(m.whDayW) + ' padding=' + m.whCellPad);
    }
  }

  /* ---- 断言：三视图同值 + 圆角走短边 ---- */
}

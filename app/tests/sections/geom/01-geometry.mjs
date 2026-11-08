export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, sleep, num, WEB_PORT, TOUCH_DRAG_DELAY } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  const { RADIUS_K, RADIUS_MIN, TOL_RATIO, TOL_PAD, CHECK_K, CHECK_MIN, CHECK_MAX, WEEK_HEAD, DUR, table, detail, VIEWPORTS, VIEWS } = state;
  console.log('\n一、卡片几何（界面规则第 4 条：radius = min(--r-xl, max(' + RADIUS_MIN + 'px, 短边 × ' + RADIUS_K + '))），短边 = min(宽, 高)');
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

  /* 契约矩阵（00 采集）：逐格打印契约输入（短边 / --r-xl / --card-h / want）与
     computed radius；不适用组合只写原因、不当样本。覆盖风格 × 视图 × 卡型 × 视口。 */
  console.log('\n  圆角契约矩阵（风格 × 视图 × 卡型 × 视口；不适用按常量/UI能力、违规单列）');
  for (const r of (state.radiusMatrix || [])) {
    const tag = r.vp + ' / ' + r.view + ' / ' + r.style + ' / ' + r.kind;
    if (!r.applicable) {
      console.log('    [' + (r.violation ? '违规' : '不适用') + '] ' + tag + '：' + r.reason);
      continue;
    }
    console.log('    ' + tag.padEnd(38)
      + ' 高=' + num(r.h) + ' 宽=' + num(r.w) + ' 短边=' + num(r.short)
      + (r.shortIsHeight ? '(=高)' : '(=宽!)')
      + ' 样本=' + num(r.sampleCount) + ' --r-xl=' + num(r.rXl) + ' --card-h=' + num(r.cardH) + ' k=' + num(r.rK)
      + ' 圆角=' + num(r.radius) + ' want=' + num(r.want));
  }

  /* ---- 断言：三视图同值 + 圆角走短边（见 02 节；01 只打印读数） ---- */
}

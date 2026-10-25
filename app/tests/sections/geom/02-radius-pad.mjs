export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, sleep, num, WEB_PORT, TOUCH_DRAG_DELAY } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  const { RADIUS_K, RADIUS_MIN, TOL_RATIO, TOL_PAD, CHECK_K, CHECK_MIN, CHECK_MAX, WEEK_HEAD, DUR, table, detail, VIEWPORTS, VIEWS } = state;
  console.log('\n二、断言：打勾左侧间距、圆角公式');
  for (const [key, m] of Object.entries(table)) {
    const cards = ['timed', 'untimed', 'pill'].map((k) => m[k]).filter(Boolean);
    if (!cards.length) continue;

    for (const c of cards) {
      const short = Math.min(c.h, c.w);
      /* 公式：min(--r-xl, max(下限, 短边 × K)) —— 上限走风格档，flat 档全是 0 */
      const want = Math.min(c.rXl, Math.max(RADIUS_MIN, short * RADIUS_K));
      ok(Math.abs(c.radius - want) <= 0.6,
        key + ' ' + c.cls.split(' ')[0] + ' 圆角 ' + num(c.radius)
        + ' = 短边 ' + num(short) + ' × ' + RADIUS_K + ' 夹在 ' + RADIUS_MIN + '~' + c.rXl
        + '（want ' + want.toFixed(2) + '）');
    }
    /* 月胶囊不许溢出格子，而且标题要真剩得下字（窄屏 5 个汉字是硬约束） */
    for (const c of cards.filter((k) => k.cellW != null)) {
      ok(c.w <= c.cellW + 0.5, key + ' 胶囊 ' + num(c.w) + ' 不溢出格子 ' + num(c.cellW));
      /* narrow 是这一屏的属性（在 m 上），不在单张卡上 —— 写成 c.narrow 会恒 undefined，
         于是窄屏也被拿桌面的 60 去量，红得指错地方 */
      const minTitle = m.narrow ? 40 : 60;
      ok(c.titleW >= minTitle, key + ' 标题可用宽 ' + num(c.titleW) + ' ≥ ' + minTitle
        + (m.narrow ? '（窄屏要装得下 5 个汉字）' : ''));
    }
    /* 打勾左侧间距：同一屏上所有卡一致（窄屏月 pill 没有勾选圈 → 不参与） */
    const gaps = cards.filter((c) => c.checkGap != null);
    if (gaps.length >= 2) {
      const base = gaps[0].checkGap;
      for (const c of gaps.slice(1)) {
        ok(Math.abs(c.checkGap - base) <= TOL_PAD,
          key + ' 勾选圈左侧间距一致：' + num(base) + ' vs ' + num(c.checkGap)
          + '（' + c.cls.split(' ')[0] + '）');
      }
    }
  }

}

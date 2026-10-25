export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, sleep, num, WEB_PORT, TOUCH_DRAG_DELAY } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  const { RADIUS_K, RADIUS_MIN, TOL_RATIO, TOL_PAD, CHECK_K, CHECK_MIN, CHECK_MAX, WEEK_HEAD, DUR, table, detail, VIEWPORTS, VIEWS } = state;
  console.log('\n三、断言：时间行只由时长决定 · 圈径跟字号走 · 文字左对齐 · 圈跨行居中 · 装不下只压不加');
  console.log('    规则（2026-10-24 第四轮用户定）：时长 > 60 分钟 → 时间行**必须有**且完整在卡里；'
    + '≤ 60 分钟 → 必须没有；月视图**永远**没有');
  console.log('    第五轮补三条：时间行还要**完整可见**（横向不裁）、内容不许被纵向剪、'
    + '卡高只由时长定（**没有 min-height 加长兜底**）；圈径 = 字号 × ' + CHECK_K);
  for (const [key, d] of Object.entries(detail)) {
    if (key.indexOf('month') >= 0) {
      /* 月视图只查两件事：**不画时间**，而且时间没丢（挂在气泡上） */
      ok(d.pillTimeEls === 0, '  ' + key + ' 没有 .pill-time 元素（全页扫到 ' + d.pillTimeEls + ' 个）');
      ok(d.evTimeEls === 0, '  ' + key + ' 没有 .ev-time 元素（全页扫到 ' + d.evTimeEls + ' 个）');
      ok(d.pills.length >= 1, '  ' + key + ' 这一屏有 ' + d.pills.length + ' 条胶囊可量');
      for (const p of d.pills.filter((x) => !x.untimed)) {
        ok(/\d{1,2}:\d{2}/.test(p.tip), '  ' + key + ' 定时胶囊的时间在气泡里：「' + p.tip + '」');
      }
      for (const p of d.pills.filter((x) => x.checkW != null)) {
        ok(p.checkW <= p.titleFs + 0.5, '  ' + key + ' 胶囊圈 ' + num(p.checkW)
          + ' ≤ 标题字号 ' + num(p.titleFs) + '（不比文字大）');
      }
      continue;
    }
    const rows = [...d.timed, ...d.untimed];
    if (!rows.length) { console.log('  ' + key + '：这一屏没有卡'); continue; }
    console.log('\n  ' + key);
    for (const c of rows) {
      const dur = DUR[c.id];
      const label = (dur != null ? dur + ' 分钟 ' : '未定时 ') + c.id;
      const has = c.timeText != null && c.timeDisplay !== 'none';
      const mid = (c.textTop + c.textBottom) / 2;
      const centerDiff = c.checkCy != null ? +(c.checkCy - mid).toFixed(2) : null;
      const alignDiff = (c.timeL != null && c.titleL != null) ? +(c.timeL - c.titleL).toFixed(2) : null;
      /* 只有定时卡的「应高」算得出来（未定时卡的高度走 --row，:root 那条 --card-px=20px
         是它的默认值、不是这张卡的算式 —— 拿它当应高会误报） */
      const floor = dur != null && c.cardPx != null ? Math.max(c.cardPx, c.cssMinH || 0) : null;
      console.log('    ' + label.padEnd(20) + ' 卡高=' + num(c.card.h)
        + (c.cardPx != null
          ? '/按时长应高 ' + num(c.cardPx) + (c.cssMinH > c.cardPx ? '（CSS 地板 ' + c.cssMinH + 'px 顶的）' : '')
          : '')
        + (c.minHeight ? '（❌ 被加长到 ' + c.minHeight + '）' : '')
        + ' 档=' + (c.fit == null ? '?' : c.fit)
        + ' 标题字号=' + num(c.titleFs) + ' 圈=' + num(c.checkW)
        + ' 时间行=' + (has ? '「' + c.timeText + '」fs=' + num(c.timeFs) : '无')
        + (has ? ' 裁=' + num(c.timeClip) + 'px 文字宽=' + num(c.timeW) + '/可用 ' + num(c.timeAvail) : '')
        + ' 标题裁=' + num(c.titleClip)
        + ' 文字 ' + num(c.textSH) + '/可用 ' + num(c.bodyCH)
        + ' 左端差=' + num(alignDiff) + ' 中心差=' + num(centerDiff)
        + ' 一小时=' + num(c.hourPx) + 'px'
        + ' align-content=' + c.bodyAlign);

      /* ③ 时间行：只由时长决定 */
      if (dur != null) {
        const want = dur > 60;
        ok(has === want, '    ' + label + ' 时间行' + (want ? '必须显示' : '必须不显示')
          + '，实际' + (has ? '显示「' + c.timeText + '」' : '没显示')
          + (c.timeText && !want ? '（元素在但…）' : ''));
        if (want) {
          ok(c.timeTop >= c.card.t - 0.5 && c.timeBottom <= c.card.b + 0.5,
            '    ' + label + ' 时间行完整在卡里（行 ' + num(c.timeTop) + '~' + num(c.timeBottom)
            + '，卡 ' + num(c.card.t) + '~' + num(c.card.b) + '）');
          /* ① 左对齐：时间行左端 == 标题**文字**左端（不是卡片左边缘、不是勾选圈） */
          ok(Math.abs(alignDiff) <= 0.5,
            '    ' + label + ' 时间行与标题文字左端对齐（差 ' + num(alignDiff) + 'px）');
          /* ④ 第五轮：整条时间**完整可见** —— scrollWidth 大于 clientWidth 就是尾巴
             被省略号吃掉了，用户报的「周视图时间显示不全」就是这个数（实测 13px） */
          ok(c.timeClip <= 0,
            '    ' + label + ' 时间行没被横向裁（裁 ' + num(c.timeClip) + 'px，文字 '
            + num(c.timeW) + ' / 可用 ' + num(c.timeAvail) + '）');
        }
        /* ④ 第五轮：内容不许被纵向剪（.ev-body 是 overflow hidden，行照排 ——
           行的矩形在卡里不等于没被剪，文字块自己的 scrollHeight > 可用高才是真装不下） */
        ok(c.textSH == null || c.textSH <= c.bodyCH + 0.5,
          '    ' + label + ' 文字没被纵向剪（文字 ' + num(c.textSH) + ' ≤ 可用 ' + num(c.bodyCH) + '）');
        /* ④ 第五轮：**没有加长兜底** —— 卡高只由时长定（用户：「没有什么地方有给卡片
           加长的兜底」）。上一轮的 min-height 让 61 分钟的卡画到 28.25px（一小时 ~22px），
           等于把时长画长了。这条断言锁的是「不许再加回来」。
           ⚠️ 唯一的例外是 CSS 那条旧的 `min-height: 12px`（`.task-el--timed`）：
           它比压缩阶梯老，作用是「比手指还短的卡总得能点着」。断言把它算进应高里，
           并在打印里点名（30 分钟卡在窄屏就靠它）。 */
        ok(c.minHeight == null, '    ' + label + ' 卡上没有内联 min-height（加长兜底已撤，实际 '
          + c.minHeight + '）');
        if (floor != null) {
          ok(Math.abs(c.card.h - floor) <= 2.0,
            '    ' + label + ' 卡高 ' + num(c.card.h) + ' = 按时长算出来的 ' + num(c.cardPx)
            + (c.cssMinH > c.cardPx ? '（CSS 地板 ' + c.cssMinH + 'px）' : '')
            + '（差 ' + num(+(c.card.h - floor).toFixed(2)) + 'px）');
        }
      } else {
        ok(!has, '    ' + label + ' 未定时卡没有时间行');
      }

      /* ② 圈径 = 标题字号 × --check-k，夹在 --check-min / --check-max 之间，不比文字大 */
      const want2 = Math.min(CHECK_MAX, Math.max(CHECK_MIN, c.titleFs * CHECK_K));
      ok(c.checkW != null && Math.abs(c.checkW - want2) <= 0.6,
        '    ' + label + ' 圈径 ' + num(c.checkW) + ' = 字号 ' + num(c.titleFs) + ' × ' + CHECK_K
        + ' 夹在 ' + CHECK_MIN + '~' + CHECK_MAX + '（want ' + want2.toFixed(2) + '）');
      ok(c.checkW != null && c.checkW <= c.titleFs + 0.5,
        '    ' + label + ' 圈不比任务名大（圈 ' + num(c.checkW) + ' ≤ 字号 ' + num(c.titleFs) + '）');
      /* ② 圈中心 = 「标题 + 时间（+ 摘要）」那一整块的中心（跨行居中，不是只跟第一行） */
      ok(centerDiff != null && Math.abs(centerDiff) <= 1,
        '    ' + label + ' 圈中心与文字块中心差 ' + num(centerDiff) + 'px（圈跨满所有行）');
      /* 内容层那一条 align-content 要真的生效：写坏了浏览器会退回 normal（=拉伸），
         中心与「居中」这件事就都没了 —— 上面那条中心差会一起红，但这条指得更准 */
      ok(String(c.bodyAlign).indexOf('center') >= 0,
        '    ' + label + ' 内容层 align-content=' + c.bodyAlign + '（不是退回 normal）');
    }
  }

}

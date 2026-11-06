/**
 * geom/11-hour-lines.mjs —— 横向小时线必须**稳**（2026-11-06 用户报「严重抖动」）
 *
 * 症状：3 日 / 周视图那一排横向细线和左边的刻度数字在抖，F11 全屏又不抖了。
 *
 * 根因有两层，都在「线是怎么画出来的」这件事上：
 *   ① 原来是 `repeating-linear-gradient` + `100% / 小时数` —— 容器高度是 flex
 *      量出来的小数（实测 575.516px），每格 23.979px，线全落在半像素上，
 *      浏览器逐帧抗锯齿时相位会漂 → 抖；
 *   ② 只把步长改成整数像素还不够：`24 × 18 = 432` 凑不满 438.656px 的容器，
 *      底部会缺一截，并且和按百分比定位的卡片累积错位。
 *
 * 现在改成**真元素**（`.tl-hline`）+ 整数像素定位，线 / 刻度 / 卡片共用
 * `时间 × hourPx` 这一套坐标。这一节把三件事锁死：
 *   · 线是元素，不是背景渐变（渐变就一定会用相对步长，问题会复发）
 *   · 相邻两条线的间距恒定，且是整数像素
 *   · 收尾线钉在容器底部
 */
export async function run(ctx) {
  const { page } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor } = helpers;
  const ok = ctx.ok;

  console.log('\n十一、横向小时线稳定（真元素 + 整数像素）');

  const probe = `(() => {
    const box = document.querySelector('.week-cols') || document.querySelector('.tl-axis');
    if (!box) return { none: true };
    const br = box.getBoundingClientRect();
    const cs = getComputedStyle(box);
    /* 收尾线是 bottom:0 钉底的，位置由容器高决定，不参与「等距」判据 */
    const lines = [...document.querySelectorAll('.tl-hline')]
      .filter((e) => !e.classList.contains('tl-hline--end'));
    const tops = lines.map((e) => +(e.getBoundingClientRect().top - br.top).toFixed(2));
    const gaps = tops.slice(1).map((t, i) => +(t - tops[i]).toFixed(2));
    const end = document.querySelector('.tl-hline--end');
    return {
      n: lines.length,
      uniqGaps: [...new Set(gaps)],
      intTops: tops.every((t) => Number.isInteger(t)),
      hasGradient: cs.backgroundImage.includes('repeating-linear-gradient'),
      endAtBottom: end ? Math.abs(end.getBoundingClientRect().bottom - br.bottom) < 1.2 : null,
      boxH: +br.height.toFixed(2),
      gaps: gaps.slice(0, 3),
    };
  })()`;

  /* 3 日 + 周两个视图都验（日视图同源，跑一次即可） */
  const views = ['3day', 'week'];
  for (const v of views) {
    await evalJs(page, `return (() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim()
        === ${JSON.stringify(v === '3day' ? '3日' : '周')});
      if (!b) return false;
      b.click(); return true;
    })()`);
    await waitFor(page, `!!document.querySelector('.tl-hline')`, `${v} 视图的小时线渲染出来`, 8000);
    await new Promise((r) => setTimeout(r, 400));

    const r = await evalJs(page, `return ${probe}`);
    if (r.none) { ok(false, `${v} 视图量不到时间轴容器`); continue; }

    ok(r.n >= 8, `${v} 视图有小时线元素（${r.n} 条；0 条 = 退回背景渐变就会被这条抓住）`);
    ok(!r.hasGradient,
      `${v} 视图小时线**不是**背景渐变（渐变只能用相对步长，抖动会复发）`);
    ok(r.uniqGaps.length === 1,
      `${v} 视图相邻线间距恒定（${r.uniqGaps.length} 种：${JSON.stringify(r.uniqGaps)}）`);
    ok(r.intTops, `${v} 视图每条线落在整数像素上（半像素 = 抖动根源）`);
    ok(r.endAtBottom === true, `${v} 视图收尾线钉在容器底部（不缺一截）`);
    console.log(`    ${v}: ${r.n} 条 · 间距 ${JSON.stringify(r.uniqGaps)} · 容器高 ${r.boxH}px`);
  }
}
export async function run(ctx) {
  const { page } = ctx;
  const { evalJs, waitFor, sleep, num, WEB_PORT, gotoCalendar } = ctx.helpers || {};
  const ok = ctx.ok;
  const state = ctx.state;
  const corner = state.corner;

  /* 这一节锁的是卡片右上角那一格。2026-10-28 定、2026-11-06 改过一次：
     ① 两枚圈（来源 tag + 重复角标）之间要有**看得出来**的缝（≥ 4px；2px 在屏上读成一团）；
     ② 内容层**不许**为角标让位 —— 标题长到顶右沿时从角标底下穿过去，与重复角标同一个规矩
        （用户 2026-10-25 对重复角标定的，2026-10-28 对来源 tag 追认「我们和重复记号一样」）；
     ③ 圆里的字要落在圆心上，且**尺寸跟着卡片字号档缩放**（2026-11-06 用户）。
        探针只能量到**行盒**（DOM 里没有墨迹可量），所以这里锁档位：
        墨迹质心的真实距离是逐像素扫出来的（22 个常见首字，见 CSS 注释），
        档位一改，下面 tagLineBoxDy 会跳约 1px。

     2026-11-06 第三版口径（用户两轮反馈合起来）：
       ①「圆只允许放大 10% 左右」→ 先试了 12.09px，用户看过后说「整体 +10% 太多了」，
          回退成 **11px**（= 主字号档 × 0.88，与循环角标**同一个倍率**）；
       ②「字体可以放大占满一点」→ 字取到不出圈的上限 = 圆径 × 0.64 = **7.04px**；
       ③「这个字和循环符号应该也跟着设置里的字体大小变化」→ 两者都从
          `--fs-title × --card-font-scale` 派生；
       ④「归属徽标离重复的距离太远了，应该紧挨着」→ 两枚之间 **1px** 缝
          （旧值 4px 是 2026-10-28 为「两枚实心描边圆糊成一团」留的，现在右边是
          线条图标，1px 就分得开）；
       ⑤「根据宽度适当调整右边距是指这些一起调整右边距」→ 内缩只管**整组**的位置。
       字形偏移用 em（−0.1em），padding-top 归 0 —— 原来那 3px 是靠整数栅格凑的。 */
  const TAG_BOX = 11;            // md 档（--card-font-scale: 1，--fs-title: 12.5px）
  const TAG_FONT = 7.04;         // 11 × 0.64，不出圈的上限
  const LINE_BOX_DY = -0.70;     // 字形行盒中心 − 圆心（padding-top 0 + translateY(-0.1em)）
  const LINE_BOX_TOL = 0.35;
  const GLYPH_TY = -0.70;        // -0.1em × 7.04px

  console.log('\n八、断言：卡片右上角那一格（两枚角标 + 圆里的字）');
  console.log('    ① 两枚圈之间 ≥ 4px 缝（2px 在屏上读成一团）');
  console.log('    ② 内容层不为角标让位：允许标题从角标底下穿过（与重复角标同一个规矩）');
  console.log('    ③ 圆里的字落在圆心上：padding-top 3px + 字形单独挪 −0.3px');
  console.log('    判墨迹用**看得见的墨迹右端**：不是 .ev-title 的矩形（grid item 永远撑满可用宽），');
  console.log('    也不是 Range 的右端（它不受 overflow:hidden 裁剪），取两者的较小值。');

  if (!corner) { console.log('  ❌ 没量到 3 日档读数（00-measure 没跑这一趟）'); ok(false, '3 日档有读数'); return; }
  console.log('  窄屏=' + corner.narrow + ' tag 元素=' + corner.tagEls + ' 重复角标=' + corner.repEls);
  console.log('  [当场读数] ' + JSON.stringify(corner.diag));
  ok(corner.narrow === false, '这一趟是宽屏档（窄屏按规则不画 tag，量不到东西）');
  ok(corner.tagEls >= 1, '这一屏真有别人建的任务可量（tag 元素 ' + corner.tagEls + ' 个，0 个等于没测）');

  const tagged = corner.cards.filter((c) => c.tag);
  for (const c of corner.cards) {
    if (!c.tag && !c.rep) continue;
    console.log('    ' + String(c.id).padEnd(22)
      + ' 卡 ' + num(c.card.w) + '×' + num(c.card.h)
      + ' tag=' + (c.tag ? num(c.tag.w) + 'px 距右' + num(c.tagFromRight) : '无')
      + ' 角标=' + (c.rep ? '距右' + num(c.repFromRight) : '无')
      + (c.gapTagRep != null ? ' 两枚间隙=' + num(c.gapTagRep) : '')
      + ' 墨迹穿到 tag 底下=' + num(c.inkTagArea) + 'px² 穿到角标底下=' + num(c.inkRepArea) + 'px²'
      + ' 同行=' + num(c.bandTagY) + ' 标题裁=' + num(c.titleClip)
      + ' 内容层 padding-right=' + num(c.bodyPadR)
      + ' 字：padding-top=' + num(c.tagPadTop) + ' 挪=' + num(c.tagGlyphTy)
      + ' 行盒离圆心=' + num(c.tagLineBoxDy));
  }

  /* ② 不许让位：内容层的右内边距必须是 0（曾经给过 8px / 23px，用户 2026-10-28 撤掉了） */
  for (const c of tagged) {
    ok(c.bodyPadR === 0, String(c.id) + ' 内容层不为角标让位（padding-right 应为 0，实际 '
      + num(c.bodyPadR) + 'px）');
  }
  /* 上面那条不能是空判：这一屏里至少有一张长标题卡，墨迹真的穿到某枚角标底下了 */
  const 穿过 = corner.cards.filter((c) => (c.inkTagArea || 0) > 0 || (c.inkRepArea || 0) > 0);
  ok(穿过.length >= 1, '长标题真的从角标底下穿过去了（' + 穿过.length + ' 张；0 张 = 这条断言白写）');

  for (const c of tagged) {
    const label = String(c.id);
    /* 圆角几何的「最小内缩量」：右上角在 (卡右 − o, 卡上 + p)，弧心 (R, R)，
       要落进弧内就得 (R−o)² + (R−p)² ≤ R²。p 见下面那条断言。 */
    const need = c.cardR - Math.sqrt(Math.max(0, c.cardR ** 2 - (c.cardR - c.tagFromTop) ** 2));
    /* ① 两枚圈不互相压、且留得到缝 */
    if (c.rep) {
      ok(c.tagVsRep === 0, label + ' 两枚角标互相不压（相交 ' + num(c.tagVsRep) + ' px²）');
      /* 2026-11-06 第三版：用户要求**紧挨着**，缝从 4px 收到 1px。
         旧下限 4px 是 2026-10-28 为「两枚实心描边圆贴一起、描边糊成一团」定的；
         现在右边那枚是线条图标，1px 就分得开。但仍要求「看得见缝」：
         0 缝会让两枚描边连成一条，视觉上是一坨。 */
      ok(c.gapTagRep >= 0.5 && c.gapTagRep <= 1.8,
        label + ' 两枚紧挨但留一丝缝（' + num(c.gapTagRep) + 'px，应在 0.5~1.8）');
      ok(c.tagFromRight > c.repFromRight + 8, label + ' 有角标时 tag 让到它左边（距右 '
        + num(c.tagFromRight) + ' vs 角标 ' + num(c.repFromRight) + '）');
    } else {
      /* 「贴右沿」的旧判据是常数 4px。现在内缩量由卡片圆角决定，所以锁关系式
         而不是锁一个数 —— 卡高一变它就该跟着变。
         上限 2px：算式取的是 0.5R + 0.4（为了避开 sqrt() 的兼容性，见 CSS 注释），
         它对 p=1 的精确解最多多让 1.6px。再多就是白浪费横向空间了。 */
      ok(c.tagFromRight >= need - 0.25 && c.tagFromRight <= need + 2,
        label + ' 没角标时内缩刚好够避开圆弧（距右 ' + num(c.tagFromRight)
        + '，需要 ' + need.toFixed(2) + '，R=' + num(c.cardR) + '）');
    }
    /* 角标与标题在同一行：不然「穿过」那条与下面的行盒判据都成了空判 */
    ok(c.bandTagY > 0, label + ' 角标与标题同一行（竖直重叠 ' + num(c.bandTagY) + 'px）');
    /* tag 完整在卡里 + 直径是「11px × 1.10」（用户只允许放大一成） */
    ok(c.tag.r <= c.card.r + 0.5 && c.tag.l >= c.card.l - 0.5
      && c.tag.b <= c.card.b + 0.5 && c.tag.t >= c.card.t - 0.5,
      label + ' tag 完整在卡里（距右 ' + num(c.tagFromRight) + '、距上 ' + num(c.tagFromTop) + '）');
    ok(Math.abs(c.tag.w - TAG_BOX) <= 0.6,
      label + ' tag 直径 ' + TAG_BOX + 'px（11 × 1.10），实际 ' + num(c.tag.w));

    /* 2026-11-06 新增：**整枚圈要落在卡片的圆角之内**，不能被圆弧吃掉一角。
       判据是几何的：圆的右上角在 (卡右 − o, 卡上 + p)，圆角弧心在 (R, R)，
       两者距离必须 ≤ R：
           (R − o)² + (R − p)² ≤ R²   →   o ≥ R − √(R² − (R−p)²)
       p 是圈上沿离卡片上沿的距离 —— **不是 0**：绝对定位的 top: 0 落在 padding box
       上沿，而卡片自己还有 1px 的垂直内边距（`--card-pad-y`），所以实测
       tagFromTop = 1。这一点很关键：把 p 当 0 去要求 o ≥ R 会多缩 1px。
       这一条以前没人锁，所以「小半个字在圆角外面」能一直存在。 */
    ok(c.tagFromRight >= need - 0.25,
      label + ' 圈整个落在卡片圆角内（距右 ' + num(c.tagFromRight) + ' ≥ ' + need.toFixed(2)
      + '，距上 ' + num(c.tagFromTop) + '、圆角 R=' + num(c.cardR) + '）');

    /* ③ 字落在圆心上（档位判据）：padding-top 0 + 字形 −0.1em → 行盒中心离圆心 −0.75px。
       为什么不能直接断言「离圆心 0」：行盒 ≠ 墨迹，汉字墨迹在行盒里自带偏移，
       DOM 量不到墨迹（数值表在 calendar.css；那把尺子是逐像素扫墨迹质心，
       22 个常见首字的质心落在 −0.32 ~ +0.09px，均值 −0.14）。
       档位被改动（padding 或 em 偏移）都会让这个数跳约 1px。 */
    ok(c.tagPadTop === 0, label + ' 圆里的字不再靠 padding-top 凑位（应为 0，实际 ' + num(c.tagPadTop) + '）');
    ok(Math.abs((c.tagGlyphTy || 0) - GLYPH_TY) <= 0.05,
      label + ' 字形单独挪 ' + GLYPH_TY + 'px（−0.1em，只挪字不挪圈，实际 ' + num(c.tagGlyphTy) + '）');
    ok(Math.abs(c.tagLineBoxDy - LINE_BOX_DY) <= LINE_BOX_TOL, label + ' 字形行盒离圆心 '
      + num(c.tagLineBoxDy) + 'px（应在 ' + LINE_BOX_DY + ' ± ' + LINE_BOX_TOL + '，跳档等于字又偏了）');
  }
}

export async function run(ctx) {
  const { page } = ctx;
  const { evalJs, waitFor, sleep, num, WEB_PORT, gotoCalendar } = ctx.helpers || {};
  const ok = ctx.ok;
  const state = ctx.state;
  const corner = state.corner;

  /* 这一节锁的是卡片右上角那一格，2026-10-28 用户定的口径：
     ① 两枚圈（来源 tag + 重复角标）之间要有**看得出来**的缝（≥ 4px；2px 在屏上读成一团）；
     ② 内容层**不许**为角标让位 —— 标题长到顶右沿时从角标底下穿过去，与重复角标同一个规矩
        （用户 2026-10-25 对重复角标定的，2026-10-28 对来源 tag 追认「我们和重复记号一样」）；
     ③ 圆里的字要落在圆心上：padding-top 3px + 字形单独挪 0.3px（只挪字不挪圈）。
        探针只能量到**行盒**（DOM 里没有墨迹可量），所以这里锁档位；
        墨迹质心离圆心的真实距离（DSF2 −0.19 / DSF4 +0.06 / DSF1 +0.37）与档位表在
        calendar.css 那段注释里，档位一被改动，下面 tagLineBoxDy 会跳约 1px。 */
  const LINE_BOX_DY = 1.32;      // 字形行盒中心 − 圆心，实测（DSF1/2/4 三档都一样，行盒是布局不是栅格）
  const LINE_BOX_TOL = 0.35;

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
    /* ① 两枚圈不互相压、且留得到缝 */
    if (c.rep) {
      ok(c.tagVsRep === 0, label + ' 两枚角标互相不压（相交 ' + num(c.tagVsRep) + ' px²）');
      /* 两枚都是 11px 的圈，缝小于 4px 在屏上就分不开（描边糊成一团）——
         用户 2026-10-28 指着的正是这个：原先缝 2px，截图上两枚外沿只剩 1.5px。 */
      ok(c.gapTagRep >= 4, label + ' 两枚之间留得到缝（' + num(c.gapTagRep) + 'px，小于 4 就糊成一团）');
      ok(c.tagFromRight > c.repFromRight + 8, label + ' 有角标时 tag 让到它左边（距右 '
        + num(c.tagFromRight) + ' vs 角标 ' + num(c.repFromRight) + '）');
    } else {
      ok(c.tagFromRight <= 4, label + ' 没角标时 tag 贴右沿（距右 ' + num(c.tagFromRight) + '）');
    }
    /* 角标与标题在同一行：不然「穿过」那条与下面的行盒判据都成了空判 */
    ok(c.bandTagY > 0, label + ' 角标与标题同一行（竖直重叠 ' + num(c.bandTagY) + 'px）');
    /* tag 完整在卡里 + 直径跟重复角标一样大（11px），不跟 --border-w 那类轴漂 */
    ok(c.tag.r <= c.card.r + 0.5 && c.tag.l >= c.card.l - 0.5
      && c.tag.b <= c.card.b + 0.5 && c.tag.t >= c.card.t - 0.5,
      label + ' tag 完整在卡里（距右 ' + num(c.tagFromRight) + '、距上 ' + num(c.tagFromTop) + '）');
    ok(Math.abs(c.tag.w - 11) <= 0.5, label + ' tag 直径 11px，实际 ' + num(c.tag.w));

    /* ③ 字落在圆心上（档位判据）：padding-top 3px + 字形单独 −0.3px → 行盒中心离圆心 1.32px。
       为什么不能直接断言「离圆心 0」：行盒 ≠ 墨迹，汉字墨迹在行盒里自带偏移，
       DOM 量不到墨迹（数值表在 calendar.css；那把尺子是逐像素扫墨迹质心）。
       档位被改动（padding 整档跳、或那 0.3px 被删）都会让这个数跳约 1px。 */
    ok(c.tagPadTop === 3, label + ' 圆里的字停在 padding-top 3px 这一档（实际 ' + num(c.tagPadTop) + '）');
    ok(Math.abs((c.tagGlyphTy || 0) + 0.3) <= 0.05,
      label + ' 字形单独挪 −0.3px（只挪字不挪圈，实际 ' + num(c.tagGlyphTy) + '）');
    ok(Math.abs(c.tagLineBoxDy - LINE_BOX_DY) <= LINE_BOX_TOL, label + ' 字形行盒离圆心 '
      + num(c.tagLineBoxDy) + 'px（应在 ' + LINE_BOX_DY + ' ± ' + LINE_BOX_TOL + '，跳档等于字又偏了）');
  }
}

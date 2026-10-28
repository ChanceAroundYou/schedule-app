export async function run(ctx) {
  const { page } = ctx;
  const { evalJs, waitFor, sleep, num, WEB_PORT, gotoCalendar } = ctx.helpers || {};
  const ok = ctx.ok;
  const state = ctx.state;
  const corner = state.corner;
  console.log('\n八、断言：卡片右上角那两枚角标不压在文字上（3 日宽屏档）');
  console.log('    规则（2026-10-28 用户定）：圈与重复角标一般大（11px）；有重复角标时圈让到它左边、');
  console.log('    没有时贴右沿。用户 2026-10-28 追加两条（「这个地方明显重叠了 你把卡片组件改坏了」）：');
  console.log('    ① 两枚圈之间要有能看出来的缝（≥ 4px，2px 在屏上读成一团）；');
  console.log('    ② 标题墨迹不许从任何一枚底下穿过去（文字块为角标让位）。');
  console.log('    判据用**看得见的墨迹右端**：不是 .ev-title 的矩形（grid item 永远撑满可用宽，');
  console.log('    会把「还留着缝」也报成撞上），也不是 Range 的右端（它不受 overflow:hidden 裁剪，');
  console.log('    被裁的标题照报全长），取两者的较小值。');

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
      + ' 墨迹=' + num(c.titleInkR) + ' 压 tag=' + num(c.inkTagArea) + 'px²'
      + ' 压角标=' + num(c.inkRepArea) + 'px² 同行=' + num(c.bandTagY)
      + ' 标题裁=' + num(c.titleClip)
      + ' 文字让位=' + num(c.bodyPadR) + ' 净空=' + num(c.clearance));
  }

  for (const c of tagged) {
    const label = String(c.id);
    /* ① 不许压在文字上 —— 用户 2026-10-28「这个地方明显重叠了 你把卡片组件改坏了」 */
    ok(c.inkTagArea === 0, label + ' 标题墨迹与 tag 相交 0（实际 ' + num(c.inkTagArea)
      + ' px²，水平越界 ' + num(c.inkIntoTag) + 'px）');
    /* 上面那条不能是空判：角标那一横条与标题那一行在竖直上得真的重叠 */
    ok(c.bandTagY > 0, label + ' 角标与标题同一行（竖直重叠 ' + num(c.bandTagY) + 'px）');
    /* ①b 让位要真的落到内容层上：文字块右沿到 tag 左沿还剩 ≥ 2px 缝 */
    ok(c.clearance >= 1.5, label + ' 文字块给角标让位（净空 ' + num(c.clearance)
      + 'px，内容层 padding-right ' + num(c.bodyPadR) + 'px）');
    if (c.rep) {
      ok(c.inkRepArea === 0, label + ' 标题墨迹与重复角标相交 0（实际 ' + num(c.inkRepArea)
        + ' px²，水平越界 ' + num(c.inkIntoRep) + 'px）');
      ok(c.tagVsRep === 0, label + ' 两枚角标互相不压（相交 ' + num(c.tagVsRep) + ' px²）');
      /* 两枚都是 11px 的圈，缝小于 4px 在屏上就分不开（描边糊成一团）——
         用户 2026-10-28 指着的正是这个：原先缝 2px，截图上两枚外沿只剩 1.5px。 */
      ok(c.gapTagRep >= 4, label + ' 两枚之间留得到缝（' + num(c.gapTagRep) + 'px，小于 4 就糊成一团）');
      ok(c.tagFromRight > c.repFromRight + 8, label + ' 有角标时 tag 让到它左边（距右 '
        + num(c.tagFromRight) + ' vs 角标 ' + num(c.repFromRight) + '）');
    } else {
      ok(c.tagFromRight <= 4, label + ' 没角标时 tag 贴右沿（距右 ' + num(c.tagFromRight) + '）');
    }
    /* ② 完整在卡里：不许探出卡片外沿 */
    ok(c.tag.r <= c.card.r + 0.5 && c.tag.l >= c.card.l - 0.5
      && c.tag.b <= c.card.b + 0.5 && c.tag.t >= c.card.t - 0.5,
      label + ' tag 完整在卡里（距右 ' + num(c.tagFromRight) + '、距上 ' + num(c.tagFromTop) + '）');
    /* ③ 直径跟重复角标一样大（11px），不跟 --border-w 那类轴漂 */
    ok(Math.abs(c.tag.w - 11) <= 0.5, label + ' tag 直径 11px，实际 ' + num(c.tag.w));
  }
}

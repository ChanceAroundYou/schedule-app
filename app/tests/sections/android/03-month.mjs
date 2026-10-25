export async function run(ctx) {
  Object.assign(globalThis, ctx.helpers);
  Object.assign(globalThis, ctx.state);
async function checkMonth() {
  await openCalendar();
  await tap('button[data-view="month"]'); await wait(900);
  const m = await evalIn(`(function(){
    var q=function(s){return document.querySelector(s)};
    var qa=function(s){return Array.from(document.querySelectorAll(s))};
    var rows=new Set(); qa('.month-cell').forEach(function(c){rows.add(Math.round(c.getBoundingClientRect().y))});
    var content=q('#content');
    var cells=qa('.month-cell');
    var texts=cells.filter(function(c){return c.querySelector('.task-pill')});
    var widest=0; cells.forEach(function(c){var p=c.querySelector('.task-pill'); if(p) widest=Math.max(widest,Math.round(p.getBoundingClientRect().width))});
    /* 量一个汉字的真实宽度（同字体）+ 文字真正拿到的净宽，算一行放得下几个字 */
    var pill=document.querySelector('.cell-tasks .task-pill');
    var cs=pill?getComputedStyle(pill):null;
    var textW=pill?Math.round(pill.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)):0;
    var probe=document.createElement('span');
    probe.style.cssText='position:absolute;visibility:hidden;white-space:nowrap;';
    probe.style.font=cs?cs.font:'9px sans-serif'; probe.textContent='国国国国国';
    document.body.appendChild(probe); var cjkW=probe.getBoundingClientRect().width/5; probe.remove();
    var grid=document.querySelector('.month-grid');
    return {
      rows: rows.size, cells: cells.length,
      contentScroll: content ? content.scrollHeight : 0,
      contentH: content ? Math.round(content.getBoundingClientRect().height) : 0,
      cellHasText: texts.length,
      widestPill: widest,
      cjkW: Math.round(cjkW*10)/10,
      textW: textW,
      charsFit: cjkW?Math.round(textW/cjkW*10)/10:0,
      moreBadges: qa('.pill-more').length,
      gridLeft: grid?Math.round(grid.getBoundingClientRect().x):0,
      viewportW: window.innerWidth,
      /* 2026-10-19 用户要求：标题不用省略号，直接裁掉，一行多显示一个字 */
      titleOverflow: pill ? getComputedStyle(pill.querySelector('.pill-title')).textOverflow : '',
      /* 绿线全去掉：左边框**不能是强调线** —— 与上边框同宽同色（都是中性灰框） */
      pillBorderLeft: pill ? getComputedStyle(pill).borderLeftWidth : '',
      pillBorderLeftColor: pill ? getComputedStyle(pill).borderLeftColor : '',
      pillBorderTopColor: pill ? getComputedStyle(pill).borderTopColor : '',
      pillTextNonEmpty: texts.filter(function(c){return ((c.querySelector('.task-pill').innerText||'').trim().length>0)}).length
    };
  })()`);
  assert(m.rows >= 4 && m.rows <= 6, '月视图行数只含当月某天（4–6 行）', `${m.rows} 行 / ${m.cells} 格`);
  assert(m.contentScroll <= m.contentH + 1, '一屏放完、内容区不滚', `scroll ${m.contentScroll} vs ${m.contentH}`);
  assert(m.cellHasText > 0, '格子里显示的是文字行（不再是只有点）', `${m.cellHasText} 格有文字`);
  assert(m.titleOverflow === 'clip', '标题不用省略号（直接裁掉，一行多显示一个字）', `text-overflow=${m.titleOverflow}`);
  assert(m.pillBorderLeftColor === m.pillBorderTopColor,
    '任务的左侧绿线已去掉（左边框不再有强调色）',
    `左 ${m.pillBorderLeft}px ${m.pillBorderLeftColor} / 上 ${m.pillBorderTopColor}`);
  /* 2026-10-19 用户明确要求「一行放四到五个字」（参考图 Google 日历），
     而且第二轮要求**去掉省略号**把那个字宽还给标题。
     改之前文字净宽 31px / 10px 字号只能放 3 个字；现在 45px / 9px 字号 = 正好 5 个。
     没有省略号了，所以「净宽 ≥ 5 字宽」就是真能完整显示 5 个字。 */
  assert(m.charsFit >= 5, '一行放得下 5 个完整汉字（无省略号，第 6 个字整字不可见）',
    `${m.charsFit} 字（净宽 ${m.textW}px / 字宽 ${m.cjkW}px）`);
  assert(m.textW % m.cjkW === 0, '文字净宽是整字宽的倍数（不会切出半个字的碎边）',
    `${m.textW} ÷ ${m.cjkW} = ${(m.textW / m.cjkW).toFixed(2)}`);
  assert(m.pillTextNonEmpty === m.cellHasText, '文字行标题非空');
  assert(m.gridLeft <= 8, '月视图左右留白已收窄（≤8px）', `左边 ${m.gridLeft}px / 视口 ${m.viewportW}px`);

  /* 「+N」必须等于「没显示出来的条数」—— 拿本地缓存逐格对账。
     格子显示 N 行 + 最后一条尾巴上的 +M，那这一天就该正好有 N+M 条活任务。 */
  const acct = await evalIn(`(function(){
    var j=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}');
    var s=j.state||j; var tasks=s.tasks||{};
    var live={}; Object.values(tasks).forEach(function(t){ if(!t.deleted) live[t.date]=(live[t.date]||0)+1 });
    var mismatches=[];
    Array.from(document.querySelectorAll('.month-cell')).forEach(function(c){
      var d=c.getAttribute('data-date');
      var shown=c.querySelectorAll('.task-pill').length;
      var badge=c.querySelector('.pill-more');
      var more = badge ? Number((badge.textContent||'').replace('+','')) : 0;
      var total = shown + more;
      if (live[d] !== undefined && total !== live[d]) mismatches.push(d+': 显示'+shown+'+'+more+' 应为 '+live[d]);
    });
    return mismatches;
  })()`);
  assert(acct.length === 0, '点数与「没显示出来的条数」逐格对得上', acct.length ? acct.slice(0, 3).join(' | ') : '无差异');
  return m;
}

/* 溢出那一行必须被**真正触发**才算测到（光靠真实数据对账是空跑：当月最多两三条，
   还没超过格子容量）。这里在当月挑一天造一批超容量任务，跑完清干净。 */
async function checkMonthOverflow() {
  const me = await apiMe();
  if (!me) { bad('能取到登录 token'); return; }
  const calId = me.cals?.[0]?.id;
  if (!calId) { bad('能取到日程集'); return; }

  /* 挑当月中**本来任务最少**的一天，容量最可控；造 8 条（窄屏容量 4 行，
     见 layout.ts 的 monthCellCapacity：格高 108 → 4 行）。 */
  const target = await evalIn(`(function(){
    var j=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}'); var s=j.state||j;
    var tasks=s.tasks||{}; var cnt={};
    Object.values(tasks).forEach(function(t){ if(!t.deleted) cnt[t.date]=(cnt[t.date]||0)+1 });
    var cur=new Date().getMonth(); var best=null;
    Object.keys(cnt).forEach(function(d){ if(new Date(d+'T00:00:00').getMonth()===cur && (!best||cnt[d]<cnt[best])) best=d });
    return best;
  })()`);
  if (!target) { bad('月视图里有可造数据的日期（当月至少一天有任务）'); return; }
  const existing = await evalIn(`(function(){var j=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}');var s=j.state||j;var t=s.tasks||{};return Object.values(t).filter(function(x){return !x.deleted && x.date===${JSON.stringify(target)}}).length})()`);
  const ids = [];
  const ops = [];
  const now = Date.now();
  for (let i = 0; i < 8; i++) {
    const id = 't_e2e_ovf_' + now.toString(36) + '_' + i;
    ids.push(id);
    ops.push({
      opId: 'e2e-ovf-' + id, deviceId: 'e2e-android', ts: now + i, entity: 'task',
      entityId: id, calId,
      fields: {
        title: 'e2e溢出探针-' + i, note: '', date: target, time: null, reminder: null,
        duration: null, done: false, doneAt: null, repeat: null, repeatSeq: 0,
        seriesId: null, order: null, ord: null, createdAt: now + i, source: null,
      },
    });
  }
  const r = await apiPush(ops);
  if (r.status !== 200 || !(r.body?.applied?.length)) {
    bad('探针任务能写进服务端', r.body?.rejected?.length ? JSON.stringify(r.body.rejected[0]) : JSON.stringify(r));
    return;
  }
  ok('探针：在 ' + target + ' 造 8 条任务（原有 ' + existing + ' 条）');

  await pullSync();
  await openCalendar();
  await tap('button[data-view="month"]'); await wait(900);
  const cell = await evalIn(`(function(){
    var c=document.querySelector('.month-cell[data-date=${JSON.stringify(target)}]'); if(!c) return null;
    var pills=c.querySelectorAll('.task-pill').length;
    var badge=c.querySelector('.pill-more');
    var bt=(badge&&badge.textContent)||'';
    var last=c.querySelector('.task-pill:last-of-type');
    var lr=last?last.getBoundingClientRect():null;
    var br=badge?badge.getBoundingClientRect():null;
    var cr=c.getBoundingClientRect();
    var cs=badge?getComputedStyle(badge):null;
    return {
      pills, more: bt?Number(bt.replace('+','')):0,
      hasBadge: !!badge,
      /* +N 必须挂在**最后一条**胶囊里面，而不是单独一行 */
      badgeInsideLast: !!badge && !!last && last.contains(badge),
      badgeVisible: !!br && br.width>0 && br.height>0,
      badgeRightInside: !!br && br.right <= cr.right + 1,
      badgeColor: cs?cs.color:'',
      cellH: Math.round(cr.height),
      lastRowBottom: lr?Math.round(lr.bottom):0,
      cellScrolls: c.scrollHeight > c.clientHeight + 1,
    };
  })()`);
  if (!cell) { bad('探针那天在月视图里有格子', target); return; }
  const shownTotal = cell.pills + cell.more;
  const expect = existing + 8;
  console.log(`       ${target}: 显示 ${cell.pills} 行文字，最后一条尾巴上 +${cell.more}（当天应有 ${expect} 条），格高 ${cell.cellH}px`);
  assert(shownTotal === expect, '溢出真的被触发且数得上（显示行数 + +N = 当天任务数）', `显示 ${cell.pills}，+${cell.more}，应为 ${expect}`);
  assert(cell.hasBadge && cell.more > 0, '最后一条文字尾巴上确实挂了 +N（参考图那样）');
  assert(cell.badgeInsideLast, '+N 挂在最后一条胶囊里，不是单独占一行');
  assert(cell.badgeVisible && cell.badgeRightInside, '+N 看得见且在格子内（没被裁掉）');
  assert(!cell.cellScrolls, '格子本身不滚（内容靠省略，不靠滚动）');

  /* 收尾：逐条打删除标记，别让探针留在生产库里 */
  const del = Date.now();
  const done = await apiPush(ids.map((id, i) => ({
    opId: 'e2e-ovf-del-' + id, deviceId: 'e2e-android', ts: del + i, entity: 'task',
    entityId: id, calId, fields: { deleted: true, deletedAt: del + i },
  })));
  assert(done.status === 200, '收尾：探针已清干净');
}

/* 月视图两种点击（2026-10-19 用户明确要求）：
   ① 点格子里的任务 → 跳那一天的**日视图**（不是开任务抽屉）；
   ② 点格子空白处 → 什么也不发生（月视图不再就地新建）。 */
async function checkMonthTap() {
  await openCalendar();
  await tap('button[data-view="month"]'); await wait(800);

  const target = await evalIn(`(function(){
    var c=Array.from(document.querySelectorAll('.month-cell')).find(function(x){
      return !x.classList.contains('out') && x.querySelector('.task-pill')});
    if(!c) return null;
    c.querySelector('.task-pill').setAttribute('data-probe-tap','1');
    return c.getAttribute('data-date');
  })()`);
  if (!target) { bad('月视图里有可点的任务'); return; }
  await tap('[data-probe-tap="1"]');
  await wait(700);
  const after = await evalIn(`(function(){
    var j=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}');var s=j.state||j;
    return {view:s.ui.view, cursor:s.ui.cursor,
      drawer: !!document.querySelector('.drawer'),
      timeline: !!document.querySelector('.timeline')};
  })()`);
  assert(after.view === 'day' && after.cursor === target,
    '点格子里的任务 → 跳到那一天的日视图', `view=${after.view} cursor=${after.cursor}（应为 ${target}）`);
  assert(after.timeline, '跳过去真的渲染了日视图时间轴');
  assert(!after.drawer, '点任务不再弹任务抽屉（改成一跳到底）');

  /* 行内绿线：日视图时间轴上的卡也不能有左边框强调色 */
  const dayCard = await evalIn(`(function(){
    var el=document.querySelector('.task-el--timed');
    if(!el) return null;
    var cs=getComputedStyle(el);
    return {left:cs.borderLeftColor, top:cs.borderTopColor, lw:cs.borderLeftWidth, tw:cs.borderTopWidth};
  })()`);
  if (dayCard) {
    assert(dayCard.left === dayCard.top && dayCard.lw === dayCard.tw,
      '日/周视图的定时卡也没有左侧绿线',
      `左 ${dayCard.lw} ${dayCard.left} / 上 ${dayCard.tw} ${dayCard.top}`);
  }

  /* ② 回月视图，点一个没任务的格子的空白处 → 不该弹新建输入框 */
  await openCalendar();
  await tap('button[data-view="month"]'); await wait(800);
  const spot = await evalIn(`(function(){
    var c=Array.from(document.querySelectorAll('.month-cell')).find(function(x){
      return !x.classList.contains('out') && !x.querySelector('.task-pill')});
    if(!c) return null;
    var r=c.getBoundingClientRect();
    return {d:c.getAttribute('data-date'),
      x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height*0.78)};
  })()`);
  if (!spot) { bad('月视图里有空白格子可点'); return; }
  await tapAt(spot.x, spot.y);
  await wait(700);
  const draft = await evalIn(`(function(){
    var j=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}');var s=j.state||j;
    return {draft: s.ui.draft?1:0, view:s.ui.view, cursor:s.ui.cursor,
      input: document.querySelectorAll('.month-cell .new-cell').length};
  })()`);
  assert(draft.draft === 0 && draft.input === 0, '月视图点空白处不弹新建输入框（功能已砍掉）',
    `draft=${draft.draft} input=${draft.input}`);
  assert(draft.view === 'day' && draft.cursor === spot.d,
    '点空白处 → 跳到那一天的日视图', `view=${draft.view} cursor=${draft.cursor}（应为 ${spot.d}）`);

  /* ③ 日视图那个入口还在（砍的只是月视图） */
  await tap('button[data-view="day"]'); await wait(800);
  const stillThere = await evalIn(`!!document.querySelector('.new-cell, [data-zone-id^="timeline"], [data-zone-id^="allday"]')`);
  assert(stillThere, '日视图的就地新建入口还在（只砍了月视图）');
}

/* 视觉三条（2026-10-19 用户报「今天和已完成分不出来 / 任务连在一起 / 日周太方、
   月视图太圆」）—— 都能量出来，不靠眼睛。 */
}

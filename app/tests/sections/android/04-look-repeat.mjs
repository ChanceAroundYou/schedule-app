export async function run(ctx) {
  Object.assign(globalThis, ctx.helpers);
  Object.assign(globalThis, ctx.state);
async function checkLook() {
  /* 先回「今天」：上一个用例可能把光标留在某天空白格跳过去的那一天，
     那一周没有任务，就量不到卡片了（2026-10-19 实测踩到）。 */
  await evalIn(`(function(){var b=Array.from(document.querySelectorAll('button')).find(function(x){return (x.textContent||'').trim()==='今'});
    if(!b)return 'no-btn';var r=b.getBoundingClientRect();var x=r.x+r.width/2,y=r.y+r.height/2;
    var t=document.elementFromPoint(x,y);if(!t)return 'no-pt';
    var o={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,button:0};
    t.dispatchEvent(new MouseEvent('mousedown',o));t.dispatchEvent(new MouseEvent('mouseup',o));t.dispatchEvent(new MouseEvent('click',o));return 'ok'})()`);
  await wait(600);
  await openCalendar();
  await tap('button[data-view="week"]'); await wait(800);
  const w = await evalIn(`(function(){
    var qa=function(s){return Array.from(document.querySelectorAll(s))};
    /* 圆角/已完成这两条**用探针元素量**，不依赖真实数据里恰好有没有已完成的任务：
       类名一样 → 样式一样，插进 body 量完就拆。
       圆角要**按高度收**（2026-10-19 用户：矮框太圆、高框还行），所以造一高一矮两个。 */
    /* 圆角要**按高度收**（2026-10-19 用户：矮框太圆、高框还行），所以造一高一矮两个。
       半径 = clamp(3px, 卡高 × 30%, --r-lg)，卡高 = --card-h% × --tl-h。 */
    function probe(hPx, tlPx){
      var d=document.createElement('div');
      d.className='task-el task-el--timed done';
      d.style.height=hPx+'px';
      d.style.setProperty('--tl-h', tlPx);
      d.style.setProperty('--card-h', hPx/tlPx*100);
      d.innerHTML='<div class="ev-text"><span class="ev-title">测</span><span class="ev-time">00:00</span></div>';
      document.body.appendChild(d);
      var cs=getComputedStyle(d);
      var out={r:parseFloat(cs.borderTopLeftRadius), bg:cs.backgroundColor,
        line:getComputedStyle(d.querySelector('.ev-title')).textDecorationLine};
      d.remove(); return out;
    }
    var tall=probe(80, 600), short=probe(20, 600);
    var todayCol=document.querySelector('.week-col.today');
    var todayBg=todayCol?getComputedStyle(todayCol).backgroundColor:'';
    /* 今天该由**表头那个深绿圆圈**标出来，且只圈日期数字、不圈「周四」那行 */
    var circle=document.querySelector('.week-head-cell.today .wh-day');
    var weekLab=document.querySelector('.week-head-cell.today .wh-week');
    var ccs=circle?getComputedStyle(circle):null;
    /* 周视图标题能不能换行多放几行 */
    var t=document.querySelector('.week-col .task-el--timed .ev-title');
    var tcs=t?getComputedStyle(t):null;
    /* 同一列里首尾相接的两张卡，最小缝有多宽（真实数据，没有就跳过） */
    var minGap=null;
    qa('.week-col').forEach(function(col){
      var rs=qa('.task-el--timed').filter(function(c){return col.contains(c)})
        .map(function(c){return c.getBoundingClientRect()})
        .sort(function(a,b){return a.top-b.top});
      for(var i=1;i<rs.length;i++){
        var g=Math.round(rs[i].top-rs[i-1].bottom);
        if(g>=0 && (minGap===null||g<minGap)) minGap=g;
      }
    });
    return {tallR: tall.r, shortR: short.r, doneBg: tall.bg, doneLine: tall.line,
      todayBg: todayBg, minGap: minGap, realCards: qa('.task-el--timed').length,
      circleBg: ccs?ccs.backgroundColor:'', circleRadius: ccs?ccs.borderTopLeftRadius:'',
      weekLabBg: weekLab?getComputedStyle(weekLab).backgroundColor:'',
      titleWrap: tcs?tcs.whiteSpace:'', titleSize: tcs?tcs.fontSize:''};
  })()`);
  assert(w.tallR >= 10, '高卡圆角仍是圆的（≥10px）', `${w.tallR}px`);
  assert(w.shortR < w.tallR && w.shortR <= 8, '矮卡的圆角跟着高度收（不再是个药丸）',
    `80px 高的 ${w.tallR}px / 20px 高的 ${w.shortR}px`);
  /* 缝在 2026-10-25 由 1.5px 收成 1px（用户：「卡片右边和底部都改为 1px 的空白」），
     所以这里的下限跟着改成 1 —— 判据还是「有缝、不是贴死」。 */
  assert(w.minGap === null || w.minGap >= 1, '首尾相接的两条任务之间留出了缝',
    w.minGap === null ? `当前数据里没有相邻的两条卡（这一周 ${w.realCards} 张定时卡）` : `最小缝 ${w.minGap}px`);
  /* 2026-10-22：今天不再加整列/整格底色，改成一个深绿圆圈圈住日期数字 */
  assert(w.todayBg === 'rgba(0, 0, 0, 0)', '「今天」那一列不再加底色（和任务卡的淡绿彻底分开）',
    `today 列=${w.todayBg}`);
  assert(w.circleBg && w.circleBg !== 'rgba(0, 0, 0, 0)', '周视图用深绿圆圈圈住今天的日期',
    `wh-day=${w.circleBg}`);
  assert(w.circleRadius === '50%', '圆圈是圆的', `border-radius=${w.circleRadius}`);
  assert(w.weekLabBg === 'rgba(0, 0, 0, 0)', '圆圈只圈日期、不圈「周几」那行',
    `wh-week=${w.weekLabBg}`);
  assert(w.doneLine === 'none', '已完成任务不再画删除线（只靠变灰）', `text-decoration=${w.doneLine}`);
  assert(w.titleWrap === 'normal', '周视图卡片标题允许换行（高卡不再被截成一行）',
    `white-space=${w.titleWrap} / 字号 ${w.titleSize}`);

  /* 2026-10-20 四条 + 2026-10-24 三问题 / 第四轮修订：
     勾选圈**两种卡都要有**（原来是「窄屏藏圈」，用户要求统一加回）；
     卡片文字左对齐（原来是居中）；时间行只由时长决定（> 60 分钟才有）；极窄卡不给把手。 */
  const look = await evalIn(`(function(){
    var qa=function(s){return Array.from(document.querySelectorAll(s))};
    var chkT=document.querySelector('.week-col .task-el--timed .check-btn');
    var chkU=document.querySelector('.wun-cell .task-el--untimed .check-btn');
    var title=document.querySelector('.week-col .task-el--timed .ev-title');
    var cards=qa('.week-col .task-el--timed');
    var tallest=null;
    cards.forEach(function(c){
      if(!tallest||c.getBoundingClientRect().height>tallest.getBoundingClientRect().height) tallest=c;
    });
    /* 比把手还窄的卡不该再画上下把手（把手各 8px）。
       2026-10-25 起判据分两档：**≥1 小时的卡一定有把手**（用户：「1 小时长度的
       卡片也给显示时间调节把手」），哪怕它只有 20px 高；**不足 1 小时**的卡才
       受 26px 像素门槛管。所以这里只数「不足 1 小时却画了把手」的卡。 */
    var stHW={}; try{ stHW=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}'); }catch(e){ stHW={}; }
    var tasksHW=stHW.tasks||{};
    var tinyWithHandle=cards.filter(function(c){
      if(!c.querySelector('.ev-resize')) return false;
      var id=c.getAttribute('data-id')||'';
      var t=tasksHW[id]||tasksHW[id.split('#')[0]];
      if(!t) return false;                       /* 读不到时长 → 不判它 */
      var dur=t.duration&&t.duration>0?t.duration:60;
      return dur<60 && c.getBoundingClientRect().height < 26;
    }).length;
    var body=document.querySelector('.week-col .task-el--timed .ev-body');
    /* 2026-10-22：现在线改成**整周一条**（画在 .week-cols 上），不是每列一段 */
    var cols=document.querySelector('.week-cols');
    var nowLine=cols?cols.querySelector(':scope > .tl-now'):null;
    var perColNow=document.querySelectorAll('.week-col .tl-now').length;
    var colW=(document.querySelector('.week-col')||{getBoundingClientRect:function(){return {width:0}}}).getBoundingClientRect().width;
    var gutter=(document.querySelector('.week-gutter')||{getBoundingClientRect:function(){return {width:0}}}).getBoundingClientRect().width;
    return {
      checkTimed: chkT?getComputedStyle(chkT).display:'(none)',
      checkUntimed: chkU?getComputedStyle(chkU).display:'(none)',
      titleAlign: title?getComputedStyle(title).textAlign:'',
      bodyOverflow: body?getComputedStyle(body).overflow:'',
      tinyWithHandle: tinyWithHandle, cards: cards.length,
      tallH: tallest?Math.round(tallest.getBoundingClientRect().height):0,
      tallHasTime: tallest?!!tallest.querySelector('.ev-time'):null,
      /* 2026-10-24 第四轮：手机端周视图**也显示时间**了 —— 判据换成时长：
         时长 > 60 分钟的卡必须有那一行，≤ 60 分钟必须没有。
         「有没有那一行」要量 display（JS 给不给 timeText 不算数），
         「该不该有」从本机状态读时长（重复任务的卡用的是派生 id，两头都试）。 */
      cardsWithTime: cards.filter(function(c){
        var t=c.querySelector('.ev-time');
        return t && getComputedStyle(t).display!=='none';
      }).length,
      wantTimeCards: (function(){
        var st={}; try{ st=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}'); }catch(e){ st={}; }
        var tasks=st.tasks||{};
        return cards.filter(function(c){
          var id=c.getAttribute('data-id')||'';
          var t=tasks[id]||tasks[id.split('#')[0]];
          if(!t) return false;
          return (t.duration&&t.duration>0?t.duration:60)>60;
        }).length;
      })(),
      /* 读不到时长的张数（>0 时上面那两个数不能直接比，脚本会改用宽判据） */
      durUnknownCards: (function(){
        var st={}; try{ st=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}'); }catch(e){ st={}; }
        var tasks=st.tasks||{};
        return cards.filter(function(c){
          var id=c.getAttribute('data-id')||'';
          return !(tasks[id]||tasks[id.split('#')[0]]);
        }).length;
      })(),
      /* 第五轮补两条：时间行**完整不裁**、卡上**没有加长兜底**。
         口径与 card-geometry.mjs 第三节一致 —— 横向看 .ev-time 自己的
         scrollWidth 有没有超出自己的 clientWidth（不是看它在卡里露不露头：
         align-items: center 会把 1px 上下各分一半，落在容差里出不来）。 */
      timeClipCards: cards.filter(function(c){
        var t=c.querySelector('.ev-time');
        if(!t || getComputedStyle(t).display==='none') return false;
        return t.scrollWidth - t.clientWidth > 0.5;
      }).length,
      minHCards: cards.filter(function(c){
        return (c.getAttribute('style')||'').indexOf('min-height') >= 0;
      }).length,
      /* 未定时那一栏的标题字号必须和定时卡标题一致（同一个 --ev-title-fs；
         第五轮分轴后**横向那一轴不许动标题字号**，所以这一条比从前更该成立） */
      untimedTitleSize: (function(){
        var u=document.querySelector('.wun-cell .task-el--untimed .ev-title');
        return u?getComputedStyle(u).fontSize:'';
      })(),
      timedTitleSize: (function(){
        var u=document.querySelector('.week-col .task-el--timed .ev-title');
        return u?getComputedStyle(u).fontSize:'';
      })(),
      untimedCards: document.querySelectorAll('.wun-cell .task-el--untimed').length,
      /* 2026-10-24 三问题：一小时定时卡与无定时卡必须**处处一样**。
         量的是同一列里的两张卡：外高、左右留白、圆角、卡片左边界。
         高允许 1px 误差（百分比高度受亚像素取整），其余按同值判。 */
      pair: (function(){
        var t=document.querySelector('.week-col .task-el--timed');
        var u=document.querySelector('.wun-cell .task-el--untimed');
        if(!t||!u) return null;
        var a=t.getBoundingClientRect(), b=u.getBoundingClientRect();
        var ca=getComputedStyle(t), cb=getComputedStyle(u);
        return {
          th:a.height, uh:b.height, tw:a.width, uw:b.width, tx:a.x, ux:b.x,
          tbr:parseFloat(ca.borderRadius), ubr:parseFloat(cb.borderRadius),
          tpad:ca.paddingLeft+' '+ca.paddingRight, upad:cb.paddingLeft+' '+cb.paddingRight,
        };
      })(),
      nowLineW: nowLine?Math.round(nowLine.getBoundingClientRect().width):0,
      colsW: cols?Math.round(cols.getBoundingClientRect().width):0,
      perColNow: perColNow,
      daysVisible: colW?Math.round((window.innerWidth - gutter)/colW*10)/10:0,
      colW: Math.round(colW),
    };
  })()`);
  /* 2026-10-24 用户：「任务的打勾按钮统一都加回去」—— 周视图两种卡都要有勾选圈
     （以前窄屏把这两个圈 CSS 藏掉了，改成一律显示）。 */
  assert(look.checkTimed === 'block', '周视图定时卡带勾选圈', `display=${look.checkTimed}`);
  assert(look.checkUntimed === 'block', '周视图未定时那一格也带勾选圈', `display=${look.checkUntimed}`);
  assert(look.titleAlign === 'left', '周视图卡片文字左对齐（九条第 6 条：以前居中）',
    `text-align=${look.titleAlign}`);
  /* 三问题第 1 + 2 条：一小时卡与无定时卡同高、同左右留白、同圆角、同一左边界 */
  if (look.pair) {
    const p = look.pair;
    assert(Math.abs(p.th - p.uh) <= 1, '一小时卡与无定时卡同高', `定时 ${p.th.toFixed(2)} / 未定时 ${p.uh.toFixed(2)}`);
    assert(Math.abs(p.tw - p.uw) <= 1, '同一列里两种卡同宽', `定时 ${p.tw.toFixed(2)} / 未定时 ${p.uw.toFixed(2)}`);
    assert(Math.abs(p.tx - p.ux) <= 1, '两种卡左边界对齐', `定时 x=${p.tx.toFixed(2)} / 未定时 x=${p.ux.toFixed(2)}`);
    assert(Math.abs(p.tbr - p.ubr) <= 0.1, '两种卡圆角同值（半径 = 自身高 × 30%）',
      `定时 ${p.tbr} / 未定时 ${p.ubr}`);
    assert(p.tpad === p.upad, '两种卡左右留白同一份', `定时 ${p.tpad} / 未定时 ${p.upad}`);
  }
  assert(look.tinyWithHandle === 0,
    '不足 1 小时的窄卡不画把手（≥1 小时的一律画，见 TaskCard 的 canResize）',
    `${look.tinyWithHandle} 张不足 1 小时的窄卡还带把手（共 ${look.cards} 张）`);
  assert(look.bodyOverflow === 'hidden', '内容层负责裁剪（超出卡片的东西不外溢）',
    `overflow=${look.bodyOverflow}`);
  /* 2026-10-22：现在线横贯整周（从周一到周日），不再是每天各画一段 */
  assert(look.perColNow === 0, '「现在」线不再是一个列画一段', `${look.perColNow} 列还各画了一段`);
  assert(look.nowLineW > 0 && look.nowLineW >= look.colsW - 2, '「现在」线横贯整周',
    `线宽 ${look.nowLineW}px / 七列总宽 ${look.colsW}px`);
  /* 2026-10-22：一屏至少能看到四天（原来列宽 92px 只能看 3.4 天） */
  assert(look.daysVisible >= 4, '窄屏一屏至少看得见 4 天',
    `${look.daysVisible} 天（列宽 ${look.colW}px）`);

  /* 「现在」线不能糊到左边那根刻度列上（用户横向拖动时会露出来）。
     做法是**真的横向滚一下**，再在刻度列里、线的同一高度取一点，看命中的是不是线。 */
  await evalIn(`(function(){var v=document.querySelector('.week-view');
    if(v){v.dataset.e2eScroll=String(v.scrollLeft);v.scrollLeft=200;}return 1})()`);
  await wait(200);
  const nowClip = await evalIn(`(function(){
    var line=document.querySelector('.week-cols > .tl-now');
    var g=document.querySelector('.week-gutter');
    if(!line||!g) return null;
    var lr=line.getBoundingClientRect(), gr=g.getBoundingClientRect();
    var hit=document.elementFromPoint(Math.round(gr.left+gr.width/2), Math.round(lr.top));
    return {hit: hit?(hit.className||'').toString():'(none)',
      scrolled: Math.round(document.querySelector('.week-view').scrollLeft),
      gutterRight: Math.round(gr.right), lineLeft: Math.round(lr.left)};
  })()`);
  assert(nowClip && nowClip.hit.indexOf('tl-now') < 0,
    '横向滚动后「现在」线不会糊到左侧刻度列上',
    nowClip ? `滚到 ${nowClip.scrolled}px，刻度列中间命中的是「${nowClip.hit}」` : '没找到线或刻度列');
  await evalIn(`(function(){var v=document.querySelector('.week-view');
    if(v&&v.dataset.e2eScroll!==undefined){v.scrollLeft=Number(v.dataset.e2eScroll);delete v.dataset.e2eScroll;}return 1})()`);
  await wait(150);
  /* 2026-10-24 第四轮（用户：「不是超过 1 小时的都该显示么」）：手机端周视图
     **不再一律藏时间**，判据只剩时长 —— 带时间行的张数必须等于时长 > 60 分钟的张数。 */
  if (look.durUnknownCards > 0) {
    assert(look.cardsWithTime >= look.wantTimeCards,
      `手机端周视图带时间行的卡不少于该带的（时长读不到 ${look.durUnknownCards} 张，只判下限）`,
      `带时间行 ${look.cardsWithTime}/${look.cards}，该带 ${look.wantTimeCards}`);
  } else {
    assert(look.cardsWithTime === look.wantTimeCards,
      '手机端周视图的时间行只由时长决定（> 60 分钟必须有，≤ 60 必须没有）',
      `带时间行 ${look.cardsWithTime}/${look.cards}，该带 ${look.wantTimeCards}（最高卡 ${look.tallH}px）`);
  }
  if (look.untimedCards > 0) {
    assert(!!look.untimedTitleSize && look.untimedTitleSize === look.timedTitleSize,
      '未定时任务的标题字号和定时任务一致',
      `未定时 ${look.untimedTitleSize} / 定时 ${look.timedTitleSize}（${look.untimedCards} 张未定时卡）`);
  } else {
    ok('今天没有未定时任务，跳过字号对比');
  }
  /* 2026-10-24 第五轮（用户：「周视图的时间要求完整显示」+「没有什么地方有给卡片加长的兜底」）：
     时间行要**完整**（尾巴不被省略号吃掉），而且卡上不许有 min-height —— 顶高等于把时长画长。 */
  assert(look.timeClipCards === 0,
    '手机端周视图的时间行完整可见（没有被横向裁）',
    `裁了的 ${look.timeClipCards} 张 / 带时间行的 ${look.cardsWithTime} 张`);
  assert(look.minHCards === 0,
    '卡片没有加长兜底（装不下只压不加长）',
    `带内联 min-height 的 ${look.minHCards} 张 / 定时卡 ${look.cards} 张`);

  /* 月视图：胶囊不能比日/周大卡还圆 */
  await tap('button[data-view="month"]'); await wait(700);
  const m = await evalIn(`(function(){
    /* ⚠️ 必须挑**未完成**的那条来比色：DOM 里第一个胶囊可能正好是已完成的
       （用户这个月 16/17 号就全是已完成），那样两边取到同一个元素，断言白测。 */
    var p=document.querySelector('.cell-tasks .task-pill:not(.done)');
    var grid=document.querySelector('.month-grid');
    /* 月视图的「已完成」要和日/周同一套语言：灰底 + 划线（用户 2026-10-19：
       「月视图现在无论是不是完成全是白色，和日周不统一」）。同样用探针量。 */
    var d=document.createElement('div');
    d.className='task-pill done';
    d.innerHTML='<span class="pill-title">测</span>';
    document.body.appendChild(d);
    var dcs=getComputedStyle(d);
    var out={doneBg:dcs.backgroundColor, doneOpacity:dcs.opacity,
      doneLine:getComputedStyle(d.querySelector('.pill-title')).textDecorationLine};
    d.remove();
    var tcell=document.querySelector('.month-cell.today');
    var plain=document.querySelector('.month-cell:not(.today):not(.out)');
    var lv=document.querySelector('.month-cell.lv2, .month-cell.lv3');
    return {pill: p?parseFloat(getComputedStyle(p).borderTopLeftRadius):0,
      grid: grid?parseFloat(getComputedStyle(grid).borderTopLeftRadius):0,
      todayCellBg: tcell?getComputedStyle(tcell).backgroundColor:'',
      plainCellBg: plain?getComputedStyle(plain).backgroundColor:'',
      lvBar: lv?getComputedStyle(lv).boxShadow:'(没有忙的格子)',
      doneBg: out.doneBg, doneOpacity: out.doneOpacity, doneLine: out.doneLine,
      normalBg: p?getComputedStyle(p).backgroundColor:''};
  })()`);
  assert(m.pill <= 5, '月视图胶囊不再是个药丸（圆角 ≤5px）', `${m.pill}px（改之前 7px）`);
  assert(m.grid > 0 && m.grid < 12, '月视图外框比之前收一档（<12px）', `${m.grid}px（改之前 12px）`);
  assert(m.pill < 10, '月视图的圆角比日/周大卡更小（视觉分档）', `月 ${m.pill}px / 日周 ${w.tallR}px`);
  assert(m.normalBg && m.doneBg !== m.normalBg, '月视图的已完成不再是白底（和日/周同一套语言）',
    `done=${m.doneBg} / 未完成=${m.normalBg}`);
  assert(m.doneLine === 'none', '月视图已完成标题也没有删除线（所有视图统一）', `text-decoration=${m.doneLine}`);
  assert(m.doneOpacity === '1', '已完成不再靠整体变淡（那会和白底混成一个样）', `opacity=${m.doneOpacity}`);
  /* 今天那格现在回落到和普通格子一样的底色（--panel），不再有额外淡绿 */
  assert(m.todayCellBg === m.plainCellBg, '月视图今天格子不再加底色（只留日期圆圈）',
    `today 格=${m.todayCellBg} / 普通格=${m.plainCellBg}`);
  assert(m.lvBar === 'none' || m.lvBar === '(没有忙的格子)', '月视图去掉了格子底部的负载条',
    `box-shadow=${m.lvBar}`);
}

async function checkRepeat() {
  const me = await apiMe();
  if (!me) { bad('能取到登录 token'); return; }
  ok('能从页面取到登录 token');
  const calId = me.cals && me.cals[0] && me.cals[0].id;
  if (!calId) { bad('能取到机器人自己的日程集'); return; }
  ok('能取到日程集', calId);

  const title = 'e2e安卓重复-' + Date.now().toString(36);
  const rootId = 't_e2e_and_' + Date.now().toString(36);
  const now = Date.now();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const iso = `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-${pad(new Date().getDate())}`;

  const r1 = await apiPush([{
    opId: 'e2e-' + rootId, deviceId: 'e2e-android', ts: now, entity: 'task',
    entityId: rootId, calId,
    fields: {
      title, note: '', date: iso, time: null, reminder: null, duration: null,
      done: false, doneAt: null,
      repeat: { unit: 'week', n: 1, weekdays: [5, 6], monthday: 1, yearMonth: 1, end: null },
      repeatSeq: 0, seriesId: rootId, order: null, ord: null, createdAt: now, source: null,
    },
  }]);
  assert(r1.status === 200 && (r1.body?.applied?.length ?? 0) > 0,
    '线上能创建重复任务', r1.body?.rejected?.length ? JSON.stringify(r1.body.rejected[0]) : 'ok');

  // 同步 → 客户端补齐实例；看月视图（不 reload：会换执行上下文、甩断这条 WS）
  await pullSync(6000);
  await openCalendar();
  await tap('button[data-view="month"]'); await wait(600);
  const dates = await evalIn(`Array.from(document.querySelectorAll('[data-date]')).filter(c=>(c.textContent||'').includes(${JSON.stringify(title)})).map(c=>c.getAttribute('data-date'))`, 20000);
  const wd = (d) => new Date(d + 'T00:00:00').getDay();
  const fri = dates.filter((d) => wd(d) === 5);
  const sat = dates.filter((d) => wd(d) === 6);
  console.log(`       月视图里这条重复任务落在: ${dates.join(', ') || '(无)'}`);
  assert(dates.length >= 2, '实例出现在月视图', `${dates.length} 天`);
  assert(fri.length >= 1, '周五有实例', `周五 ${fri.length} 天`);
  assert(sat.length >= 1, '周六有实例', `周六 ${sat.length} 天`);

  // 收尾：结束系列（repeatUntil=今天），实例由级联清掉
  const r2 = await apiPush([{
    opId: 'e2e-end-' + rootId, deviceId: 'e2e-android', ts: now + 1, entity: 'task',
    entityId: rootId, calId, fields: { repeatUntil: iso },
  }]);
  assert(r2.status === 200, '收尾：系列已结束（repeatUntil=今天）');

  /* ⚠️ 只打 repeatUntil **不够**（2026-10-19 实测）：级联删完之后客户端本地仍
     留着那批实例，冷启动同步回来照样显示在月视图上 —— 等于往用户真实日历里
     留了一堆「e2e安卓重复…」。所以再显式把这一批（含历史残留）逐条打删除标。 */
  await pullSync(3000);
  const leftovers = await evalIn(`(function(){
    var j=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}');var s=j.state||j;
    var t=s.tasks||{};
    return Object.keys(t).filter(function(id){
      var x=t[id]; return x && !x.deleted && (x.title||'').indexOf('e2e安卓重复-')===0;
    });
  })()`);
  if (leftovers.length) {
    const del2 = Date.now();
    const r3 = await apiPush(leftovers.map((id, i) => ({
      opId: 'e2e-rm-' + id, deviceId: 'e2e-android', ts: del2 + i, entity: 'task',
      entityId: id, calId, fields: { deleted: true, deletedAt: del2 + i },
    })));
    assert(r3.status === 200, `收尾：逐条清掉残留实例（${leftovers.length} 条）`);
  } else {
    ok('收尾：没有残留实例');
  }
  await pullSync(3000);
}
}

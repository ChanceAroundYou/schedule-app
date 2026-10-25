export async function run(ctx) {
  Object.assign(globalThis, ctx.helpers);
  Object.assign(globalThis, ctx.state);
async function checkCore() {
  await openCalendar();
  await tap('button[data-view="day"]'); await wait(700);
  let has = await evalIn(`!!document.querySelector('.timeline')`);
  assert(has, '日视图时间轴存在');

  await tap('button[data-view="week"]'); await wait(500);
  const wk = await evalIn(`!!document.querySelector('.week-cols')`);
  assert(wk, '周视图渲染（.week-cols）');

  /* 2026-10-22 用户报的两条（周视图未定时区）：
     ① 3 条以上不再折成「+3」，**全部显示**；
     ② 末尾同样**永远多一整行空白**，点它能就地开草稿；
     ③ 整格有高度上限、超了在格子里自己滚（时间轴高度不受影响）。 */
  const wun = await evalIn(`(function(){
    var cells = Array.from(document.querySelectorAll('.wun-cell'));
    var cell = cells.filter(function(c){
      return c.querySelectorAll('.task-el--untimed').length > 0;
    }).sort(function(a,b){
      return b.querySelectorAll('.task-el--untimed').length - a.querySelectorAll('.task-el--untimed').length;
    })[0] || cells[0];
    if (!cell) return null;
    var blank = cell.querySelector('.wun-blank');
    var r = blank ? blank.getBoundingClientRect() : null;
    return {
      n: cell.querySelectorAll('.task-el--untimed').length,
      more: !!cell.querySelector('.wun-more'),
      blank: !!blank,
      maxH: getComputedStyle(cell).maxHeight,
      scrollable: cell.scrollHeight > cell.clientHeight + 1,
      at: r ? { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } : null,
    };
  })()`);
  if (wun) {
    assert(!wun.more, '周视图不再把未定时任务折成「+N」');
    assert(wun.blank, '周视图未定时格末尾有多一整行空白');
    assert(wun.maxH !== 'none', '周视图未定时格有高度上限（超了自己滚）', `max-h ${wun.maxH}`);
    if (wun.n > 0 && wun.at) {
      const before = await evalIn(`document.querySelectorAll('.wun-cell .new-cell').length`);
      await tapAt(wun.at.x, wun.at.y); await wait(400);
      const after = await evalIn(`document.querySelectorAll('.wun-cell .new-cell').length`);
      assert(after > before, '点周视图那行空白能就地开草稿', `草稿 ${before} → ${after}`);
      await evalIn(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`);
      await wait(200);
    }
  } else {
    ok('周视图没有未定时格，跳过');
  }

  await tap('button[data-view="month"]'); await wait(500);
  const cells = await evalIn(`document.querySelectorAll('[data-date]').length`);
  assert(cells >= 28, '月视图渲染（日期格 ≥28）', `${cells} 格`);

  await tap('button[data-view="day"]'); await wait(400);

  /* 2026-10-22 未定时区（三条用户要求）：
     ① 卡片是**紧凑一行**（不是「一小时高」——那时候加一条就吃掉一小时空间）；
     ② 手机端**一条一行、占满整行**（以前两列、每条只剩半行宽）；
     ③ 末尾**永远多一整行空白**，点它就开草稿 —— 虚线「＋」格已按用户要求删掉
        （真机上点那个格子没反应）。 */
  const al = await evalIn(`(function(){
    var wrap=document.querySelector('.allday-items');
    var cards=Array.from(document.querySelectorAll('.allday-items .task-el'));
    var blanks=Array.from(document.querySelectorAll('.allday-blank'));
    var h=cards.length?Math.round(cards[0].getBoundingClientRect().height):0;
    var cw=cards.length?Math.round(cards[0].getBoundingClientRect().width):0;
    var ww=wrap?Math.round(wrap.getBoundingClientRect().width):0;
    var bh=blanks.length?Math.round(blanks[0].getBoundingClientRect().height):0;
    var font=getComputedStyle(document.body).fontFamily;
    return {n:cards.length,h:h,cw:cw,ww:ww,cols:wrap?+wrap.dataset.cols:0,
            blanks:blanks.length,bh:bh,hasAdd:!!document.querySelector('.zone-add'),font:font};
  })()`);
  assert(!al.hasAdd, '虚线「＋」格已移除（改成空白行）');
  if (al.n > 0) {
    assert(al.h > 0 && al.h <= 30, '未定时卡片是紧凑一行（不再是一小时高）', `高 ${al.h}px / ${al.n} 条`);
    assert(al.cols === 1, '手机端未定时区是 1 列', `cols=${al.cols}`);
    assert(al.cw > al.ww * 0.85, '未定时卡片占满整行（不再被挤成半行）', `卡 ${al.cw}px / 区 ${al.ww}px`);
    assert(al.blanks > 0 && al.bh >= 20, '末尾永远留一整行空白', `空 ${al.blanks} 格 × ${al.bh}px`);
    const before = await evalIn(`document.querySelectorAll('.new-cell').length`);
    await evalIn(`(function(){var a=document.querySelectorAll('.allday-blank');
      if(!a.length)return 0;var t=a[a.length-1];
      var b=t.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;
      var el=document.elementFromPoint(x,y);var o={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,button:0};
      el.dispatchEvent(new MouseEvent('mousedown',o));el.dispatchEvent(new MouseEvent('mouseup',o));
      el.dispatchEvent(new MouseEvent('click',o));return 1})()`);
    await wait(300);
    const after = await evalIn(`document.querySelectorAll('.new-cell').length`);
    assert(after > before, '点那行空白能就地开草稿', `草稿框 ${before} → ${after}`);
    await evalIn(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await wait(200);
  } else {
    ok('未定时区当前没有任务，跳过紧凑度检查');
  }
  assert(/PingFang|Noto Sans CJK|Microsoft YaHei|Source Han/.test(al.font) &&
    al.font.indexOf('PingFang') < al.font.indexOf('system-ui'),
    '字体栈把中文字体排在 system-ui 前面（中英混排同一套字）', al.font.slice(0, 60));

  // 排除已知良性噪声：Capacitor safe-area 插件在 WebView 加载时往一个
  // 临时为 null 的节点注入样式报错，属第三方插件现象，非产品逻辑问题。
  const real = () => consoleErrors.filter((e) => !/safe area CSS/i.test(e));
  assert(real().length === 0, '零控制台报错（已排除 safe-area 插件噪声）',
    real().length ? real().slice(0, 3).join(' | ') : '无');
}

}

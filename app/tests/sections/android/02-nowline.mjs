export async function run(ctx) {
  Object.assign(globalThis, ctx.helpers);
  Object.assign(globalThis, ctx.state);
async function checkNowLine() {
  // now-line 只在「今天」渲染（isToday 门控），先点顶栏「今」跳回今天
  await evalIn(`(function(){var b=Array.from(document.querySelectorAll('button')).find(x=>(x.textContent||'').trim()==='今');if(!b)return 'no-btn';var r=b.getBoundingClientRect();var x=r.x+r.width/2,y=r.y+r.height/2;var t=document.elementFromPoint(x,y);if(!t)return 'no-pt';var o={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,button:0};t.dispatchEvent(new MouseEvent('mousedown',o));t.dispatchEvent(new MouseEvent('mouseup',o));t.dispatchEvent(new MouseEvent('click',o));return 'clicked';})()`);
  await wait(500);
  await openCalendar();
  await tap('button[data-view="day"]'); await wait(700);
  const has = await evalIn(`!!document.querySelector('.tl-now')`);
  if (!has) { bad('当前时间线存在（今天、日视图）'); return; }
  ok('当前时间线存在（今天、日视图）');
  const info = await evalIn(`(function(){
    var el=document.querySelector('.tl-now'); var cs=getComputedStyle(el);
    var p=document.createElement('div'); p.style.color='var(--ok)'; document.body.appendChild(p);
    var okColor=getComputedStyle(p).color; p.remove();
    return {bc:cs.backgroundColor, ok:okColor, children:el.children.length, text:(el.textContent||'').trim()};
  })()`);
  assert(info.bc === info.ok, '线条是 --ok 深绿（实心 div 的底色，不是 border-top）', `实际 ${info.bc}，--ok=${info.ok}`);
  assert(info.children === 0 && info.text === '', '只有一根线：无圆点、无时刻文字',
    `子元素 ${info.children}、文本「${info.text}」`);
}

}

#!/usr/bin/env node
/**
 * android-live-check.mjs —— 安卓真机端到端实测（对标网页端 live-check.mjs）
 *
 * 通过 CDP 驱动真机 WebView，断言同一套核心场景：
 *   core      进应用外壳（日视图时间轴出现）→ 周/月视图渲染 → 零控制台报错
 *   now-line  今天日视图的当前时间线是 --ok 深绿细线、无圆点无时刻文字
 *   month     窄屏月视图：行数只含当月某天、一屏不滚、每行 5 个完整汉字（无省略号）、
 *             左右留白已收窄、任务左侧没有绿线、塞不下的在最后一条尾巴上挂 +N、
 *             点任务跳那一天的日视图、点空白处不再就地新建
 *   repeat    API 建「每周五、六」系列 → 断言周五+周六实例都落到月视图 → repeatUntil 收尾
 *
 * 与网页端 live-check.mjs 的区别：
 *   · 网页端用 Playwright 打生产 URL；这里用 CDP 打真机 WebView（WebView 的
 *     网络栈 earlier 出过 DNS 整体失效，所以真机实测比网页端更关键）。
 *   · 必须装 **debug 包**（正式包关了 WebView 调试，`webview_devtools_remote_*`
 *     不存在，CDP 连不上）；debug 与 release 同签名，覆盖安装不丢数据。
 *   · 键盘/输入法相关（输入法弹起、收起后布局）CDP 模拟不了，那部分见 devflow
 *     的「自动化边界」，交给用户真手指验收。
 *
 * 用法：
 *   node app/tests/android-live-check.mjs --device 192.168.1.172:38237
 *   node app/tests/android-live-check.mjs --device 192.168.1.172:38237 --features core,now-line,repeat
 *
 * 前置：先把 debug 包装上（同签名，数据保留）
 *   MSYS_NO_PATHCONV=1 "$ADB" install -r app/android/app/build/outputs/apk/debug/app-debug.apk
 *
 * 退出码：0 全过；1 有断言失败。
 */

import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

/* 基址要跟**装机包实际用的那个**一致 —— 家用局域网直连包（Cloudflare 被丢包的
   绕开方案，见 docs/踩坑-环境.md 第 4 条）是用
   `API_BASE=http://192.168.1.6/schedule UPDATE_BASE=... ./deploy/build-apk.sh`
   打的，这时候打公网域名会连不上。用 --base / BASE 覆盖。 */
/* 基址要跟**装机包实际用的那个**一致 —— 家用局域网直连包（Cloudflare 被丢包的
   绕开方案，见 docs/踩坑-环境.md 第 4 条）是用
   `API_BASE=http://192.168.1.6/schedule UPDATE_BASE=... ./deploy/build-apk.sh`
   打的；这种包在 WebView 里打公网域名会连不上（实测 connection closed）。
   用 --base / BASE 覆盖，默认仍是公网域名。 */
const BASE = process.env.BASE || 'https://home.xiaokubao.space/schedule';
const ADB = process.env.ADB || 'C:/Users/小哭包/Android/platform-tools/adb.exe';
const ENV = { ...process.env, MSYS_NO_PATHCONV: '1' };
const PKG = 'space.xiaokubao.schedule';

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
let device = null;
let featArg = 'core,now-line,month,repeat';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--device') device = argv[++i];
  else if (argv[i].startsWith('--device=')) device = argv[i].split('=')[1];
  else if (argv[i] === '--features') featArg = argv[++i];
  else if (argv[i].startsWith('--features=')) featArg = argv[i].split('=')[1];
  else if (argv[i].includes(':') && !device) device = argv[i];
}
if (!device) { console.error('用法: node app/tests/android-live-check.mjs --device <IP:端口> [--features core,now-line,repeat]'); process.exit(2); }
const FEATURES = new Set(featArg.split(',').map((s) => s.trim()).filter(Boolean));

/* ---------- 结果统计 ---------- */
let pass = 0, fail = 0; const lines = [];
const ok = (n, d) => { pass++; lines.push(`  ok   ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d) => { fail++; lines.push(`  FAIL ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => (c ? ok(n, d) : bad(n, d));

/* ---------- CDP ---------- */
const adb = (args, opts = {}) => execSync(`"${ADB}" -s ${device} ${args}`, { encoding: 'utf8', env: ENV, timeout: 60000, ...opts });

// 冷启动 App（确保 WebView 调试通道在；debug 包才开调试）
try { adb('shell svc power stayon true', { stdio: 'ignore' }); } catch {}
try { adb('shell input keyevent 224', { stdio: 'ignore' }); } catch {}   // 唤醒屏幕
try { adb(`shell am force-stop ${PKG}`, { stdio: 'ignore' }); } catch {}
// 用 am start 拉到前台（monkey 启动常把 App 留在后台，WebView 不建调试通道）
try { adb(`shell am start -n ${PKG}/.MainActivity`, { stdio: 'ignore' }); } catch {}
console.error('[android-live-check] 已启动 App，等待 WebView 调试通道…');
await new Promise((r) => setTimeout(r, 6000));

execSync(`"${ADB}" connect ${device}`, { stdio: 'ignore', env: ENV });
const socket = adb('shell cat /proc/net/unix')
  .split('\n').map((l) => l.match(/webview_devtools_remote_(\d+)/)?.[1]).find(Boolean);
if (!socket) { console.error('找不到 webview_devtools socket（App 起着吗？是 debug 包吗？）'); process.exit(1); }

const localPort = 9343 + (Number(socket) % 100);
try { execSync(`"${ADB}" forward --remove tcp:${localPort}`, { stdio: 'ignore', env: ENV }); } catch {}
execSync(`"${ADB}" -s ${device} forward tcp:${localPort} localabstract:webview_devtools_remote_${socket}`, { env: ENV });
const list = JSON.parse(execSync(`curl -s http://127.0.0.1:${localPort}/json`, { encoding: 'utf8' }));
const page0 = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page0) { console.error('没有可调试页面:', JSON.stringify(list)); process.exit(1); }

const ws = await openWs(page0.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const consoleErrors = [];
ws.onMessage = (raw) => {
  const m = JSON.parse(raw);
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (txt) consoleErrors.push(txt.slice(0, 160));
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    consoleErrors.push('exception: ' + (d.exception?.description || d.text || ''));
  }
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};
function send(method, params = {}, timeoutMs = 20000) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('CDP 超时: ' + method)); } }, timeoutMs);
    pending.set(mid, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable').catch(() => {});

/* node 侧 eval：直接 Runtime.evaluate（无需页面侧 __cdp 注入） */
async function evalIn(expr, timeoutMs = 20000) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/* 合成点击：在元素中心点派发 mousedown/up/click，冒泡到 root 被 React 委托收到
   （OPPO/ColorOS 上 CDP 的 Input 域完全没效果，只能走页面内合成事件） */
async function tap(sel) {
  return evalIn(`(function(){
    var el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'no-sel';
    var r=el.getBoundingClientRect(); var x=r.x+r.width/2, y=r.y+r.height/2;
    var t=document.elementFromPoint(x,y); if(!t) return 'no-pt';
    var o={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,button:0};
    t.dispatchEvent(new MouseEvent('mousedown',o));
    t.dispatchEvent(new MouseEvent('mouseup',o));
    t.dispatchEvent(new MouseEvent('click',o));
    return t.tagName;
  })()`);
}
/* 按坐标点（点空白处用，没有选择器可点） */
async function tapAt(x, y) {
  return evalIn(`(function(){
    var t=document.elementFromPoint(${x},${y}); if(!t) return 'no-pt';
    var o={bubbles:true,cancelable:true,view:window,clientX:${x},clientY:${y},button:0};
    t.dispatchEvent(new MouseEvent('mousedown',o));
    t.dispatchEvent(new MouseEvent('mouseup',o));
    t.dispatchEvent(new MouseEvent('click',o));
    return t.tagName+'.'+(t.className||'');
  })()`);
}
async function reload() {
  await send('Page.reload');
  await wait(4000); // 等 SPA 重新挂载
}

/* 不用 Page.reload：reload 会换掉执行上下文，把这条裸 WS 连接甩断
   （实测 connection closed）。改用页面事件触发同步 —— lifecycle 在
   focus/visibilitychange 上挂了 onWake → syncNow，等一轮就能读到新数据。 */
async function pullSync(waitMs = 4000) {
  await evalIn(`window.dispatchEvent(new Event('focus'))`);
  await wait(waitMs);
}

/* 视图切换只在「日程」页里，所以要先确保 nav 落在 calendar。
   ⚠️ 窄屏底栏按钮**没有** `data-nav`（那是侧栏的锚点，底栏成员是用户自选的
   ui.tabs）—— 所以这里按文本找「日程」，找不到也不报错：已经在日程页就不用点。 */
async function openCalendar() {
  const r = await evalIn(`(function(){
    var j=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}');var s=j.state||j;
    if (s.ui && s.ui.nav === 'calendar') return 'already';
    var el=Array.from(document.querySelectorAll('[data-nav], .tab')).find(function(x){return (x.textContent||'').trim()==='日程'});
    if(!el) return 'no-nav';
    var b=el.getBoundingClientRect();var x=b.x+b.width/2,y=b.y+b.height/2;
    var t=document.elementFromPoint(x,y);if(!t) return 'no-pt';
    var o={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,button:0};
    t.dispatchEvent(new MouseEvent('mousedown',o));t.dispatchEvent(new MouseEvent('mouseup',o));t.dispatchEvent(new MouseEvent('click',o));
    return 'clicked';
  })()`);
  if (r !== 'no-nav' && r !== 'no-pt') await wait(600);
  return r;
}

/* ---------- API 助手（页面上下文里发，带 Bearer） ---------- */
async function apiMe() {
  return evalIn(`(async()=>{var t=localStorage.getItem('schedule-app-token');if(!t)return null;
    var r=await fetch('${BASE}/api/me',{headers:{Authorization:'Bearer '+t}});
    return r.ok?await r.json():null;})()`);
}
async function apiPush(ops) {
  return evalIn(`(async()=>{var t=localStorage.getItem('schedule-app-token');
    var r=await fetch('${BASE}/api/sync',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},
      body:JSON.stringify({cursor:1,ops:${JSON.stringify(ops)}})});
    return {status:r.status,body:await r.json().catch(()=>null)};})()`);
}

/* ------------------------------------------------------------ 各项检查 */

async function checkCore() {
  await openCalendar();
  await tap('button[data-view="day"]'); await wait(700);
  let has = await evalIn(`!!document.querySelector('.timeline')`);
  assert(has, '日视图时间轴存在');

  await tap('button[data-view="week"]'); await wait(500);
  const wk = await evalIn(`!!document.querySelector('.week-cols')`);
  assert(wk, '周视图渲染（.week-cols）');

  await tap('button[data-view="month"]'); await wait(500);
  const cells = await evalIn(`document.querySelectorAll('[data-date]').length`);
  assert(cells >= 28, '月视图渲染（日期格 ≥28）', `${cells} 格`);

  await tap('button[data-view="day"]'); await wait(400);

  /* 2026-10-22 未定时区：
     ① 卡片是**紧凑一行**（不是「一小时高」——那时候加一条就吃掉一小时空间）；
     ② 有任务时末尾有个虚线「＋」格，点它能就地开草稿；
     ③ 字体栈里带拉丁字形的中文字体排在 system-ui 前面（否则中英混排两套字）。 */
  const al = await evalIn(`(function(){
    var cards=Array.from(document.querySelectorAll('.allday-items .task-el'));
    var add=document.querySelector('.zone-add');
    var h=cards.length?Math.round(cards[0].getBoundingClientRect().height):0;
    var font=getComputedStyle(document.body).fontFamily;
    return {n:cards.length, h:h, hasAdd:!!add, font:font};
  })()`);
  if (al.n > 0) {
    assert(al.h > 0 && al.h <= 30, '未定时卡片是紧凑一行（不再是一小时高）', `高 ${al.h}px / ${al.n} 条`);
    assert(al.hasAdd, '未定时区末尾有「＋」格（随时能再加一条）');
    const before = await evalIn(`document.querySelectorAll('.new-cell').length`);
    await evalIn(`(function(){var a=document.querySelector('.zone-add');if(!a)return 0;
      var b=a.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;
      var t=document.elementFromPoint(x,y);var o={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,button:0};
      t.dispatchEvent(new MouseEvent('mousedown',o));t.dispatchEvent(new MouseEvent('mouseup',o));
      t.dispatchEvent(new MouseEvent('click',o));return 1})()`);
    await wait(300);
    const after = await evalIn(`document.querySelectorAll('.new-cell').length`);
    assert(after > before, '点「＋」格能就地开草稿', `草稿框 ${before} → ${after}`);
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
    return {bc:cs.borderTopColor, ok:okColor, children:el.children.length, text:(el.textContent||'').trim()};
  })()`);
  assert(info.bc === info.ok, '线条是 --ok 深绿', `实际 ${info.bc}，--ok=${info.ok}`);
  assert(info.children === 0 && info.text === '', '只有一根线：无圆点、无时刻文字',
    `子元素 ${info.children}、文本「${info.text}」`);
}

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
      d.innerHTML='<div class="ev-head"><span class="ev-title">测</span></div><span class="ev-time">00:00</span>';
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
  assert(w.minGap === null || w.minGap >= 2, '首尾相接的两条任务之间留出了缝',
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

  /* 2026-10-20 四条：去勾选圈 / 文字居中 / 有空间显示时间 / 极窄卡不给把手 */
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
    /* 比把手还窄的卡不该再画上下把手（把手各 8px） */
    var tinyWithHandle=cards.filter(function(c){
      return c.getBoundingClientRect().height < 24 && c.querySelector('.ev-resize');
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
      cardsWithTime: cards.filter(function(c){return c.querySelector('.ev-time')}).length,
      nowLineW: nowLine?Math.round(nowLine.getBoundingClientRect().width):0,
      colsW: cols?Math.round(cols.getBoundingClientRect().width):0,
      perColNow: perColNow,
      daysVisible: colW?Math.round((window.innerWidth - gutter)/colW*10)/10:0,
      colW: Math.round(colW),
    };
  })()`);
  assert(look.checkTimed === 'none', '周视图定时卡去掉了勾选圈', `display=${look.checkTimed}`);
  assert(look.checkUntimed === 'none', '周视图未定时那一格也去掉了勾选圈', `display=${look.checkUntimed}`);
  assert(look.titleAlign === 'center', '周视图卡片文字居中', `text-align=${look.titleAlign}`);
  assert(look.tinyWithHandle === 0, '比把手还窄的卡不再画上下把手',
    `${look.tinyWithHandle} 张窄卡还带把手（共 ${look.cards} 张）`);
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
  if (look.tallHasTime !== null) {
    assert(look.tallHasTime, '有空间时还是显示时间（最高的那张卡要有时间行）',
      `最高 ${look.tallH}px，${look.cardsWithTime}/${look.cards} 张带时间行`);
  }

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

/* ------------------------------------------------------------------ 主流程 */
console.log(`\n== 安卓真机实测 ${device}（features: ${[...FEATURES].join(', ')}）`);
try {
  // 登录后默认落在「今天」列表；视图切换在日程页副 header → 先进日程页
  await openCalendar();
  await tap('button[data-view="day"]'); await wait(800);
  const shell = await evalIn(`!!document.querySelector('.timeline') || !!document.querySelector('.week-cols')`);
  assert(shell, '应用外壳就绪（时间轴/周视图出现）');

  if (FEATURES.has('core')) await checkCore();
  if (FEATURES.has('now-line')) await checkNowLine();
  if (FEATURES.has('month')) {
    await checkMonth();
    await checkMonthOverflow();
    await checkMonthTap();
    await checkLook();
  }
  if (FEATURES.has('repeat')) await checkRepeat();

  if (FEATURES.has('core')) {
    const real = consoleErrors.filter((e) => !/safe area CSS/i.test(e));
    assert(real.length === 0, '全流程零控制台报错（已排除 safe-area 插件噪声）',
      real.length ? real.slice(0, 3).join(' | ') : '无');
  }
} catch (e) {
  bad('脚本执行中断', e && e.message);
} finally {
  try { adb('shell svc power stayon false', { stdio: 'ignore' }); } catch {}
  console.log(lines.join('\n'));
  console.log(`\n== 结果：${pass}/${pass + fail} 通过`);
  if (fail) { console.log('未通过：'); for (const l of lines.filter((x) => x.startsWith('  FAIL'))) console.log(l); }
  for (const [, p] of pending) clearTimeout(p.timer);
  pending.clear();
  ws.close();
  process.exit(fail ? 1 : 0);
}

/* ---------------- 极简 WebSocket（RFC6455，客户端掩码） ---------------- */
function openWs(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const sock = connect(Number(u.port), u.hostname, () => {
      sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), upgraded = false;
    const ws = { onMessage: null, send(payload) {
      const data = Buffer.from(payload);
      const mask = randomBytes(4);
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
      let head;
      if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
      else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xFE; head.writeUInt16BE(data.length, 2); }
      else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0xFF; head.writeBigUInt64BE(BigInt(data.length), 2); }
      sock.write(Buffer.concat([head, mask, masked]));
    }, close() { try { sock.destroy(); } catch {} } };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!buf.slice(0, end).toString().includes('101')) return reject(new Error('WS 升级失败'));
        buf = buf.slice(end + 4); upgraded = true; resolve(ws);
      }
      for (;;) {
        if (buf.length < 2) return;
        const len2 = buf[1] & 0x7F; let off = 2, len = len2;
        if (len2 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len2 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len).toString('utf8');
        buf = buf.slice(off + len);
        if (ws.onMessage) ws.onMessage(payload);
      }
    });
    sock.on('error', reject);
  });
}

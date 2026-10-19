#!/usr/bin/env node
/**
 * android-live-check.mjs —— 安卓真机端到端实测（对标网页端 live-check.mjs）
 *
 * 通过 CDP 驱动真机 WebView，断言同一套核心场景：
 *   core      进应用外壳（日视图时间轴出现）→ 周/月视图渲染 → 零控制台报错
 *   now-line  今天日视图的当前时间线是 --ok 深绿细线、无圆点无时刻文字
 *   month     窄屏月视图：行数只含当月某天、一屏不滚、格子里是文字行、
 *             塞不下的在下方用点表示（点数 = 没显示出来的条数）
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
  await tap('button[data-view="month"]'); await wait(900);
  const m = await evalIn(`(function(){
    var q=function(s){return document.querySelector(s)};
    var qa=function(s){return Array.from(document.querySelectorAll(s))};
    var rows=new Set(); qa('.month-cell').forEach(function(c){rows.add(Math.round(c.getBoundingClientRect().y))});
    var content=q('#content');
    var cells=qa('.month-cell');
    var texts=cells.filter(function(c){return c.querySelector('.task-pill')});
    var dotRows=qa('.cell-more');
    var widest=0; cells.forEach(function(c){var p=c.querySelector('.task-pill'); if(p) widest=Math.max(widest,Math.round(p.getBoundingClientRect().width))});
    return {
      rows: rows.size, cells: cells.length,
      contentScroll: content ? content.scrollHeight : 0,
      contentH: content ? Math.round(content.getBoundingClientRect().height) : 0,
      cellHasText: texts.length,
      widestPill: widest,
      dotRows: dotRows.length,
      dotsTotal: qa('.more-dot').length,
      pillTextNonEmpty: texts.filter(function(c){return ((c.querySelector('.task-pill').innerText||'').trim().length>0)}).length
    };
  })()`);
  assert(m.rows >= 4 && m.rows <= 6, '月视图行数只含当月某天（4–6 行）', `${m.rows} 行 / ${m.cells} 格`);
  assert(m.contentScroll <= m.contentH + 1, '一屏放完、内容区不滚', `scroll ${m.contentScroll} vs ${m.contentH}`);
  assert(m.cellHasText > 0, '格子里显示的是文字行（不再是只有点）', `${m.cellHasText} 格有文字`);
  assert(m.widestPill > 20, '文字行有实际宽度', `${m.widestPill}px`);
  assert(m.pillTextNonEmpty === m.cellHasText, '文字行标题非空');

  /* 点数必须等于「没显示出来的条数」—— 拿本地缓存逐格对账。
     格子显示 N 行 + 点 M 个，那这一天就该正好有 N+M 条活任务。 */
  const acct = await evalIn(`(function(){
    var j=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}');
    var s=j.state||j; var tasks=s.tasks||{};
    var live={}; Object.values(tasks).forEach(function(t){ if(!t.deleted) live[t.date]=(live[t.date]||0)+1 });
    var mismatches=[];
    Array.from(document.querySelectorAll('.month-cell')).forEach(function(c){
      var d=c.getAttribute('data-date');
      var shown=c.querySelectorAll('.task-pill').length;
      var dots=c.querySelectorAll('.more-dot').length;
      var n=(c.querySelector('.more-n')||{}).textContent;
      var moreN = n ? Number(n.replace('+','')) : 0;
      var total = shown + dots + moreN;
      if (live[d] !== undefined && total !== live[d]) mismatches.push(d+': 显示'+shown+'+点'+(dots+moreN)+' 应为 '+live[d]);
    });
    return mismatches;
  })()`);
  assert(acct.length === 0, '点数与「没显示出来的条数」逐格对得上', acct.length ? acct.slice(0, 3).join(' | ') : '无差异');
  return m;
}

/* 点那一行必须被**真正触发**才算测到（光靠真实数据对账是空跑：当月最多两三条，
   还没超过格子容量）。这里在当月挑一天造一条超容量的任务组，跑完清干净。 */
async function checkMonthOverflow() {
  const me = await apiMe();
  if (!me) { bad('能取到登录 token'); return; }
  const calId = me.cals?.[0]?.id;
  if (!calId) { bad('能取到日程集'); return; }

  /* 挑当月中**本来任务最少**的一天，容量最可控；造满 6 条（窄屏一般 3 行容量）。 */
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
  for (let i = 0; i < 6; i++) {
    const id = 't_e2e_ovf_' + now.toString(36) + '_' + i;
    ids.push(id);
    ops.push({
      opId: 'e2e-ovf-' + id, deviceId: 'e2e-android', ts: now + i, entity: 'task',
      entityId: id, calId,
      fields: {
        title: 'e2e点行探针-' + i, note: '', date: target, time: null, reminder: null,
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
  ok('探针：在 ' + target + ' 造 6 条任务（原有 ' + existing + ' 条）');

  await pullSync();
  await openCalendar();
  await tap('button[data-view="month"]'); await wait(900);
  const cell = await evalIn(`(function(){
    var c=document.querySelector('.month-cell[data-date=${JSON.stringify(target)}]'); if(!c) return null;
    var pills=c.querySelectorAll('.task-pill').length;
    var dots=c.querySelectorAll('.more-dot').length;
    var moreN=(c.querySelector('.more-n')||{}).textContent||'';
    var row=c.querySelector('.cell-more');
    var cr=c.getBoundingClientRect(), rr=row?row.getBoundingClientRect():null;
    return {
      pills, dots, moreN: moreN ? Number(moreN.replace('+','')) : 0,
      hasMoreRow: !!row,
      rowInside: !!rr && rr.bottom <= cr.bottom + 1 && rr.top >= cr.top,
      cellH: Math.round(cr.height),
      cellScrolls: c.scrollHeight > c.clientHeight + 1,
    };
  })()`);
  if (!cell) { bad('探针那天在月视图里有格子', target); return; }
  const shownTotal = cell.pills + cell.dots + cell.moreN;
  const expect = existing + 6;
  console.log(`       ${target}: 显示 ${cell.pills} 行文字 + 点 ${cell.dots} + ${cell.moreN}（当天应有 ${expect} 条），格高 ${cell.cellH}px`);
  assert(shownTotal === expect, '点那一行真的被触发且数得上（显示行数 + 点 = 当天任务数）', `显示 ${cell.pills}，点 ${cell.dots + cell.moreN}，应为 ${expect}`);
  assert(cell.hasMoreRow && cell.dots + cell.moreN > 0, '格子下方确实画了点行（不再是只有一个点）');
  assert(cell.rowInside, '点那一行在格子内（没被 overflow 裁掉）', `bottom ${cell.rowInside ? '在框内' : '顶出格子'}`);
  assert(!cell.cellScrolls, '格子本身不滚（内容靠省略，不靠滚动）');

  /* 收尾：逐条打删除标记，别让探针留在生产库里 */
  const del = Date.now();
  const done = await apiPush(ids.map((id, i) => ({
    opId: 'e2e-ovf-del-' + id, deviceId: 'e2e-android', ts: del + i, entity: 'task',
    entityId: id, calId, fields: { deleted: true, deletedAt: del + i },
  })));
  assert(done.status === 200, '收尾：探针已清干净');
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

#!/usr/bin/env node
/**
 * android-live-check.mjs —— 安卓真机端到端实测（对标网页端 live-check.mjs）
 *
 * 通过 CDP 驱动真机 WebView，断言同一套核心场景：
 *   core      进应用外壳（日视图时间轴出现）→ 周/月视图渲染 → 零控制台报错
 *   now-line  今天日视图的当前时间线是 --ok 深绿细线、无圆点无时刻文字
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

const BASE = 'https://home.xiaokubao.space/schedule';
const ADB = process.env.ADB || 'C:/Users/小哭包/Android/platform-tools/adb.exe';
const ENV = { ...process.env, MSYS_NO_PATHCONV: '1' };
const PKG = 'space.xiaokubao.schedule';

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
let device = null;
let featArg = 'core,now-line,repeat';
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

  // 刷新 → 同步 → 客户端补齐实例；看月视图
  await reload();
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
  // 等外壳就绪：App 直接进某个视图，先点一下 day 确保日视图挂载
  await tap('button[data-view="day"]'); await wait(800);
  const shell = await evalIn(`!!document.querySelector('.timeline') || !!document.querySelector('.week-cols')`);
  assert(shell, '应用外壳就绪（时间轴/周视图出现）');

  if (FEATURES.has('core')) await checkCore();
  if (FEATURES.has('now-line')) await checkNowLine();
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

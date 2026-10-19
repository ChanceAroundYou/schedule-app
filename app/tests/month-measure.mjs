#!/usr/bin/env node
/**
 * month-measure.mjs —— 量窄屏月视图的横向开销（改前基线 / 改后验收都用它）
 *
 * 打出来的数：
 *   视口宽、内容区宽、格子宽、文字行（.task-pill）宽、字号
 *   每格文字行数、点行数、以及「一行到底放得下几个汉字」（用实测字宽算）
 *
 * 用法：BASE=http://192.168.1.6/schedule node app/tests/month-measure.mjs --device 192.168.1.172:37009
 */
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

const ADB = process.env.ADB || 'C:/Users/小哭包/Android/platform-tools/adb.exe';
const ENV = { ...process.env, MSYS_NO_PATHCONV: '1' };
const argv = process.argv.slice(2);
let device = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--device') device = argv[++i];
  else if (argv[i].startsWith('--device=')) device = argv[i].split('=')[1];
}
if (!device) { console.error('用法: node app/tests/month-measure.mjs --device IP:端口'); process.exit(2); }

execSync(`"${ADB}" connect ${device}`, { stdio: 'ignore', env: ENV });
execSync(`"${ADB}" -s ${device} shell am start -n space.xiaokubao.schedule/.MainActivity`, { stdio: 'ignore', env: ENV });
await new Promise((r) => setTimeout(r, 5000));
execSync(`"${ADB}" connect ${device}`, { stdio: 'ignore', env: ENV });
const socket = execSync(`"${ADB}" -s ${device} shell cat /proc/net/unix`, { encoding: 'utf8', env: ENV })
  .split('\n').map((l) => l.match(/webview_devtools_remote_(\d+)/)?.[1]).find(Boolean);
if (!socket) { console.error('找不到 webview_devtools socket（是 debug 包吗？App 起着吗？）'); process.exit(1); }
const localPort = 9443 + (Number(socket) % 100);
try { execSync(`"${ADB}" forward --remove tcp:${localPort}`, { stdio: 'ignore', env: ENV }); } catch {}
execSync(`"${ADB}" -s ${device} forward tcp:${localPort} localabstract:webview_devtools_remote_${socket}`, { env: ENV });
const list = JSON.parse(execSync(`curl -s http://127.0.0.1:${localPort}/json`, { encoding: 'utf8' }));
const page0 = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page0) { console.error('没有可调试页面'); process.exit(1); }
const ws = await openWs(page0.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onMessage = (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: mid, method, params }));
});
await send('Runtime.enable');
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
/* 进日程页 → 月视图（底栏没有 data-nav，按文本找「日程」） */
await ev(`(function(){
  var j=JSON.parse(localStorage.getItem('schedule-app-v4')||'{}');var s=j.state||j;
  if (s.ui && s.ui.nav !== 'calendar') {
    var el=Array.from(document.querySelectorAll('[data-nav], .tab')).find(function(x){return (x.textContent||'').trim()==='日程'});
    if(el){var b=el.getBoundingClientRect();var x=b.x+b.width/2,y=b.y+b.height/2;var t=document.elementFromPoint(x,y);
      var o={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,button:0};
      t.dispatchEvent(new MouseEvent('mousedown',o));t.dispatchEvent(new MouseEvent('mouseup',o));t.dispatchEvent(new MouseEvent('click',o));}
  }
  return true;
})()`);
await new Promise((r) => setTimeout(r, 600));
await ev(`(function(){var el=document.querySelector('button[data-view="month"]');if(!el)return 'no';
  var b=el.getBoundingClientRect();var x=b.x+b.width/2,y=b.y+b.height/2;var t=document.elementFromPoint(x,y);
  var o={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,button:0};
  t.dispatchEvent(new MouseEvent('mousedown',o));t.dispatchEvent(new MouseEvent('mouseup',o));t.dispatchEvent(new MouseEvent('click',o));return 'ok'})()`);
await new Promise((r) => setTimeout(r, 1200));

const m = await ev(`(function(){
  var content=document.querySelector('#content');
  var grid=document.querySelector('.month-grid');
  var cell=document.querySelector('.month-cell');
  var pill=document.querySelector('.cell-tasks .task-pill');
  var title=pill?pill.querySelector('.pill-title'):null;
  var cs=pill?getComputedStyle(pill):null;
  var cr=cell?cell.getBoundingClientRect():null;
  var pr=pill?pill.getBoundingClientRect():null;
  var gr=grid?grid.getBoundingClientRect():null;
  /* 量一个汉字的真实宽度：塞一个「国」字 span 用同字体量 */
  var probe=document.createElement('span'); probe.style.cssText='position:absolute;visibility:hidden;white-space:nowrap;';
  probe.style.font=cs?cs.font:'10px sans-serif'; probe.textContent='国国国国国';
  document.body.appendChild(probe); var cjkW=probe.getBoundingClientRect().width/5; probe.remove();
  var cells=Array.from(document.querySelectorAll('.month-cell'));
  var rows=new Set(); cells.forEach(function(c){rows.add(Math.round(c.getBoundingClientRect().y))});
  return {
    viewportW: window.innerWidth,
    contentW: content?Math.round(content.getBoundingClientRect().width):0,
    contentPadL: content?getComputedStyle(content).paddingLeft:0,
    gridW: gr?Math.round(gr.width):0,
    gridLeft: gr?Math.round(gr.x):0, gridRight: gr?Math.round(gr.right):0,
    cellW: cr?Math.round(cr.width):0, cellH: cr?Math.round(cr.height):0,
    cellPad: cell?getComputedStyle(cell).paddingLeft:'0',
    pillW: pr?Math.round(pr.width):0, pillH: pr?Math.round(pr.height):0,
    pillPad: cs?cs.paddingLeft:'0', pillBL: cs?cs.borderLeftWidth:'0', font: cs?cs.fontSize:'0',
    cjkW: Math.round(cjkW*10)/10,
    rows: rows.size, cells: cells.length,
    textCells: cells.filter(function(c){return c.querySelector('.task-pill')}).length,
    dotRows: document.querySelectorAll('.pill-more').length,
    pillsPerCellMax: Math.max.apply(null,[0].concat(cells.map(function(c){return c.querySelectorAll('.task-pill').length}))),
  };
})()`);
console.log(JSON.stringify(m, null, 1));
const chars = (w) => (m.cjkW ? (w / m.cjkW).toFixed(1) : '?');
console.log(`\n→ 文字行可用宽 ${m.pillW}px，一个汉字 ${m.cjkW}px → 约 ${chars(m.pillW)} 个汉字`);
console.log(`→ 横向开销：内容区 padding ${m.contentPadL}×2 + 格子 padding ${m.cellPad}×2 + 胶囊 padding ${m.pillPad}×2 + 左色条 ${m.pillBL} = 每格约 ${Math.round(parseFloat(m.contentPadL)*2/7 + parseFloat(m.cellPad)*2 + parseFloat(m.pillPad)*2 + parseFloat(m.pillBL))}px`);
console.log(`→ 网格左边 ${m.gridLeft}px、右边剩 ${m.viewportW - m.gridRight}px（这就是用户说的左右空白）`);
ws.close();
function openWs(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const sock = connect(Number(u.port), u.hostname, () => {
      sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), upgraded = false;
    const ws = {
      onMessage: null,
      send(payload) {
        const data = Buffer.from(payload); const mask = randomBytes(4);
        const masked = Buffer.alloc(data.length);
        for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
        let head;
        if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
        else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xFE; head.writeUInt16BE(data.length, 2); }
        sock.write(Buffer.concat([head, mask, masked]));
      },
      close() { try { sock.destroy(); } catch {} },
    };
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
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len).toString('utf8');
        buf = buf.slice(off + len);
        if (ws.onMessage) ws.onMessage(payload);
      }
    });
    sock.on('error', reject);
  });
}

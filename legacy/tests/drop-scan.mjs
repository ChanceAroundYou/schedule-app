/**
 * 拖放落点扫描 —— 用 CDP 驱动真实 Chrome，测「多列 grid 里拖动到底判到哪」。
 *
 * 为什么不用 iframe：headless 下 iframe.onload 时序不可靠，onload 常常不触发，
 * 拿不到数据就等于没测。CDP 直接 attach 到页面，evaluate 同步跑，可靠。
 *
 * 用法：
 *   1) 起静态服务器：python -m http.server 8901（在工程根目录）
 *   2) node tests/drop-scan.mjs [宽高，默认 1430x900]
 *
 * 输出：每个被拖任务在 zone 内各个落点坐标系下，app.js 判定的插入位置 + 指示线位置。
 * 用途：找出「判错 / 判得反直觉 / 指示线与实际落点不符」的区域，用数据说话。
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 8901
const [W, H] = (process.argv[2] || '1430x900').split('x').map(Number)
/* 注意：Node 的 spawn 只认 Windows 风格路径（反斜杠），
   写 'C:/...' 会 ENOENT —— 那是 Git Bash 的习惯，不是 Node 的。 */
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PY = 'C:\\Users\\小哭包\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe'
const CDP_PORT = 9333 + (process.pid % 200)
const ROOT = 'C:\\飞牛\\家庭文件\\星星包\\coding\\日程管理'

/** 极简 CDP 客户端：只用到 Runtime.evaluate 和 Page.navigate */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map() }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    const c = new CDP(ws)
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && c.waits.has(m.id)) {
        const { res, rej } = c.waits.get(m.id)
        c.waits.delete(m.id)
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      }
    }
    return c
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.waits.set(id, { res, rej }))
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    }
    return r.result.value
  }
}

const SCAN = `(() => {
  const w = window, d = document;
  const D = w.__schedDebug;
  if (!D) return { error: '__schedDebug 未就绪' };
  D.setNav('inbox');

  const zone = d.querySelector('[data-drop="inbox"]');
  if (!zone) return { error: '找不到 [data-drop="inbox"]' };
  const zr = zone.getBoundingClientRect();

  const items = [...zone.querySelectorAll('.task-row[data-id]')].map(el => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.id, title: el.querySelector('.row-title').textContent.trim(),
             left:r.left, right:r.right, top:r.top, bottom:r.bottom,
             cx:Math.round(r.left+r.width/2), cy:Math.round(r.top+r.height/2),
             w:Math.round(r.width), h:Math.round(r.height) };
  });

  const out = {
    zone: { left:Math.round(zr.left), right:Math.round(zr.right),
            top:Math.round(zr.top), bottom:Math.round(zr.bottom) },
    cols: w.getComputedStyle(zone).gridTemplateColumns,
    items, drags: []
  };

  for (const drag of items) {
    D.beginDrag(drag.id);
    const seen = {};
    for (let y = out.zone.top - 4; y <= out.zone.bottom + 4; y += 6) {
      for (let x = out.zone.left - 4; x <= out.zone.right + 4; x += 10) {
        zone.dispatchEvent(new w.DragEvent('dragover', {
          bubbles:true, cancelable:true, clientX:x, clientY:y,
          dataTransfer: new w.DataTransfer()
        }));
        const ref = D.getDropRef();
        const g = D.getGuides();
        const gdesc = g.length
          ? g.map(q => q.cls + '@x' + q.x + ',y' + q.y + ',w' + q.w + ',h' + q.h).join(' + ')
          : '无指示物';
        const key = (ref ? ref.id + (ref.pos === 'before' ? '前' : '后') : '无落点') + '  |  ' + gdesc;
        (seen[key] = seen[key] || []).push([x, y]);
      }
    }
    out.drags.push({
      drag: drag.title,
      regions: Object.entries(seen).map(([k, pts]) => {
        const xs = pts.map(a => a[0]), ys = pts.map(a => a[1]);
        return { key: k, x0: Math.min(...xs), x1: Math.max(...xs),
                 y0: Math.min(...ys), y1: Math.max(...ys), n: pts.length };
      })
    });
  }
  D.endDrag();
  return out;
})()`

/** 轮询直到表达式为真。Page.navigate/reload 返回都不代表新文档已就绪。 */
async function waitFor(cdp, expr, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await sleep(200)
    try { if (await cdp.eval(`!!(${expr})`)) return true } catch { /* 上下文还在换 */ }
  }
  throw new Error('等待超时：' + expr)
}

async function main() {
  const srv = spawn(PY, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' })
  srv.on('error', e => console.error('静态服务器启动失败：' + e.message))
  await sleep(800)

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
    `--window-size=${W},${H}`, '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=C:/Users/小哭包/AppData/Local/Temp/sched-cdp-' + process.pid,
    'about:blank',
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await r.json()
      target = list.find(t => t.type === 'page')
    } catch { /* 还没起来 */ }
  }
  if (!target) { console.error('✗ Chrome 没起来'); cleanup(); return }

  const cdp = await CDP.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  /* 先导航到应用页，再注入数据。
     顺序不能反：about:blank 是 opaque origin，读 localStorage 会 SecurityError。
     而且 Page.navigate 返回不代表新文档已就绪，要显式等 location 变成目标页。 */
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` })
  await waitFor(cdp, `location.origin === 'http://127.0.0.1:${PORT}' && !!window.__schedDebug`)

  await cdp.eval(`(() => {
    const today = new Date().toISOString().slice(0,10);
    const mk = (title, order) => ({ id:'T'+(order+1), title, note:'', date:null, time:null,
      duration:60, done:false,
      repeat:{unit:'none',n:1,weekdays:[],monthday:4,end:null},
      order, createdAt:1750000000000+order*1000, doneAt:null, source:null });
    localStorage.setItem('schedule-app-v1', JSON.stringify({
      version:3, tasks:[mk('任务A',0),mk('任务B',1),mk('任务C',2),mk('任务D',3)],
      trash:[], habits:[], archive:[],
      ui:{nav:'inbox',view:'day',cursor:today,theme:'light',search:'',navOrder:null,navBottom:null}
    }));
    return 1;
  })()`)
  await cdp.send('Page.reload')
  await waitFor(cdp, `!!window.__schedDebug && document.querySelectorAll('.task-row').length > 0`)

  const res = await cdp.eval(SCAN)
  if (res.error) { console.error('✗ ' + res.error); cleanup(); return }

  console.log(`视口 ${W}×${H}`)
  console.log(`zone x[${res.zone.left}..${res.zone.right}] y[${res.zone.top}..${res.zone.bottom}]`)
  console.log(`布局 ${res.cols}`)
  console.log('')
  res.items.forEach(it => console.log(
    `  ${it.title} ${it.id}  x[${it.left}..${it.right}] 中${it.cx}  y[${it.top}..${it.bottom}] 中${it.cy}`))
  console.log('')
  for (const dr of res.drags) {
    console.log(`━━ 拖 ${dr.drag} ━━`)
    for (const r of dr.regions) {
      console.log(`  ${r.key}`)
      console.log(`      x[${r.x0}..${r.x1}] y[${r.y0}..${r.y1}]  ${r.n}点`)
    }
    console.log('')
  }
  cleanup()
}

function cleanup() {
  try { spawn('taskkill', ['/PID', String(process.pid), '/T', '/F'], { stdio: 'ignore', detached: true }).unref() } catch {}
  process.exit(0)
}
main()

/**
 * 落点扫描 v2 —— 打印每个落点的「光标位置 / 目标格 / 落点索引」三元组，
 * 用来人工核对判定是否合乎直觉，以及统计是否存在系统性偏差。
 *
 * 与 drop-assert 的区别：那个只报「不一致」，这个把全貌摊开，
 * 便于判断某处判定到底是 bug 还是本来就该那样。
 *
 * 用法：node tests/drop-scan2.mjs [宽高]
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 8903
const [W, H] = (process.argv[2] || '1430x900').split('x').map(Number)
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PY = 'C:\\Users\\小哭包\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe'
const CDP_PORT = 9633 + (process.pid % 200)
const ROOT = 'C:\\飞牛\\家庭文件\\星星包\\coding\\日程管理'
const TITLES = ['任务A', '任务B', '任务C', '任务D', '任务E']

let chromeRef = null

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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }
}

async function waitFor(cdp, expr, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await sleep(200)
    try { if (await cdp.eval(`!!(${expr})`)) return true } catch {}
  }
  throw new Error('等待超时：' + expr)
}

const SCAN = `(() => {
  const w = window, d = document;
  const D = w.__schedDebug;
  D.setNav('inbox');
  const zone = d.querySelector('[data-drop="inbox"]');
  const zr = zone.getBoundingClientRect();
  const rows = [...zone.querySelectorAll('.task-row[data-id]')].map(el => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.id, title: el.querySelector('.row-title').textContent.trim(),
             left:r.left, right:r.right, top:r.top, bottom:r.bottom };
  });
  const drag = rows[0];

  const grid = [];
  const samples = [];
  D.beginDrag(drag.id);
  for (let y = Math.round(zr.top) - 6; y <= Math.round(zr.bottom) + 6; y += 5) {
    let line = '';
    for (let x = Math.round(zr.left) - 6; x <= Math.round(zr.right) + 6; x += 8) {
      zone.dispatchEvent(new w.DragEvent('dragover', {
        bubbles:true, cancelable:true, clientX:x, clientY:y, dataTransfer:new w.DataTransfer()
      }));
      const hl = zone.querySelector('.ins-hl');
      const ref = D.getDropRef();
      const g = D.getGuides().find(q => q.cls.indexOf('ins-line')>=0 || q.cls.indexOf('ins-bar')>=0);
      if (!hl || !ref) { line += ' '; continue; }
      const cell = rows.find(c => c.id === hl.dataset.id);
      if (!cell) { line += '?'; continue; }
      /* 用中文标题标出「最终顺序里被拖任务会排在哪」——
         直接算 order，比反算 ref 可靠 */
      const sibs = rows.filter(c => c.id !== drag.id).map(c => c.id);
      let k;
      if (ref.pos === 'before') k = sibs.indexOf(ref.id);
      else k = sibs.indexOf(ref.id) + 1;
      line += String(k);
      if (x % 80 === 0 || x === Math.round(zr.left) - 6) {
        samples.push({ x, y, k,
          hl: cell.title,
          guide: g ? (g.cls.indexOf('ins-bar')>=0 ? ('V@x'+g.x+',y'+g.y+',h'+g.h)
                                            : ('H@x'+g.x+',y'+g.y+',w'+g.w)) : '无' });
      }
    }
    grid.push({ y, line });
  }
  D.endDrag();

  return { zone: { left:Math.round(zr.left), top:Math.round(zr.top),
                   right:Math.round(zr.right), bottom:Math.round(zr.bottom) },
           rows, grid, samples };
})()`

async function main() {
  const srv = spawn(PY, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' })
  await sleep(800)
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
    `--window-size=${W},${H}`, '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=C:/Users/小哭包/AppData/Local/Temp/sched-scan2-' + process.pid,
    'about:blank',
  ], { stdio: 'ignore' })
  chromeRef = chrome

  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      target = list.find(t => t.type === 'page')
    } catch {}
  }
  if (!target) { console.error('✗ Chrome 没起来'); shutdown(1) }

  const cdp = await CDP.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` })
  await waitFor(cdp, `location.origin === 'http://127.0.0.1:${PORT}' && !!window.__schedDebug`)
  await cdp.eval(`(() => {
    const today = new Date().toISOString().slice(0,10);
    const T = ${JSON.stringify(TITLES)};
    const mk = (title, order) => ({ id:'T'+(order+1), title, note:'', date:null, time:null,
      duration:60, done:false,
      repeat:{unit:'none',n:1,weekdays:[],monthday:4,end:null},
      order, createdAt:1750000000000+order*1000, doneAt:null, source:null });
    localStorage.setItem('schedule-app-v1', JSON.stringify({
      version:3, tasks:T.map(mk), trash:[], habits:[], archive:[],
      ui:{nav:'inbox',view:'day',cursor:today,theme:'light',search:'',navOrder:null,navBottom:null}
    }));
    return 1;
  })()`)
  await cdp.send('Page.reload')
  await waitFor(cdp, `!!window.__schedDebug && document.querySelectorAll('.task-row').length > 0`)

  const res = await cdp.eval(SCAN)
  console.log(`视口 ${W}×${H}`)
  console.log(`zone x[${res.zone.left}..${res.zone.right}] y[${res.zone.top}..${res.zone.bottom}]`)
  console.log('')
  res.rows.forEach((r, i) => console.log(
    `  ${i}: ${r.title} x[${Math.round(r.left)}..${Math.round(r.right)}] y[${Math.round(r.top)}..${Math.round(r.bottom)}]`))
  console.log('')
  console.log('拖动「任务A」，每格显示「落点索引」（0=仍排最前，1=排第2，…）：')
  console.log('')
  res.grid.forEach(g => console.log(`  y=${String(g.y).padStart(4)} |${g.line}|`))
  console.log('')
  console.log('抽样明细（左列 x=256 与若干 x）：')
  res.samples.slice(0, 40).forEach(s =>
    console.log(`  (${String(s.x).padStart(4)},${String(s.y).padStart(4)})  k=${s.k}  高亮=${s.hl}  ${s.guide}`))
  shutdown(0)
}

function shutdown(code) {
  /* 不能只 taskkill 自己的 PID：chrome 是 spawn 出来的子进程，跑完不清
     会占住 CDP 端口，下次运行连到上次的旧页面，表现为「DOM 里查不到刚建的
     指示物」这种假故障（踩过一次）。所以按进程名兜底清一遍。 */
  try {
    if (chromeRef && !chromeRef.killed) chromeRef.kill('SIGKILL')
    spawn('taskkill', ['/F', '/IM', 'chrome.exe'], { stdio: 'ignore', detached: true }).unref()
  } catch {}
  process.exit(code)
}
main().catch(e => { console.error('✗ ' + e.message); shutdown(1) })

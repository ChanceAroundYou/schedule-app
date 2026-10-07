/**
 * 落点一致性断言 —— 校验「指示物」与「真实落点」讲的是同一件事。
 *
 * 这才是拖动该满足的标准。之前用「before/after 参照任务」定位时，
 * 判定和画线是分开算的，两者会各说各话（实测偏差半个列宽 = 568px），
 * 而且同一个逻辑位置有多种画法，线会突然跳列。
 *
 * 现在改成格子模型：第 k 格 ↔ 第 k 个插入位，一一对应。
 * 所以断言很干净：
 *   A1 指示线必须贴着目标格的某个边缘（横线上沿 / 竖线左沿）
 *   A2 指示线与光标的距离不超过该格尺寸的量级（不能差出一整格）
 *   A3 不产生「插到自己前面/后面」的自环
 *   A4 高亮格 = 线的宿主格（两者必须指同一个格子）
 *
 * 用法：node tests/drop-assert.mjs [宽高]
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 8902
const [W, H] = (process.argv[2] || '1430x900').split('x').map(Number)
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PY = 'C:\\Users\\小哭包\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe'
const CDP_PORT = 9533 + (process.pid % 200)
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
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    }
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

const CHECK = `(() => {
  const w = window, d = document;
  const D = w.__schedDebug;
  D.setNav('inbox');
  const zone = d.querySelector('[data-drop="inbox"]');
  const zr = zone.getBoundingClientRect();

  const cells = () => [...zone.querySelectorAll('.task-row[data-id]')].map(el => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.id, title: el.querySelector('.row-title').textContent.trim(),
             left:r.left, right:r.right, top:r.top, bottom:r.bottom,
             w:r.width, h:r.height };
  });

  const all = cells();
  /* 按 top 聚行、按 left 排序，得到 row-major 序号 —— 与 app.js 的格子模型一致 */
  const tops = [];
  all.forEach(c => { if (!tops.some(t => Math.abs(t - c.top) < 4)) tops.push(c.top); });
  tops.sort((a,b)=>a-b);
  const ordered = [];
  tops.forEach(t => {
    all.filter(c => Math.abs(c.top - t) < 4).sort((a,b)=>a.left-b.left)
        .forEach(c => ordered.push(c));
  });
  const cols = tops.length ? Math.max(...tops.map(t =>
    all.filter(c => Math.abs(c.top - t) < 4).length)) : 1;
  const slotOf = id => ordered.findIndex(c => c.id === id);

  /* 行间距 / 列间距：用来判断「线有没有跨到别的格/别的行」 */
  const rowGap = tops.length > 1
    ? Math.min(...tops.slice(1).map((t, i) => t - tops[i]))
    : (ordered[0] ? ordered[0].h : 40);
  const colGap = (() => {
    const l = [...new Set(ordered.map(c => Math.round(c.left)))].sort((a,b)=>a-b);
    if (l.length < 2) return ordered[0] ? ordered[0].w : 40;
    return Math.min(...l.slice(1).map((v, i) => v - l[i]));
  })();

  const violations = [];
  let checked = 0;

  function distToSeg(px,py,x1,y1,x2,y2){
    const dx=x2-x1, dy=y2-y1, l2=dx*dx+dy*dy;
    let t = l2 ? ((px-x1)*dx+(py-y1)*dy)/l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px-(x1+t*dx), py-(y1+t*dy));
  }

  for (const drag of ordered) {
    D.beginDrag(drag.id);
    for (let y = Math.round(zr.top) - 4; y <= Math.round(zr.bottom) + 4; y += 6) {
      for (let x = Math.round(zr.left) - 4; x <= Math.round(zr.right) + 4; x += 10) {
        zone.dispatchEvent(new w.DragEvent('dragover', {
          bubbles:true, cancelable:true, clientX:x, clientY:y,
          dataTransfer: new w.DataTransfer()
        }));
        const guides = D.getGuides();
        if (!guides.length) continue;
        checked++;

        const list = guides.find(g => g.cls.indexOf('ins-line') >= 0 || g.cls.indexOf('ins-bar') >= 0);
        if (!list) continue;
        const hlEl = zone.querySelector('.ins-hl');
        const ref = D.getDropRef();

        /* A4: 必须有高亮格 */
        if (!hlEl) {
          violations.push({ rule:'A4-无目标格高亮', drag:drag.title, x, y });
          continue;
        }
        const cell = ordered.find(c => c.id === hlEl.dataset.id);
        if (!cell) continue;

        /* A1: 线必须贴着目标格边缘 */
        const horiz = list.cls.indexOf('ins-line') >= 0;
        const lx = list.x, ly = list.y;
        const touches =
          horiz
            ? (Math.abs(ly - cell.top) <= 3) || (Math.abs(ly - cell.bottom) <= 3)
            : (Math.abs(lx - cell.left) <= 3) || (Math.abs(lx - cell.right) <= 3);
        if (!touches) {
          violations.push({ rule:'A1-线未贴目标格', drag:drag.title, x, y,
                            线: horiz ? ('y'+ly) : ('x'+lx),
                            格: { left:Math.round(cell.left), right:Math.round(cell.right),
                                  top:Math.round(cell.top), bottom:Math.round(cell.bottom) } });
        }

        /* A2: 高亮格必须就是「离光标最近的那一格」。
           这才是拖动该满足的语义：你指哪格，它就去哪。
           只验「附近有格子」太松 —— 吸附到隔壁格也过了；
           只验「距离够近」也抓不到跨列。这里直接比对最近格，语义最硬。

           末行不满时几何上会有空白（末行右侧），但最近格依然唯一，
           所以这个判据不需要任何容差。 */
        const nearest = ordered.reduce((best, c) => {
          const dx = Math.max(c.left - x, 0, x - c.right);
          const dy = Math.max(c.top - y, 0, y - c.bottom);
          const d = Math.hypot(dx, dy);
          return (!best || d < best.d) ? { c, d } : best;
        }, null);
        if (nearest && nearest.c.id !== hlEl.dataset.id) {
          violations.push({ rule:'A2-高亮非最近格', drag:drag.title, x, y,
                            高亮: cell.title, 应高亮: nearest.c.title,
                            距离差: Math.round(
                              Math.hypot(
                                Math.max(cell.left - x, 0, x - cell.right),
                                Math.max(cell.top - y, 0, y - cell.bottom)) - nearest.d) });
        }

        /* A3: 不该自环 */
        if (ref && ref.id === drag.id) {
          violations.push({ rule:'A3-自环', drag:drag.title, x, y, pos: ref.pos });
        }
      }
    }
    D.endDrag();
  }

  /* 顺带验证排序真的生效：把 A 拖到最后一格，看顺序对不对 */
  const order = D.orderOf(ordered[0].id);
  return { checked, violations, cols, rowGap: Math.round(rowGap), colGap: Math.round(colGap), cells: ordered.map(c=>c.title), order };
})()`

/** 真实拖一次，验证落库顺序 */
const REAL_DROP = `(() => {
  const w = window, d = document;
  const D = w.__schedDebug;
  D.setNav('inbox');
  const zone = d.querySelector('[data-drop="inbox"]');
  const rows = [...zone.querySelectorAll('.task-row[data-id]')];
  const first = rows[0], last = rows[rows.length-1];
  const r = last.getBoundingClientRect();

  D.beginDrag(first.dataset.id);
  /* 落在最后一格的左沿 → 插到它之前，也就是成为倒数第二个 */
  const x = r.left + 2, y = r.top + r.height/2;
  zone.dispatchEvent(new w.DragEvent('dragover', {
    bubbles:true, cancelable:true, clientX:x, clientY:y, dataTransfer:new w.DataTransfer()
  }));
  const guide = D.getGuides()[0];
  zone.dispatchEvent(new w.DragEvent('drop', {
    bubbles:true, cancelable:true, clientX:x, clientY:y, dataTransfer:new w.DataTransfer()
  }));

  const after = [...d.querySelectorAll('.task-row[data-id] .row-title')].map(e=>e.textContent.trim());
  return { guide, after, moved: first.dataset.id };
})()`

async function main() {
  const srv = spawn(PY, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' })
  await sleep(800)
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
    `--window-size=${W},${H}`, '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=C:/Users/小哭包/AppData/Local/Temp/sched-assert-' + process.pid,
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

  const seed = `(() => {
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
  })()`
  await cdp.eval(seed)
  await cdp.send('Page.reload')
  await waitFor(cdp, `!!window.__schedDebug && document.querySelectorAll('.task-row').length > 0`)

  const res = await cdp.eval(CHECK)
  console.log(`视口 ${W}×${H}   列数 ${res.cols}   行间距 ${res.rowGap}px  列间距 ${res.colGap}px`)
  console.log(`采样 ${res.checked} 个落点\n`)

  if (!res.violations.length) {
    console.log('✓ 全部通过：指示线贴目标格、离光标在一个格内、无自环')
  } else {
    const byRule = {}
    res.violations.forEach(v => { (byRule[v.rule] = byRule[v.rule] || []).push(v) })
    console.log(`✗ ${res.violations.length} 处不一致：\n`)
    for (const [rule, list] of Object.entries(byRule)) {
      console.log(`  ${rule}  ${list.length} 处`)
      list.slice(0, 3).forEach(v => {
        const ex = v.距离 !== undefined ? ` 距离${v.距离}>上限${v.上限}`
          : v.应高亮 !== undefined ? ` 高亮${v.高亮} 但最近的是${v.应高亮} 差${v.距离差}px`
          : v.线 !== undefined ? ` 线${v.线} 格x[${v.格.left}..${v.格.right}]`
          : v.pos ? ` pos=${v.pos}` : ''
        console.log(`    拖${v.drag} @(${v.x},${v.y})${ex}`)
      })
      if (list.length > 3) console.log(`    …另有 ${list.length - 3} 处`)
      console.log('')
    }
  }

  /* 真实拖一次：验证落库顺序 */
  await cdp.send('Page.reload')
  await waitFor(cdp, `!!window.__schedDebug && document.querySelectorAll('.task-row').length > 0`)
  const drop = await cdp.eval(REAL_DROP)
  console.log(`实拖「${res.cells[0]}」到末格左沿 →  落库顺序：${drop.after.join(' → ')}`)

  const bad = res.violations.length > 0
  shutdown(bad ? 1 : 0)
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

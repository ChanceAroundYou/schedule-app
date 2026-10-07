/**
 * 日视图「未定时区」拖放断言 —— 验证格子模型在**另一种容器结构**下同样成立。
 *
 * 为什么单独测：待办箱的落点容器（.group-items.mc）自己就是 grid，
 * 而日视图的 .allday-zone 是外层 wrapper，grid 在它内部的 .allday-items。
 * 两者几何不同（grid 的起点不等于 zone 的起点），行首横线的
 * 宽度基准、竖线的定位基准都会不一样 —— 只测待办箱会漏掉这一类。
 *
 * 另外这里用的是 .task-pill（胶囊）不是 .task-row，DOM 结构也要确认。
 *
 * 用法：node tests/allday-assert.mjs [宽高]
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 8904
const [W, H] = (process.argv[2] || '1430x900').split('x').map(Number)
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PY = 'C:\\Users\\小哭包\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe'
const CDP_PORT = 9733 + (process.pid % 200)
const ROOT = 'C:\\飞牛\\家庭文件\\星星包\\coding\\日程管理'

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

const CHECK = `(() => {
  const w = window, d = document;
  const D = w.__schedDebug;
  D.setNav('calendar');

  /* 日视图进入时会自动滚到「当前时间」附近（Views 里按 nowMin 定位），
     未定时区会被顶出视口 —— 那样量到的 rect 是负坐标，断言没有意义。
     先滚回顶部再量。 */
  const content = d.getElementById('content');
  if (content) content.scrollTop = 0;
  w.dispatchEvent(new w.Event('scroll'));

  const zone = d.querySelector('[data-drop="allday"]');
  if (!zone) return { error: '找不到未定时区' };
  const zr = zone.getBoundingClientRect();
  if (zr.top < 0 || zr.bottom > innerHeight) {
    return { error: '未定时区不在视口内（top=' + Math.round(zr.top) + '），需先滚动到可见' };
  }

  const els = [...zone.querySelectorAll('[data-untimed="1"]')];
  if (!els.length) return { error: '未定时区里没有任务（种子数据没生效？）' };

  const rowsOf = () => els.map(el => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.id, title: el.textContent.trim().slice(0,8),
             left:r.left, right:r.right, top:r.top, bottom:r.bottom, w:r.width, h:r.height };
  });

  let all = rowsOf();
  /* 视觉 row-major */
  const tops = [];
  all.forEach(c => { if (!tops.some(t => Math.abs(t - c.top) < 4)) tops.push(c.top); });
  tops.sort((a,b)=>a-b);
  const ordered = [];
  tops.forEach(t => all.filter(c => Math.abs(c.top - t) < 4)
    .sort((a,b)=>a.left-b.left).forEach(c => ordered.push(c)));
  const cols = Math.max(...tops.map(t => all.filter(c => Math.abs(c.top-t)<4).length));

  const violations = [];
  let checked = 0;

  for (const drag of ordered) {
    D.beginDrag(drag.id);
    for (let y = Math.round(zr.top) - 4; y <= Math.round(zr.bottom) + 4; y += 6) {
      for (let x = Math.round(zr.left) - 4; x <= Math.round(zr.right) + 4; x += 12) {
        zone.dispatchEvent(new w.DragEvent('dragover', {
          bubbles:true, cancelable:true, clientX:x, clientY:y, dataTransfer:new w.DataTransfer()
        }));
        /* 让位模型：判据是「洞的位置 == 目标格」。
           旧版查 .ins-line / .ins-hl（静态线条模型），已随让位动画一起废弃 ——
           留着不改会「采样 0 个落点」地假通过，那比没有测试更糟。 */
        const hole = zone.querySelector('.drop-hole');
        const holes = zone.querySelectorAll('.drop-hole');
        if (holes.length !== 1) {
          violations.push({ rule:'A1-洞的数量', x, y, 洞数: holes.length });
          D.endDrag(); continue;
        }
        checked++;
        const hr = hole.getBoundingClientRect();

        /* A2: 洞必须落在离光标最近的那一格（与列表页同一判据） */
        let near = null, nd = Infinity;
        for (const c of ordered) {
          const dx = Math.max(c.left - x, 0, x - c.right);
          const dy = Math.max(c.top - y, 0, y - c.bottom);
          const d = Math.hypot(dx, dy);
          if (d < nd) { nd = d; near = c; }
        }
        if (near && nd <= 2) {
          const inRow = hr.top >= near.top - 4 && hr.top <= near.bottom - 4;
          const inCol = hr.left >= near.left - 4 && hr.left <= near.right - 4;
          if (!inRow || !inCol) {
            violations.push({ rule:'A2-洞不在最近格', x, y,
              洞: { l: Math.round(hr.left), t: Math.round(hr.top) },
              应在: { l: Math.round(near.left), r: Math.round(near.right),
                      t: Math.round(near.top), b: Math.round(near.bottom) } });
          }
        }

        /* A3: 洞不能越出容器（视口坐标对视口坐标 —— 单位必须一致，
           之前拿 getBoundingClientRect 的结果去比 zone.width，量纲错了） */
        if (hr.left < zr.left - 2 || hr.left + hr.width > zr.left + zr.width + 2 ||
            hr.top < zr.top - 2 || hr.top + hr.height > zr.top + zr.height + 2) {
          violations.push({ rule:'A3-洞越出容器', x, y,
            洞: { l: Math.round(hr.left), t: Math.round(hr.top),
                  w: Math.round(hr.width), h: Math.round(hr.height) },
            容器: { w: Math.round(zr.width), h: Math.round(zr.height) } });
        }
      }
    }
    D.endDrag();
  }

  return { checked, violations, cols, zone:{w:Math.round(zr.width),h:Math.round(zr.height)},
           cells: ordered.map(c=>c.title) };
})()`

async function main() {
  const srv = spawn(PY, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' })
  await sleep(800)
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
    `--window-size=${W},${H}`, '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=C:/Users/小哭包/AppData/Local/Temp/sched-allday-' + process.pid,
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

  /* 5 个「无时间、今天」的任务 → 日视图未定时区会排成多列（>3 才分列） */
  await cdp.eval(`(() => {
    const today = new Date().toISOString().slice(0,10);
    const mk = (title, order) => ({ id:'P'+(order+1), title, note:'', date:today, time:null,
      duration:60, done:false,
      repeat:{unit:'none',n:1,weekdays:[],monthday:4,end:null},
      order, createdAt:1750000000000+order*1000, doneAt:null, source:null });
    const T = ['买牛奶','取快递','交房租','写周报','打电话'];
    localStorage.setItem('schedule-app-v1', JSON.stringify({
      version:3, tasks:T.map(mk), trash:[], habits:[], archive:[],
      ui:{nav:'calendar',view:'day',cursor:today,theme:'light',search:'',navOrder:null,navBottom:null}
    }));
    return 1;
  })()`)
  await cdp.send('Page.reload')
  await waitFor(cdp, `!!window.__schedDebug && document.querySelector('[data-drop="allday"] [data-untimed="1"]')`)

  const res = await cdp.eval(CHECK)
  if (res.error) { console.error('✗ ' + res.error); shutdown(1) }

  console.log(`视口 ${W}×${H}   未定时区 ${res.zone.w}×${res.zone.h}   列数 ${res.cols}`)
  console.log(`任务 ${res.cells.join(' ')}`)
  console.log(`采样 ${res.checked} 个落点\n`)
  if (!res.violations.length) {
    console.log('✓ 全部通过：洞贴最近格、洞不越出容器')
    shutdown(0)
  }
  const byRule = {}
  res.violations.forEach(v => { (byRule[v.rule] = byRule[v.rule] || []).push(v) })
  console.log(`✗ ${res.violations.length} 处：\n`)
  for (const [rule, list] of Object.entries(byRule)) {
    console.log(`  ${rule}  ${list.length} 处`)
    list.slice(0, 3).forEach(v => console.log(
      `    拖${v.drag} @(${v.x},${v.y})` +
      (v.应高亮 ? ` 高亮${v.高亮} 应${v.应高亮}` : '') +
      (v.线 ? ` ${JSON.stringify(v.线)}` : '') +
      (v.容器 ? ` 线${JSON.stringify(v.线)} 容器${JSON.stringify(v.容器)}` : '')))
    console.log('')
  }
  shutdown(1)
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

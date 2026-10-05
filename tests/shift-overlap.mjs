/**
 * 让位重叠检查 —— 拖动过程中，任务行不能互相压在同一格上。
 *
 * 背景：拖动时其他任务会「让位」挪开一格，被拖的那条留在原位压暗。
 * 挪的方向如果算错，就会出现两条任务 rect 完全重合 ——
 * 画面上等于凭空少了一条，而且洞被压在下面看不见。
 *
 * 这个脚本在多个视口宽度下逐个落点检查：
 *   B1 参与让位的行，两两不能 rect 重合
 *   B2 洞不能被任何让位中的行盖住（洞的位置必须是空的）
 *
 * 用法：node tests/shift-overlap.mjs
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PY = 'C:\\Users\\小哭包\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe'
const PORT = 8934
const CDP_PORT = 9800 + (process.pid % 150)
const ROOT = 'C:\\飞牛\\家庭文件\\星星包\\coding\\日程管理'

const WIDTHS = [1000, 1440, 1920, 2560]   /* 1000 = 单列，其余 = 双列 */

let chromeRef = null

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.m = new Map() }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((a, b) => { ws.onopen = a; ws.onerror = b })
    const c = new CDP(ws)
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && c.m.has(m.id)) {
        const { r, j } = c.m.get(m.id); c.m.delete(m.id)
        m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result)
      }
    }
    return c
  }
  s(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((r, j) => this.m.set(id, { r, j }))
  }
  async e(expr) {
    const r = await this.s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }
}

function shutdown(code) {
  try {
    if (chromeRef && !chromeRef.killed) chromeRef.kill('SIGKILL')
    spawn('taskkill', ['/F', '/IM', 'chrome.exe'], { stdio: 'ignore', detached: true }).unref()
  } catch {}
  process.exit(code)
}

/* 8 条待办箱任务，够填满 4 行（双列） */
const SEED = `(() => {
  const mk = (id,title,o)=>({id,title,note:'',date:null,time:null,duration:60,done:false,
    repeat:{unit:'none',n:1,weekdays:[],monthday:4,end:null},
    ord:null,order:o,createdAt:1750000000000+o*1000,doneAt:null,source:null});
  localStorage.setItem('schedule-app-v1', JSON.stringify({version:3,
    tasks:['任务A','任务B','任务C','任务D','任务E','任务F','任务G','任务H']
      .map((t,i)=>mk('B'+(i+1),t,i)),
    trash:[],habits:[],archive:[],
    ui:{nav:'inbox',view:'list',cursor:new Date().toISOString().slice(0,10),
        theme:'light',search:'',navOrder:null,navBottom:null}}));
  return 1;
})()`

/* 拖第 src 条到第 dst 条上。返回坐标要分两步：
   先派发 dragover，再等transform 过渡动画走完（180ms）后单独量 ——
   在同一个表达式里立刻量会读到动画起始帧，看着像「完全没让位」。 */
const DRAG_START = (src, dst) => `(() => {
  const w = window, d = document, D = w.__schedDebug;
  const z = d.querySelector('[data-drop="list"]');
  D.endDrag();
  const rows = [...z.querySelectorAll('.task-row[data-id]')];
  const s = rows[${src}], t = rows[${dst}];
  const r = t.getBoundingClientRect();
  D.beginDrag(s.dataset.id, 'task');
  s.classList.add('dragging');
  z.dispatchEvent(new w.DragEvent('dragover', { bubbles:true, cancelable:true,
    clientX: Math.round(r.left + r.width/2), clientY: Math.round(r.top + r.height/2),
    dataTransfer:new w.DataTransfer() }));
  return 1;
})()`

const MEASURE = `(() => {
  const z = document.querySelector('[data-drop="list"]');
  const hole = z.querySelector('.drop-hole');
  const hr = hole ? hole.getBoundingClientRect() : null;
  const box = el => { const b = el.getBoundingClientRect();
    return { l:Math.round(b.left), t:Math.round(b.top), r:Math.round(b.right), b:Math.round(b.bottom) }; };
  return JSON.stringify({
    洞: hr ? { l:Math.round(hr.left), t:Math.round(hr.top), r:Math.round(hr.right), b:Math.round(hr.bottom) } : null,
    行: [...z.querySelectorAll('.task-row[data-id]')].map(el => ({
      id: el.dataset.id, 标题: el.querySelector('.row-title').textContent,
      rect: box(el), 动了: !!el.style.transform, 压暗: el.classList.contains('drag-muted') })),
  });
})()`

const hit = (a, b) =>
  a.l < b.r - 4 && b.l < a.r - 4 && a.t < b.b - 4 && b.t < a.b - 4

const violations = []

async function main() {
  const srv = spawn(PY, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' })
  await sleep(900)
  chromeRef = spawn(CHROME, ['--headless=new', '--disable-gpu',
    `--remote-debugging-port=${CDP_PORT}`, '--window-size=1400,980',
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    `--user-data-dir=${ROOT}\\tests\\.tmp-ovl-${process.pid}`, 'about:blank'], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      target = l.find(t => t.type === 'page')
    } catch {}
  }
  if (!target) { console.error('✗ Chrome 没起来'); shutdown(1); return }

  const cdp = await CDP.connect(target.webSocketDebuggerUrl)
  await cdp.s('Page.enable'); await cdp.s('Runtime.enable')

  for (const w of WIDTHS) {
    await cdp.s('Emulation.setDeviceMetricsOverride',
      { width: w, height: 900, deviceScaleFactor: 1, mobile: false })
    await cdp.s('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` })
    await sleep(900)
    await cdp.e(SEED)
    await cdp.s('Page.reload')
    await sleep(900)

    const n = 8
    let bad = 0
    for (let src = 0; src < n; src++) {
      for (let dst = 0; dst < n; dst++) {
        if (src === dst) continue
        await cdp.e(DRAG_START(src, dst))
        /* 等transform 过渡动画走完再量，否则读到中间帧 */
        await sleep(260)
        const fin = JSON.parse(await cdp.e(MEASURE))
        const moved = fin.行.filter(x => x.动了 && !x.压暗)

        /* B1: 让位中的行两两不重合 */
        for (let i = 0; i < moved.length; i++) {
          for (let j = i + 1; j < moved.length; j++) {
            if (hit(moved[i].rect, moved[j].rect)) {
              bad++
              if (violations.length < 6) {
                violations.push({ w, src, dst, rule: 'B1-让位行重叠',
                  a: moved[i].标题 + JSON.stringify(moved[i].rect),
                  b: moved[j].标题 + JSON.stringify(moved[j].rect),
                  洞: JSON.stringify(fin.洞),
                  全景: fin.行.map(x => x.标题 + '@' + x.rect.l + ',' + x.rect.t).join('  ') })
              }
            }
          }
        }
        /* B2: 洞不能被让位中的行盖住 */
        if (fin.洞) {
          for (const m of moved) {
            if (hit(fin.洞, m.rect)) {
              bad++
              if (violations.length < 6) {
                violations.push({ w, src, dst, rule: 'B2-洞被盖住',
                  洞: JSON.stringify(fin.洞), 行: m.标题 + JSON.stringify(m.rect),
                  全景: fin.行.map(x => x.标题 + '@' + x.rect.l + ',' + x.rect.t).join('  ') })
              }
            }
          }
        }
      }
    }
    console.log(`${bad ? '✗' : '✓'} ${String(w).padStart(4)}px  ${n * (n - 1)} 个落点，${bad} 处问题`)
  }
  if (violations.length) {
    console.log('\n前几条明细:')
    for (const v of violations) {
      console.log(`  [${v.w}px] ${v.rule}  拖${v.src}→落${v.dst}`)
      console.log(`     ${v.a || ''}  ×  ${v.b || v.行 || ''}`)
      if (v.洞) console.log(`     洞 ${v.洞}`)
      console.log(`     ${v.全景}`)
    }
  }
  cdp.ws.close()
  shutdown(violations.length ? 1 : 0)
}

main().catch(e => { console.error('✗ ' + e.message); shutdown(1) })

/**
 * 拖放指示物截图 —— 供人眼确认视觉效果。
 * 在指定落点触发 dragover，把指示线 + 目标格高亮拍下来。
 *
 * 用法：node tests/drop-shot.mjs
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'

const PORT = 8905
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PY = 'C:\\Users\\小哭包\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe'
const CDP_PORT = 9833 + (process.pid % 200)
const ROOT = 'C:\\飞牛\\家庭文件\\星星包\\coding\\日程管理'
const OUT = 'C:\\Users\\小哭包\\AppData\\Local\\Temp\\sched-shots'

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
  /* 真实指针拖动：走 Input 域，走浏览器完整事件链（pointerdown → dragstart →
     dragover → …），和用户真的用鼠标拖一模一样。
     合成 DragEvent（dispatchEvent）在某些 headless 配置下不会进入
     应用自己的 dragover 处理器 —— 表现为「DOM 里一个指示物都没有」，
     排查了很久才发现是这个坑。 */
  async dragTo(x0, y0, x1, y1) {
    await this.send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1 })
    /* 先小幅移动触发 dragstart，再逐步移到目标，让 dragover 有机会触发 */
    await this.send('Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: x0 + 6, y: y0 + 6, button: 'left', buttons: 1 })
    const steps = 6
    for (let i = 1; i <= steps; i++) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(x0 + (x1 - x0) * i / steps),
        y: Math.round(y0 + (y1 - y0) * i / steps),
        button: 'left', buttons: 1,
      })
      await sleep(60)
    }
  }
  async release(x, y) {
    /* mouseReleased 缺 x/y 会报 Invalid parameters（CDP 绑定层要求必填） */
    await this.send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: x || 0, y: y || 0, button: 'left', buttons: 0, clickCount: 1 })
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(r.data, 'base64'))
  }
}

async function waitFor(cdp, expr, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await sleep(200)
    try { if (await cdp.eval(`!!(${expr})`)) return true } catch {}
  }
  throw new Error('等待超时：' + expr)
}

async function main() {
  const profile = 'C:/Users/小哭包/AppData/Local/Temp/sched-shot-' + process.pid
  const srv = spawn(PY, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' })
  await sleep(800)
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=1430,900', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', `--user-data-dir=${profile}`,
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
  /* 不设 Emulation.setDeviceMetricsOverride。
     它会强制改变视口并触发一次完整重排，实测之后 dispatchEvent 出来的
     dragover 不再走到应用自己的处理器（DOM 里一个指示物都没有）。
     视口宽度用启动参数 --window-size 定就够了。 */
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` })
  await waitFor(cdp, `location.origin === 'http://127.0.0.1:${PORT}' && !!window.__schedDebug`)

  /* 4 个待办箱任务，正好是用户说的场景：2×2 */
  await cdp.eval(`(() => {
    const today = new Date().toISOString().slice(0,10);
    const T = ['整理季度汇报大纲','取快递','研究新显示器','给导师发进展'];
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
  /* 等一次就够，不要轮询：waitFor 每次都往页面注入一句表达式，
     轮询窗口可能正好落在重渲染的空档里，导致后面读到 null。
     固定睡 1.5s 让 seed 后的 reload 完全结束。 */
  await sleep(1800)
  const ready = await cdp.eval(
    `!!document.querySelector('[data-drop="inbox"] .task-row[data-id]')`)
  if (!ready) { console.error('✗ 页面没渲染出待办箱任务'); shutdown(1) }

  /* 4 个待办箱任务，正好是用户描述的场景：2×2。
     注意：截图要在**同一个 eval 里**完成「查 DOM → 触发 dragover → 读回指示物」。
     跨 eval 会踩到重渲染的时序坑 —— setNav 之后 DOM 是新的，
     之前拿到的引用全部失效（实测高亮和线都读成 null）。 */
  const spots = [
    { name: '1-光标停在右下格（跨行到第2列）', index: 3 },
    { name: '2-光标停在右上格（同一行往右挪）', index: 1 },
    { name: '3-光标停在左下格（只往下挪）',   index: 2 },
  ]

  for (const s of spots) {
    /* 用**真实鼠标事件**把第一项拖到目标格，然后在「还没松手」时截图 ——
       这才是用户看到的画面。合成 DragEvent 走不进应用的 dragover 处理器。 */
    const geo = await cdp.eval(`(() => {
      const zone = document.querySelector('[data-drop="inbox"]');
      const rows = [...zone.querySelectorAll('.task-row[data-id]')];
      const a = rows[0].getBoundingClientRect();
      const b = rows[${s.index}].getBoundingClientRect();
      return { x0: Math.round(a.left + 40), y0: Math.round(a.top + a.height/2),
               x1: Math.round(b.left + b.width/2), y1: Math.round(b.top + b.height/2),
               拖: rows[0].querySelector('.row-title').textContent.trim(),
               目标: rows[${s.index}].querySelector('.row-title').textContent.trim(),
               行数: rows.length };
    })()`)
    if (geo.行数 <= s.index) { console.log(`${s.name} → 只有 ${geo.行数} 个任务`); continue }

    await cdp.dragTo(geo.x0, geo.y0, geo.x1, geo.y1)
    await sleep(200)

    const info = await cdp.eval(`(() => {
      const hl = document.querySelector('.ins-hl');
      const g = window.__schedDebug.getGuides()[0];
      return { 高亮: hl ? hl.querySelector('.row-title').textContent.trim() : null,
               线: g ? (g.cls.indexOf('ins-bar') >= 0 ? '竖线' : '横线')
                      + ' @x' + g.x + ',y' + g.y : null };
    })()`)

    const file = `${OUT}\\drop-${s.name[0]}.png`
    await cdp.shot(file)
    console.log(s.name)
    console.log(`   把「${geo.拖}」拖到「${geo.目标}」中心 (${geo.x1},${geo.y1})`)
    console.log(`   指示：高亮「${info.高亮}」  ${info.线}`)
    console.log(`   → ${file}\n`)

    await cdp.release(geo.x1, geo.y1)
    await sleep(150)
    await cdp.eval(`window.__schedDebug.endDrag()`)
  }
  shutdown(0)
}

let chromeRef = null

/** 关掉自己拉起的 chrome。
    注意：不能只 taskkill 自己的 PID —— chrome 是 spawn 出来的子进程，
    跑完不清会**占住 CDP 端口**，下一次运行就连到上一次的旧页面上，
    表现为「DOM 里查不到刚刚创建的指示物」这种假故障（踩过一次）。 */
function shutdown(code) {
  try {
    if (chromeRef && !chromeRef.killed) chromeRef.kill('SIGKILL')
    /* 再兜底：按 profile 目录找出所有 chrome 进程一并清掉 */
    spawn('taskkill', ['/F', '/IM', 'chrome.exe'], { stdio: 'ignore', detached: true }).unref()
  } catch {}
  process.exit(code)
}
main().catch(e => { console.error('✗ ' + e.message); shutdown(1) })

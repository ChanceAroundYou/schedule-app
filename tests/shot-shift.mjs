/**
 * 让位动画截图 —— 肉眼确认「丝滑」这件事真的发生了。
 *
 * 断言只能证明「洞的位置 == 落点」，证明不了「动得顺不顺」。
 * 这个脚本把拖动过程的关键帧截下来：让位前的原位、让位后的滑动中态、
 * 洞的落位，一眼就能看出是不是整列依次挪开。
 *
 * 用法：node tests/shot-shift.mjs
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'

const PORT = 8912
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PY = 'C:\\Users\\小哭包\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe'
const CDP_PORT = 9971
const ROOT = 'C:\\飞牛\\家庭文件\\星星包\\coding\\日程管理'
const OUT = 'C:\\Users\\小哭包\\AppData\\Local\\Temp\\sched-shots'

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
  async shot(file) {
    const r = await this.s('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(r.data, 'base64'))
  }
}
function shutdown(code) {
  try {
    if (chromeRef && !chromeRef.killed) chromeRef.kill('SIGKILL')
    spawn('taskkill', ['/F', '/IM', 'chrome.exe'], { stdio: 'ignore', detached: true }).unref()
  } catch {}
  process.exit(code)
}

const SEED = `(() => {
  const T = new Date().toISOString().slice(0,10);
  const mk = (id,title,o)=>({id,title,note:'',date:null,time:null,duration:60,done:false,
    repeat:{unit:'none',n:1,weekdays:[],monthday:4,end:null},
    ord:null,order:o,createdAt:1750000000000+o*1000,doneAt:null,source:null});
  localStorage.setItem('schedule-app-v1', JSON.stringify({version:3,
    tasks:['整理季度汇报','给导师发进展','取快递','预约体检','交房租','学英语','写周报','订机票']
      .map((t,i)=>mk('B'+(i+1),t,i)),
    trash:[],habits:[],archive:[],
    ui:{nav:'inbox',view:'day',cursor:T,theme:'light',search:'',navOrder:null,navBottom:null}}));
  return 1;
})()`

/* 拖到第 k 格并让位（不清洞，停在让位后的状态） */
const DRAG_START = (k) => `(() => {
  const w = window, d = document, D = w.__schedDebug;
  const z = d.querySelector('[data-drop="list"]');
  /* 先收掉上一次拖动：endDrag 会复位所有 transform，
     否则这里量到的 rect 是让位后的坐标，算出的落点会偏一格 */
  w.__schedDebug.endDrag();
  const rows = [...z.querySelectorAll('.task-row[data-id]')];
  const src = rows[0], dst = rows[${k}];
  const r = dst.getBoundingClientRect();
  const x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2);
  D.beginDrag(src.dataset.id, 'task');
  src.classList.add('dragging');
  z.dispatchEvent(new w.DragEvent('dragover', { bubbles:true, cancelable:true,
    clientX:x, clientY:y, dataTransfer:new w.DataTransfer() }));
  return { 落点: D.getDropRef(), 诊断: D.shiftDebug('[data-drop="list"]') };
})()`

/* 动画走完后再采样：transform transition 是 180ms，
   同步读会拿到中间帧，看着像「没让位」 */
const DRAG_SAMPLE = `(() => {
  const w = window, d = document;
  const z = d.querySelector('[data-drop="list"]');
  const h = z.querySelector('.drop-hole');
  const cells = [...z.querySelectorAll('.task-row[data-id]')];
  return {
    洞: (()=>{const h=z.querySelector('.drop-hole');
      return h?{l:Math.round(h.getBoundingClientRect().left),t:Math.round(h.getBoundingClientRect().top)}:null;})(),
    各行: cells.map(el=>{const b=el.getBoundingClientRect();
      return { 标题: el.querySelector('.row-title').textContent,
               左: Math.round(b.left), 上: Math.round(b.top),
               transform: el.style.transform || '(无)' };}),
    洞文本: h ? h.textContent : '',
  };
})()`

async function main() {
  const srv = spawn(PY, ['-m','http.server',String(PORT),'--bind','127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' })
  await sleep(900)
  const chrome = spawn(CHROME, ['--headless=new','--disable-gpu',
    `--remote-debugging-port=${CDP_PORT}`,'--window-size=1430,980','--no-first-run',
    '--no-default-browser-check','--hide-scrollbars',
    `--user-data-dir=C:/Users/小哭包/AppData/Local/Temp/shot-shift-${process.pid}`,
    'about:blank'], { stdio: 'ignore' })
  chromeRef = chrome

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
  await cdp.s('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` })
  await sleep(1800)
  await cdp.e(SEED)
  await cdp.s('Page.reload')
  await sleep(1800)

  /* 1. 原始状态 */
  await cdp.shot(`${OUT}\\shift-0-before.png`)
  const before = await cdp.e(`[...document.querySelectorAll('[data-drop="list"] .row-title')].map(e=>({
    t: e.textContent, l: Math.round(e.closest('.task-row').getBoundingClientRect().left),
    y: Math.round(e.closest('.task-row').getBoundingClientRect().top) }))`)
  console.log('初始位置:')
  before.forEach(b => console.log(`   ${b.t.padEnd(12)} 左${b.l} 上${b.y}`))

  /* 2. 拖到第 5 格，看让位 */
  const s1 = await cdp.e(DRAG_START(5))
  console.log('第1次拖动诊断: ' + JSON.stringify(s1.诊断))
  await sleep(450)   /* 等过渡动画走完 */
  const st = await cdp.e(DRAG_SAMPLE)
  await cdp.shot(`${OUT}\\shift-1-shifted.png`)
  console.log('\n让位后（洞在 ' + JSON.stringify(st.洞) + '）:')
  st.各行.forEach(r => console.log(`   ${r.标题.padEnd(12)} 左${r.左} 上${r.上}  ${r.transform}`))

  /* 3. 换行拖动（拖到第 2 格，跨行） */
  const s2 = await cdp.e(DRAG_START(2))
  console.log('\n第2次拖动诊断: ' + JSON.stringify(s2.诊断))
  await sleep(450)
  const st2 = await cdp.e(DRAG_SAMPLE)
  await cdp.shot(`${OUT}\\shift-2-crossrow.png`)
  console.log('\n跨行让位（洞在 ' + JSON.stringify(st2.洞) + '）:')
  st2.各行.forEach(r => console.log(`   ${r.标题.padEnd(12)} 左${r.左} 上${r.上}  ${r.transform}`))

  /* 4. 松手后落库 */
  await cdp.e(`(() => {
    const z = document.querySelector('[data-drop="list"]');
    const rows=[...z.querySelectorAll('.task-row[data-id]')];
    const r=rows[2].getBoundingClientRect();
    z.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,
      clientX:Math.round(r.left+r.width/2),clientY:Math.round(r.top+r.height/2),
      dataTransfer:new DataTransfer()}));
    return 1;
  })()`)
  await sleep(500)
  await cdp.shot(`${OUT}\\shift-3-dropped.png`)
  const after = await cdp.e(`[...document.querySelectorAll('[data-drop="list"] .row-title')].map(e=>e.textContent)`)
  console.log('\n松手后顺序: ' + after.join(' → '))

  console.log(`\n截图已保存到 ${OUT}\\shift-*.png`)
  shutdown(0)
}
main().catch(e => { console.error('✗ ' + e.message); shutdown(1) })

/**
 * 视图冒烟 —— 确认改了列表分列之后，日/周/月视图仍然正常渲染。
 * 只看「有没有崩、关键容器在不在、横向有没有溢出」。
 *
 * 用法：node tests/view-smoke.mjs [宽x高]
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const CDP_PORT = 9850 + (process.pid % 100)
const ROOT = 'C:\\飞牛\\家庭文件\\星星包\\coding\\日程管理'
const URL = 'file:///' + ROOT + '/dist/index.html'
const [W, H] = (process.argv[2] || '1920x900').split('x').map(Number)

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

const SEED = `(() => {
  const T = new Date().toISOString().slice(0,10);
  const mk = (id,title,o,opt)=>Object.assign({id,title,note:'',date:null,time:null,
    duration:60,done:false,repeat:{unit:'none',n:1,weekdays:[],monthday:4,end:null},
    ord:null,order:o,createdAt:1750000000000+o*1000,doneAt:null,source:null},opt||{});
  const tasks = [];
  for (let i=0;i<9;i++) tasks.push(mk('B'+i,'待办箱'+(i+1),i));
  for (let i=0;i<7;i++) tasks.push(mk('T'+i,'今天'+(i+1),i,{date:T,time:['09:00','10:30','14:00','16:00'][i%4]}));
  for (let i=0;i<6;i++) tasks.push(mk('O'+i,'逾期'+(i+1),i,{date:'2026-10-01'}));
  const habits = Array.from({length:6},(_,i)=>({id:'H'+i,title:'习惯'+(i+1),order:i,log:{},createdAt:i}));
  localStorage.setItem('schedule-app-v1', JSON.stringify({version:3, tasks,
    trash:[], habits, archive:[],
    ui:{nav:'calendar',view:'day',cursor:T,theme:'light',search:'',navOrder:null,navBottom:null}}));
  return 1;
})()`

const CASES = [
  { view: 'day',   nav: 'calendar', must: ['.timeline', '.allday-zone'] },
  { view: 'week',  nav: 'calendar', must: ['.week-view', '.week-col'] },
  { view: 'month', nav: 'calendar', must: ['.month-view', '.month-cell'] },
  { view: 'day',   nav: 'inbox',    must: ['.mc .task-row'] },
  { view: 'day',   nav: 'habits',   must: ['.habit-list .habit-row'] },
]

const bad = []

async function main() {
  chromeRef = spawn(CHROME, ['--headless=new', '--disable-gpu',
    `--remote-debugging-port=${CDP_PORT}`, `--window-size=${W},${H}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    `--user-data-dir=${ROOT}\\tests\\.tmp-smoke-${process.pid}`, 'about:blank'], { stdio: 'ignore' })
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
  await cdp.s('Page.navigate', { url: URL })
  await sleep(900)
  await cdp.e(SEED)

  for (const c of CASES) {
    await cdp.e(`(() => {
      const s = JSON.parse(localStorage.getItem('schedule-app-v1'));
      s.ui.view = '${c.view}'; s.ui.nav = '${c.nav}';
      localStorage.setItem('schedule-app-v1', JSON.stringify(s));
      location.reload();
    })()`)
    await sleep(800)
    const err = await cdp.e(`(window.__errs||[]).length`)
    const info = await cdp.e(`(() => {
      const need = ${JSON.stringify(c.must)};
      const miss = need.filter(s => !document.querySelector(s));
      const de = document.documentElement;
      return JSON.stringify({
        miss,
        横向溢出: de.scrollWidth > de.clientWidth + 1 ? de.scrollWidth + '>' + de.clientWidth : '无',
        视图节点: document.querySelectorAll('.task-row,.task-el,.habit-row,.month-cell').length,
      });
    })()`)
    const r = JSON.parse(info)
    const ok = !r.miss.length && r.横向溢出 === '无' && !err && r.视图节点 > 0
    if (!ok) bad.push({ c, r, err })
    console.log(`${ok ? '✓' : '✗'} ${c.nav}/${c.view}`.padEnd(22) +
      `节点 ${String(r.视图节点).padStart(3)}  横向溢出 ${r.横向溢出}` +
      (r.miss.length ? `  缺失 ${r.miss.join(',')}` : '') + (err ? `  JS报错 ${err}` : ''))
  }
  cdp.ws.close()
  console.log('')
  console.log(bad.length ? `❌ ${bad.length} 项异常` : `✅ ${CASES.length} 项全部正常（视口 ${W}×${H}）`)
  shutdown(bad.length ? 1 : 0)
}
main().catch(e => { console.error('✗ ' + e.message); shutdown(1) })

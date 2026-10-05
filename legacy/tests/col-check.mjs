/**
 * 列数核对 —— 断言「电脑版一行最多放两个任务」。
 *
 * 需求：待办箱 / 今天 / 逾期 / 今天已完成 / 已完成 / 打卡
 * 这些列表在宽屏下不要分太多列，一行最多 2 个。
 *
 * 做法：种足数据（每个列表 ≥ 8 条，保证能填满多行），
 * 逐个视口宽度读getComputedStyle().gridTemplateColumns 的轨道数。
 * 非 grid（display:block）算 1 列，grid 就数轨道条数。
 *
 * 用法：node tests/col-check.mjs
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const CDP_PORT = 9700 + (process.pid % 120)
const ROOT = 'C:\\飞牛\\家庭文件\\星星包\\coding\\日程管理'
const URL = 'file:///' + ROOT + '/dist/index.html'

/* 视口宽度：覆盖到 4K，重点看 ≥1560 的那几档旧规则有没有被清掉 */
const WIDTHS = [900, 1119, 1120, 1440, 1680, 1920, 2560, 3440]
const MAX_COLS = 2

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

function shutdown(code) {
  try {
    if (chromeRef && !chromeRef.killed) chromeRef.kill('SIGKILL')
    spawn('taskkill', ['/F', '/IM', 'chrome.exe'], { stdio: 'ignore', detached: true }).unref()
  } catch {}
  process.exit(code)
}

/* 每个列表都放 9 条，够填满 4 行多，列数一多就看得出来 */
const SEED = `(() => {
  const T = new Date().toISOString().slice(0,10);
  const D = n => { const d = new Date(); d.setDate(d.getDate()+n);
    return d.toISOString().slice(0,10); };
  const mkTask = (id, title, o, opt) => Object.assign({
    id, title, note:'', date:null, time:null, duration:60, done:false,
    repeat:{unit:'none',n:1,weekdays:[],monthday:4,end:null},
    ord:null, order:o, createdAt:1750000000000+o*1000, doneAt:null, source:null
  }, opt||{});
  const mkHabit = (id, title, o) => ({ id, title, order:o, log:{}, createdAt:1750000000000+o*1000 });
  const many = (pre, opt, n) => Array.from({length:n}, (_,i) =>
    mkTask(pre+i, pre+i, i, Object.assign({}, opt, {order:i})));

  const tasks = [
    ...many('B', null, 9),                              /* 待办箱 9 */
    ...many('T', {date:T}, 9),                /* 今天 9 */
    ...many('O', {date:D(-1)}, 9),                /* 逾期 9 */
    ...many('D', {done:true,date:D(-1),doneAt:1750000000000}, 9), /* 已完成 9 */
  ];
  const habits = Array.from({length:9}, (_,i) => mkHabit('H'+i,'习'+i,i));

  localStorage.setItem('schedule-app-v1', JSON.stringify({
    version:3, tasks, trash:[], habits, archive:[],
    ui:{nav:'inbox',view:'list',cursor:T,theme:'light',search:'',
        navOrder:null,navBottom:null,tdoneOpen:true}
  }));
  return 1;
})()`

const NAVS = ['inbox', 'today', 'overdue', 'done', 'habits']

/* 读每个 .mc 容器的列数。display:block 记1 列，grid 数轨道条数。 */
const READ = `(() => {
  const out = [];
  document.querySelectorAll('.mc').forEach(z => {
    const cs = getComputedStyle(z);
    const kids = z.querySelectorAll(':scope > .task-row, :scope > .habit-row').length;
    if (!kids) return;
    const cols = cs.display === 'grid' || cs.display === 'inline-grid'
      ? cs.gridTemplateColumns.split(' ').filter(Boolean).length : 1;
    out.push({ scope: z.dataset.scope || '(无scope)', cols, kids, w: Math.round(z.getBoundingClientRect().width) });
  });
  return out;
})()`

const violations = []

async function run() {
  chromeRef = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--disable-gpu',
    '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + ROOT + '\\tests\\.tmp-cols-profile',
    '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const tabs = await r.json()
      target = tabs.find(t => t.type === 'page')
    } catch {}
    if (!target) await sleep(250)
  }
  if (!target) throw new Error('CDP 连接失败')

  const cdp = await CDP.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  for (const w of WIDTHS) {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: w, height: 900, deviceScaleFactor: 1, mobile: false })

    for (const nav of NAVS) {
      await cdp.send('Page.navigate', { url: URL })
      await sleep(500)
      await cdp.eval(SEED)
      /* 直接改 localStorage 再刷新 —— 别用 DB.setNav，它会先按旧状态渲染一帧，
         量到的是上一个页面的容器（inbox 那行曾读成 habits 就是这个坑）。 */
      await cdp.eval(`(() => {
        const s = JSON.parse(localStorage.getItem('schedule-app-v1'));
        s.ui.nav = '${nav}';
        localStorage.setItem('schedule-app-v1', JSON.stringify(s));
        location.reload();
      })()`)
      await sleep(700)
      const rows = JSON.parse(await cdp.eval(`JSON.stringify(${READ})`))
      report(w, nav, rows)
    }
  }
  cdp.ws.close()
}

function report(w, nav, rows) {
  const line = rows.map(r => `${r.scope}:${r.cols}列×${r.kids}项`).join(' ')
  const bad = rows.filter(r => r.cols > MAX_COLS)
  if (bad.length) {
    violations.push({ w, nav, bad })
    console.log(`✗ ${String(w).padStart(4)}px ${nav.padEnd(8)} ${line}`)
  } else {
    console.log(`✓ ${String(w).padStart(4)}px ${nav.padEnd(8)} ${line}`)
  }
}

try {
  await run()
} catch (e) {
  console.error('运行失败：', e.message)
  shutdown(1)
}

console.log('')
if (violations.length) {
  console.log(`❌ ${violations.length} 处超过 ${MAX_COLS} 列`)
  shutdown(1)
} else {
  console.log(`✅ 全部视口下所有列表都≤ ${MAX_COLS} 列`)
  shutdown(0)
}

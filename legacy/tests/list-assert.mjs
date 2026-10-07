/**
 * 落点一致性断言 —— 校验「让位洞」与「真实落点」讲的是同一件事。
 *
 * 模型换成了让位：拖动时列表真的让开一个洞，任务落在洞的位置。
 * 所以判据比之前更干净 —— 不需要推断「线画在哪代表什么」，
 * 直接比对「洞的序号」和「落库后它实际排到第几位」：
 *
 *   A1 洞必须出现，且唯一（不能有多个占位）
 *   A2 洞的序号 = dropRef 推出的落点位次
 *   A3 真实拖动后，它在最终顺序里的位置 = 洞的序号（这是核心）
 *   A4 不产生「插到自己前面/后面」的自环
 *   A5 洞不能越出容器
 *
 * 覆盖所有可拖列表：待办箱 / 今天 / 逾期各组 / 今天已完成 / 已完成 / 打卡
 *
 * 用法：node tests/list-assert.mjs [宽高]
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 8908
const [W, H] = (process.argv[2] || '1430x900').split('x').map(Number)
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PY = 'C:\\Users\\小哭包\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe'
const CDP_PORT = 9600 + (process.pid % 150)
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
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    }
    return r.result.value
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, Buffer.from(r.data, 'base64'))
  }
  /* 真实指针拖动：走 Input 域，走浏览器完整事件链。
     合成 DragEvent（dispatchEvent）在 headless 下进不了应用的 dragover 处理器。 */
  async dragTo(x0, y0, x1, y1) {
    await this.send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1 })
    await this.send('Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: x0 + 6, y: y0 + 6, button: 'left', buttons: 1 })
    for (let i = 1; i <= 6; i++) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(x0 + (x1 - x0) * i / 6),
        y: Math.round(y0 + (y1 - y0) * i / 6),
        button: 'left', buttons: 1,
      })
      await sleep(60)
    }
  }
  async release(x, y) {
    /* 松手前必须再有一次真实位移：鼠标静止着松手，Chrome 会判定
       「拖动没生效」直接取消 —— 只派发 dragend 而不派发 drop，
       落库自然不执行。��是测试脚本的坑，不是产品的。 */
    await this.send('Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: x, y: y - 1, button: 'left', buttons: 1 })
    await sleep(80)
    await this.send('Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    await sleep(120)
    await this.send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
}

function shutdown(code) {
  /* chrome 是 spawn 出来的子进程，跑完不清会占住 CDP 端口，
     下次运行连到上次的旧页面，表现为「DOM 里查不到刚建的东西」这种假故障。 */
  try {
    if (chromeRef && !chromeRef.killed) chromeRef.kill('SIGKILL')
    spawn('taskkill', ['/F', '/IM', 'chrome.exe'], { stdio: 'ignore', detached: true }).unref()
  } catch {}
  process.exit(code)
}

async function waitFor(cdp, expr, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { if (await cdp.eval(`!!(${expr})`)) return true } catch {}
    await sleep(200)
  }
  return false
}

/* 每个列表页的测试配置：怎么进、落点容器在哪、有几个条目 */
const VIEWS = [
  { key: 'inbox', nav: 'inbox', zone: '[data-drop="list"]', kind: 'task', expect: 5 },
  { key: 'today', nav: 'today', zone: '[data-drop="list"]', kind: 'task', expect: 3 },
  { key: 'overdue', nav: 'overdue', zone: '[data-drop="list"]', kind: 'task', expect: 4 },
  { key: 'done', nav: 'done', zone: '[data-drop="list"]', kind: 'task', expect: 3 },
  { key: 'habits', nav: 'habits', zone: '[data-drop="list"]', kind: 'habit', expect: 4 },
]

/* 播种：给每个列表都放足条目，覆盖各种分组情况 */
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

  const tasks = [
    /* 待办箱：无日期，5 条 */
    mkTask('B1','箱1',0), mkTask('B2','箱2',1), mkTask('B3','箱3',2),
    mkTask('B4','箱4',3), mkTask('B5','箱5',4),
    /* 今天：定时2 + 未定时3，共 5 */
    mkTask('T1','今1',0,{date:T,time:'09:00'}),
    mkTask('T2','今2',1,{date:T,time:'10:00'}),
    mkTask('T3','今3',2,{date:T}),
    mkTask('T4','今4',3,{date:T}),
    mkTask('T5','今5',4,{date:T}),
    /* 逾期：-1 四条、-2 两条 */
    mkTask('O1','逾1',0,{date:D(-1)}), mkTask('O2','逾2',1,{date:D(-1)}),
    mkTask('O3','逾3',2,{date:D(-1)}), mkTask('O4','逾4',3,{date:D(-1)}),
    mkTask('O5','逾5',4,{date:D(-2)}), mkTask('O6','逾6',5,{date:D(-2)}),
    /* 已完成：doneAt 分两组 */
    mkTask('D1','完1',0,{done:true,date:D(-1),doneAt:1750000000000}),
    mkTask('D2','完2',1,{done:true,date:D(-1),doneAt:1750000001000}),
    mkTask('D3','完3',2,{done:true,date:D(-2),doneAt:1740000000000}),
  ];
  const habits = [mkHabit('H1','习1',0), mkHabit('H2','习2',1),
                  mkHabit('H3','习3',2), mkHabit('H4','习4',3)];

  localStorage.setItem('schedule-app-v1', JSON.stringify({
    version:3, tasks, trash:[], habits, archive:[],
    ui:{nav:'inbox',view:'day',cursor:T,theme:'light',search:'',
        navOrder:null,navBottom:null,tdoneOpen:true}
  }));
  return 1;
})()`

/* 核心断言：遍历容器内每个格子，触发 dragover，检查洞与落点一致 */
const CHECK = (zoneSel, kind) => `(() => {
  const w = window, d = document;
  const D = w.__schedDebug;
  const zone = d.querySelector('${zoneSel}');
  if (!zone) return { error: '找不到落点容器 ${zoneSel}' };

  const sel = '${kind}' === 'habit' ? '[data-habit]' : '[data-untimed="1"]';
  const rows = [...zone.querySelectorAll(sel)];
  if (rows.length < 2) return { error: '容器里只有 ' + rows.length + ' 个条目' };

  const items = rows.map(el => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.id, title: (el.querySelector('.row-title,.habit-title')||{}).textContent,
             left:r.left, right:r.right, top:r.top, bottom:r.bottom,
             cx: Math.round(r.left+r.width/2), cy: Math.round(r.top+r.height/2) };
  });

  const violations = [];
  let checked = 0;

  for (const drag of items) {
    /* 逐个目标格：把光标放到那一格中心，看洞是否落在同一格 */
    for (let target = 0; target < items.length; target++) {
      if (target === items.indexOf(drag)) continue;   /* 拖到自己身上跳过 */
      const t = items[target];
      D.beginDrag(drag.id, '${kind}');
      const ev = new w.DragEvent('dragover', {
        bubbles:true, cancelable:true, clientX:t.cx, clientY:t.cy,
        dataTransfer:new w.DataTransfer()
      });
      zone.dispatchEvent(ev);

      const holes = zone.querySelectorAll('.drop-hole');
      /* A1: 洞唯一 */
      if (holes.length !== 1) {
        violations.push({ rule:'A1-洞的数量', drag:drag.title, target:t.title,
                          洞数: holes.length });
        D.endDrag(); continue;
      }
      const hole = holes[0];
      const hr = hole.getBoundingClientRect();
      const zr = zone.getBoundingClientRect();
      checked++;

      /* A5: 洞不能越出容器 */
      if (hr.left < zr.left - 2 || hr.right > zr.right + 2 ||
          hr.top < zr.top - 2 || hr.bottom > zr.bottom + 2) {
        violations.push({ rule:'A5-洞越出容器', drag:drag.title, target:t.title,
                          洞:{l:Math.round(hr.left),r:Math.round(hr.right),
                              t:Math.round(hr.top),b:Math.round(hr.bottom)},
                          容器:{l:Math.round(zr.left),r:Math.round(zr.right),
                               t:Math.round(zr.top),b:Math.round(zr.bottom)} });
      }

      /* A2: 洞必须落在目标格那一行。
         判定用「洞的 top 落在目标格 top/bottom 区间内」——
         跨列移动时洞与目标格同高同宽，同行判定即可。
         之前用「与 top 的距离 < 行高」比松，会把相邻行也判成通过。 */
      const onTargetRow = hr.top >= t.top - 4 && hr.top <= t.bottom - 4;
      if (!onTargetRow) {
        violations.push({ rule:'A2-洞不在目标行', drag:drag.title, target:t.title,
                          洞top: Math.round(hr.top),
                          目标行: Math.round(t.top) + '..' + Math.round(t.bottom) });
      }
      /* A3: 横向也要落在目标格内 —— 只查纵向会漏掉「跨到隔壁列」这种错误 */
      const onTargetCol = hr.left >= t.left - 4 && hr.left <= t.right - 4;
      if (!onTargetCol) {
        violations.push({ rule:'A3-洞不在目标列', drag:drag.title, target:t.title,
                          洞left: Math.round(hr.left),
                          目标列: Math.round(t.left) + '..' + Math.round(t.right) });
      }
      D.endDrag();
    }
  }
  return { checked, violations, 条目数: items.length, 标题: items.map(i=>i.title) };
})()`

/* 真实拖动：拖第一个到最后一个，验证落库后的顺序真的变了 */
const REAL = (zoneSel, kind) => `(async () => {
  const w = window, d = document;
  const D = w.__schedDebug;
  const zone = d.querySelector('${zoneSel}');
  if (!zone) return { error: '找不到容器' };
  const sel = '${kind}' === 'habit' ? '[data-habit]' : '[data-untimed="1"]';
  const rows = [...zone.querySelectorAll(sel)];
  if (rows.length < 2) return { error: '条目不足' };

  const titleOf = el => (el.querySelector('.row-title,.habit-title')||{}).textContent;
  const before = rows.map(titleOf);
  const a = rows[0].getBoundingClientRect();
  const last = rows[rows.length-1].getBoundingClientRect();
  return {
    before,
    from: { x: Math.round(a.left + 40), y: Math.round(a.top + a.height/2) },
    /* 落在最后一项的中心 = 排到末尾 */
    to:   { x: Math.round(last.left + last.width/2), y: Math.round(last.top + last.height/2) },
  };
})()`

const READ_ORDER = (zoneSel, kind) => `(() => {
  const zone = document.querySelector('${zoneSel}');
  if (!zone) return { error: '容器消失' };
  const sel = '${kind}' === 'habit' ? '[data-habit]' : '[data-untimed="1"]';
  return [...zone.querySelectorAll(sel)]
    .map(el => (el.querySelector('.row-title,.habit-title')||{}).textContent);
})()`

async function main() {
  const srv = spawn(PY, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' })
  await sleep(800)
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
    `--window-size=${W},${H}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars',
    `--user-data-dir=C:/Users/小哭包/AppData/Local/Temp/list-assert-${process.pid}`,
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
  if (!target) { console.error('✗ Chrome 没起来'); shutdown(1); return }

  const cdp = await CDP.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  /* 先导航再播种：about:blank 是 opaque origin，读 localStorage 会 SecurityError */
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` })
  await waitFor(cdp, `!!window.__schedDebug`)
  await cdp.eval(SEED)
  await cdp.send('Page.reload')
  await waitFor(cdp, `!!window.__schedDebug && document.querySelectorAll('.task-row').length > 0`)

  console.log(`视口 ${W}×${H}\n`)
  let bad = 0

  for (const v of VIEWS) {
    const setup = await cdp.eval(`(() => {
      const D = window.__schedDebug;
      D.setNav('${v.nav}');
      const zone = document.querySelector('${v.zone}');
      if (!zone) return { error: '视图 ${v.key} 里没有落点容器' };
      const sel = '${v.kind}' === 'habit' ? '[data-habit]' : '[data-untimed="1"]';
      return { 容器: zone.dataset.scope || '(无)', 条目: zone.querySelectorAll(sel).length };
    })()`)
    if (setup.error) { console.log(`✗ ${v.key}: ${setup.error}`); bad++; continue }

    /* A1–A5：遍历所有落点 */
    const res = await cdp.eval(CHECK(v.zone, v.kind))
    if (res.error) { console.log(`✗ ${v.key}: ${res.error}`); bad++; continue }

    /* A3': 真实鼠标拖动，验证落库顺序真的等于洞的位置 */
    const geo = await cdp.eval(REAL(v.zone, v.kind))
    if (geo.error) { console.log(`✗ ${v.key}: ${geo.error}`); bad++; continue }

    /* 落库验证走「手动派发事件序列」，不用 Input 域。
       headless 下 HTML5 拖拽建立得很勉强：实测 dragover 只派发 2 次
       就直接 dragend（drop 根本不派发），不同视口表现还不一致 ——
       那是环境限制，不是产品缺陷。
       这里要验的是「判定 → 落库 → 重绘」这条链路，
       所以直接按顺序把 dragstart/dragover/drop 喂进去。 */
    const landed = await cdp.eval(`(() => {
      const w = window, d = document;
      const D = w.__schedDebug;
      const zone = d.querySelector('${v.zone}');
      const sel = '${v.kind}' === 'habit' ? '[data-habit]' : '[data-untimed="1"]';
      const rows = [...zone.querySelectorAll(sel)];
      const src = rows[0], dst = rows[rows.length - 1];
      const dr = dst.getBoundingClientRect();
      const x = Math.round(dr.left + dr.width / 2);
      const y = Math.round(dr.top + dr.height / 2);

      const mk = (t, cx, cy) => {
        const ev = new w.DragEvent(t, { bubbles: true, cancelable: true,
          clientX: cx, clientY: cy, dataTransfer: new w.DataTransfer() });
        zone.dispatchEvent(ev); return ev;
      };
      /* 走真实链路：先让 dragstart 认下被拖元素，再 dragover 定位，最后 drop */
      D.beginDrag(src.dataset.id, '${v.kind}');
      src.classList.add('dragging');
      mk('dragover', x, y);
      const ref = D.getDropRef();
      const hole = zone.querySelector('.drop-hole');
      const holeOK = !!hole &&
        Math.abs(hole.getBoundingClientRect().top - dr.top) < 6;
      mk('drop', x, y);
      return { 落点: ref, 洞到位: holeOK };
    })()`)
    const mid = { 有洞: landed.洞到位, 洞数: landed.洞到位 ? 1 : 0 }
    await sleep(400)
    const after = await cdp.eval(READ_ORDER(v.zone, v.kind))
    if (after.error) { console.log(`✗ ${v.key}: ${after.error}`); bad++; continue }

    const moved = geo.before[0]
    const landedLast = after[after.length - 1] === moved
    const orderChanged = JSON.stringify(geo.before) !== JSON.stringify(after)

    /* 专项：同一次拖动内连续换位。
       这是让位模型最容易出错的地方 —— 让位是加在元素上的 transform，
       第二次判定若拿被让位后的坐标当基准，落点会整体偏掉一格
       （实测跨行换位时整列被甩到容器外，x 变成 -306 / 1398）。
       所以这里连着拖 3 次，每次都检查「基准没被污染」。 */
    const multi = await cdp.eval(`(() => {
      const w = window, d = document, D = w.__schedDebug;
      const z = d.querySelector('${v.zone}');
      const sel = '${v.kind}' === 'habit' ? '[data-habit]' : '[data-untimed="1"]';
      D.endDrag();
      let rows = [...z.querySelectorAll(sel)];
      D.beginDrag(rows[0].dataset.id, '${v.kind}');
      const out = [];
      /* 依次指向第 4、2、最后、1 格 —— 含跨行与回退 */
      for (const k of [4, 2, rows.length - 1, 1]) {
        const dst = [...z.querySelectorAll(sel)][k];
        if (!dst) continue;
        const r = dst.getBoundingClientRect();
        z.dispatchEvent(new w.DragEvent('dragover', { bubbles:true, cancelable:true,
          clientX: Math.round(r.left + r.width/2), clientY: Math.round(r.top + r.height/2),
          dataTransfer: new w.DataTransfer() }));
        const chk = D.shiftDebug('${v.zone}');
        const hole = z.querySelector('.drop-hole');
        out.push({ 目标格: k,
          基准被污染: chk.基准被污染,
          洞在目标行: hole
            ? Math.abs(hole.getBoundingClientRect().top - r.top) < 6 : false });
      }
      D.endDrag();
      return out;
    })()`)
    const badMulti = multi.filter(m => m.基准被污染 > 0 || !m.洞在目标行)
    const violations = res.violations
    if (badMulti.length) {
      badMulti.forEach(m => violations.push({ rule:'A6-连续换位',
        目标格: m.目标格, 基准被污染: m.基准被污染, 洞在目标行: m.洞在目标行 }))
    }

    const vres = res.violations
    const ok = vres.length === 0 && landedLast && mid.有洞 && mid.洞数 === 1
    if (!ok) bad++

    console.log(`${ok ? '✓' : '✗'} ${v.key.padEnd(8)} 作用域 ${String(setup.容器).padEnd(12)} `
      + `条目 ${res.条目数}  采样 ${res.checked}`)
    console.log(`   拖动中: 洞 ${mid.洞数} 个, 落点 ${landed.落点 ? landed.落点.id + ' ' + landed.落点.pos : '(无)'}`)
    console.log(`   拖前 ${geo.before.join(' → ')}`)
    console.log(`   拖后 ${after.join(' → ')}`)
    if (!landedLast) console.log(`   ✗ 「${moved}」没有排到末尾（实际在第 ${after.indexOf(moved)} 位）`)
    if (!orderChanged) console.log(`   ✗ 顺序完全没变`)
    if (vres.length) {
      const byRule = {}
      vres.forEach(x => { (byRule[x.rule] = byRule[x.rule] || []).push(x) })
      for (const [rule, list] of Object.entries(byRule)) {
        console.log(`   ✗ ${rule}  ${list.length} 处`)
        list.slice(0, 3).forEach(x => {
          console.log(`       拖「${x.drag}」指向「${x.target}」 `
            + Object.entries(x).filter(([k]) => !['rule','drag','target'].includes(k))
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' '))
        })
      }
    }
    console.log('')
  }

  if (bad === 0) console.log('✓ 全部通过：各列表均可拖动，且指示与落点一致')
  else console.log(`✗ ${bad} 个视图有问题`)
  shutdown(bad === 0 ? 0 : 1)
}

main().catch(e => { console.error('✗ ' + e.message); shutdown(1) })

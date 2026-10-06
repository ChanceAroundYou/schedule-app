/**
 * smoke.mjs —— 端到端冒烟：注册 → 建任务 → 勾选 → 刷新 → 服务端确认
 *
 * 纯 Node + CDP 驱动真实 Chromium，零 npm 依赖（和 legacy/tests 一个路子）。
 * 这是「新版到底能不能用」的最低证据：单测覆盖的是纯函数，它们全绿也说明不了
 * 登录表单能提交、相对路径的 API 打得通、localStorage 里的数据能活过刷新。
 *
 * 跑法（先起后端和静态服务器，脚本不自己起，避免端口打架）：
 *   SCHEDULE_DATA_DIR=/tmp/x node server/server.js            # 终端 1
 *   npx vite preview --host 127.0.0.1 --port 5199             # 终端 2
 *   node app/tests/smoke.mjs                                  # 终端 3
 *
 * 退出码 1 = 有问题。
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME || '/home/xiaokubao/.local/bin/chromium';
const BASE = process.env.BASE || 'http://127.0.0.1:5199/';
const PORT = 9333;
const PROFILE = `/tmp/sched-smoke-profile-${Date.now()}`;

let nextId = 1;
const pending = new Map();
let ws;

/* ------------------------------------------------------------ CDP 驱动 */

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

async function evalJs(sessionId, expression) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, sessionId);
  if (r.exceptionDetails) {
    throw new Error('页面里抛错了: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
}

/** 轮询到条件成立为止，别用固定 sleep 赌时序 */
async function waitFor(sessionId, expression, label, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    if (await evalJs(sessionId, expression)) return;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error('等超时：' + label + '\n  当前 DOM 摘要：' +
        await evalJs(sessionId, `document.body.innerText.slice(0,300)`));
    }
    await sleep(120);
  }
}

/* ------------------------------------------------------------- 断言 */

let failed = 0;
function check(ok, label, detail = '') {
  if (ok) { console.log('  ok   ' + label); return; }
  failed++;
  console.log('  FAIL ' + label + (detail ? '\n       ' + detail : ''));
}

/* --------------------------------------------------------------- 主流程 */

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--ignore-certificate-errors',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  chrome.stderr.on('data', () => {});   // Chromium 话很多，静默掉

  try {
    const ver = await waitForHttp(`http://127.0.0.1:${PORT}/json/version`);
    ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (e) => {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
      const slot = pending.get(m.id);
      if (!slot) return;
      pending.delete(m.id);
      if (m.error) slot.rej(new Error(m.error.message));
      else slot.res(m.result);
    };

    // 开一个独立 target，页面里的控制台错误才拿得到
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);

    const problems = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
      if (m.method === 'Runtime.exceptionThrown') {
        problems.push(m.params.exceptionDetails?.exception?.description || 'unknown');
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        problems.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });

    console.log('\n— 打开应用 —');
    await send('Page.navigate', { url: BASE }, sessionId);
    await waitFor(sessionId, `!!document.querySelector('input[autocomplete="username"]')`,
      '登录表单出现');

    // 文案要等 auth/state 回来才切到「创建管理员」，不能刚出现表单就断言
    await waitFor(sessionId, `document.body.innerText.includes('管理员')`,
      '空库时文案切成「创建第一个账户 / 会成为管理员」');
    check(true, '空库时文案切成「创建第一个账户 / 会成为管理员」');

    console.log('\n— 注册并进入 —');
    const user = 'smoke' + Date.now().toString(36);
    await evalJs(sessionId, `
      (() => {
        const set = (el, v) => {
          const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
          d.set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const inputs = document.querySelectorAll('form input');
        set(inputs[0], ${JSON.stringify(user)});
        set(inputs[1], 'smokepass123');
        document.querySelector('form button[type=submit]').click();
      })()
    `);
    await waitFor(sessionId, `!!document.querySelector('.topbar')`, '主界面出现');

    console.log('\n— 建一条任务（自然语言解析）—');
    await evalJs(sessionId, `
      (() => {
        const i = document.querySelector('.fast-add input');
        const d = Object.getOwnPropertyDescriptor(i.constructor.prototype, 'value');
        d.set.call(i, '明天下午3点 交周报 2小时');
        i.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    // 解析预览必须在回车之前就把结果摆给用户看
    const chip = await evalJs(sessionId, `
      Array.from(document.querySelectorAll('.fast-parse .fp-chip')).map(e => e.textContent)
    `);
    check(chip.includes('明天'), '解析预览里有「明天」', JSON.stringify(chip));
    check(chip.includes('15:00'), '解析预览里有 15:00', JSON.stringify(chip));
    check(chip.includes('2小时'), '解析预览里有 2小时', JSON.stringify(chip));

    await evalJs(sessionId, `
      (() => {
        const i = document.querySelector('.fast-add input');
        i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()
    `);

    // 解析出来的是「明天」，所以落库后今天页看不到它 —— 直接从 store 里核对
    await waitFor(sessionId, `
      (() => { const s = JSON.parse(localStorage.getItem('schedule-app-v4') || '{}');
        return Object.values(s.tasks || {}).some(t => t.title === '交周报'); })()
    `, '任务落进 localStorage');

    const saved = await evalJs(sessionId, `
      (() => { const s = JSON.parse(localStorage.getItem('schedule-app-v4') || '{}');
        const t = Object.values(s.tasks).find(x => x.title === '交周报');
        return { date: t.date, time: t.time, duration: t.duration, done: t.done }; })()
    `);
    check(saved.time === '15:00', '解析出时间 15:00', JSON.stringify(saved));
    check(saved.duration === 120, '解析出时长 2 小时', JSON.stringify(saved));
    const tomorrow = await evalJs(sessionId, `
      (() => { const d = new Date(); d.setDate(d.getDate() + 1);
        return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); })()
    `);
    check(saved.date === tomorrow, '解析出日期 = 明天（' + tomorrow + '）', JSON.stringify(saved));

    console.log('\n— 日程视图：方块落在正确的时间位置 —');
    // 「今天」页也有前后翻页按钮，点一次会跳到明天并切到日视图
    await waitFor(sessionId, `!!document.querySelector('.round-btn')`, '翻页按钮可用');
    await evalJs(sessionId, `document.querySelectorAll('.round-btn')[1].click()`);
    await waitFor(sessionId, `!!document.querySelector('.tl-event')`, '时间轴上有方块');

    const inTimeline = await evalJs(sessionId, `
      (() => {
        const ev = document.querySelector('.tl-event');
        return ev ? { title: ev.querySelector('.ev-title')?.textContent,
                      top: ev.style.top, height: ev.style.height,
                      span: ev.querySelector('.ev-time')?.textContent } : null;
      })()
    `);
    check(!!inTimeline, '时间轴上出现了方块', JSON.stringify(inTimeline));
    // 15:00 在 1440 分钟里占 900 → DAY_H(1536) 的 62.5% = 960px
    check(inTimeline && Math.abs(parseFloat(inTimeline.top) - 960) < 1,
      '方块落在 15:00（top ≈ 960px）', inTimeline && inTimeline.top);
    check(inTimeline && inTimeline.span === '15:00 – 17:00', '时间段文案 15:00 – 17:00',
      inTimeline && inTimeline.span);

    console.log('\n— 勾选完成 —');
    await evalJs(sessionId, `document.querySelector('.tl-event .check-btn').click()`);
    await waitFor(sessionId, `
      (() => { const s = JSON.parse(localStorage.getItem('schedule-app-v4') || '{}');
        const t = Object.values(s.tasks || {}).find(x => x.title === '交周报');
        return !!t && t.done === true; })()
    `, '任务被标记为完成');
    check(true, '勾选后 done 落库');

    console.log('\n— 刷新后仍在（localStorage 落盘）—');
    const before = await evalJs(sessionId, `localStorage.getItem('schedule-app-v4')?.length || 0`);
    await send('Page.reload', {}, sessionId);
    await waitFor(sessionId, `!!document.querySelector('.topbar')`, '刷新后回到主界面');

    // 光看见 topbar 不算数 —— 那可能是个空壳。要看到**由持久化状态渲染出来的**
    // 东西：侧栏进度块 + 时间轴上那条明天 15:00 的任务。
    await waitFor(sessionId, `!!document.querySelector('.side-pulse .sp-num')`,
      '侧栏「今日进度」渲染出来');
    const pulse = await evalJs(sessionId,
      `document.querySelector('.side-pulse .sp-num')?.textContent`);
    check(pulse === '0/0', '今日进度是 0/0（任务排在明天，不在今天）', String(pulse));

    await waitFor(sessionId, `!!document.querySelector('.tl-event')`,
      '刷新后重新落到日视图且时间轴上有方块');
    const afterReload = await evalJs(sessionId,
      `document.querySelector('.tl-event .ev-time')?.textContent`);
    check(afterReload === '15:00 – 17:00', '刷新后时间段的文案没变',
      String(afterReload));

    const after = await evalJs(sessionId, `localStorage.getItem('schedule-app-v4')?.length || 0`);
    check(after > 0 && Math.abs(after - before) < before * 0.9,
      '刷新后本机数据还在', `before=${before} after=${after}`);

    console.log('\n— 同步真的推上服务器了 —');
    // outbox 应该是空的（要么推成功被 ack，要么还没轮到）
    await sleep(2500);
    const ob = await evalJs(sessionId, `
      (() => { const s = JSON.parse(localStorage.getItem('schedule-app-v4') || '{}');
        return { outbox: (s.outbox||[]).length, cursor: s.cursor||0, tasks: Object.keys(s.tasks||{}).length }; })()
    `);
    check(ob.cursor > 0, '拉取游标已前进（服务器回过数据）', JSON.stringify(ob));
    check(ob.outbox === 0, 'outbox 已清空（推送被服务器确认）', JSON.stringify(ob));
    check(ob.tasks >= 1, '本机有任务实体', JSON.stringify(ob));

    check(problems.length === 0, '页面没有未捕获的错误', problems.join('\n       '));
  } finally {
    try { ws?.close(); } catch (_) { /* ignore */ }
    chrome.kill('SIGKILL');
  }

  console.log(failed ? `\n✗ ${failed} 项不通过` : '\n✓ 全部通过');
  process.exit(failed ? 1 : 0);
}

async function waitForHttp(url, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    try { return await (await fetch(url)).json(); } catch (_) { /* 还没起来 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('Chromium 没起来：' + url);
    await sleep(150);
  }
}

main().catch((e) => { console.error('\n✗ 冒烟脚本自己崩了：', e.message); process.exit(1); });

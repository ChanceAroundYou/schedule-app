/**
 * cdp.mjs —— 真机 WebView 的 CDP 驱动（零依赖，Node 内建 WebSocket）
 *
 * 为什么需要它：App 的界面是 WebView 画的，系统看不见里面的控件
 * （uiautomator dump 只能拿到原生壳），所以 `adb input tap` 只能猜屏幕坐标。
 * CDP 能直接在网页里定位元素、发**可信**输入事件、读状态，
 * 「点空白处到底落在几点」这种问题才算真验证过。
 *
 * 往页面里注入一个 `__cdp` 对象（都在 Promise 里，测试脚本可以直接 await）：
 *   __cdp.eval(expr)                      → 执行表达式，返回值
 *   __cdp.tap(selector)                   → 元素中心点派发**真实**鼠标事件
 *   __cdp.click(x, y)                     → 屏幕坐标派发真实鼠标事件
 *   __cdp.type(text)                      → 往当前焦点输入框灌字（可信输入）
 *   __cdp.key(name)                       → 按一个键，如 'Enter' / 'Escape'
 *   __cdp.wait(ms)                        → 等一会儿
 *   __cdp.text(selector)                  → 取元素文本
 *   __cdp.rect(selector)                  → 取元素 bounding rect
 *   __cdp.adb('shell input keyevent 4')   → 在**驱动侧**跑一条 adb（收键盘这类
 *                                           系统级操作只能这么发，CDP 到不了系统）
 *
 * ⚠️⚠️ 这台机器（OPPO PLJ110 / DPR=3）的 WebView **CDP Input 域完全没效果**：
 * Input.dispatchMouseEvent / insertText / dispatchKeyEvent 发了都如石沉大海
 * （原坐标、×DPR、÷DPR 全试过）。所以 click/type/key 全部走**页面内合成事件**
 * （elementFromPoint + dispatchEvent 冒泡到 root，React 委托能收到）。
 * 代价：拖拽类操作模拟不了；点击类全走委托，本项目正好都是，够用。
 *
 * 用法：
 *   node cdp.mjs <设备IP:端口> --file 脚本.mjs     # 跑脚本（推荐）
 *   node cdp.mjs <设备IP:端口> '表达式'            # 单次执行
 *   node cdp.mjs <设备IP:端口> --relaunch …        # 先重启 App 再跑
 *
 * ⚠️ 已知约束（OPPO/ColorOS 实测）：**一个 CDP 会话结束后，下一次 attach 会
 * 无响应**（不是崩溃，是 WebView 调试通道进入坏状态，logcat 无栈）。
 * 所以「跑多个探针」不要开多个会话 —— 要么 `--relaunch` 每个会话前重启，
 * 要么把所有用例写进一个 --file 里一次跑完。会话**内部**多步操作是稳的。
 */
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const [host, portStr] = process.argv[2].split(':');
// 参数解析：--relaunch 与 --file 顺序任意。⚠️ 以前是按下标硬取，不带
// --relaunch 时 argv[5] 是 undefined，readFileSync 直接崩 —— 症状是
// 「探针跑出来没输出」，极像 App 无响应，排查了半天。
const argv = process.argv.slice(3);
let relaunch = false, file = null, expr = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--relaunch') relaunch = true;
  else if (argv[i] === '--file') file = argv[++i];
  else if (expr === null) expr = argv[i];
}
const code = file ? readFileSync(file, 'utf8') : expr;
if (code == null) { console.error('用法: node cdp.mjs <IP:端口> [--relaunch] (--file 脚本.mjs | \'表达式\')'); process.exit(1); }

const PKG = process.env.PKG || 'space.xiaokubao.schedule';
const ADB = process.env.ADB || 'C:/Users/小哭包/Android/platform-tools/adb.exe';
const ENV = { ...process.env, MSYS_NO_PATHCONV: '1' };
const adb = (args, opts = {}) => execSync(`"${ADB}" -s ${host}:${portStr} ${args}`,
  { encoding: 'utf8', env: ENV, timeout: 60000, ...opts });

// 1. 确保设备在线。**必须先 connect**：adb 守护进程每次冷启动都会把无线
//    连接抖掉，而本脚本可能正好赶在守护进程重启之后跑。connect 幂等。
execSync(`"${ADB}" connect ${host}:${portStr}`, { stdio: 'ignore', env: ENV });

// 1.5 需要的话先冷启动 App。**为什么默认不做**：见文件头「已知约束」——
//     每次 attach 前 App 必须是新起的，否则 WebView 调试通道不响应。
if (relaunch) {
  try { adb('shell svc power stayon true', { stdio: 'ignore' }); } catch {}
  try { adb('shell input keyevent 224', { stdio: 'ignore' }); } catch {}  // 唤醒屏幕
  try { adb(`shell am force-stop ${PKG}`, { stdio: 'ignore' }); } catch {}
  try { adb(`shell monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`, { stdio: 'ignore' }); } catch {}
  console.error('[cdp] 已重启 App，等它起来…');
  await new Promise(r => setTimeout(r, 6000));
}

// 2. 找到 WebView 的 unix socket 名
const socket = execSync(`"${ADB}" -s ${host}:${portStr} shell cat /proc/net/unix`,
  { encoding: 'utf8', env: ENV })
  .split('\n').map(l => l.match(/webview_devtools_remote_(\d+)/)?.[1])
  .find(Boolean);
if (!socket) { console.error('找不到 webview_devtools socket（App 起着吗？是 debug 包吗？）'); process.exit(1); }

// 3. adb forward 到本地端口，取页面 ws 地址
const localPort = 9333 + (Number(socket) % 100);
try { execSync(`"${ADB}" forward --remove tcp:${localPort}`, { stdio: 'ignore', env: ENV }); } catch {}
execSync(`"${ADB}" -s ${host}:${portStr} forward tcp:${localPort} localabstract:webview_devtools_remote_${socket}`,
  { env: ENV });
const list = JSON.parse(execSync(`curl -s http://127.0.0.1:${localPort}/json`, { encoding: 'utf8' }));
const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.error('没有可调试页面:', JSON.stringify(list)); process.exit(1); }

// 4. 连上
const ws = await openWs(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
/* 网络层取证：WebView 里「Failed to fetch 且几毫秒就返回」说明请求根本没出网，
   但光看页面拿不到原因。开 Network 域之后 CDP 会给出 errorText
   （net::ERR_*）和 blockedReason —— 这是判断「到底是网络问题还是被拦」
   唯一可靠的证据（2026-10-17 手机端连不上服务器时加的）。 */
const netReqUrl = new Map();
const netFails = [];
ws.onMessage = async (raw) => {
  const msg = JSON.parse(raw);
  if (process.env.CDP_DEBUG) console.error('[cdp<-]', raw.slice(0, 300));

  if (msg.method === 'Network.requestWillBeSent') {
    netReqUrl.set(msg.params.requestId, msg.params.request?.url || '');
  }
  if (msg.method === 'Network.loadingFailed') {
    netFails.push({
      url: (netReqUrl.get(msg.params.requestId) || '?').slice(0, 70),
      errorText: msg.params.errorText,
      blockedReason: msg.params.blockedReason,
      cors: msg.params.corsErrorStatus?.corsError || null,
    });
  }

  // 页面里的 __cdp.xxx() 最终是调 window.__cdpRawSend(json) —— CDP 把它当成
  // Runtime.bindingCalled 事件送回来。这里接住、执行、再把结果**回灌**页面。
  //
  // ⚠️ 为什么不能就地 resolve 页面的 Promise：那个 Promise 存在页面的
  //    __cdpWait 里，驱动侧拿不到。而且「外层 evaluate 正 await 着页面 Promise」
  //    这件事决定了：**不能在等待它的过程中再发起一个 awaitPromise 的 evaluate**
  //    （那会互相等，死锁，症状就是 20s 超时）。
  //    所以回灌用的是一次**同步** evaluate（不等 Promise，立刻返回）。
  if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__cdpRawSend') {
    const inner = JSON.parse(msg.params.payload);
    // 页面喊 adb：在驱动侧执行（验收脚本要靠它发系统级按键，比如 BACK 收键盘）
    if (inner.method === '__adb') {
      let out = '', err = null;
      try {
        out = execSync(`"${ADB}" -s ${host}:${portStr} ${inner.params.args}`,
          { encoding: 'utf8', env: ENV, timeout: 30000 });
      } catch (e) { err = String(e.message || e); }
      await send('Runtime.evaluate', {
        expression: `window.__cdpSettle(${inner.id}, ${JSON.stringify(JSON.stringify(out))}${err ? ', null, ' + JSON.stringify(err) : ''})`,
        returnByValue: true,
      });
      return;
    }
    try {
      const res = await send(inner.method, inner.params || {});
      await send('Runtime.evaluate', {
        expression: `window.__cdpSettle(${inner.id}, ${JSON.stringify(JSON.stringify(res))})`,
        returnByValue: true,
      });
    } catch (e) {
      await send('Runtime.evaluate', {
        expression: `window.__cdpSettle(${inner.id}, null, ${JSON.stringify(String(e && e.message || e))})`,
        returnByValue: true,
      });
    }
    return;
  }

  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
function send(method, params = {}, timeoutMs = 20000) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(mid)) { pending.delete(mid); reject(new Error('CDP 超时: ' + method)); }
    }, timeoutMs);
    pending.set(mid, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable').catch(() => {});
// ⚠️ 没有 Input.enable —— Input 域不提供这个方法，调了会 -32601。
if (process.env.CDP_DEBUG) console.error('[cdp] 域已启用');

// 5. 往页面里注入助手。**可信事件**走 Input 域（浏览器当成真人操作），
//     synthetic 事件只用于「点一下看看有没有反应」这类不怕被 React 忽略的场景。
await send('Runtime.evaluate', {
  expression: `(() => {
  const S = (m, p) => window.__cdpSend(m, p);
  window.__cdp = {
    // 等一个宏任务/一段时间。页面是单线程的，灌完字得给它时间渲染
    wait: (ms) => new Promise(r => setTimeout(r, ms || 0)),
    async eval(expr) {
      const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    rect(sel) {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    },
    text(sel) {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null;
    },
    all(sel) { return Array.from(document.querySelectorAll(sel)).map(e => e.textContent.replace(/\\s+/g, ' ').trim()); },
    /* 点击：**页面内派发合成鼠标事件**，不走 CDP 的 Input 域。
       为什么（2026-10-17 实测，OPPO PLJ110 / DPR=3）：Input.dispatchMouseEvent
       在这台机器的 WebView 上**完全没效果**——原坐标、×DPR、÷DPR 三种都试过，
       点了页面毫无反应。而 elementFromPoint + dispatchEvent 冒泡到 root，
       React 的委托监听正常收到（probe2 同样方式成功建过任务）。
       ⚠️ 合成 click 对「拖拽」无效，但本项目点击全走委托，够用。
       ⚠️ 这段代码嵌在驱动的大模板字符串里，只能单引号拼接 —— 用反引号
       会把外层字符串提前结束（Node 直接在驱动侧报 SyntaxError）。 */
    async click(x, y) {
      const r = await S('Runtime.evaluate', {
        expression: '(function(){'
          + 'var el = document.elementFromPoint(' + x + ', ' + y + ');'
          + 'if (!el) return null;'
          + 'var o = {bubbles: true, cancelable: true, view: window, clientX: ' + x + ', clientY: ' + y + ', button: 0};'
          + 'el.dispatchEvent(new MouseEvent("mousedown", o));'
          + 'el.dispatchEvent(new MouseEvent("mouseup", o));'
          + 'el.dispatchEvent(new MouseEvent("click", o));'
          + 'return el.tagName;'
          + '})()',
        returnByValue: true,
      });
      return r.result.value;
    },
    async tap(sel) {
      const r = this.rect(sel);
      if (!r) throw new Error('tap 找不到元素: ' + sel);
      await this.click(r.cx, r.cy);
    },
    /* 灌字：focus + 原生 value setter + input 事件。
       两步都是必须的：React 受控组件只认它自己追着的 setter 路径，
       直接 el.value = x 不会触发 onChange；而只 setter 不派发 input
       React 收不到通知。派发完**等一个宏任务**再返回，让 state 落定 ——
       不等的话紧接着发 Enter，commit() 读到的还是空串（实测踩过）。 */
    async type(text, sel) {
      if (sel) {
        const r = this.rect(sel);
        if (!r) throw new Error('type 找不到元素: ' + sel);
        await this.click(r.cx, r.cy);
        await this.wait(80);
      }
      const r = await S('Runtime.evaluate', {
        expression: '(function(){'
          + 'var el = document.activeElement;'
          + 'if (!el || (el.tagName !== "TEXTAREA" && el.tagName !== "INPUT")) return "no input focused";'
          + 'var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;'
          + 'var setter = Object.getOwnPropertyDescriptor(proto, "value").set;'
          + 'setter.call(el, ' + JSON.stringify(text) + ');'
          + 'el.dispatchEvent(new Event("input", {bubbles: true}));'
          + 'return el.value;'
          + '})()',
        returnByValue: true,
      });
      await this.wait(120);
      return r.result.value;
    },
    async key(name) {
      const map = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9 };
      const kc = map[name] || 0;
      const r = await S('Runtime.evaluate', {
        expression: '(function(){'
          + 'var el = document.activeElement;'
          + 'if (!el) return "no active element";'
          + 'var base = {bubbles: true, cancelable: true, key: ' + JSON.stringify(name)
          + ', code: ' + JSON.stringify(name) + ', keyCode: ' + kc + ', which: ' + kc + '};'
          + 'el.dispatchEvent(new KeyboardEvent("keydown", base));'
          + 'el.dispatchEvent(new KeyboardEvent("keyup", base));'
          + 'return el.tagName;'
          + '})()',
        returnByValue: true,
      });
      await this.wait(60);
      return r.result.value;
    },
    // 驱动侧跑一条 adb。返回 stdout。系统级操作（BACK 收键盘、HOME 等）只能走这
    adb(args) { return S('__adb', { args }); },
  };
  window.__cdpSend = (m, p) => new Promise((resolve, reject) => {
    const mid = ++window.__cdpId;
    window.__cdpWait.set(mid, { resolve, reject });
    window.__cdpRawSend(JSON.stringify({ id: mid, method: m, params: p || {} }));
  });
  window.__cdpId = 0;
  window.__cdpWait = new Map();
  // 驱动侧把 CDP 结果回灌到这里（见驱动里 bindingCalled 的处理）
  window.__cdpSettle = (mid, resJson, err) => {
    const w = window.__cdpWait.get(mid);
    if (!w) return;
    window.__cdpWait.delete(mid);
    if (err) w.reject(new Error(err));
    else w.resolve(resJson ? JSON.parse(resJson) : undefined);
  };
  return 'ok';
})()`,
  returnByValue: true,
});
console.error('[cdp] 页面助手已注入');

// 6. 桥接：页面的 __cdpSend → 本进程 send()
await send('Runtime.addBinding', { name: '__cdpRawSend' });

// 7. 跑测试脚本。脚本里可以直接用 await __cdp.xxx()
//    ⚠️ 这条的超时必须远长于单次 CDP 调用：整套验收（建 5 条任务、删 5 条、
//    三轮键盘交互）要 40s+，用单次那种 20s 会被误杀。
const wrapped = `(async () => {\n${code}\n})()`;
const r = await send('Runtime.evaluate', {
  expression: wrapped, returnByValue: true, awaitPromise: true,
}, 300000);
if (r.exceptionDetails) {
  console.error('脚本抛错:', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  process.exit(1);
}
console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value));
if (netFails.length) {
  console.log('--- 网络层失败明细（CDP Network.loadingFailed）---');
  for (const f of netFails.slice(0, 8)) {
    console.log(`  ${f.errorText || '?'}${f.blockedReason ? ' blocked=' + f.blockedReason : ''}${f.cors ? ' cors=' + f.cors : ''}  ${f.url}`);
  }
}
// 收尾：清掉 pending 的 20s 超时定时器再退。否则 ws.close() 之后某个
// 悬挂的 setTimeout 到点 reject，Node 拿未捕获 rejection 刷一屏错误栈 ——
// 结果明明是对的，输出却被淹没，看着像失败了。
for (const [, p] of pending) clearTimeout(p.timer);
pending.clear();
ws.close();
process.exit(0);

/* ---------------- 极简 WebSocket（RFC6455，客户端掩码） ---------------- */
function openWs(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const sock = connect(Number(u.port), u.hostname, () => {
      sock.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), upgraded = false;
    const ws = {
      onMessage: null,
      send(payload) {
        const data = Buffer.from(payload);
        const mask = randomBytes(4);
        const masked = Buffer.alloc(data.length);
        for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
        let head;
        if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
        else if (data.length < 65536) {
          head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xFE; head.writeUInt16BE(data.length, 2);
        } else {
          head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0xFF; head.writeBigUInt64BE(BigInt(data.length), 2);
        }
        sock.write(Buffer.concat([head, mask, masked]));
      },
      close() { try { sock.destroy(); } catch {} },
    };
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!buf.slice(0, end).toString().includes('101')) return reject(new Error('WS 升级失败'));
        buf = buf.slice(end + 4); upgraded = true; resolve(ws);
      }
      for (;;) {
        if (buf.length < 2) return;
        const len2 = buf[1] & 0x7F;
        let off = 2, len = len2;
        if (len2 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len2 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len).toString('utf8');
        buf = buf.slice(off + len);
        if (ws.onMessage) ws.onMessage(payload);
      }
    });
    sock.on('error', reject);
  });
}

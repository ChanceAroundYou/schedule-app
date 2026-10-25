export async function cdpTargets(port = +(process.env.SMOKE_CDP_PORT || 9223)) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

export async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { res, rej } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
    } else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    waiting.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, events, close: () => ws.close() };
}

/** 在页面里求值，返回 JSON 化后的结果 */
export async function evalJs(page, expr) {
  const r = await page.send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true, returnByValue: true,
  });
  // exception.description 才是「TypeError: 读了 null 的 x」那句人话；
  // 只打 exceptionDetails.text 的话所有异常都长成一句「Uncaught」，等于没说
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception?.description || d.text) + ' :: ' + JSON.stringify(r.result?.value));
  }
  return r.result.value;
}

/**
 * 等到表达式返回真值，超时就抛（带上最后看到的值，方便定位）。
 *
 * **表达式不能以换行开头**：这里会把它包成 `return <expr>`，而 `return` 后面
 * 跟换行会被 ASI 断成一句裸 `return`，整条表达式变成永远不可达的代码 ——
 * 症状是「最后一次求值 = undefined」且一直等到超时，看着像应用没反应，
 * 其实是探针自己写错了。多行模板（为了排版好看）几乎必然踩上，所以这里
 * 直接 trim 掉，别指望每个调用点都记得不换行。
 */
export async function waitFor(page, expr, what, ms = 8000) {
  const src = expr.trim();
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await evalJs(page, `return ${src};`);
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等不到「${what}」，最后一次求值 = ${JSON.stringify(last)}`);
}

/* 探针中断时把**页面现状**打进日志。只报「等不到 .sidebar」的话，分不清是
   注册失败、页面空白还是后端挂了 —— 2026-10-24 为这类超时白查了好几轮，
   就差这一眼。 */
export async function dumpPage(page, label) {
  try {
    const s = await evalJs(page, `
      return {
        url: location.href,
        login: !!document.querySelector('form input'),
        text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300),
      };
    `);
    console.error(`  [页面现状·${label}] url=${s.url} 还在登录页=${s.login}`);
    console.error(`  [页面文字] ${s.text}`);
    if (s.login) {
      console.error('  [提示] 注册没成功、页面留在登录页 —— 错在哪看上面的「页面文字」；'
        + 'dist 若是旧构建，ensureDist 会自动重建（也可手动 cd app && npm run build）');
    }
  } catch (_) { /* 页面已经没了就算了，别盖掉原始错误 */ }
}

/**
 * 点页面里的一个元素。**找不到**返回 'missing'，否则返回事件序列
 * （'pointerdown:xxx → click:xxx'，放断言里，出问题一眼看得出点没点进去）。
 *
 * **必须连 pointerdown 一起补，光 `el.click()` 不算一次真点击**：这个应用的
 * 点击委托挂在 pointerdown 上（长按状态机在那儿），而「吞掉抬手那记 click」
 * 的标志也只在 pointerdown 里复位 —— 上一节触屏拖拽留下的标志会让第一次
 * `.click()` 整整一下被吃掉（详见 docs/踩坑-环境.md 第 32 条）。
 *
 * `findExpr` 是一段**返回元素**的表达式，不是选择器字符串 —— 调用点常常要先
 * 按文字筛一轮。
 */
export async function clickEl(page, findExpr) {
  return evalJs(page, `
    const el = ${findExpr};
    if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const seen = [];
    const spy = (e) => seen.push(e.type + ':' + (e.target.className || e.target.tagName));
    document.addEventListener('pointerdown', spy, true);
    document.addEventListener('click', spy, true);
    el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerType: 'mouse', isPrimary: true }, at)));
    el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerType: 'mouse', isPrimary: true }, at)));
    el.dispatchEvent(new MouseEvent('click', at));
    document.removeEventListener('pointerdown', spy, true);
    document.removeEventListener('click', spy, true);
    return seen.join(' → ') || 'ok';
  `);
}

/* ---------------------------------------------------- 触屏合成 */

/** 和 ui/dnd/sensors.ts 的 TOUCH_DRAG_DELAY 对齐（2026-10-24 起是 250） */
export const TOUCH_DRAG_DELAY = 250;

/**
 * 合成一次触摸。走 CDP 的 Input.dispatchTouchEvent —— 它派生出来的
 * pointer 事件带 pointerType:'touch'，和真手指走的是同一条路。
 *
 * 必须先 Emulation.setTouchEmulationEnabled，否则 Chrome 不装触摸后端，
 * 这些事件会被直接丢掉（不是报错，是静默无效，最难查的那种）。
 *
 * 抬手也要给坐标：`touchPoints: []` 在有些版本上被接受、有些版本报
 * 「Touch points must be between 1 and 16」，所以一律带上最后那个点。
 */
export let lastTouch = { x: 0, y: 0 };
export async function touch(page, type, at) {
  if (at) lastTouch = at;
  await page.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: [{ x: lastTouch.x, y: lastTouch.y, radiusX: 8, radiusY: 8, force: 1 }],
  });
}

/**
 * 合成一次按键。走 CDP 的 Input.dispatchKeyEvent —— 事件按**真实焦点**
 * 派发，不是我们自己在页面里指定 target，所以能连带证明「焦点真在它身上」。
 *
 * 在页面里 `el.dispatchEvent(new KeyboardEvent('keydown', …))` 也能让
 * 处理器跑起来，但那样 target 是我们摆上去的：把手要是压根拿不到焦点
 * （比如忘了 tabIndex），它照样「通过」。这里不行。
 */
export async function key(page, k, code, vk) {
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** 用顶栏的快速输入框加一条任务（走真实 UI，不直接改 store） */
export async function quickAdd(page, text) {
  const n = await evalJs(page, `return document.querySelectorAll('[data-scope="inbox"] .task-el').length;`);
  await evalJs(page, `
    const inp = document.querySelector('.fast-add textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(inp, ${JSON.stringify(text)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  `);
  // 等它真出现 —— 不等的话下一条会插到上一条前面，顺序断言就成了空话
  return waitFor(page,
    `document.querySelectorAll('[data-scope="inbox"] .task-el').length > ${n}`, '任务出现');
}

/**
 * 等某个东西从界面上消失 —— 期间**不断催一次同步**。
 *
 * 为什么要催：客户端的拉取不是定时的（`sync/lifecycle.ts` 的轮询只在 outbox
 * 非空时才 syncNow），纯用 API 写进去的删除墓碑没人拉就永远不生效。
 * 探针里没有本地改动可推，所以只能自己戳 `focus`（等同切回前台 → 立即 syncNow）。
 * 单次戳可能撞上「上一趟同步还在飞」，所以每 900ms 补一脚，直到它真的让位。
 */
export async function waitGone(page, exprGone, what, ms = 20000) {
  return waitFor(page, `
    (() => {
      if (${exprGone}) return 1;
      const now = Date.now();
      if (!window.__lastNudge || now - window.__lastNudge > 900) {
        window.__lastNudge = now;
        window.dispatchEvent(new Event('focus'));
      }
      return null;
    })()
  `, what, ms);
}

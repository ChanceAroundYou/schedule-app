/**
 * browser-smoke.mjs —— 用真实 Chrome 走一遍新界面（零依赖，走 CDP）
 *
 * 单元测试测不到「页面白不白」。这个探针起一套**完全隔离**的环境：
 *   临时后端（临时数据库）→ 一个带 /api 代理的静态服务 → 真实 Chrome
 * 然后像人一样注册、切日程集、改名、看邀请，一路收集 console 报错。
 *
 * 为什么自己搭静态服务而不是用 vite preview：preview 的代理写死在 25692，
 * 那是线上后端 —— 探针会往生产库里写账号。隔离是这里的第一要求。
 *
 *   node app/tests/browser-smoke.mjs
 *
 * 退出码非 0 = 有问题。环境变量 CHROME 可以指定浏览器可执行文件；
 * 不指定则按「各平台常见安装位置」自动探测。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist');
/* 端口**默认还是那三个，被占了自动让开**；也能用环境变量钉死 —— 原来写死（踩坑 40），
   两个 session 同时跑探针就只能等：谁后跑谁拿不到端口，前一个崩掉以后还会
   留下占着端口的孤儿进程（浏览器已经没了，它还在等 CDP）。改端口即可并行：
   `SMOKE_API_PORT=25711 SMOKE_WEB_PORT=5199 SMOKE_CDP_PORT=9233 node tests/browser-smoke.mjs`。
   数据本来就按 run 隔离（SCHEDULE_DATA_DIR），所以并行互不干扰。 */
/**
 * listen，被占了就退回内核分配，返回**真实**那个端口。
 *
 * 为什么光有 `freePort` 不够：假模型那个服务器是**第十二节才起的**，
 * 而 `freePort` 在探针开头就把号放掉了 —— 中间隔了几十秒，
 * 那个号很可能已经被别人占上（本机同时跑两趟探针就必然如此）。
 * `freePort` 只能解决「起之前就占着」，解决不了「起之前空着、起的时候被抢」。
 * 所以两个 listen 都走这里：**真被抢走要响，不要无声无息地卡死**。
 */
function listenFree(srv, preferred) {
  return new Promise((res, rej) => {
    srv.once('error', (e) => {
      if (e.code !== 'EADDRINUSE') return rej(e);
      srv.listen(0, '127.0.0.1', () => res(srv.address().port));   // 让内核挑
    });
    srv.listen(preferred, '127.0.0.1', () => res(srv.address().port));
  });
}

/** 试着占一下 preferred，占不到就往后挨个试，再不行让内核给一个空闲端口 */
async function freePort(preferred) {
  const attempt = (port) => new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(0));          // EADDRINUSE 之类 → 当这个号不可用
    s.listen(port, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  /* 首选通就还是那个熟悉的号 —— 没有别的理由改变它 */
  if (await attempt(preferred)) return preferred;
  /* 首选被占：往后找，但**按 pid 错开起点**。两个探针几乎同时起时，它们在同一
     瞬间都会觉得首选是空的；从同一个号开始找就会挑到同一个，然后第二个的子进程
     bind 失败 —— 那正是这个机制本来要挡的那件事。 */
  const skip = 1 + (process.pid % 16);
  for (let i = 0; i < 24; i++) { const p = await attempt(preferred + skip + i); if (p) return p; }
  return attempt(0);                        // 一片都占了，让内核挑
}
const API_PORT = +(process.env.SMOKE_API_PORT || await freePort(25701));   // 临时后端
let WEB_PORT = +(process.env.SMOKE_WEB_PORT || await freePort(5198));    // 静态 + 代理
const CDP_PORT = +(process.env.SMOKE_CDP_PORT || await freePort(9223));
let MODEL_PORT = +(process.env.SMOKE_MODEL_PORT || await freePort(25711));
/* Chrome 定位：环境变量 → 各平台常见安装位置 → 原默认。原来写死 NAS 的 Linux 路径，
   Windows 上每次都得人肉带 CHROME=（web-loop 里还另硬编码了一份 Windows 路径，
   换个平台又反了）。2026-10-24 改成三级探测，谁跑都对号入座。 */
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/opt/google/chrome/chrome',
].filter(Boolean);
const CHROME = process.env.CHROME
  || CHROME_CANDIDATES.find((p) => existsSync(p))
  || '/opt/google/chrome/chrome';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
};

let failures = 0;
const ok = (cond, what, detail) => {
  const tail = detail === undefined || detail === '' ? '' : '（' + detail + '）';
  if (cond) console.log('  ok   ' + what + tail);
  else { failures++; console.log('  FAIL ' + what + tail); }
};

/* ---------------------------------------------------- 静态服务 + 代理 */

import { serveDist as _serveDist } from './lib/server.mjs';
const serveDist = (wp) => _serveDist({ webPort: wp, apiPort: API_PORT, dist: DIST, mime: MIME, listenFree });

import * as CDP from './lib/cdp.mjs';
const { cdpTargets, connect, evalJs, waitFor, dumpPage, clickEl, touch, key, quickAdd, waitGone, TOUCH_DRAG_DELAY } = CDP;

/* ------------------------------------------------------------ 主流程 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'sched-browser-'));
const procs = [];
/** 静态服务句柄。离线那一段要主动把它关掉，所以提到外面来 */
let web = null;

function track(p) { procs.push(p); return p; }

function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch (_) { /* 已经没了 */ } }
  // Chrome 被 SIGKILL 之后还在往 profile 里写，直接 rm 会 ENOTEMPTY。
  // 这本来只是收尾，不该因为收尾把整轮结果盖掉（之前就是这么盖掉过一次失败报告的）
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (_) { /* /tmp 里留个目录无所谓 */ }
}
process.on('exit', cleanup);

/* dist 必须是**当前源码的同源版**。原来只判「有没有」——旧 dist 会让整轮探针
   测一堆不相干的东西还查不出为什么（2026-10-24 连挂四轮，失败跑的 dist 是
   并发会话早一个小时构建的旧版）。现在比新旧：dist 比源码旧、或者根本是
   APK 的注基址变体（资产里带生产域名，会绕开临时后端直连生产），就自动重建。
   git checkout / pull 会刷新源码 mtime → 偶尔误判「旧」→ 多花一次 build，
   换「测的确实是当前代码」，值。 */
function ensureDist() {
  const APP_DIR = path.join(ROOT, 'app');
  const idx = path.join(DIST, 'index.html');
  const srcRoots = ['src', 'index.html', 'vite.config.ts', 'tailwind.config.js', 'postcss.config.js']
    .map((p) => path.join(APP_DIR, p)).filter(existsSync);
  let newest = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  for (const r of srcRoots) {
    if (statSync(r).isDirectory()) walk(r); else newest = Math.max(newest, statSync(r).mtimeMs);
  }
  const assetsDir = path.join(DIST, 'assets');
  const injected = existsSync(assetsDir) && readdirSync(assetsDir)
    .filter((f) => f.endsWith('.js'))
    .some((f) => readFileSync(path.join(assetsDir, f), 'utf8').includes('home.xiaokubao.space'));
  const why = !existsSync(idx) ? '不存在'
    : injected ? '是 APK 注基址变体（会绕开临时后端直连生产，必须重建）'
    : newest > statSync(idx).mtimeMs ? '比源码旧' : '';
  if (!why) return;
  console.log(`  [dist] ${why}，自动重建（npm run build）…`);
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const r = existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, 'run', 'build'], { cwd: APP_DIR, stdio: 'inherit' })
    : spawnSync('npm', ['run', 'build'], { cwd: APP_DIR, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0 || !existsSync(idx)) {
    throw new Error('dist 重建失败 —— 手动 cd app && npm run build 看报错');
  }
  console.log('  [dist] 重建完成');
}

try {
  ensureDist();
  if (!existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME);

  track(spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
    env: { ...process.env, PORT: String(API_PORT), SCHEDULE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  procs[procs.length - 1].stderr.on('data', (d) => process.stderr.write('[be] ' + d));
  procs[procs.length - 1].stdout.on('data', (d) => process.stderr.write('[bo] ' + d));
  const _sr = await serveDist(WEB_PORT); web = _sr.srv; WEB_PORT = _sr.webPort;
  procs.push({ kill: () => { if (web && web.listening) web.close(); } });

  const mark = (got, want) => (got === want ? '' : `（首选 ${want} 被占，已让开）`);
  console.log(`\n端口：后端 ${API_PORT}${mark(API_PORT, 25701)} · 页面 ${WEB_PORT}${mark(WEB_PORT, 5198)} · CDP ${CDP_PORT}${mark(CDP_PORT, 9223)} · 假模型 ${MODEL_PORT}${mark(MODEL_PORT, 25711)}`);


  const state = {};
  const ctx = {
    page: null,
    errors: [],
    state,
    ok: (cond, what, detail) => {
      const tail = detail === undefined || detail === '' ? '' : '（' + detail + '）';
      if (cond) console.log('  ok   ' + what + tail);
      else { failures++; console.log('  FAIL ' + what + tail); }
    },
  };

  // connect page
  track(spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(dataDir, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--touch-events=enabled', '--window-size=1280,860', 'about:blank',
  ], { stdio: 'ignore' }));

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try { const list = await cdpTargets(CDP_PORT); target = list.find((t) => t.type === 'page'); } catch (_) {}
    if (!target) await new Promise((r) => setTimeout(r, 150));
  }
  if (!target) throw new Error('Chrome 没开起来');
  const page = await connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
  ctx.page = page;
  /* 失败信息的多行缩进。既吃 `errors` 那种 `{text, url}`，也吃 a11y 那种
     纯字符串列表 —— 拆分时它留在了老文件里，五个 section 还在用，于是
     「fmt is not defined」把整趟探针打断。**给它留在 helpers 里。** */
  const errors = ctx.errors;
  const collect = () => {
    for (const e of page.events.splice(0)) {
      if (e.method === 'Runtime.exceptionThrown') errors.push({ text: e.params.exceptionDetails?.text || 'exception', url: '' });
      else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') errors.push({ text: e.params.entry.text, url: e.params.entry.url || '' });
    }
  };
  const fmt = (list) => list.map((e) => (typeof e === 'string' ? e : e.text + (e.url ? '  <' + e.url + '>' : ''))).join('\n      ');
  const a11y = (root) => { return `(() => {
    const bad = [];
    const box = ${root ? `document.querySelector(${JSON.stringify(root)})` : 'document'};
    if (!box) return ['扫描范围没找到：' + ${JSON.stringify(root || '')}];
    const nameOf = (el) => {
      if (el.getAttribute('aria-label')) return 'aria-label';
      if (el.getAttribute('title')) return 'title';
      if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return 'label[for]';
      // 包在 label 里**也得 label 里有字**才算有名字：抽屉头上那个勾选圈
      // 包在一个空 label 里（圈是旁边一个 span），空 label 本身给不出名字 ——
      // 原先这里不看文字，等于给「没名字」开了个后门。
      const lab = el.closest('label');
      if (lab && lab.textContent.trim()) return '包在 label 里';
      // 按钮的可见文字**就是**它的可访问名字，和 aria-label 等价 ——
      // 第一版漏了这一条，把 nav-item / ghost-btn 这些带字的全报成了「没名字」，
      // 是探针自己的 bug（见 CLAUDE.md 四、40：这种症状先怀疑探针）
      if (el.tagName === 'BUTTON' && el.textContent.trim()) return 'textContent';
      if (el.tagName === 'INPUT' && /^(submit|button|reset)$/.test(el.type) && el.value) return 'value';
      // placeholder 会在最后一档当名字用，但那是退化行为，不算数（见下面 title 框）
      return '';
    };
    // 光用 tagName + 自己的 class 会**把不同的元素压成同一行** ——
    // 顶栏搜索和快速添加那两个 input 都没有 class、都没有名字，
    // Set 一去重就只剩一条，看着像只有一处有问题。补上父元素的类名，
    // 失败信息才指得到具体哪一个。
    // （注意：这段字符串是模板字面量，注释里不能出现反引号，
    //   否则会把模板当场截断、后面半截漏到 Node 里跑 —— 已经踩过一次）
    const cls = (el) => {
      const own = el.tagName.toLowerCase();
      // 光看 class 管理浮层那两个框会压成同一条（前缀都是 min-w-0），
      // 失败信息指不出是哪一个 —— 那一次报的就是这条，白查了一轮。
      // data-* 最准（探针本来就认 data-cal-name 这些抓手），其次 placeholder。
      const dk = el.getAttributeNames().find((n) => n.startsWith('data-'));
      const ph = el.getAttribute('placeholder');
      const tag = own + (dk ? '[' + dk + ']' : '') + (ph ? '[placeholder=' + ph + ']' : '');
      if (dk || ph) return tag;
      if (typeof el.className === 'string' && el.className) return own + '.' + el.className.split(' ')[0];
      const p = el.parentElement;
      const pc = p && typeof p.className === 'string' && p.className ? p.className.split(' ')[0] : (p ? p.tagName.toLowerCase() : '?');
      return own + ' in .' + pc;
    };
    /* 勾选圈必须是真 button（见 CLAUDE.md 三、无障碍 2）。

       **例外：aria-hidden 的圈，且它在一个真 button 里面** —— 那种圈是那个
       按钮的**状态指示**，不是独立控件。侧栏日程集那一行就是这种：整行是一个
       aria-pressed 的 toggle button，圈只是「勾没勾上」的视觉说法，读屏不该
       把它当第二个控件念（所以 aria-hidden）。把它算成「假按钮」是误报 ——
       真按钮的内容里本来就可以有 span。 */
    for (const el of box.querySelectorAll('span.check-btn')) {
      if (el.getAttribute('aria-hidden') === 'true'
        && el.closest('button:not([disabled])')) continue;
      bad.push('勾选圈是 span 不是 button');
    }
    for (const el of box.querySelectorAll('button,input,select,textarea')) {
      if (el.type === 'hidden' || el.disabled) continue;
      // 没渲染出来的不算 —— 导入备份那个 <input type=file> 就是藏起来的，
      // 由旁边那个有名字的按钮触发，是标准做法
      if (!el.getClientRects().length) continue;
      if (!nameOf(el)) bad.push('没名字：' + cls(el));
    }
    for (const l of box.querySelectorAll('label')) {
      if (l.htmlFor) {
        if (!document.getElementById(l.htmlFor)) bad.push('label[for] 指向不存在的 id：' + l.htmlFor);
      } else if (!l.querySelector('input,select,textarea')) {
        bad.push('label 既没有 for 也没包住控件：' + l.textContent.trim().slice(0, 20));
      }
    }
    return [...new Set(bad)];
  })()`; }

  /* 原来的「切到待办箱 + scan()」两条留在这里，但它们是**第十八节**的前置：
     拆分时挪进了 sections/smoke/16.mjs（那一节自己重新扫）。留在这里会在
     还没有任何 section 登录之前就点 [data-nav="inbox"] —— 页面上还没有这个
     按钮，`null.click()` 当场把整趟探针打断。**别再搬回来。** */
  const openCalMenu = () => evalJs(page, `const t=document.querySelector('[data-cal-menu]'); if(t.getAttribute('aria-expanded')!=='true') t.click(); return true;`);
  const waitCalMenu = () => waitFor(page, `!!document.querySelector('.cal-menu-pop [data-cal-row]')`, '日程集下拉打开', 4000);
  const closeCalMenu = () => evalJs(page, `const t=document.querySelector('[data-cal-menu]'); if(t.getAttribute('aria-expanded')==='true') t.click(); return true;`);
  const withCals = async (fn) => { await openCalMenu(); await waitCalMenu(); return fn(); };
  const shown = () => withCals(() => evalJs(page, `return [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')].filter((b)=>b.getAttribute('aria-pressed')==='true').map((b)=>b.textContent.trim());`));
  const clickCal = (name) => withCals(() => evalJs(page, `[...document.querySelectorAll('.cal-menu-pop [data-cal-row]')].find((b)=>b.textContent.trim()===${JSON.stringify(name)}).click(); return true;`));
  const waitShownCount = (n, label) => withCals(() => waitFor(page, `[...document.querySelectorAll('.cal-menu-pop [data-cal-row]')].filter((b)=>b.getAttribute('aria-pressed')==='true').length===${n}?1:null`, label, 5000));
  const focusCal = async (id) => { await withCals(() => evalJs(page, `const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); const rows=()=>[...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]; for(const other of rows()){ if(other.dataset.calRow!==${JSON.stringify(id)} && other.getAttribute('aria-pressed')==='true'){ other.click(); await sleep(60);} } const b=rows().find(x=>x.dataset.calRow===${JSON.stringify(id)}); if(b && b.getAttribute('aria-pressed')!=='true'){ b.click(); await sleep(60);} return true;`)); await closeCalMenu(); };
  const inbox = () => evalJs(page, `return [...document.querySelectorAll('[data-scope="inbox"] .task-el')].map((el) => el.textContent.trim());`);
  const SETTER = `(el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }`;
  const helpers = { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, cdpTargets, connect, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort: API_PORT, webPort: WEB_PORT, dataDir,
    /* 拆分后 section 在自己的模块里，拿不到本文件的顶层符号。这几样第十二节
       （AI 假模型）要用：起服务器、抢端口、登记清理、以及**可变的**模型端口
       （listenFree 抢走了首选端口时会换号，对象传引用，写回才看得见）。 */
    createServer, listenFree, track, ports: { model: MODEL_PORT, web: WEB_PORT }, TOUCH_DRAG_DELAY,
    /* 拆分后各 section 是独立模块，**局部变量不共享**。原先在同一个函数体里
       自然能读到的三样东西现在得显式传：后端 API 小工具（几节都在用）、
       静态服务的句柄（第十三节要关掉再重开）、以及可变端口。
       `web` 用 getter/setter 包一层 —— 第十三节重开静态服务后换的是**主文件里
       那个变量**，直接传值只会改到 section 自己的副本，主文件的清理就漏了。 */
    api: async (method, p, body, token) => {
      const headers = {};
      if (token) headers.Authorization = 'Bearer ' + token;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(`http://127.0.0.1:${API_PORT}/api${p}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    serveDist, procs,
    /* 两节（导航拖拽 / 设置页调序）共用的小包装：8 秒超时的 waitFor。
       原先定义在同一个函数体里，拆开后 23 节读不到 22 节里的那个局部 const。 */
    waitForUi: (what, expr) => waitFor(page, expr, what, 8000),
    /* 给 input / textarea / select 赋值并触发 input 的 setter。
       二十节（导航/项目）里定义的，二十一节也要用 —— 拆开后是两段字符串模板，
       各自定义等于抄两份。放这里一处。 */
    SETTER: `(el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
        : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }`,
    web: { get srv() { return web; }, set srv(v) { web = v; } },
    reloadWeb: async () => {
      const _sr = await serveDist(helpers.ports.web);
      web = _sr.srv; helpers.ports.web = _sr.webPort; WEB_PORT = _sr.webPort;
      procs.push({ kill: () => { if (web && web.listening) web.close(); } });
    },
  };
  ctx.ports = helpers.ports;
  ctx.helpers = helpers;

  const { sectionFiles } = await import('./sections/smoke/index.mjs');
  for (const f of sectionFiles) {
    const mod = await import(f);
    await mod.run(ctx);
  }

  page.close();
} catch (e) {
  failures++;
  console.error('\n探针中断：', e && e.message ? e.message : e);
  if (e && e.stack) console.error(String(e.stack).split('\n').slice(1, 5).join('\n'));
} finally {
  cleanup();
}

console.log(failures ? `\n✗ ${failures} 项不对\n` : '\n✓ 全通过\n');
process.exit(failures ? 1 : 0);
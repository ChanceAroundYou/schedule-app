/**
 * main.tsx —— 入口
 *
 * 上线走两步，顺序不能反：
 *
 *   1. **一次性拆掉旧版注册的 Service Worker。** 旧版（纯静态那一代）注册过
 *      sw.js，缓存名 `schedule-v12`，而且缓存里躺着**旧版 index.html**。
 *      网络抖动时它会回那份 HTML，那份 HTML 又去加载 app.js / views.js ——
 *      用户看到的是上一版界面，而且「怎么刷新都不变」。
 *   2. **注册新版自己的 Service Worker**（`sw.js`，见那个文件头），
 *      作用只有一个：断网时还能把应用打开。
 *
 * 这两步会打架 —— 第 1 步「注销作用域内所有 SW」会把第 2 步刚注册的也干掉。
 * 所以第 1 步**一辈子只跑一次**，用一个 localStorage 标记锁住。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tailwind.css';
import App from './App.tsx';
import { applySafeAreaInsets } from './data/widget.ts';
import { watchUpdates } from './data/update-guard.ts';

const RELOAD_FLAG = 'schedule-sw-cleared';
const MIGRATED_FLAG = 'schedule-sw-migrated';

/**
 * 拆掉旧版 SW。**只跑一次**，跑过就记标记，以后再进这个页面直接跳过。
 *
 * @returns 是否正在重载（调用方要立刻停下，别再往下走）
 */
async function migrateAwayFromLegacySW(): Promise<boolean> {
  if (localStorage.getItem(MIGRATED_FLAG) === '1') return false;

  // 不支持 SW 的环境（http 下的非 localhost）也要记标记，不然每次都要走一遍
  if (!('serviceWorker' in navigator)) {
    localStorage.setItem(MIGRATED_FLAG, '1');
    return false;
  }

  let cleaned = false;

  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) {
      // 只动我们自己作用域下的，不碰同一域名下别的应用的 SW
      const scope = r.scope || '';
      if (!scope.includes('/schedule/') && scope !== location.origin + '/') continue;
      await r.unregister();
      cleaned = true;
    }
  } catch (_) { /* 不支持就算了，不值得为它拦住启动 */ }

  try {
    for (const k of await caches.keys()) {
      // 旧版的缓存名长这样：schedule-v12。
      // **新版那个（sched-shell-*）不能删** —— 它是新 SW 存的应用外壳，
      // 删了就等于顺手把离线能力也清掉。
      if (!/^schedule-v\d+$/.test(k)) continue;
      await caches.delete(k);
      cleaned = true;
    }
  } catch (_) { /* 同上 */ }

  localStorage.setItem(MIGRATED_FLAG, '1');

  // 清理过就重载一次，让浏览器丢掉已注册的 controller。
  // 加 sessionStorage 标记：万一还有别的 SW 让下一轮也「清理成功」，
  // 也不会陷进无限刷新 —— 这是无头测试里最容易把浏览器挂死的一类 bug。
  if (cleaned && sessionStorage.getItem(RELOAD_FLAG) !== '1') {
    sessionStorage.setItem(RELOAD_FLAG, '1');
    location.reload();
    return true;
  }
  return false;
}

/**
 * 注册应用外壳的缓存（离线打开用）。
 *
 * `./sw.js` 而不是 `/sw.js`：作用域按脚本所在目录算，这样才落在 `/schedule/`
 * 下，和 vite 的 `base:'./'` 一致。用绝对路径的话 dev 与线上会错位。
 *
 * **开发时（`npm run dev`）不注册** —— 否则缓存会在改代码时把 dev 也一起骗了，
 * 正好踩中「改了代码但浏览器没生效」那个坑。`npm run preview` 是生产构建，
 * 会注册，探针要靠它测离线。
 */
function registerShell(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* 注册失败无所谓：照常能用，只是断网时打不开 */
  });
}

/**
 * 量一次系统栏占位并写进 CSS 变量（`--sat` 等）。
 *
 * ⚠️ **绝不能 await 它再首屏渲染**（2026-10-14，用户报「整个 App 卡在开屏页
 * 不能操作」时挖出来的）。
 *
 * 早先的写法是 `await applySafeAreaInsets()` 然后才 `createRoot().render()`，
 * 理由是「晚一步首帧就没内边距，顶栏会先贴着状态栏画出来再跳一下」。
 * 那个理由是假的，代价是真的：
 *
 *   插件调用要经 Capacitor 的桥。桥还没就绪时（冷启动那一刻很常见），
 *   这次调用会在渲染进程里**同步阻塞**等原生回应 —— 原生那边收不到就永远
 *   不回。于是：**首屏永远不画**，系统开屏一直挂着，用户点不动；
 *   连 DevTools 的 `Runtime.evaluate` 都会超时（主线程被占死）。
 *
 * 关键点：**JS 的超时救不了同步阻塞**（线程被占住，定时器根本不跑），
 * 所以唯一的办法就是**不让它挡在首屏前面**。安全区只是几个像素的内边距，
 * 晚一帧补上最多是一次几乎看不出来的轻微位移；而卡住是「整个 App 报废」。
 *
 * 转屏 / 从后台回来仍要重量：折叠屏展开、横竖屏切换后系统栏高度会变。
 */
function watchSafeArea(): void {
  void applySafeAreaInsets();
  window.addEventListener('resize', () => { void applySafeAreaInsets(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void applySafeAreaInsets();
  });
}

async function boot(): Promise<void> {
  const reloading = await migrateAwayFromLegacySW();
  if (reloading) return;

  registerShell();
  watchSafeArea();          // 不 await：见上面那段，别挡首屏

  /* 版本自检（2026-10-17）：线上换版后提示刷新，避免「发了新版还看到旧界面」。
     只在生产构建里做（dev 的 index.html 引的是 /src/main.tsx，比出来永远不一致）。
     不 await —— 它要发一个请求，卡在首屏前面没道理。 */
  if (import.meta.env.PROD) watchUpdates();

  const el = document.getElementById('root');
  if (!el) throw new Error('#root 不存在');
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();

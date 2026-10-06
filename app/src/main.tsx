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

async function boot(): Promise<void> {
  const reloading = await migrateAwayFromLegacySW();
  if (reloading) return;

  registerShell();

  const el = document.getElementById('root');
  if (!el) throw new Error('#root 不存在');
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();

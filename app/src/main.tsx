/**
 * main.tsx —— 入口
 *
 * **上线第一件事是拆掉旧的 Service Worker。**
 *
 * 旧版（纯静态那一代）注册了 `sw.js`，缓存名 `schedule-v12`，策略是网络优先 +
 * 离线回落。它缓存的是 /schedule/ 下的 index.html / app.js / views.js ——
 * 而新版的资源文件名完全不同（带 hash 的 assets/*.js）。问题是导航请求
 * （index.html）本身也在缓存里：离线或网络抖动时，旧 SW 会把**旧版 HTML**
 * 回给浏览器，那份 HTML 又去加载 app.js / views.js，于是用户看到的是
 * 上一个版本的界面，而且「怎么刷新都不变」。
 *
 * 所以：注销所有 SW + 清空所有 cache，然后重新加载一次。
 * 只在真的清理掉了东西时 reload，否则每次打开都要多转一圈。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tailwind.css';
import App from './App.tsx';

const RELOAD_FLAG = 'schedule-sw-cleared';

async function escapeLegacyServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
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
      if (!k.startsWith('schedule-')) continue;
      await caches.delete(k);
      cleaned = true;
    }
  } catch (_) { /* 同上 */ }

  // 清理过就重载一次，让浏览器丢掉已注册的 controller。
  // 加 sessionStorage 标记：万一下一次仍然「清理成功」（比如每次都有别的 SW），
  // 也不会陷进无限刷新 —— 这是无头测试里最容易把浏览器挂死的一类 bug。
  if (cleaned && sessionStorage.getItem(RELOAD_FLAG) !== '1') {
    sessionStorage.setItem(RELOAD_FLAG, '1');
    location.reload();
    return true;
  }
  return false;
}

async function boot(): Promise<void> {
  const reloading = await escapeLegacyServiceWorker();
  if (reloading) return;

  const el = document.getElementById('root');
  if (!el) throw new Error('#root 不存在');
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();

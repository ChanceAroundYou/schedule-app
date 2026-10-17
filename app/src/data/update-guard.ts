/**
 * update-guard —— 让「发了新版却看不到变化」自己好起来
 *
 * 用户 2026-10-17 的原话：「我已经检测过了，你这边什么都没有改。」
 * 查下来线上产物确实是最新的（线上 bundle 与本地同指纹、三条改动逐条实测通过），
 * 问题出在**浏览器这一端拿到了旧页面**，而它不会自愈：
 *
 *   1. **页面一直开着** —— 单页应用（SPA）的代码在打开那一刻就固定了，
 *      之后再怎么「刷新」当前标签、切页面，都不会换成新 bundle；
 *   2. **断网/抖动时回落到旧壳** —— `sw.js` 的 `navFirst()` 在网络失败时
 *      会把缓存里的 index.html 端出来。那份 HTML 引的是**旧版** assets，
 *      于是界面回到上一版，而且只要网络不稳就一直这样。
 *
 * 所以这里做一件很小的事：启动后静默拉一次线上的 `index.html`（不走缓存），
 * 比对**它引用的主 JS 文件名**与「当前正在跑的那个」是否一致。
 * 不一致 = 线上已经换版 → 提示用户点一下刷新，并顺手清掉 SW 的壳缓存，
 * 免得更完还是旧的。
 *
 * 为什么比文件名而不是版本号：版本号只在发版时变，一天发五次它也还是同一个号；
 * assets 文件名带内容哈希，**内容一变名字就变**，这是唯一靠得住的判据。
 *
 * ⚠️ 只在生产构建里跑：dev 是 vite 现场编译，index.html 引的是 /src/main.tsx，
 * 比出来永远「不一致」，会把开发环境刷成无限重载。
 */

import { toast } from '../ui/kit.tsx';

/** 当前正在跑的主 JS 文件名（`index-XXXX.js`） */
function runningBundle(): string {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  if (!el || !el.src) return '';
  return el.src.split('/').pop() || '';
}

/** 线上 index.html 现在引用的主 JS 文件名 */
async function latestBundle(): Promise<string> {
  /* ⚠️ 必须带一个随机查询串：不带的话这个请求会被 sw.js 的
     `staleWhileRevalidate` 命中缓存里的**旧** index.html —— 那就变成
     「旧的自己跟自己比」，永远一致，自检形同虚设。
     带 `?v=随机数` 后缓存里没有这个 key，会老实走网络。 */
  const res = await fetch('./index.html?v=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) return '';
  const html = await res.text();
  const m = html.match(/src="[^"]*\/assets\/(index-[^"]+\.js)"/);
  return m ? m[1] : '';
}

/** 清掉 SW 存的应用外壳（只清 `sched-shell-*`，不碰别的应用） */
async function dropShellCache(): Promise<void> {
  try {
    for (const k of await caches.keys()) {
      if (k.startsWith('sched-shell-')) await caches.delete(k);
    }
  } catch (_) { /* 不支持 Cache API 就算了，刷新本身也大概率能换掉 */ }
}

let prompted = false;

/** 查一次有没有新版；有就提示。失败一律静默（离线时本来就拉不到） */
export async function checkForUpdate(): Promise<void> {
  if (prompted) return;
  try {
    const [cur, next] = [runningBundle(), await latestBundle()];
    if (!cur || !next || cur === next) return;
    prompted = true;
    toast('有新版本了', {
      label: '刷新',
      run: () => {
        void dropShellCache().finally(() => {
          // 用 replace 而不是 reload：刷新后不该多留一条历史记录
          location.reload();
        });
      },
    });
  } catch (_) { /* 静默 */ }
}

/**
 * 装上自检：启动查一次，之后**回到前台**再查（手机切回来最常见）。
 *
 * 限流 5 分钟：visibilitychange 在手机上触发很频繁（下拉通知栏、切相机都会来一发），
 * 每次都发请求既费流量也吵。
 */
export function watchUpdates(): void {
  let last = 0;
  const run = () => {
    const now = Date.now();
    if (now - last < 5 * 60_000) return;
    last = now;
    void checkForUpdate();
  };
  /* 首查延后 1.5 秒：ToastHost 要等 React 挂完才有监听，太早发的提示会丢；
     也避免抢首屏那一下的网络。 */
  setTimeout(run, 1500);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) run();
  });
}

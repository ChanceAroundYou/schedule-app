/**
 * sw.js —— 应用外壳的离线缓存
 *
 * 它只做一件事：**断网时还能把应用打开**。数据层本来就是离线的
 * （localStorage + outbox，见 sync/engine.ts），缺的一直是「页面本身加载不出来」。
 *
 * 策略按请求类型分开，不是一刀切：
 *
 *   ../api/*      **一律不碰。** 同步引擎自己管重试和发件箱；缓存一个接口响应
 *                 会让用户看到过期数据却以为是最新的
 *   导航请求      网络优先 + 回落缓存里的 index.html。**不能反过来** ——
 *                 缓存优先正是旧版那个「怎么刷新都是旧界面」的病根
 *   ../assets/*   缓存优先。文件名带内容哈希，内容一变名字就变，
 *                 同一个 URL 永远不会变内容，没有过期问题
 *   其余同源 GET  先给缓存、后台更新（图标、manifest 这些）
 *
 * **装的时候现场抠一份预缓存清单**：构建产物的文件名带哈希，写死在源码里会
 * 立刻过期，所以改成「拿 index.html，把里面引用的 assets 抠出来存下」。
 * 不这么做的话，**第一次访问是缓存不到东西的** —— 那一趟资源早就直接走网络
 * 拿完了，SW 才刚 activate，于是离线能力要等到「第二次打开」才有。
 *
 * ⚠️ 改这个文件之后**不用**动版本号，浏览器每次导航都会重新校验它
 * （nginx 给 /schedule/ 配的是 no-cache）。但改了缓存策略要改 CACHE 名字，
 * 否则 activate 里删旧缓存那一步不会触发。
 */

const CACHE = 'sched-shell-v2';

/** 这些都要按 sw.js 自己的位置算 —— 应用挂在 /schedule/ 下，不是根 */
const INDEX = new URL('./index.html', self.location.href).href;
const API = new URL('./api/', self.location.href).pathname;
const ASSETS = new URL('./assets/', self.location.href).pathname;

/** 第一次打开就在离线状态、缓存里什么都没有时的兜底页 */
const COLD_OFFLINE = '<!doctype html><meta charset="utf-8">'
  + '<title>离线</title>'
  + '<body style="font:15px/1.8 system-ui,sans-serif;padding:2.5rem;color:#666">'
  + '<h2 style="color:#333">现在连不上</h2>'
  + '<p>这台设备还没有缓存过应用，先联网打开一次。</p>';

/** 名字固定、不进哈希，可以直接写死。少一个离线时就是页头缺个图标 */
const EXTRA = ['manifest.json', 'icon.svg'].map((f) => new URL(f, INDEX).href);

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await precacheShell();
    await self.skipWaiting();   // 不留旧 worker 在旁边等着，直接接管
  })());
});

/**
 * 装上那一刻就把外壳拿下来：index.html + 它引用的那几个 assets。
 *
 * 任何一步失败都不抛 —— 离线能力是加分项，装不上也要让 SW 正常激活，
 * 大不了退化成「联网多打开一次才有」。
 */
async function precacheShell() {
  try {
    const cache = await caches.open(CACHE);
    const res = await fetch(INDEX, { cache: 'reload' });
    if (!res || !res.ok) return;
    const html = await res.clone().text();
    await cache.put(INDEX, res);

    // Vite 出来的就是 <script src="./assets/index-XXX.js"> 与
    // <link href="./assets/index-XXX.css"> 这两种形状，正则够用；
    // 万一以后形态变了，最坏结果也只是「少预缓存一个文件」，
    // 那个文件仍会在第一次真正用到时被 cacheFirst 存下来
    const urls = new Set();
    for (const m of html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)) {
      urls.add(new URL(m[1], INDEX).href);
    }
    await Promise.all([...urls, ...EXTRA].map(async (u) => {
      try {
        const r = await fetch(u, { cache: 'reload' });
        if (r && r.ok) await cache.put(u, r);
      } catch (_) { /* 少一个资源不值得让 install 失败 */ }
    }));
  } catch (_) { /* 同上 */ }
}


self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      // 只删自己上一代。旧版的 schedule-v12 由页面里的
      // migrateAwayFromLegacySW() 负责，两边各管各的
      if (k.startsWith('sched-shell-') && k !== CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

// ponytail: 同一个 CACHE 里，历次部署留下的旧哈希资源会一直躺着（改名才清）。
// 一个文件几十到几百 KB，几年下来也就几十 MB —— 不值得为它写一套 LRU。
// 真嫌大了把 CACHE 改名抬一版就清空了。

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(API)) return;      // 接口交给引擎，别插手

  if (req.mode === 'navigate') { e.respondWith(navFirst(req)); return; }
  if (url.pathname.startsWith(ASSETS)) { e.respondWith(cacheFirst(req)); return; }
  e.respondWith(staleWhileRevalidate(req));
});

/** 导航：网络优先，断了才用缓存里的壳 */
async function navFirst(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      // 存成 INDEX 这个固定键 —— 不管用户访问的是 /schedule/ 还是
      // /schedule/index.html?x=1，下次离线都要能落到同一份壳上
      const cache = await caches.open(CACHE);
      void cache.put(INDEX, res.clone());
    }
    return res;
  } catch (_) {
    const hit = await caches.match(INDEX);
    if (hit) return hit;
    return new Response(COLD_OFFLINE, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
}

/** 带哈希的资源：同一个 URL 内容永不变，命中就直接用 */
async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;

  const res = await fetch(req);
  if (res && res.ok) {
    const cache = await caches.open(CACHE);
    void cache.put(req, res.clone());
  }
  return res;   // 离线且没缓存时让它抛 —— 这种资源本来就没法降级
}

/** 图标 / manifest 这类：先给缓存，同时后台更新 */
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);

  const net = fetch(req).then((res) => {
    if (res && res.ok) void cache.put(req, res.clone());
    return res;
  });

  if (hit) {
    void net.catch(() => { /* 后台更新失败就失败，别抛到 SW 的 console 里 */ });
    return hit;
  }
  return net;
}

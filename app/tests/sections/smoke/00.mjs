export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n零、装上 Service Worker 的那一刻就有离线能力');
  // 必须在**这一趟**就断言。第六节会刷新页面，那之后缓存里必然有东西，
  // 再查就分不清「安装时预缓存了」和「后来被动存下来的」——
  // 而「第一次打开后断网能进」正是这个功能唯一要保证的事。
  await waitFor(page, `!!navigator.serviceWorker.controller`, 'Service Worker 接管页面', 15000);
  /* 缓存名不写死：sw.js 里那个 `CACHE` 常量会随策略升级抬版本
     （2026-10-17 从 sched-shell-v2 抬到 v3，写死的话产品没坏、探针先红）。
     只认前缀 `sched-shell-`，那是这个应用自己的命名空间。 */
  const cached = await evalJs(page, `
    const names = (await caches.keys()).filter((k) => k.startsWith('sched-shell-'));
    for (const n of names) {
      const c = await caches.open(n);
      const urls = (await c.keys()).map((r) => new URL(r.url).pathname);
      if (urls.some((p) => p.endsWith('/index.html'))) return urls;   // 取「真装好了」的那份
    }
    return [];
  `);
  ok(cached.some((p) => p.endsWith('/index.html')), '外壳 HTML 已预缓存，实际 ' + JSON.stringify(cached));
  ok(cached.some((p) => p.includes('/assets/') && p.endsWith('.js')), '带哈希的 JS 已预缓存');
  ok(cached.some((p) => p.includes('/assets/') && p.endsWith('.css')), '带哈希的 CSS 已预缓存');
  ok(cached.some((p) => p.endsWith('/manifest.json')), 'manifest 已预缓存');
  ok(cached.some((p) => p.endsWith('/icon.svg')), '图标已预缓存');


}

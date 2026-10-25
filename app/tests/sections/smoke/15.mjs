export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, web, reloadWeb } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n十三、离线：外壳能打开，顶栏会说话');
  // Service Worker 在第一趟就接管了（见「零」）。这里只确认它没在这几轮
  // 刷新 / 邀请流程里掉线 —— 掉了的话下面那几条会以另一种方式失败
  ok(await evalJs(page, `return !!navigator.serviceWorker.controller;`),
    'Service Worker 一直接管着页面');

  // navigator.onLine 不会因为「我把本地服务器关了」而变 —— 它反映的是网卡。
  // 要用 CDP 模拟离线才能驱动 offline 事件。
  await page.send('Network.enable');
  await page.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await waitFor(page, `navigator.onLine === false`, '浏览器报告离线', 5000);
  await waitFor(page, `document.querySelector('.sync-dot[title*="离线"]') ? 1 : null`,
    '顶栏出现离线标记', 5000);
  ok(true, '断网时顶栏告诉用户「改动先存在本机」，而不是一直转圈');

  await page.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await waitFor(page, `navigator.onLine === true`, '恢复联网', 5000);
  ok(await evalJs(page, `return !document.querySelector('.sync-dot[title*="离线"]');`),
    '联网后离线标记消失');

  // 真正的离线考验：把静态服务关掉再刷新，页面只可能来自 Service Worker 缓存。
  // closeAllConnections 是必须的 —— 光 close() 只停止接受新连接，Chrome 池子里
  // 那条 keep-alive 还能把请求送进来，测试会假通过。
  web.srv.closeAllConnections?.();
  await new Promise((r) => web.srv.close(r));
  await page.send('Page.reload');
  await waitFor(page, `!!document.querySelector('.sidebar')`, '断网后仍能打开应用', 12000);
  ok(await withCals(() => evalJs(page, `
    return [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .some((b) => b.textContent.trim() === '全家');`)),
    '断网打开的是同一份数据（日程集名字还在）');
  await closeCalMenu();
  ok(await evalJs(page, `return document.querySelectorAll('[data-nav]').length > 0;`),
    '断网时导航也在，不是白屏');

  collect();
  // 断网时 /api/ 的请求必然失败 —— Service Worker **故意不碰接口**，这是设计如此。
  // 引擎自己会把它记成 lastError 显示出来，所以这里只关心别的来源的报错。
  const other = errors.filter((e) => !e.url.includes('/api/'));
  ok(other.length === 0, '离线这一段除了接口连不上，没有别的 console 报错'
    + (other.length ? '：\n      ' + fmt(other) : ''));

  // 静态服务关了之后必须重开 —— 后面几节（尤其十六的改密码）要走 /api/ 代理。
  // 不重开的话它们会以另一种方式失败：fetch 直接「连不上服务器」，
  // 看着像网络问题，其实是代理没了。
  await reloadWeb();

  // 放在最后、且刻意在「关掉静态服务」之后：这一节全是纯 DOM 查询，
  // 不需要网络，而断网那一节已经把服务器关了 —— 插在它前面会被它的
  // closeAllConnections 打乱状态，插在后面则完全不动已有状态。

}

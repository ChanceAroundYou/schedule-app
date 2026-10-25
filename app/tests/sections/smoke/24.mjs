export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n二十、修改密码：改完还登录着，别的设备被踢出去');

  // 先确认后端还活着 —— 后端 stdio 是 ignore，死了会静默，
  // 症状是「连不上服务器」，看着像网络问题其实是进程没了
  let health = 'node-side fetch failed';
  try {
    const hr = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
    health = String(hr.status);
  } catch (e) { health = 'node fetch failed: ' + e.message; }
  ok(health === '200', '后端还活着（node health=' + health + '）');

  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'))`);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');
  await clickEl(page, `document.querySelector('.more-sheet [data-nav="settings"]')`);
  // 设置页现在是 tab 布局，先点关于 tab 再检查
  await clickEl(page, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '关于')`);
  await waitFor(page, `!!document.querySelector('[data-about="version"]')`, '设置页挂上');
  // 修改密码按钮在账户安全 tab 里
  await clickEl(page, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '安全')`);
  await clickEl(page, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '修改密码')`);
  await waitFor(page, `!!document.querySelector('input[type="password"]')`, '改口令浮层打开');
  ok((await evalJs(page, `return document.querySelectorAll('input[type="password"]').length;`)) === 3,
    '三个框：当前 / 新 / 再输一遍 —— 没有「找回口令」这回事，手一抖打错就没了');

  const setPw = (sel, v) => evalJs(page, `
    return (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'missing';
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })();
  `);

  // 先喂一个错的当前密码 —— 提示要说人话，而且**不能把人踢出去**
  await setPw('input[id$="-c"]', 'not-the-real-password');
  await setPw('input[id$="-n"]', 'brand-new-99');
  await setPw('input[id$="-a"]', 'brand-new-99');
  await clickEl(page, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '修改')`);
  await waitFor(page, `!!document.querySelector('[role="alert"]')`, '报错出现');
  const alertText = await evalJs(page, `return document.querySelector('[role="alert"]').textContent;`);
  ok(alertText.includes('当前密码'), '提示说「当前密码不对」，实际：' + alertText);
  ok(await evalJs(page, `return !!document.querySelector('input[type="password"]');`),
    '报错之后浮层还开着 —— 关掉了等于什么也没说');

  // 再喂对的（第二节注册时用的就是 pw123456）。
  // 先把当前那只 token 存下来 —— 等下要证它**被作废了**。
  const oldTok = await evalJs(page, `return localStorage.getItem('schedule-app-token');`);
  await setPw('input[id$="-c"]', 'pw123456');
  await clickEl(page, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '修改')`);
  await waitFor(page, `document.querySelector('input[type="password"]') ? null : 1`, '浮层关掉了', 8000);
  await new Promise((r) => setTimeout(r, 400));

  // **最要紧那一条**：改完还登录着。服务器会作废掉改动之前签的那只票
  //（含请求里用的那只），所以客户端必须换上响应里带回的那只 ——
  // 换了之后刷新还在，用户感知不到。
  await page.send('Page.navigate', { url: `http://127.0.0.1:${webPort}/` });
  await waitFor(page, `!!document.querySelector('#nav') || !!document.querySelector('.tabbar')`, '刷新后主界面挂上');
  await new Promise((r) => setTimeout(r, 1500));
  // 窄屏下侧栏不渲染（`{!narrow && <Sidebar/>}`），`.brand-name` 不存在 ——
  // 用 `.tabbar` 代替，它在两种模式下都在
  ok(await evalJs(page, `return !document.querySelector('[data-act="login"]') && !!document.querySelector('.tabbar');`),
    '改完密码刷新后**还登录着**（没有被自己踢出去）');
  const newTok = await evalJs(page, `return localStorage.getItem('schedule-app-token');`);
  ok(newTok && newTok !== oldTok, '本机存的 token 已经换成了新的那只');

  // 服务器上真换了，而且改动之前签的那只确实被作废了
  const pwCheck = await evalJs(page, `
    const me = await fetch('./api/me', { headers: { authorization: 'Bearer ' + localStorage.getItem('schedule-app-token') } });
    const old = await fetch('./api/me', { headers: { authorization: 'Bearer ' + ${JSON.stringify(oldTok)} } });
    return { me: me.status, old: old.status };
  `);
  ok(pwCheck.me === 200, '换上的那只 token 在服务器上是好的，实际 ' + JSON.stringify(pwCheck));
  ok(pwCheck.old === 401, '改动之前签的那只被作废了（别人手里的旧票失效），实际 ' + JSON.stringify(pwCheck));

  /* ---- 二十一、副header 四个控件同高 + 周视图表头简化 ----
     这一节跑在**宽屏**下（探针窗口 1280px），锁的是宽屏下能验的部分。
     窄屏那几条（34px 按钮、7 列横滑、表头 width:max-content、centerWeekDay 居中）
     原先写着「测不了」，**2026-10-25 起不成立了**：26 节用
     `Emulation.setDeviceMetricsOverride` 把视口真的压到 390×854，媒体查询生效、
     合成点击也进处理器。要验窄屏就往 26 节加，别在伪窄屏（matchMedia Proxy）上写 ——
     那个只骗得过 JS，CSS 一条都不生效。 */

}

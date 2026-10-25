export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n三、进入主界面，顶栏有日程集多选');
  try {
    await waitFor(page, `!!document.querySelector('.sidebar')`, '侧栏渲染出来', 20000);
  } catch (e) {
    await dumpPage(page, '等侧栏超时（注册后没进主界面）');
    throw e;
  }
  ok(await evalJs(page, `return !!document.querySelector('[data-nav="today"]');`), '侧栏有导航项');
  // 桌面端日程集是**顶栏那个下拉多选框**（侧栏那一列已经收掉了 —— 侧栏顺序
  // 是用户自己排的，塞常驻控件进去会跟「底栏挑哪几项」抢位置）。默认日程集
  // 「我的日程」也在列表里，老数据迁移过来时 ui.cals 从 ui.cal 起步，
  // 所以进界面就该勾着一个。
  const cals0 = await withCals(() => evalJs(page, `
    return [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')].map((b) => ({
      name: b.textContent.trim(), on: b.getAttribute('aria-pressed') === 'true' }));`));
  ok(cals0.length === 1 && cals0[0].name === '我的日程',
    '下拉里列出默认日程集，实际 ' + JSON.stringify(cals0));
  ok(cals0.filter((c) => c.on).length === 1, '进界面时正好勾着一个（当前集）');
  /* 打勾的勾要**正落在圆心**（用户 2026-10-09：「打勾的图标的勾并不居中」）。
     原来写 `left:5px; top:2px` + `rotate(45deg)`：`left/top` 摆的是盒子的左上角，
     盒子中心就落在 (7,6)，而圆心在 (9,9) —— 勾整体偏左上 2×3px。
     改成 `left:50%; top:50%; translate(-50%,-50%) rotate(45deg)` 之后，盒子中心
     正好是圆心（旋转以盒子中心为原点，不动中心）。
     量的就是**勾盒中心减圆心**：`left:50%` 相对 padding 盒算，要加回边框宽度。 */
  const tick18 = await withCals(() => evalJs(page, `
    const b = document.querySelector('.cal-menu-pop [data-cal-row] .check-btn');
    const cs = getComputedStyle(b, '::after'), cb = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    const w = parseFloat(cs.width), h = parseFloat(cs.height);
    const t = cs.transform;
    let e = 0, f = 0;
    if (t && t.startsWith('matrix')) { const p = t.slice(7, -1).split(',').map(Number); e = p[4]; f = p[5]; }
    return { 圈直径: r.width,
             勾中心偏移: [+(parseFloat(cb.borderLeftWidth) + parseFloat(cs.left) + w / 2 + e - r.width / 2).toFixed(2),
                       +(parseFloat(cb.borderTopWidth) + parseFloat(cs.top) + h / 2 + f - r.height / 2).toFixed(2)] };
  `));
  ok(Math.abs(tick18.勾中心偏移[0]) <= 1.0 && Math.abs(tick18.勾中心偏移[1]) <= 1.0,
    '桌面 ' + tick18.圈直径 + 'px 勾选圈里，勾盒中心落在圆心（容差 1px：光学补偿是'
    + '**故意**偏一点点，让 L 形勾的墨迹重心回到圆心），实际 '
    + JSON.stringify(tick18.勾中心偏移));
  // 改名 / 成员 / 邀请 / 退出 / 删除全在设置页了，下拉里只留勾选
  ok(await withCals(() => evalJs(page, `
    return document.querySelectorAll('.cal-menu-pop [data-cal-manage], .cal-menu-pop [data-cal-invites], .cal-menu-pop [data-cal-new]').length === 0;`)),
    '下拉里没有管理 / 邀请 / 新建入口（都在设置页）');
  /* 下拉是**新的一层**（role="group" 里一排 aria-pressed 按钮），a11y() 要单独
     缩范围扫它一遍 —— 扫全文档时它多半关着，里面一行都没有，等于没扫。 */
  const menuA11y = await evalJs(page, `return { bad: ${a11y('.cal-menu-pop')} };`);
  ok(menuA11y.bad.length === 0, '下拉里每个控件都有名字、勾选圈也是真按钮'
    + (menuA11y.bad.length ? '：\n      ' + fmt(menuA11y.bad) : ''));
  await closeCalMenu();


}

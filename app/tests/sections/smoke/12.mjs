export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, api } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  /* 第八节注册的「妈妈」那个账号与她的集 —— 拆开后不在同一个作用域里，
     由第八节放进 ctx.state。 */
  const { mom, momCal, momCalName } = ctx.state;
  console.log('\n十、被降成只读之后：改动挡下来，并且说是哪个集');
  /* 这一节测的是「写操作不许静默失败」那条约定（见 docs/界面规则.md 五、只读 / 状态）。
     store 那一层有单测，但**接线**没测过：计数器涨了、提示没弹出来，
     用户看到的还是「点了没反应」。所以这里走完整条路：真降权限 → 真点 → 真看提示。

     顺序上放在拖拽两节之后：这一节要往待办箱里加一条自己的任务，
     放到第八节前面会把它那句「三条任务按添加顺序排」污染掉。 */
  await evalJs(page, `document.querySelector('[data-nav="inbox"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.fast-add textarea')`, '待办箱能快速添加');
  // 现在还写得进去（是 editor），先在**共享的那个集**里留下一条，
  // 后面降成只读才有一条现成的可以点。
  // **必须显式切过去**：第七节末尾归属在「全家」，不切的话这条会落进自己那个
  // 集里，降级对它不生效，下面「改动被挡下来」整段都会假红。
  await focusCal(state.momCal);
  await quickAdd(page, '共享的事');
  await waitFor(page,
    `JSON.parse(localStorage.getItem('schedule-app-v4')).outbox.length === 0`,
    '这条改动推上去了', 12000);
  ok(true, '降级前能正常写入（editor）');

  const dadId = await evalJs(page, `
    const r = await fetch('./api/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('schedule-app-token') } });
    return (await r.json()).user.id;
  `);
  const down = await api('PATCH', `/cals/${state.momCal}/members/${dadId}`, { role: 'viewer' }, state.mom.body.token);
  ok(down.status === 200, '妈妈把爸爸降成只读，实际 HTTP ' + down.status);
  ok(down.body?.error === undefined, '降级没有报错：' + JSON.stringify(down.body));

  // 催一次同步把新角色拉下来，然后确认界面真的知道了。
  // **分两段等**：本地那一层（localStorage 里的 cals）先，DOM 后。
  // 合成一个条件的话，超时时分不清是「同步压根没发生」还是「同步到了但界面没画」，
  // 而这两件的排查方向完全相反。
  await evalJs(page, `window.dispatchEvent(new Event('focus')); return true;`);
  await waitFor(page, `
    (JSON.parse(localStorage.getItem('schedule-app-v4')).cals.find((c) => c.id === ${JSON.stringify(state.momCal)}) || {}).role === 'viewer' ? 1 : null`,
    '本地拉到新角色（还停在 editor 说明这一轮同步没跑）', 15000);
  await withCals(() => waitFor(page, `
    [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .some((b) => b.textContent.includes('只读')) ? 1 : null`,
    '下拉显示「只读」', 8000));
  ok(true, '降级后下拉里把那个集标成「只读」');
  await closeCalMenu();

  // 点掉一条：这是用户在跨集页面上最常做的动作
  const hit = await clickEl(page, `
    [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
      .find((e) => e.textContent.includes('共享的事'))?.querySelector('[data-act="toggle"]')
  `);
  ok(hit !== 'missing', '找到「共享的事」的勾选框（实际事件序列 ' + hit + '）');
  const said = await waitFor(page, `
    [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent).join(' | ') || null
  `, '弹出提示', 5000);
  // **要认集名**：只说「这个日程集你只有查看权限」的话，用户正在「今天」这类
  // 跨集页面上，会以为是眼前这个集出了问题
  ok(said.includes(state.momCalName), '提示里点名了是哪个集（' + state.momCalName + '），实际 ' + JSON.stringify(said));
  ok(said.includes('查看权限'), '提示说清了原因，实际 ' + JSON.stringify(said));
  ok(await evalJs(page, `
    const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
      .find((x) => x.title === '共享的事');
    return t && !t.done;
  `), '被挡下的勾选没有写进本地（不是「界面没反应但数据已经改了」）');


}

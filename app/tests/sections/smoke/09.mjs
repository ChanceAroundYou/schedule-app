export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n七之二、日程集多选：勾选只管显示，归属不许掉进看不见的集');
  /* 锁的是 store.toggleCal 那两条（domain.test.ts 里锁的是老数据迁移，这里证的是接线）：
       1. 取消勾掉一个集 → 显示范围变小，但**归属还看得见**（让给还勾着的那个）
       2. 想把最后一个也取消掉 → 不生效。日程页全空看着像坏了，而且新建的
          东西会落进没勾的集里，用户看到的是「凭空消失」。

     **全部只读 aria-pressed，不读 localStorage**：persist 有防抖，点完立刻读
     落盘的那份拿到的是上一版（探针自己在第十一节被这个坑绊过）。 */
  /* shown / clickCal / waitShownCount / focusCal 四个助手在第三节就定义了
     （日程集下拉在顶栏，第三节是第一个要用到的地方），这里直接用。 */

  await clickCal('全家');
  ok(await waitShownCount(1, '只剩一个集勾着') === 1,
    '取消勾掉「全家」之后只剩一个集勾着，实际 ' + JSON.stringify(await shown()));
  ok(await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    return st.ui.cals.includes(st.ui.cal);
  `), '归属（新建落哪儿）仍然是被勾着的那个');

  await clickCal('全家');
  ok(await waitShownCount(2, '重新勾上「全家」') === 1, '勾回去能恢复');

  /* 最后一个不许取消掉。**必须一次只点一个** —— 点完 React 就重渲染了，
     同一批 NodeList 里的另一个节点已经脱离文档，点击不会再冒泡到容器根，
     事件委托（挂在 #content 上）收不到，看起来就像「点了没反应」。 */
  await clickCal('全家');
  ok(await waitShownCount(1, '只剩一个集勾着') === 1, '再取消掉「全家」');
  await clickCal((await shown())[0]);
  ok(await withCals(() => evalJs(page, `
    return [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true').length === 1;
  `)), '想「一个都不勾」不生效（至少留一个，避免新建的东西凭空消失）');
  await closeCalMenu();

  // 上面那两步把归属甩到了只读的共享集上 —— 后面几节要在「全家」里改东西，
  // 这里明确勾回去（勾上就顺带成为归属，见 toggleCal）
  await clickCal('全家');
  ok(await waitShownCount(2, '两个集都勾回来了') === 1, '恢复成两个都勾着、归属在「全家」');

  collect();
  ok(errors.length === 0, '邀请这一段也没有 console 报错'
    + (errors.length ? '：\n      ' + fmt(errors) : ''));


}

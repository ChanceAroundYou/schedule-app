export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, api } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n七、别人邀请我 → 接受 → 多一个集');
  // 用另一个账号（直接从 API 建）向浏览器里这个人发邀请，看界面接不接得住
  const mom = await api('POST', '/auth/register', { name: '妈妈', password: 'pw123456' });
  ok(mom.status === 200, '另一个账户注册成功');
  const momMe = (await api('GET', '/me', undefined, mom.body.token)).body;
  const momCal = momMe.cals[0].id;
  const momCalName = momMe.cals[0].name;
  state.mom = mom; state.momCal = momCal; state.momCalName = momCalName;
  /* 后两节（第十、十一节）要用这几个 —— 拆分后它们**不再是同一个函数体里的
     局部变量**，往 ctx.state 上放一份（原先就有这个共享对象，只是从没用上）。 */
  Object.assign(state, { mom, momCal, momCalName });
  const inv = await api('POST', `/cals/${momCal}/invites`, { name: '爸爸', role: 'editor' }, mom.body.token);
  ok(inv.status === 200, '妈妈发出邀请');

  // 引擎平时 15 秒轮询一次、或窗口重新获得焦点时同步。这里催它一下，别干等
  await evalJs(page, `window.dispatchEvent(new Event('focus')); return true;`);
  // 邀请收件箱在设置页的「日程集管理」卡头上（侧栏那个入口删了，跟着改名 /
  // 成员一起收进设置页 —— 它们本来就是同一类低频动作）
  await evalJs(page, `document.querySelector('[data-nav="settings"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[data-settings-tab="cals"]')`, '设置页打开', 8000);
  await evalJs(page, `document.querySelector('[data-settings-tab="cals"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[data-cal-invites]')`, '设置页出现邀请收件箱', 12000);
  const badge = await evalJs(page, `return document.querySelector('[data-cal-invites]').innerText.trim();`);
  ok(badge.includes('1'), '邀请收件箱上写着 1，实际 ' + JSON.stringify(badge));

  await evalJs(page, `document.querySelector('[data-cal-invites]').click(); return true;`);
  await waitFor(page, `document.body.innerText.includes('邀请你加入')`, '邀请浮层打开');
  const invText = await evalJs(page, `return document.querySelector('[role="dialog"]').innerText;`);
  ok(invText.includes('妈妈'), '浮层里写着谁邀请的');
  // 注意认的是**对方的**集名。自己那个已经被改成「全家」了，两者不会混
  ok(invText.includes(momCalName), '浮层里写着哪个日程集（' + momCalName + '）');
  ok(invText.includes('可编辑'), '浮层里写着什么权限');

  await evalJs(page, `
    const d = document.querySelector('[role="dialog"]');
    [...d.querySelectorAll('button')].find((b) => b.textContent.includes('接受')).click();
    return true;
  `);
  /* 菜单这会儿是关着的（上一节末尾 focusCal 顺手关了），先打开再数 */
  await withCals(() => waitFor(page,
    `document.querySelectorAll('.cal-menu-pop [data-cal-row]').length === 2`, '接受后下拉里有两个集', 12000));
  /* 多选下判「切过去了」不能看高亮：**两个可能都勾着**（全家本来就勾着，
     接受完自动把新集也勾上并设成归属）。所以认「被勾上」+「归属是它」两件事。 */
  const afterAccept = await withCals(() => evalJs(page, `
    return [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .map((b) => ({ name: b.textContent.trim(), on: b.getAttribute('aria-pressed') === 'true' }));
  `));
  ok(afterAccept.filter((r) => r.on).length === 2, '两个集都勾上了（原来那个不该被取消勾选）'
    + '　实际 ' + JSON.stringify(afterAccept));
  /* **先等落盘再读 ui.cal**：persist 有 250ms 防抖，接受完立刻读 localStorage
     拿到的是上一版（归属还是「全家」），断言会假红 —— 而且红在「归属没切过去」，
     看着像 toggleCal 的锅，其实是读早了。 */
  await waitFor(page, `
    (JSON.parse(localStorage.getItem('schedule-app-v4')).ui || {}).cals?.length === 2 ? 1 : null`,
    '落盘了（persist 有防抖，读早了是上一版）', 5000);
  ok(await withCals(() => evalJs(page, `
    const rows = [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')];
    const mine = rows.find((b) => b.textContent.includes('可编辑'));
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    return !!(mine && st.ui.cal === mine.dataset.calRow);
  `)), '接受完自动把归属切到刚加入的那个集');
  await closeCalMenu();
  ok(await evalJs(page, `return document.querySelector('[data-cal-invites]') === null;`),
    '处理完之后邀请收件箱消失');
  ok(await evalJs(page, `return document.querySelectorAll('[data-cal-item]').length === 2;`),
    '设置页的日程集管理里也是两个集');
  ok(await evalJs(page, `return !!localStorage.getItem('schedule-app-v4');`), '本地状态有落盘');


}

export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n二、注册一个账户');
  await evalJs(page, `
    const btns = [...document.querySelectorAll('button')];
    btns.find((b) => b.textContent.includes('注册一个')).click();
    return true;
  `);
  await waitFor(page, `document.body.innerText.includes('注册并进入')`, '切到注册模式');
  const reg = await evalJs(page, `
    /* 按属性取，不按位置。注册表单 2026-10-28 多了「昵称」那一行，原来那句
       const [n, p] = document.querySelectorAll('form input') 于是把密码灌进了昵称、
       密码留空 —— 红出来的是下一节「等侧栏渲染出来」超时，看着像主界面坏了。 */
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const n = document.querySelector('form input[autocomplete="username"]');
    const p = document.querySelector('form input[type="password"]');
    if (!n || !p) return { missing: { name: !!n, pwd: !!p }, count: document.querySelectorAll('form input').length };
    set.call(n, '爸爸'); n.dispatchEvent(new Event('input', { bubbles: true }));
    set.call(p, 'pw123456'); p.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('form').requestSubmit();
    return { filled: [n.id, p.id] };
  `);
  ok(reg && !reg.missing, '注册表单里认得出「用户名 / 密码」那两个输入框（多了字段也不许挤位）'
    + (reg && reg.missing ? '：' + JSON.stringify(reg.missing) : ''));

  /* -------- 日程集多选：顶栏那个下拉多选框 --------
     桌面端日程集不在侧栏（侧栏顺序是用户自己排的），在顶栏右边那个下拉多选框里，
     行是 `[data-cal-row]`。移动端走「更多」抽屉，探针跑的是桌面视口，用不到。

     **每个助手都先确认菜单开着** —— 关着的时候 `.cal-menu-pop` 里一行都没有，
     断言会假红在「找不到行」上，看着像多选坏了，其实是菜单没打开。 */


}

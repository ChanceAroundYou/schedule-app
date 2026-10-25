export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, sleep, num, WEB_PORT, TOUCH_DRAG_DELAY, gotoCalendar } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  const { RADIUS_K, RADIUS_MIN, TOL_RATIO, TOL_PAD, CHECK_K, CHECK_MIN, CHECK_MAX, WEEK_HEAD, DUR, table, detail, VIEWPORTS, VIEWS } = state;
  console.log('\n七、断言：日历里的拖拽表面不被文字选中');
  for (const view of ['day', 'month']) {
    await gotoCalendar();
    await evalJs(page, `
      const b = document.querySelector('.view-switch [data-view="${view}"]');
      if (b) b.click();
      return true;
    `);
    const marker = view === 'month' ? '.content-month' : '.content-day';
    await waitFor(page, `!!document.querySelector('${marker}')`, view + ' 视图（选中检查）');
    await sleep(350);
    const sel = await evalJs(page, `
      const read = (el) => {
        const cs = getComputedStyle(el);
        return { cls: el.className.split(' ')[0],
                 userSelect: cs.userSelect || cs.webkitUserSelect,
                 webkitUserSelect: cs.webkitUserSelect };
      };
      return {
        cards: [...document.querySelectorAll(
          '.content .task-el, .content .habit-row')].map(read),
        drafts: [...document.querySelectorAll('.content .new-cell')].map(read),
      };
    `);
    ok(sel.cards.length >= (view === 'month' ? 3 : 2),
      view + ' 量到拖拽表面 ' + sel.cards.length + ' 张（空列表等于没测）');
    for (const el of sel.cards) {
      ok(el.userSelect === 'none' || el.webkitUserSelect === 'none',
        view + ' ' + el.cls + ' 不被文字选中（user-select=' + el.userSelect
        + ' / -webkit-' + el.webkitUserSelect + '）');
    }
    /* 整屏只有草稿框存在时才量得到（点空格子才出），量到就要求可选中 */
    for (const el of sel.drafts) {
      ok(el.userSelect !== 'none', view + ' ' + el.cls + ' 是拿来打字的，文字仍可选中');
    }
  }
}

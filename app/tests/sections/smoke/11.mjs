export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n九、鼠标拖拽：MouseSensor 那一路没被触屏改动带坏');
  /* 鼠标走 dnd-kit 的 MouseSensor（mousedown / mousemove / mouseup）。
     这一节要证的**不是**排序逻辑本身（第八节已经证过了），
     而是鼠标这条**入口**还通着：mousedown 有没有记住拖的是谁、
     mousemove 有没有触发拖拽、mouseup 有没有真的落库。
     重构共享代码时最先坏的通常就是这一段接线。 */

  const pointerDrag = async (fromText, toText) => {
    const from = await evalJs(page, `
      const el = [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
        .find((e) => e.textContent.trim() === ${JSON.stringify(fromText)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    const to = await evalJs(page, `
      const el = [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
        .find((e) => e.textContent.trim() === ${JSON.stringify(toText)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    if (!from || !to) return 'missing';
    await evalJs(page, `
      const el = [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
        .find((e) => e.textContent.trim() === ${JSON.stringify(fromText)});
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      return true;
    `);
    await new Promise((r) => setTimeout(r, 50));
    await evalJs(page, `
      const el = document.elementFromPoint(${from.x}, ${from.y + 12});
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: ${from.x}, clientY: ${from.y + 12} }));
      return true;
    `);
    await new Promise((r) => setTimeout(r, 50));
    await evalJs(page, `
      const el = document.elementFromPoint(${to.x}, ${to.y});
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: ${to.x}, clientY: ${to.y} }));
      return true;
    `);
    await new Promise((r) => setTimeout(r, 50));
    await evalJs(page, `
      const el = document.elementFromPoint(${to.x}, ${to.y});
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: ${to.x}, clientY: ${to.y} }));
      return true;
    `);
    await new Promise((r) => setTimeout(r, 350));
    return 'ok';
  };

  ok((await inbox()).join('') === '乙丙甲', '接着第八节的状态，「甲」还在最后，实际 ' + JSON.stringify(await inbox()));
  ok(await pointerDrag('甲', '乙') === 'ok', '合成 pointer 拖拽打在行上');
  const mAfter = await inbox();
  ok(mAfter.join('') !== '乙丙甲', '鼠标拖完顺序真的变了，实际 ' + JSON.stringify(mAfter));
  ok(mAfter[0] === '甲', '「甲」被拖回了第一位，实际 ' + JSON.stringify(mAfter));
  const mSaved = await evalJs(page, `
    const now = JSON.parse(localStorage.getItem('schedule-app-v4')).tasks;
    return Object.values(now).filter((t) => !t.deleted).sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0))
      .map((t) => t.title);
  `);
  ok(mSaved.join('') === mAfter.join(''), '鼠标拖的结果也落库了，实际 ' + JSON.stringify(mSaved));


}

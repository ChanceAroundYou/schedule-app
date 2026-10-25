export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const { block } = ctx.state;   // 十四之一（时间轴上下沿）留下的那条「微调试试」
  console.log('\n十五、软键盘避让：--kb 有人写、固定的浮层有人读');
  //
  // 无头里造不出真软键盘（真实键盘是 OS 层的，CDP 没有这个开关），
  // 所以这一节只验**管道**，分两半：
  //   ① 有没有人在写 --kb（useKeyboardInset 挂上了没有）
  //   ② 写了之后固定浮层有没有真的让开（消费端接上了没有）
  // 中间那一步「visualViewport 变化 → 算出多少像素」只能靠真机，和触屏那条一样。
  //
  // 为什么值得单列一条：`dvh` 跟的是**布局视口**，软键盘只压小**可视视口** ——
  // 所以 `100dvh` / `88dvh` 一个字都不会躲，必须靠 visualViewport 算。
  // 这正是「输入框被键盘挡住」的根因，光看 CSS 是看不出来的。

  const kbVar = await evalJs(page, `return document.documentElement.style.getPropertyValue('--kb').trim();`);
  // 桌面无头没有软键盘，所以写出来是 0px —— 这里证的是「有人在写」，不是那个 0
  ok(/^\d+px$/.test(kbVar), 'useKeyboardInset 写上了 --kb，实际 ' + JSON.stringify(kbVar));

  // 打开一个固定定位的浮层，量它的底边。用抽屉里那条删除确认（Sheet），
  // 它是 `pb-[var(--kb,0px)]` 唯一的无条件消费点。
  // 抽屉自己那条 --kb 只在 ≤900px 生效（宽屏是侧栏面板，键盘盖不到），
  // 而这一节跑在桌面视口下 —— 所以这里测的是 Sheet 这条路径。
  //
  // **选择器不能只写 `[role="dialog"]`**：详情抽屉现在也是 dialog，而且它就开在
  // 下面一层 —— 裸选择器会先命中抽屉，于是「确认浮层打开」当场假通过
  // （抽屉早就在那儿了），末尾那句「等它关掉」则永远等不到（抽屉一直开着）。
  // Sheet 是 portal 到 body 的：body > 浮层容器 > 面板。
  const SHEET = `document.querySelector('body > div > div[role="dialog"]')`;
  await clickEl(page, `document.querySelector('.task-el--timed[data-id=${JSON.stringify(block.id)}]')`);
  await waitFor(page, `!!document.querySelector('.drawer.open .drawer-title')`, '抽屉打开', 8000);
  await clickEl(page, `document.querySelector('.drawer.open [aria-label="删除任务"]')`);
  await waitFor(page, `${SHEET} ? 1 : null`, '确认浮层打开', 8000);

  // 探针自己把 --kb 顶到 200px（无头里造不出键盘，只能直接写这个变量），
  // 然后量浮层有没有整体抬上去。**写完立刻量** —— getBoundingClientRect 会
  // 强制一次样式与布局，同一个同步块里就能读到新值。
  const avoid = await evalJs(page, `
    const root = document.documentElement;
    const prev = root.style.getPropertyValue('--kb');
    root.style.setProperty('--kb', '200px');
    const dlg = ${SHEET};
    if (!dlg) { root.style.setProperty('--kb', prev); return { err: '确认浮层没找到' }; }
    const r = dlg.getBoundingClientRect();
    const out = {
      bottom: Math.round(r.bottom), vh: window.innerHeight,
      pad: getComputedStyle(dlg.parentElement).paddingBottom,
    };
    root.style.setProperty('--kb', prev);
    return out;
  `);
  ok(!avoid.err && avoid.pad === '200px',
    '确认浮层的容器读到了 --kb（padding-bottom = ' + avoid.pad + '）' + (avoid.err ? '：' + avoid.err : ''));
  // 上面那条是这一节**唯一有牙**的断言：把 Sheet 外层那句 pb-[var(--kb,0px)]
  // 摘掉重跑，它当场变成 0px。下面这条是几何自检 —— 在桌面宽度下
  // （sm 断点起 items-end 换成 items-center）浮层本来就在上半屏，
  // 摘掉 padding 它照样通过，所以别把它当守卫。
  // 「贴着键盘上沿」这个位置关系只在 ≤640px 的 items-end 下成立，
  // 而这一节跑在桌面宽度下 —— 真·窄屏视口那套在 26 节。
  ok(avoid.bottom <= avoid.vh - 199,
    '浮层整个在「键盘」之上：底边 ' + avoid.bottom + ' ≤ 视口高 ' + avoid.vh + ' − 200');

  // 取消掉，别真删 —— 这条任务前面几节还要用
  await clickEl(page, `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === '取消')`);
  await waitFor(page, `${SHEET} ? null : 1`, '确认浮层关掉', 8000);


}

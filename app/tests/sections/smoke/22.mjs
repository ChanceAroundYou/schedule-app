export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, clickCal, waitShownCount, focusCal, inbox, webPort } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n十八、功能区自定义：底栏挑哪几项、设置页调序都记得住');

  // 这一节守的是两条**曾经是死数据**的字段（见 docs/踩坑-前端-交互.md 第 16 条）：
  // `ui.navOrder` / `ui.navBottom` 被 Shell 读着、却一度没有任何写入方，
  // 「拖过一次顺序就记住了」在那一版是假的。功能区自定义补回了写入方。
  //
  // 底栏（`.tabbar`）只在窄屏渲染。这里用**伪窄屏**（下面那段 matchMedia Proxy）
  // 验的是接线：真·窄屏视口探针在 26 节（`Emulation.setDeviceMetricsOverride`）。
  // 所以这里在 React 挂载之前把
  // `matchMedia('(max-width: 900px)')` 那一路改成 `matches: true`。
  // 用 Proxy 而不是 Object.assign：后者会把 MediaQueryList 压成普通对象，
  // 丢掉原型上的 addEventListener —— hooks.ts 里那一句会当场抛异常。
  //
  // 这验的是「narrow 为真时底栏与「更多」抽屉有没有被接出来」这条**接线**，
  // 不是真实窄屏下的排版 —— 后者要验就写在 26 节（真视口那一节）。
  //
  // 2026-10-07 起设置页的「功能区」卡片**按设备分屏**：窄屏只渲染底栏胶囊
  // （data-tab），宽屏只渲染侧栏列表（data-nav-row）。所以这一节拆成两半 ——
  // 前半伪窄屏测底栏、后半真宽屏测侧栏拖拽。开关放 sessionStorage 而不是内存：
  // 注入的脚本每次导航都会重跑，内存开关会被重置。
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
      const orig = window.matchMedia.bind(window);
      window.matchMedia = (q) => {
        const r = orig(q);
        if (!/max-width:\\s*900px/.test(String(q))) return r;
        if (sessionStorage.getItem('__forceNarrow') === '0') return r;
        return new Proxy(r, {
          get(t, k) {
            if (k === 'matches') return true;
            const v = t[k];
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      };
    })();
  ` });
  /** 伪窄屏 ↔ 真宽屏之间切换，靠 sessionStorage 开关 + 重新导航 */
  const reloadAs = async (forceNarrow, what) => {
    await evalJs(page, `sessionStorage.${forceNarrow ? "removeItem('__forceNarrow')" : "setItem('__forceNarrow', '0')"}; return 1;`);
    await page.send('Page.navigate', { url: `http://127.0.0.1:${webPort}/` });
    await waitFor(page, `!!document.querySelector('${forceNarrow ? '.tabbar' : '.sidebar'}')`, what, 15000);
  };
  await reloadAs(true, '窄屏模式下底栏渲染出来了');

  // 窄屏顶栏是「标题 + 搜索图标 + 状态」，搜索框收成点开的一格（2026-10-07
  // 顶栏重构）。这一小节顺带锁住 Esc 那一层 —— `searchOpen` 原先漏在键盘
  // effect 的依赖数组之外，于是闭包里读到的永远是 false：搜索开着按 Esc 关不掉。
  // 它必须**靠 CDP 派发**，因为要的就是「按真实焦点送一个 Escape 进 document」。

  /* 先把**桌面端那个搜索框**量下来当基准（用户 2026-10-09：「移动端打开最好和
     桌面端完全一样」）—— 切回真宽屏量一次再切回来。两处要特别小心：
     · 底色得拿**聚焦态**比 —— 移动端张开后输入框是自动聚焦的，
       `.search-box:focus-within` 会换底色；
     · 空着和有字是**两档**（176 / 195）：移动端张开后框里没字，对的就是**空着**那档
       （用户 2026-10-09：「清空键不需要，点击其他地方就关了」），有字那档在下面
       单独再对一次。 */
  await reloadAs(false, '切回真宽屏量桌面端搜索框');
  await evalJs(page, `document.querySelector('.topbar .search-box input').focus(); return 1;`);
  await new Promise((r) => setTimeout(r, 250));
  const measureDesk = () => evalJs(page, `
    const b = document.querySelector('.topbar .search-box');
    const r = b.getBoundingClientRect();
    const i = b.querySelector('.search-ico svg').getBoundingClientRect();
    const inp = b.querySelector('input').getBoundingClientRect();
    const cs = getComputedStyle(b);
    const x = b.querySelector('.clear-search');
    const xr = x ? x.getBoundingClientRect() : null;
    return { 宽: +r.width.toFixed(1), 高: +r.height.toFixed(1),
             放大镜: +i.width.toFixed(1) + 'x' + +i.height.toFixed(1),
             放大镜偏移: +(i.left - r.left).toFixed(1),
             输入宽: +inp.width.toFixed(1),
             清空键: xr ? +(xr.left - r.left).toFixed(1) : null,
             描边: cs.borderTopWidth, 圆角: cs.borderRadius,
             底色: cs.backgroundColor, 内边距: cs.paddingLeft + '/' + cs.paddingRight };`);
  const deskEmpty = await measureDesk();
  await evalJs(page, `
    const el = document.querySelector('.topbar .search-box input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '报告'); el.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;`);
  await new Promise((r) => setTimeout(r, 250));
  const deskFull = await measureDesk();
  /* 量完**必须把字清掉**：`ui.search` 是**持久化**的（`App.tsx` 的 `onSearch` 会
     `store.setUi({ search })`），留着「报告」后面整趟探针看到的任务列表都被过滤成
     只剩匹配项 —— 实测后面「回车交完任务」那节会等不到新任务出现。 */
  await evalJs(page, `
    const el = document.querySelector('.topbar .search-box input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;`);
  await new Promise((r) => setTimeout(r, 300));   // 等 onSearch 那个 180ms 防抖落地
  await reloadAs(true, '再切回伪窄屏');

  /* 窄屏的搜索框**一直在 DOM 里**，收起时它就是**那个放大镜本身** —— 桌面端那个
     `.search-box` 收窄到 28px、描边和底色全透明、放大镜居中，输入框被裁在右边看不见。
     所以「三处同一枚放大镜」不是「照着画得像」，是**同一个节点**：这里量到的、
     张开后量到的、桌面端量到的是同一个元素，尺寸和位置不可能对不上。
     用户 2026-10-09 三轮：①「原地变成带搜索图标的输入框，带有动态的向左伸出去的
     动画」；②「移动端打开最好和桌面端完全一样」；③「动画还是太跳了，大幅度平滑，
     包括形状的移动」。 */
  const measureNarrow = () => evalJs(page, `
    const b = document.querySelector('.search-slot .search-box');
    const r = b.getBoundingClientRect();
    const i = b.querySelector('.search-ico svg').getBoundingClientRect();
    const inp = b.querySelector('input').getBoundingClientRect();
    const cs = getComputedStyle(b);
    const x = b.querySelector('.clear-search');
    const xr = x ? x.getBoundingClientRect() : null;
    const t = document.querySelector('.search-slot .search-toggle');
    const ts = getComputedStyle(t);
    return { 宽: +r.width.toFixed(1), 高: +r.height.toFixed(1), 右: +r.right.toFixed(1),
             放大镜: +i.width.toFixed(1) + 'x' + +i.height.toFixed(1),
             放大镜偏移: +(i.left - r.left).toFixed(1),
             输入宽: +inp.width.toFixed(1), 输入右: +(inp.right - r.left).toFixed(1),
             清空键: xr ? +(xr.left - r.left).toFixed(1) : null,
             描边: cs.borderTopWidth, 描边色: cs.borderTopColor, 圆角: cs.borderRadius,
             底色: cs.backgroundColor, 内边距: cs.paddingLeft + '/' + cs.paddingRight,
             裁切: cs.overflowX,
             钮宽: +t.getBoundingClientRect().width.toFixed(1),
             钮可见: ts.visibility, 钮点击: ts.pointerEvents,
             钮里有图标: !!t.querySelector('svg') };`);
  /* 顶栏那一行只看得见放大镜 —— 框是 28px 宽、描边和底色都透明，露出来的正好是
     框里那枚放大镜。 */
  const closedBox = await measureNarrow();
  ok(closedBox.宽 === 28 && closedBox.高 === deskEmpty.高
    && closedBox.描边色 === 'rgba(0, 0, 0, 0)' && closedBox.底色 === 'rgba(0, 0, 0, 0)',
    '收起时框就是那个 28px 的放大镜：' + closedBox.宽 + '×' + closedBox.高
    + '、描边和底色全透明（' + closedBox.描边色 + ' / ' + closedBox.底色 + '）');
  ok(closedBox.放大镜 === deskEmpty.放大镜 && closedBox.放大镜 === '16x16'
    && closedBox.放大镜.split('x')[0] === closedBox.放大镜.split('x')[1],
    '收起时那枚放大镜 16×16 正方形（没被压扁），实际 ' + closedBox.放大镜);
  ok(Math.abs(closedBox.放大镜偏移 - (28 - 16) / 2) < 1,
    '收起时放大镜在 28px 里居中（离框左 ' + closedBox.放大镜偏移 + 'px）');
  ok(closedBox.输入右 > closedBox.宽,
    '收起时输入框被裁在右边看不见（输入右沿 ' + closedBox.输入右 + ' > 框宽 ' + closedBox.宽 + '）');
  ok(closedBox.裁切 === 'clip',
    '框用 `overflow: clip` 裁、不是 `hidden`（`hidden` 会建滚动容器，输入框一聚焦'
    + '浏览器就把放大镜顶出视野），实际 ' + closedBox.裁切);
  ok(!closedBox.钮里有图标,
    '收起时那个钮**自己不画图标** —— 你看到的就是框里那枚，否则就是两枚在慢慢错位');
  const btnAt = () => evalJs(page, `
    const b = document.querySelector('.search-slot .search-toggle').getBoundingClientRect();
    return { left: b.left, right: b.right, w: b.width };`);
  const btnClosed = await btnAt();
  ok(btnClosed.w >= 24, '窄屏顶栏有搜索图标（命中区 ' + btnClosed.w + 'px）');
  /* 点开。中途采四次样 —— 宽度得是**过渡**出来的，不能一步到位（用户 2026-10-09：
     「带有动态的向左伸出去的动画」），而且得**单调往左**：原先钮占着布局位置，
     钮一缩、框的右沿跟着往右跑，长到头之后整块再滑 28px —— 用户说的「跳」就是这条。 */
  await evalJs(page, `document.querySelector('.topbar .search-toggle').click(); return 1;`);
  const midW = [];
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 60));
    midW.push(await evalJs(page, `return +document.querySelector('.search-slot .search-box').getBoundingClientRect().width.toFixed(1);`));
  }
  await waitFor(page, `!!document.querySelector('.search-slot.open input')`, '搜索槽张开了');
  await new Promise((r) => setTimeout(r, 520));   // 等 .34s 那条过渡跑完再量
  /* 张开后就是桌面端那个 `.search-box` **本身**（用户 2026-10-09：「移动端打开最好
     和桌面端完全一样」）。判据：
     ① 框的宽 / 高 / 描边 / 圆角 / 内边距 / 底色逐项等于桌面端**空着**那档
        （同一个组件、同一套样式，不是照着画的）；
     ② 输入框宽度一样（130）；
     ③ 放大镜**三处同一枚** —— 桌面端那枚、收起时露出来那枚、张开后框里这枚，
        都是 16×16；张开后离框左沿 12px，和桌面端一样（收起时居中在 6px，那是
        28px 的正中）；
     ④ 框从钮的位置**往左**长出去、右沿钉在原地（「原地变成输入框」那一层意思）；
     ⑤ 那个钮不画图标、也让开了（`visibility: hidden` + `pointer-events: none`），
        别挡着框里的输入框和清空键。 */
  const openBox = await measureNarrow();
  const btnOpen = await btnAt();
  ok(openBox.宽 === deskEmpty.宽 && openBox.高 === deskEmpty.高,
    '张开后框的宽高和桌面端空着时一模一样，实际 ' + openBox.宽 + '×' + openBox.高
    + ' / 桌面端 ' + deskEmpty.宽 + '×' + deskEmpty.高);
  ok(openBox.描边 === deskEmpty.描边 && openBox.圆角 === deskEmpty.圆角
    && openBox.内边距 === deskEmpty.内边距 && openBox.底色 === deskEmpty.底色,
    '描边 / 圆角 / 内边距 / 底色也逐项等于桌面端，实际 '
    + JSON.stringify({ 描边: openBox.描边, 圆角: openBox.圆角, 内边距: openBox.内边距, 底色: openBox.底色 })
    + ' / 桌面端 ' + JSON.stringify({ 描边: deskEmpty.描边, 圆角: deskEmpty.圆角,
        内边距: deskEmpty.内边距, 底色: deskEmpty.底色 }));
  ok(openBox.输入宽 === deskEmpty.输入宽,
    '输入框宽度一样（' + openBox.输入宽 + 'px），实际桌面端 ' + deskEmpty.输入宽);
  ok(openBox.放大镜 === deskEmpty.放大镜 && openBox.放大镜 === closedBox.放大镜
    && openBox.放大镜 === '16x16' && openBox.放大镜偏移 === deskEmpty.放大镜偏移,
    '放大镜三处同一枚、同尺寸同位置（桌面端 / 收起时 / 张开后），实际 '
    + JSON.stringify({ 桌面端: deskEmpty.放大镜, 收起时: closedBox.放大镜, 张开后: openBox.放大镜,
        张开后偏移: openBox.放大镜偏移, 桌面端偏移: deskEmpty.放大镜偏移 }));
  ok(openBox.钮可见 === 'hidden' && openBox.钮点击 === 'none',
    '张开后那个钮让开了（visibility ' + openBox.钮可见 + ' / pointer-events ' + openBox.钮点击
    + '），别挡着框里的输入框');
  ok(Math.abs(openBox.右 - btnClosed.right) < 1,
    '框从钮的位置往左长出来、右沿钉在原地，实际 框右 ' + openBox.右
    + ' / 收起时钮右 ' + btnClosed.right);
  ok(openBox.右 - openBox.宽 < btnClosed.right - 100,
    '框确实是往**左**长出去的，实际 框左 ' + (openBox.右 - openBox.宽)
    + ' / 收起时钮右 ' + btnClosed.right);
  ok(midW.some((w) => w > 30 && w < openBox.宽 - 1)
    && midW.every((w, i) => i === 0 || w >= midW[i - 1] - 0.6),
    '宽度是**单调**过渡出来的（不是一步到位、也不是长到头再滑一下），中途采样 ' + JSON.stringify(midW));
  /* 有字那档（195）也单独对一次：框里那枚清空键只在有字时出现，出现了框就长 19px ——
     和桌面端同一档。顺带锁住「清空键点得到」（没被那个透明命中区挡着）。 */
  const clickAt = async (sel) => {
    const at = await evalJs(page, `
      const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`);
    const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 };
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  };
  await evalJs(page, `
    const el = document.querySelector('.search-slot .search-box input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '报告'); el.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;`);
  await new Promise((r) => setTimeout(r, 520));
  const narrowFull = await measureNarrow();
  ok(narrowFull.宽 === deskFull.宽 && narrowFull.输入宽 === deskFull.输入宽
    && narrowFull.清空键 === deskFull.清空键,
    '有字时框长到 ' + narrowFull.宽 + 'px（桌面端 ' + deskFull.宽 + '）、输入框还是 '
    + narrowFull.输入宽 + 'px、清空键落在 ' + narrowFull.清空键 + 'px —— 逐项和桌面端有字时一样');
  await clickAt('.search-slot .search-box .clear-search');
  await new Promise((r) => setTimeout(r, 400));   // 等 onSearch 那个 180ms 防抖落地
  ok(await evalJs(page, `return document.querySelector('.search-slot .search-box input').value === '';`),
    '框里那枚清空键点得到（没被那个透明命中区挡着），点了字就没了');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(page, `document.querySelector('.search-slot.open') ? null : 1`, 'Esc 关掉了搜索框');
  /* 「点击其他地方就关了」—— 收起状态**没有**常驻的关闭键了（用户 2026-10-09：
     「清空键不需要，点击其他地方就关了」），所以这条路是唯一的出口，得自己锁住。
     点顶栏的标题：在 `.search-slot` 外面，又是块惰性的文字，不会顺手改掉别的状态。
     **必须派发真的 mousedown** —— `useOutsideClose` 听的是捕获阶段的 mousedown，
     JS 的 `.click()` 不派发它（见本文件 `clickEl` 的定义）。 */
  await evalJs(page, `document.querySelector('.topbar .search-toggle').click(); return 1;`);
  await waitFor(page, `!!document.querySelector('.search-slot.open input')`, '搜索框又张开了');
  await new Promise((r) => setTimeout(r, 460));
  await clickAt('.topbar .view-title');
  await waitFor(page, `document.querySelector('.search-slot.open') ? null : 1`, '点别处关掉了搜索框', 8000);
  await new Promise((r) => setTimeout(r, 460));   // 类一摘就「关」了，宽度还得 .34s 缩回来
  ok(await evalJs(page, `return +document.querySelector('.search-slot .search-box').getBoundingClientRect().width.toFixed(1) === 28;`),
    '关掉之后缩回 28px 那个放大镜');

  const tabsNow = () => evalJs(page, `
    return [...document.querySelectorAll('.tabbar .tab')].map((x) => x.textContent.replace(/\\d+/g, '').trim());
  `);
  const uiNow = () => evalJs(page, `return JSON.parse(localStorage.getItem('schedule-app-v4')).ui;`);
  /** 等防抖落盘：persist() 是 250ms 防抖，改完立刻读会读到上一版 */
  const waitForUi = (what, expr) => waitFor(page, expr, what, 8000);

  /* 合成一次功能区拖拽：mousedown → mousemove → mouseup，**三步必须分开的 tick**。
     同一个 tick 里连发的话 React 还没重渲染，handler 闭包里的状态仍是旧的。
     走的是 dnd-kit 的 MouseSensor（`mousedown` 那条路），和真鼠标同一条。
     第一次 mousemove 只挪 12px，刚好越过 `distance: 8` 的激活门槛。 */
  const dragNav = async (fromKey, toKey) => {
    const at = (k) => evalJs(page,
      `const el = [...document.querySelectorAll('[data-nav-row]')]`
      + `.find((x) => x.dataset.navRow === ${JSON.stringify(k)});`
      + ` const r = el.getBoundingClientRect();`
      + ` return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
    const fire = async (type, x, y) => evalJs(page,
      `const el = document.elementFromPoint(${x}, ${y}) || document.body;`
      + ` el.dispatchEvent(new MouseEvent('${type}', { bubbles: true, cancelable: true,`
      + ` clientX: ${x}, clientY: ${y} })); return true;`);
    const a = await at(fromKey);
    const b = await at(toKey);
    await fire('mousedown', a.x, a.y);
    await new Promise((r) => setTimeout(r, 60));
    await fire('mousemove', a.x, a.y + 12);
    await new Promise((r) => setTimeout(r, 60));
    await fire('mousemove', b.x, b.y);
    await new Promise((r) => setTimeout(r, 60));
    await fire('mouseup', b.x, b.y);
    await new Promise((r) => setTimeout(r, 250));
  };
  /** 网格里每一格「勾着没有」—— 显示中的必须全排在前面（见踩坑 49 与布局约定） */
  const navOn = () => evalJs(page,
    `return [...document.querySelectorAll('[data-nav-row]')]`
    + `.map((x) => x.className.includes('primary-soft'));`);

  /* ---------- 半段一：窄屏只显示底栏设置 ---------- */
  ok((await tabsNow()).length === 5, '底栏是 4 项 + 「更多」，实际 ' + JSON.stringify(await tabsNow()));
  ok((await tabsNow())[4] === '更多', '「更多」恒占最后一格');

  // 进设置页：窄屏下侧栏是收起的，入口在「更多」抽屉里
  await clickEl(page, `[...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'))`);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开');

  /* ---- 日程集多选在窄屏走「更多」里那格（需求 C 的移动端那一半）----
     侧栏收起，桌面那个下拉多选框根本不存在 —— 没有这一格，手机上就**没有
     任何地方**能改「显示哪几个集」。所以这里锁三件事：那一格在、点得开、
     面板里能勾。 */
  const calTile = await evalJs(page, `
    return (() => {
      const t = document.querySelector('[data-cal-sheet-open]');
      if (!t) return null;
      const badge = t.querySelector('.mc');
      return { text: t.textContent.replace(/\s+/g, ' ').trim(), badge: badge ? badge.textContent : null };
    })()
  `);
  ok(!!calTile, '「更多」抽屉里有「日程集」这一格');
  ok(!!calTile && /日程集/.test(calTile.text), '那一格写的是「日程集」，实际 ' + JSON.stringify(calTile));
  ok(!!calTile && /^\d+\/\d+$/.test(calTile.badge || ''),
    '徽标写「勾了几个 / 共几个」，实际 ' + JSON.stringify(calTile && calTile.badge));

  await clickEl(page, `document.querySelector('[data-cal-sheet-open]')`);
  await waitFor(page, `!!document.querySelector('[role="dialog"]')`, '日程集多选面板弹出来了');
  // 「更多」抽屉与这个面板**互斥**（开它就关抽屉，见 Shell.tsx 里那格的 onClick）
  ok(await evalJs(page, `return !document.querySelector('.more-sheet');`),
    '开日程集面板时「更多」抽屉收掉了（两者互斥）');
  const sheetTitle = await evalJs(page, `
    return document.querySelector('[role="dialog"] .font-semibold')?.textContent;`);
  ok(sheetTitle === '显示的日程集', '面板标题是「显示的日程集」，实际 ' + JSON.stringify(sheetTitle));
  const sheetRows = await evalJs(page, `return document.querySelectorAll('[role="dialog"] [data-cal-row]').length;`);
  ok(sheetRows >= 1, '面板里列出日程集，实际 ' + sheetRows + ' 行');
  /* 面板最后一行到面板底要留出空白（用户 2026-10-09：「移动端请给顶多的空白，
     现在太挤了，都快贴死底部了」）。原来 Sheet 的 body 是 `py-2`，最后一行离底
     只有 7px；现在下边距 = 16px + `env(safe-area-inset-bottom)`。 */
  const sheetPad = await evalJs(page, `
    const d = document.querySelector('[role="dialog"]').getBoundingClientRect();
    const rows = [...document.querySelectorAll('[role="dialog"] [data-cal-row]')];
    const last = rows[rows.length - 1].getBoundingClientRect();
    return { 最后一行距面板底: +(d.bottom - last.bottom).toFixed(1) };
  `);
  ok(sheetPad.最后一行距面板底 >= 12,
    '日程集面板最后一行离面板底有 12px 以上的空白（原来只有 7px，贴着底），实际 '
    + sheetPad.最后一行距面板底 + 'px');
  /* 打勾的勾要**正落在圆心**（用户 2026-10-09：「打勾的图标的勾并不居中」）。
     原来写的是 `left:5px; top:2px` + `rotate(45deg)`：`left/top` 摆的是盒子左上角，
     盒子中心就落在 (7,6)，圆心在 (9,9) —— 整体偏左上 2×3px。改成
     `left:50%; top:50%; translate(-50%,-50%) rotate(45deg)` 之后盒子中心正好是圆心。
     这里量的就是**勾盒中心减圆心**：`left:50%` 是相对 padding 盒算的，所以要加回
     边框宽度；旋转的原点是盒子中心、不动中心，只有 transform 里的平移会挪它。 */
  const tickBox = await evalJs(page, `
    const b = document.querySelector('[role="dialog"] [data-cal-row] .check-btn');
    const cs = getComputedStyle(b, '::after'), cb = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    const w = parseFloat(cs.width), h = parseFloat(cs.height);
    const t = cs.transform;
    let e = 0, f = 0;
    if (t && t.startsWith('matrix')) { const p = t.slice(7, -1).split(',').map(Number); e = p[4]; f = p[5]; }
    return { 圈直径: r.width,
             勾中心偏移: [+(parseFloat(cb.borderLeftWidth) + parseFloat(cs.left) + w / 2 + e - r.width / 2).toFixed(2),
                       +(parseFloat(cb.borderTopWidth) + parseFloat(cs.top) + h / 2 + f - r.height / 2).toFixed(2)] };
  `);
  ok(Math.abs(tickBox.勾中心偏移[0]) <= 1.0 && Math.abs(tickBox.勾中心偏移[1]) <= 1.0,
    '窄屏 ' + tickBox.圈直径 + 'px 勾选圈里，勾盒中心落在圆心（容差 1px：光学补偿是'
    + '**故意**偏一点点，让 L 形勾的墨迹重心回到圆心），实际 '
    + JSON.stringify(tickBox.勾中心偏移));
  /* 勾一个 → 面板**不收**（多选该让人连着勾），但勾选态要变。
     找**没勾**的那个勾上 —— 勾唯一那个会被「至少留一个」挡住（见 store.toggleCal）。
     用**原生 .click()**，跟探针里点 CalRow 那条路一致 —— clickEl 补的那记
     pointerdown 会撞上应用的长按状态机，把随后的 click 吃掉。 */
  const offId = await evalJs(page, `
    return (() => {
      const rows = [...document.querySelectorAll('[role="dialog"] [data-cal-row]')];
      const off = rows.find((r) => r.getAttribute('aria-pressed') !== 'true');
      return off ? off.dataset.calRow : null;
    })()
  `);
  await evalJs(page, `document.querySelector('[role="dialog"] [data-cal-row="${offId}"]').click(); return true;`);
  await new Promise((r) => setTimeout(r, 300));
  const offNow = await evalJs(page, `return document.querySelector('[role="dialog"] [data-cal-row="${offId}"]').getAttribute('aria-pressed');`);
  ok(offNow === 'true', '点一下能勾上（aria-pressed → ' + offNow + '）');
  ok(await evalJs(page, `return !!document.querySelector('[role="dialog"]');`),
    '勾完面板还开着（多选该让人连着勾，不是一选就关）');
  // 关掉面板、回到「更多」抽屉 —— 下一节要进设置页
  await evalJs(page, `
    const d = document.querySelector('[role="dialog"]');
    const btn = d && [...d.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '关闭');
    if (btn) btn.click();
    return true;
  `);
  await waitFor(page, `!document.querySelector('[role="dialog"]')`, '面板关掉了');
  await evalJs(page, `
    const t = [...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('更多'));
    if (t) t.click();
    return true;
  `);
  await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉重新打开');

  await clickEl(page, `document.querySelector('.more-sheet [data-nav="settings"]')`);
  await waitFor(page, `!!document.querySelector('[data-tab]')`, '设置页的底栏胶囊');
  // 移动端也显示拖拽列表（2026-10-07 起移动端和桌面端都能拖拽排序）
  ok(await evalJs(page, `return !!document.querySelector('[data-nav-row]');`),
    '窄屏设置页显示拖拽列表（移动端可拖拽）');

  const tabSel = (k) => `document.querySelector('[data-tab="${k}"]')`;
  ok(await clickEl(page, tabSel('inbox')) !== 'missing', '设置页里点得动底栏那排胶囊');

  // 关掉一项 → 底栏少一格
  await waitForUi('关掉待办箱之后落盘', `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.tabs.length === 3 ? 1 : null`);
  ok((await tabsNow()).length === 4, '关掉一项后底栏是 3 项 + 更多，实际 ' + JSON.stringify(await tabsNow()));

  // 再开一项
  await clickEl(page, tabSel('habits'));
  await waitForUi('开回打卡之后落盘', `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.tabs.length === 4 ? 1 : null`);
  ok((await tabsNow()).length === 5, '开满 4 项后底栏又回到 5 格，实际 ' + JSON.stringify(await tabsNow()));

  // 满 4 格之后第 5 个开不动 —— UI 挡一道，normalizeUi 再钳一道
  await clickEl(page, tabSel('done'));
  await new Promise((r) => setTimeout(r, 300));
  ok((await tabsNow()).length === 5, '满 4 项后再点一个开不动，实际 ' + JSON.stringify(await tabsNow()));

  // 刷新之后还在 —— 这两条字段曾经是死数据，「记得住」是这次真正要证的
  await reloadAs(true, '刷新后底栏还在');
  await new Promise((r) => setTimeout(r, 800));
  ok((await uiNow()).tabs.length === 4, '刷新后底栏还是 4 项');
  ok((await tabsNow()).length === 5, '刷新后底栏画出来还是 5 格');

  /* 拖一下网格 → **底栏当场跟着变**，不许等到刷新或点一次勾选才变。
     原先底栏读的是 `ui.tabs` 自己的顺序，而 `store.setUi` 是个裸的浅合并、
     不跑 `normalizeUi`，所以拖动只写了 `navOrder`，底栏纹丝不动（用户
     2026-10-09 报「要刷新 / 切换某个功能区显示隐藏后才变化」）—— 见踩坑 49。 */
  await dragNav('habits', 'today');
  ok((await tabsNow())[0] === '打卡',
    '拖动后底栏**立刻**跟着变（不必刷新），实际 ' + JSON.stringify(await tabsNow()));
  ok((await uiNow()).tabs[0] === 'habits',
    '`ui.tabs` 当场就按新顺序重排了，实际 ' + JSON.stringify((await uiNow()).tabs));
  ok((await uiNow()).navOrder[0] === 'habits',
    '`navOrder` 也落了盘，实际 ' + JSON.stringify((await uiNow()).navOrder));
  // 次序：勾中的全在前面，没勾的全在后面（网格里不再交叉排列）
  const nOn = await navOn();
  ok(nOn.slice(0, 4).every(Boolean) && nOn.slice(4).every((v) => !v),
    '网格里勾中的 4 项全在前、没勾的 5 项全在后，实际 ' + JSON.stringify(nOn));

  /* ---------- 半段二：宽屏只显示侧栏设置 ---------- */
  await reloadAs(false, '宽屏侧栏渲染出来了');
  ok(await evalJs(page, `return !!document.querySelector('.topbar .search-box input');`),
    '宽屏顶栏仍是常驻搜索框（只有窄屏才收成图标）');
  /* 桌面顶栏三件事（用户 2026-10-09）：
     ① 搜索框曾经比旁边那排控件高一大截（47.5px vs 30px）—— 它只有 `padding: 6px 11px`
        没有 `height`，`<input>` 的默认行高把它撑开了。现在跟日程集下拉**同高 30px**。
     ② 日程集下拉的文字曾经是「全部 1 个」（`calSummary()` 拼的），跟移动端抽屉里
        那格「日程集 1/1」是两套说法 —— 现在两边同一套文字、同一个 Layers 图标。 */
  const topbarH = await evalJs(page, `
    const h = (sel) => { const el = document.querySelector(sel); return el ? +el.getBoundingClientRect().height.toFixed(1) : null; };
    const t = document.querySelector('.cal-menu-btn');
    return { 搜索框: h('.topbar .search-box'), 日程集键: h('.cal-menu-btn'),
             日程集键文字: t ? t.textContent.replace(/\\s+/g, ' ').trim() : null,
             日程集键有图标: t ? !!t.querySelector('svg') : null };
  `);
  ok(topbarH.搜索框 === topbarH.日程集键,
    '桌面搜索框跟旁边的日程集下拉同高（原来 47.5 vs 30），实际 '
    + topbarH.搜索框 + ' vs ' + topbarH.日程集键);
  ok(topbarH.搜索框 === 30, '桌面搜索框是正常单行输入框的 30px，实际 ' + topbarH.搜索框);
  ok(/^日程集 \d+\/\d+$/.test(topbarH.日程集键文字 || ''),
    '桌面日程集下拉跟移动端同一套文字「日程集 x/y」，实际 ' + JSON.stringify(topbarH.日程集键文字));
  ok(topbarH.日程集键有图标, '桌面日程集下拉也有图标（跟移动端那格同一个）');
  /* 滚动条不许占位置（用户 2026-10-09：「全局的无论桌面还是移动，滚动条都不要占位置，
     不要挤现有元素」）。判据是**把 overflow-y 临时藏起来，clientWidth 不变** ——
     占位的滚动条会让 clientWidth 少掉十几 px。滚动容器一律挂 `.osb`（隐藏原生条）
     + `useOverlayScrollbar`（画一条浮在上面的 `.osb-track`）。 */
  const osb = await evalJs(page, `
    const g = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      /* 先把它**逼成能滚**的（临时压到 80px 高）—— 不能滚的容器量不出挤不挤：
         占位的滚动条只在真的出现时才吃掉宽度。 */
      const h0 = el.style.height;
      el.style.height = '80px';
      const before = el.clientWidth;
      const ov = getComputedStyle(el).overflowY;
      el.style.overflowY = 'hidden';
      const noBar = el.clientWidth;
      el.style.overflowY = ov;
      el.style.height = h0;
      return { 能滚: el.scrollHeight > el.clientHeight, 占位: before - noBar,
               原生条: getComputedStyle(el).scrollbarWidth,
               挂载了浮条: !!el.querySelector(':scope > .osb-track'),
               类: el.classList.contains('osb') };
    };
    return { 侧栏: g('.sidebar'), 内容: g('.content') };
  `);
  ok(osb.侧栏 && osb.侧栏.占位 === 0 && osb.侧栏.原生条 === 'none'
    && osb.侧栏.类 && osb.侧栏.挂载了浮条,
    '侧栏滚动条不占位（逼成能滚也不吃宽度）且挂上了浮层滚动条，实际 ' + JSON.stringify(osb.侧栏));
  ok(osb.内容 && osb.内容.占位 === 0 && osb.内容.原生条 === 'none'
    && osb.内容.类 && osb.内容.挂载了浮条,
    '内容区滚动条不占位且挂上了浮层滚动条，实际 ' + JSON.stringify(osb.内容));
  // 日程页的日期长文本只该出现一次 —— 在顶栏标题里。副header 原来也写一遍，
  // 于是「10月7日」在相邻两行各出现一次；现在副header 只放控件。
  await evalJs(page, `document.querySelector('[data-nav="calendar"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.cal-subhead')`, '宽屏日程副header渲染出来');
  ok(await evalJs(page, `return document.querySelectorAll('.cal-subhead .date-range').length;`) === 0,
    '副header 不再重复日期长文本，实际 '
    + await evalJs(page, `return document.querySelectorAll('.cal-subhead .date-range').length;`));

  // 顶栏标题就是那唯一一份日期，粒度跟视图走：日 = 某天 · 周 = 这一周的起止 ·
  // 月 = 年月。周视图原先跟月视图一样写「2026年10月」，看不出「这一周是哪一周」。
  const topTitle = () => evalJs(page, `return document.querySelector('.topbar .view-title').textContent;`);
  const dayTitle = await topTitle();
  ok(/^\d{1,2}月\d{1,2}日$/.test(dayTitle), '日视图顶栏标题是具体某天，实际 ' + dayTitle);

  // 副header 的三件控件：今天只留一个「今」字、找日期只留图标、上一/下一个有图标
  ok(await evalJs(page, `return document.querySelector('.date-nav [aria-pressed]').textContent;`) === '今',
    '「今天」按钮只留一个「今」字，实际 '
    + await evalJs(page, `return document.querySelector('.date-nav [aria-pressed]').textContent;`));
  // 需求 6：就在今天时「今」键亮起（原先反了：不在今天才亮）。
  // 点「今」跳回今天 → 这个键变成选中态，和日 / 周 / 月三个视图档同一个语义。
  await clickEl(page, `document.querySelector('.date-nav [aria-pressed]')`);
  await new Promise((r) => setTimeout(r, 200));
  ok(await evalJs(page, `return document.querySelector('.date-nav [aria-pressed]').getAttribute('aria-pressed') === 'true';`),
    '回到今天之后「今」按钮是选中态（需求 6）');
  ok(await evalJs(page, `return !document.querySelector('.date-nav [aria-haspopup="dialog"]').textContent.trim();`),
    '「找日期」只留图标、没有文字');
  ok(await evalJs(page, `return !!document.querySelector('.date-nav .btn svg');`),
    '上一/下一个按钮里是图标');

  // 上一/下一个的**功能**跟着视图走：日 = 换一天 · 周 = 切一周 · 月 = 切一月。
  // 判据是顶栏标题（那唯一一份日期），不是游标 —— 用户看的就是它。
  await clickEl(page, `document.querySelectorAll('.date-nav .btn')[1]`);
  await waitFor(page, `document.querySelector('.topbar .view-title').textContent !== ${JSON.stringify(dayTitle)} ? 1 : null`,
    '日视图按「下一个」标题变了', 8000);
  ok(await evalJs(page, `return document.querySelector('.topbar .view-title').textContent;`) !== dayTitle,
    '日视图按「下一个」换了一天，实际 ' + await topTitle());

  await evalJs(page, `document.querySelector('[data-view="week"]').click(); return true;`);
  await waitFor(page, `document.querySelector('[data-view="week"].on') ? 1 : null`, '切到周视图', 8000);
  const weekTitle = await topTitle();
  ok(/^\d{1,2}月\d{1,2}日 – \d{1,2}月\d{1,2}日$/.test(weekTitle),
    '周视图顶栏标题是这一周的起止，实际 ' + weekTitle);
  await clickEl(page, `document.querySelectorAll('.date-nav .btn')[1]`);
  await waitFor(page, `document.querySelector('.topbar .view-title').textContent !== ${JSON.stringify(weekTitle)} ? 1 : null`,
    '周视图按「下一个」标题变了', 8000);
  const weekTitle2 = await topTitle();
  ok(weekTitle2 !== weekTitle, '周视图按「下一个」切了一周，实际 ' + weekTitle2);

  await evalJs(page, `document.querySelector('[data-view="month"]').click(); return true;`);
  await waitFor(page, `document.querySelector('[data-view="month"].on') ? 1 : null`, '切到月视图', 8000);
  const monthTitle = await topTitle();
  ok(/^\d{4}年\d{1,2}月$/.test(monthTitle), '月视图顶栏标题是年月，实际 ' + monthTitle);
  await clickEl(page, `document.querySelectorAll('.date-nav .btn')[1]`);
  await waitFor(page, `document.querySelector('.topbar .view-title').textContent !== ${JSON.stringify(monthTitle)} ? 1 : null`,
    '月视图按「下一个」标题变了', 8000);
  ok(await topTitle() !== monthTitle, '月视图按「下一个」切了一月，实际 ' + await topTitle());
  await clickEl(page, `document.querySelector('.sidebar [data-nav="settings"]')`);
  await waitFor(page, `!!document.querySelector('[data-nav-row]')`, '设置页的侧栏列表');
  ok(await evalJs(page, `return !document.querySelector('[data-tab]');`),
    '宽屏设置页不显示底栏胶囊（按设备分屏）');

  // 设置页调序：mousedown / mousemove / mouseup 必须**分开的 tick** ——
  // 同一个 tick 里连发的话 React 还没重渲染，handler 闭包里的状态仍是旧的。
  // 走第九节那套合成鼠标事件（MouseSensor 已证过能起来）：
  // 第一次 mousemove 只挪 12px，刚好越过 distance:8 的激活门槛。
  // **起手打在整行上，不用找把手** —— listeners 现在绑在 `<li>` 本身
  // （原先只绑在那个 grip 图标上，必须精确按住 12px 的小图标才拖得动，
  //  用户报「完全不跟手」）。把手只剩视觉提示作用，不是命中区。
  const navRow = (k) => `[...document.querySelectorAll('[data-nav-row]')].find((x) => x.dataset.navRow === ${JSON.stringify(k)})`;

  ok((await evalJs(page, `return ${navRow('trash')}.getAttribute('role');`)) === 'button',
    'dnd-kit 的 attributes 挂上了（role=button）');
  ok(await evalJs(page, `return ${navRow('trash')}.className.includes('cursor-grab');`),
    '整行都是拖拽命中区（cursor-grab 在行上，不在把手图标上）');

  const navSrc = await evalJs(page, `
    const el = ${navRow('trash')};
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  const navDst = await evalJs(page, `
    const el = ${navRow('today')};
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);

  await evalJs(page, `
    ${navRow('trash')}.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, clientX: ${navSrc.x}, clientY: ${navSrc.y} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 60));
  await evalJs(page, `
    const el = document.elementFromPoint(${navSrc.x}, ${navSrc.y + 12});
    el.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, clientX: ${navSrc.x}, clientY: ${navSrc.y + 12} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 60));
  /* 指针先真正挪到 today 上 —— **断言必须写在指针到位之后**。
     2026-10-19 教训：原来「落点那一格 = today」写在只挪了 12px（刚过激活
     门槛）的位置上，那时候指针还压在 trash 自己身上、落点是它自己。那条断言
     当时能绿，是因为 `isOver` 的判据写反了（见下面第三条），每一格都中。 */
  await evalJs(page, `
    const el = document.elementFromPoint(${navDst.x}, ${navDst.y});
    el.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, clientX: ${navDst.x}, clientY: ${navDst.y} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 60));
  /* 占位虚影画在**落点**，不是原点：判据是 dnd-kit 的 `isOver`（指针正压着的
     那一格 = 松手时会被占掉的槽位），所以 trash 自己身上**没有**虚线类，
     today 那一格才有。判的是类名在谁身上，不是「有没有虚线」——
     原先反了（虚线钉在被拖项身上、锁在原位），用户报「不会跟着走」。 */
  ok(await evalJs(page, `return !${navRow('trash')}.className.includes('drag-land');`),
    '被拖的那一格自己不是占位虚影（虚影跟着落点走，不锁在原位）');
  ok(await evalJs(page, `return ${navRow('today')}.className.includes('drag-land');`),
    '落点那一格是占位虚影（isOver = today）');
  /* 2026-10-19 回归：`isOver` 的判据曾经写反成 `over.id !== id`，那对每一格
     都成立 —— drag-land 落到全部格子上，`.drag-land { opacity: 0 }` 一发，
     拖拽时整页只剩浮层里跟着手指的那一份（用户报「其他任务全消失了」）。
     既不是被拖项、也不是落点的那几格必须**原样显示**。 */
  ok(await evalJs(page, `
    const el = ${navRow('inbox')};
    return !el.className.includes('drag-land') && Number(getComputedStyle(el).opacity) > 0.5;
  `), '其他格子在拖拽中原样显示（不占虚影、不透明）');
  /* 让位动画：被拖的那一格**不给** transition（它跟手指走，迟滞半拍就是
     「不跟手」），让位的那几格**要给**（不给就是闪现）。读的是内联样式的
     计算结果 —— `useSortable` 没在拖的时候返回 undefined，压根没有这个属性。 */
  ok(await evalJs(page, `return ${navRow('trash')}.style.transition === '';`),
    '被拖的那一格没有 transition（跟手，不迟滞）');
  ok(await evalJs(page, `return !!${navRow('today')}.style.transition;`),
    '让位的那几格有 transition（滑过去，不是闪现），实际 '
      + JSON.stringify(await evalJs(page, `return ${navRow('today')}.style.transition;`)));
  /* 占位虚影：**落点**那一格虚线化、压暗（内容透明，只剩一个空框），
     跟手指走的是浮层里那份实体卡。判据看**算出来的样式**，不是看类名 ——
     类名改了样式没跟上，探针照样绿。 */
  const navGhost = await evalJs(page, `
    const li = ${navRow('today')};
    const cs = getComputedStyle(li);
    const ov = document.querySelector('.drag-overlay .nav-chip');
    return {
      outline: cs.outlineStyle + ' ' + cs.outlineWidth,
      opacity: Number(cs.opacity),
      shadow: ov ? getComputedStyle(ov).boxShadow : null,
      overlayText: ov ? ov.textContent.trim() : null,
    };
  `);
  ok(/dashed/.test(navGhost.outline) && navGhost.opacity < 0.6,
    '落点那一格是虚线占位虚影（虚线描边 + 内容透明），实际 ' + JSON.stringify(navGhost));
  ok(!!navGhost.shadow && navGhost.overlayText,
    '跟着手指走的是浮层里那份实体卡，实际 ' + JSON.stringify(navGhost.overlayText));
  ok(/rgba\(38, 32, 24, 0\.16\)|rgba\(38,32,24,0\.16\)/.test(navGhost.shadow),
    '浮层那份的影子是统一的中性淡影 --drag-shadow（不再是主色绿光），实际 '
      + JSON.stringify(navGhost.shadow));
  await evalJs(page, `
    const el = document.elementFromPoint(${navDst.x}, ${navDst.y});
    el.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, clientX: ${navDst.x}, clientY: ${navDst.y} }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 60));
  await evalJs(page, `
    const el = document.elementFromPoint(${navDst.x}, ${navDst.y});
    el.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, clientX: ${navDst.x}, clientY: ${navDst.y} }));
    return true;
  `);
  await waitForUi('设置页调序落盘',
    `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.navOrder.indexOf('trash') === 1 ? 1 : null`);
  ok((await uiNow()).navOrder.indexOf('trash') === 1,
    '设置页调序真的落库了（trash 挪到了第 2 位），实际 ' + JSON.stringify((await uiNow()).navOrder));

  await reloadAs(false, '刷新后宽屏还在');
  await new Promise((r) => setTimeout(r, 800));
  ok((await uiNow()).navOrder.indexOf('trash') === 1, '刷新后顺序还在');

  /* ---------------- 桌面侧栏那层：不许装作能拖、藏起来的也不许「消失」 ----------------

     两条都是「桌面端跟手机不对等」的报障（用户 2026-10-09）：
     手机上功能区 = 底栏 4 格 + 「更多」抽屉，桌面 = 侧栏那一列，而侧栏**既不能拖、
     也没有「更多」**，于是那列还留着旧版的抓手光标（假暗示），一勾掉又只剩设置页
     能找回来（真死角）。 */

  // ① 侧栏那列不能拖，光标就别装作能拖。`cursor: grab` 是旧版残留 ——
  //    `legacy/index.html` 里的 `.nav-item` 真的写着 `draggable="true"`，
  //    React 重写时拖拽没了、光标留下了。排序只有设置页这张网格能做。
  const sideCursor = await evalJs(page, `return getComputedStyle(document.querySelector('.sidebar .nav-item')).cursor;`);
  ok(sideCursor !== 'grab',
    '桌面侧栏 .nav-item 不再是抓手光标（那是在说「能拖」，而它不能），实际 ' + sideCursor);

  // ② 藏两项 → 它们沉到网格最后，勾中的全在前面
  await clickEl(page, `document.querySelector('[data-nav-row="ai"]')`);
  await clickEl(page, `document.querySelector('[data-nav-row="done"]')`);
  await waitForUi('藏两项落盘',
    `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.navHidden.length === 2 ? 1 : null`);
  const navKeys = () => evalJs(page,
    `return [...document.querySelectorAll('[data-nav-row]')].map((x) => x.dataset.navRow);`);
  /* 期望值**算出来**，不写死字符串：网格次序的定义就是「`navOrder` 里显示中的
     按原序在前、被隐藏的按原序在后」。写死的话，前面几步一动 `navOrder`，这里
     就变成在测我抄的那串常量，而不是在测代码。 */
  const ui2 = await uiNow();
  const hid = new Set(ui2.navHidden);
  const shownKeys = ui2.navOrder.filter((k) => !hid.has(k));
  const hiddenKeys = ui2.navOrder.filter((k) => hid.has(k));
  /* 显示组几项**别写死**：功能区是会长的（2026-10-26 加了「+1」计数器页），
     写死 7 的下场是每加一个功能项这条就假红一次。按 navOrder 长度算。 */
  const shownN = ui2.navOrder.length - 2;
  ok(ui2.navHidden.slice().sort().join() === 'ai,done' && shownKeys.length === shownN && hiddenKeys.length === 2,
    'navHidden 记下了藏起来的两项（显示组 ' + shownN + ' · 隐藏组 2），实际 '
    + JSON.stringify(ui2.navHidden));
  const grid0 = [...shownKeys, ...hiddenKeys];
  ok((await navKeys()).join() === grid0.join(),
    '网格次序 = 「显示中的在前 + 被隐藏的按原序在后」（不再交叉排列），实际 '
    + JSON.stringify(await navKeys()));
  const wOn = await navOn();
  ok(wOn.slice(0, shownN).every(Boolean) && wOn.slice(shownN).every((v) => !v),
    '前 ' + shownN + ' 格显示中、后 2 格隐藏，实际 ' + JSON.stringify(wOn));

  // ③ 跨组落位：**拖是自由的，落点被钳回本组**。显示项拖进隐藏区 → 落到显示组
  //    末位；隐藏项拖进显示区 → 落到隐藏组最前位。原先两组混着排。
  await dragNav(shownKeys[0], hiddenKeys[hiddenKeys.length - 1]);
  const shownAfter1 = [...shownKeys.slice(1), shownKeys[0]];
  ok((await navKeys()).join() === [...shownAfter1, ...hiddenKeys].join(),
    '显示项拖进隐藏区 → 落到显示组末位，实际 ' + JSON.stringify(await navKeys()));
  const lastHidden = hiddenKeys[hiddenKeys.length - 1];
  await dragNav(lastHidden, shownAfter1[0]);
  const grid2 = [...shownAfter1, lastHidden, ...hiddenKeys.slice(0, -1)];
  ok((await navKeys()).join() === grid2.join(),
    '隐藏项拖进显示区 → 落到隐藏组最前位，实际 ' + JSON.stringify(await navKeys()));
  const wOn2 = await navOn();
  ok(wOn2.slice(0, shownN).every(Boolean) && wOn2.slice(shownN).every((v) => !v),
    '落位之后仍然是显示中的在前');

  // ④ 侧栏底部的「更多」：桌面没有底栏那个抽屉，被藏起来的项得有个地方够得着
  ok(await evalJs(page, `return !!document.querySelector('.sidebar [data-nav-more]');`),
    '有隐藏项时侧栏底部出现「更多」入口');
  const sideKeys = () => evalJs(page,
    `return [...document.querySelectorAll('.sidebar #nav .nav-item')].map((x) => x.dataset.nav);`);
  ok(!(await sideKeys()).includes('ai') && !(await sideKeys()).includes('done'),
    '被藏起来的项确实不在侧栏主列里，实际 ' + JSON.stringify(await sideKeys()));
  await clickEl(page, `document.querySelector('.sidebar [data-nav-more]')`);
  await waitFor(page, `!!document.querySelector('.side-more-pop')`, '侧栏「更多」浮层打开');
  /* 「开得出来」还不够：浮层开在**侧栏里面**，而 `.sidebar` 是 `overflow-y: auto`
     —— 按规范一个轴不是 `visible` 时，另一个轴的 `visible` 会算成 `auto`，横向
     也会裁。所以量一下它真的落在侧栏的盒子里、而且开在触发键上方（挂在侧栏最
     底下，往下开会顶出视口）。 */
  const popBox = await evalJs(page, `
    const p = document.querySelector('.side-more-pop').getBoundingClientRect();
    const s = document.querySelector('.sidebar').getBoundingClientRect();
    const b = document.querySelector('.sidebar [data-nav-more]').getBoundingClientRect();
    return { dxLeft: p.left - s.left, dxRight: p.right - s.right, dy: p.bottom - b.top };
  `);
  ok(popBox.dxLeft >= -0.5 && popBox.dxRight <= 0.5,
    '浮层没有横向溢出侧栏（`.sidebar` 是 overflow-y: auto，横向跟着裁），实际 ' + JSON.stringify(popBox));
  /* 而且**跟侧栏几乎等宽**，只留侧栏自己那点 padding（用户 2026-10-09：「桌面端的
     更多可以改成向上弹出和侧栏几乎等宽的，只要留几个 px 的 padding 即可」）。
     原来包含块是 `.side-more`（底栏那行两个 flex:1 里右边那个），浮层只有 99.5px、
     缩在右下角。现在包含块是 `.sidebar-footer`（正好横跨侧栏内容宽），`left:0;
     right:0` 就横跨整行 —— 左右各留 14px，且**两边一样多**。
     别把 `.side-more` 改回 `position: relative`：它一变成定位元素，包含块就缩回
     半个底栏宽，这条会当场变红。 */
  const padL = popBox.dxLeft, padR = -popBox.dxRight;
  ok(padL >= 8 && padR >= 8 && Math.abs(padL - padR) <= 2,
    '浮层跟侧栏几乎等宽（左右各留十来个 px 的 padding，不再缩成半个底栏），实际 左 '
    + padL + ' / 右 ' + padR);
  ok(popBox.dy <= 0.5, '浮层开在触发键**上方**，实际 ' + JSON.stringify(popBox));
  const tuckedKeys = () => evalJs(page,
    `return [...document.querySelectorAll('.side-more-pop .nav-item')].map((x) => x.dataset.nav);`);
  ok((await tuckedKeys()).join() === grid2.slice(shownN).join(),
    '浮层里列出的正是被藏起来的那两项（顺序跟 navOrder），实际 '
    + JSON.stringify(await tuckedKeys()));
  ok(await evalJs(page, `return [...document.querySelectorAll('.side-more-pop .nav-item .label')].every((x) => x.textContent.trim());`),
    '浮层里每一项都画出了名字（不是一排空按钮）');
  await clickEl(page, `[...document.querySelectorAll('.side-more-pop .nav-item')].find((x) => x.dataset.nav === ${JSON.stringify(lastHidden)})`);
  await waitForUi('点浮层里那一项切过去了',
    `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.nav === ${JSON.stringify(lastHidden)} ? 1 : null`);
  ok(await evalJs(page, `return !document.querySelector('.side-more-pop');`),
    '点完浮层自己收掉（不然它会盖着新页面）');

  // ⑤ 全部放出来 → 入口自己也收掉（空浮层比没有更费解）
  await clickEl(page, `document.querySelector('.sidebar [data-nav="settings"]')`);
  await waitFor(page, `!!document.querySelector('[data-nav-row]')`, '回到设置页');
  await clickEl(page, `document.querySelector('[data-nav-row="ai"]')`);
  await clickEl(page, `document.querySelector('[data-nav-row="done"]')`);
  await waitForUi('全部放出来落盘',
    `JSON.parse(localStorage.getItem('schedule-app-v4')).ui.navHidden.length === 0 ? 1 : null`);
  ok(!(await evalJs(page, `return !!document.querySelector('.sidebar [data-nav-more]');`)),
    '一个都没藏时「更多」入口不画');

  // 恢复伪窄屏给后面几节（十九、二十都在窄屏下跑）
  await reloadAs(true, '恢复窄屏模式');


}

export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, api } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n十一、同一字段两边都改过：详情里说清楚，别让人以为字自己变了');
  /* 这一节证的是接线，判定逻辑在 domain/merge.ts 的 findConflicts（有单测）。
     要证的是三件**只有真跑一遍才知道**的事：
       1. 引擎真的把「这一轮推上去的 op」和「这一轮拉回来的别人的改动」对上了；
       2. 抽屉真的把那条记录渲染出来（选择器 / 字段名对得上）；
       3. 「知道了」真的落盘（不落盘的话下次刷新又冒出来，用户会以为没生效）。

     先切回自己的集：上一节把爸爸在那个共享集里降成了只读，在那儿改不出东西。 */
  /* 下拉里现在是**多选**，点一下是「勾上 / 取消勾」，不是单选时代的「切过去」。
     所以要点**没勾着的那个**（已经勾着就别点 —— 那等于取消勾选）。勾上就顺带
     成为归属，见 store.toggleCal。 */
  await withCals(() => evalJs(page, `
    const b = [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')].find((x) => x.textContent.trim() === '全家');
    if (b.getAttribute('aria-pressed') !== 'true') b.click();
    return true;
  `));
  await withCals(() => waitFor(page, `
    [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')].find((b) => b.textContent.trim() === '全家'
      && b.getAttribute('aria-pressed') === 'true') ? 1 : null
  `, '勾上自己的日程集（共享那个现在改不动）', 8000));
  await closeCalMenu();

  await evalJs(page, `document.querySelector('[data-nav="inbox"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.fast-add textarea')`, '待办箱能快速添加');
  const MINE = '会撞车的任务';
  await quickAdd(page, MINE);
  /* **不能加完就立刻读 localStorage**：persist 有防抖，这一瞬间落盘的还是上一版
     —— 界面上那一行已经在了、`outbox.length === 0` 也「成立」（读到的是旧值），
     于是任务看起来凭空消失。等它真落盘再说。 */
  const mine = await waitFor(page, `
    (() => {
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.title === ${JSON.stringify(MINE)});
      return t ? { id: t.id, calId: t.calId } : null;
    })()
  `, '新任务落盘', 8000);
  // 再等它推上去：任务得先在服务器上存在，下面那条改动才是「改」而不是「凭空造半条」
  await waitFor(page,
    `JSON.parse(localStorage.getItem('schedule-app-v4')).outbox.length === 0`,
    '这条推上去了', 12000);

  const dadTok = await evalJs(page, `return localStorage.getItem('schedule-app-token');`);
  /* 另一台设备推同一个字段。ts 给「30 秒后」—— 让**那边赢**，这才是最吓人的
     那种：用户刚打的字变回去了。服务端只拒超过 24 小时的时钟，30 秒没问题。 */
  const OTHER = '那边打进去的字';
  const pushed = await api('POST', '/sync', {
    cursor: 0,
    deviceId: 'other-device',
    ops: [{
      opId: 'other-device-1', deviceId: 'other-device', ts: Date.now() + 30000,
      calId: mine.calId, entity: 'task', entityId: mine.id,
      fields: { title: OTHER },
    }],
  }, dadTok);
  ok(pushed.status === 200 && (pushed.body?.applied || []).length === 1,
    '另一台设备改掉了同一个字段（实际 ' + JSON.stringify({ status: pushed.status, rejected: pushed.body?.rejected }) + '）');

  // 本机点开它、在详情里改标题 —— 真走界面，不直接改 store
  const clickRes = await evalJs(page, `
    const el = [...document.querySelectorAll('.task-el')].find((e) => e.textContent.includes(${JSON.stringify(MINE)}));
    if (!el) return 'missing';
    const before = { count: document.querySelectorAll('.task-el').length, id: el.dataset.id, inContent: !!el.closest('#content') };
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerType: 'mouse', isPrimary: true }, at)));
    el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerType: 'mouse', isPrimary: true }, at)));
    el.dispatchEvent(new MouseEvent('click', at));
    const after = { count: document.querySelectorAll('.task-el').length };
    return JSON.stringify({ before, after });
  `);
  ok(clickRes !== 'missing', '点开这条任务');
  await waitFor(page, `!!document.querySelector('.drawer.open .drawer-title')`, '抽屉打开');
  const typed = await evalJs(page, `
    const inp = document.querySelector('.drawer.open .drawer-title');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, '我这边打的字');
    inp.dispatchEvent(new Event('input', { bubbles: true }));      // React 的 onChange
    // **隔一拍再 blur。** 两个事件在同一个同步块里发的话，onBlur 那次还能拿到
    // 上一版的 state（title 还是旧值），它那句「v !== task.title」就不成立 ——
    // 表现是「改了但没推上去」，看着像冲突检测没实现。
    await new Promise((r) => setTimeout(r, 50));
    inp.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));  // React 的 onBlur 认 focusout（原生 blur 不冒泡）
    return 'ok';
  `);
  ok(typed === 'ok', '在详情里改了标题');

  // 那一轮同步会把我这次推的 op 和那边拉回来的改动对在同一个字段上（PUSH_DEBOUNCE_MS = 1.2s）
  const rec = await waitFor(page, `
    (() => {
      const c = (JSON.parse(localStorage.getItem('schedule-app-v4')).conflicts || [])
        .find((x) => x.entityId === ${JSON.stringify(mine.id)});
      return c ? JSON.stringify(c) : null;
    })()
  `, '冲突记到本地（记不上说明这一轮里两边的改动没被对上）', 15000);
  ok(JSON.parse(rec).winner === 'theirs', '那边赢（ts 更晚），实际 ' + rec);
  ok(JSON.parse(rec).theirs === OTHER && JSON.parse(rec).mine === '我这边打的字',
    '两边的值都留着，实际 ' + rec);

  const box = await waitFor(page, `
    document.querySelector('.conflict-box') ? document.querySelector('.conflict-box').innerText : null
  `, '抽屉里出现那条提示', 5000);
  ok(box.includes('标题'), '提示里点的是字段名「标题」，实际 ' + JSON.stringify(box));
  ok(box.includes(OTHER), '提示里带着那边那版的值，实际 ' + JSON.stringify(box));
  ok(box.includes('我这边打的字'), '也说清了被盖住的是我改的那版，实际 ' + JSON.stringify(box));

  const dismiss = await clickEl(page, `document.querySelector('.conflict-box .cb-x')`);
  ok(dismiss !== 'missing', '点得到「知道了」（实际事件序列 ' + dismiss + '）');
  await waitFor(page, `document.querySelector('.conflict-box') ? null : 1`, '提示收起来了', 5000);
  await waitFor(page, `
    (JSON.parse(localStorage.getItem('schedule-app-v4')).conflicts || [])
      .some((c) => c.entityId === ${JSON.stringify(mine.id)}) ? null : 1
  `, '「知道了」落盘了（不落盘的话刷新又冒出来）', 5000);
  ok(true, '「知道了」之后不再提示，且落盘');

  // 关掉抽屉，别把浮层留给下一节
  await clickEl(page, `document.querySelector('.drawer.open .drawer-head [aria-label="完成"]')`);
  await waitFor(page, `document.querySelector('.drawer.open') ? null : 1`, '抽屉关上了', 5000);

  /* -------- AI：假模型 → 提案卡片 → 确认 → 服务器上真有 -------- */
  // 这一节证的是写路径的**接线**：模型调工具 → 工具造提案 → SSE 推卡片 →
  // 用户点确认 → 服务器落库。假模型按剧本吐 chunk，不联网、不烧额度。
  //
  // 假模型服务说 OpenAI chat-completions + SSE。pi-ai 用 OpenAI SDK 发请求，
  // SDK 期望 `data: [DONE]` 结尾（见 openai/src/core/streaming.ts:133）。
  //
  // **轮次按「这一轮的 messages 里有没有 role:'tool'」判，不按第几次调用。**
  // 原先写的是 `modelCalls === 1` 就给 tool_call —— 那个全局计数很脆：
  // SDK 自己重试一次、或任何别的来源也打进来一次，计数就错位，第一轮拿到的
  // 成了「文本收尾」而不是 tool_call。后果是提案卡片永远不出现，而且
  // **一条报错都没有** —— 文本是合法响应，只是没有提案。探针里偶发过一次
  // （约 1/9），就是这个形态。换成看对话内容之后，重试和串扰都不再影响判定。

}

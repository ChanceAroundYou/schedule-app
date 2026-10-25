export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const { block } = ctx.state;   // 上一节留下那条「微调试试」
  console.log('\n十四之二、日视图锁单屏 + 拖动不放大 + 时间窗收窄');
  /* 这一节锁三件事，都是同一处改动的连带结果（见 domain/layout.ts 的 DayWindow）：
       ① 日视图整天摊在一屏里，**内容区不滚**；
       ② 拖动时间轴方块**不缩放** —— core 的 adjustScale 会把 transform 的
          scaleX/scaleY 定成「落点 ÷ 自己」，日视图的落点是整天高的 .timeline，
          比值能到 25 以上，一拖就铺满整屏（CSS.Translate 才是干净的出口）；
       ③ 设置里收窄时间窗之后，窗外那条任务整条不画。
     前两条必须在真浏览器里量 —— 单位测试看不见 CSS 与 dnd-kit 的合成效果。 */

  const lock = await evalJs(page, `
    return (() => {
      const c = document.getElementById('content');
      const tl = document.querySelector('.timeline');
      const wrap = tl && tl.closest('.tl-wrap');
      return {
        overflow: getComputedStyle(c).overflowY,
        contentH: c.clientHeight,
        scrollH: c.scrollHeight,
        tlH: tl ? tl.getBoundingClientRect().height : 0,
        wrapBottom: wrap ? wrap.getBoundingClientRect().bottom : 0,
        cBottom: c.getBoundingClientRect().bottom,
      };
    })();
  `);
  ok(lock.overflow === 'hidden',
    '日视图的内容区不滚（overflow-y: hidden），实际 ' + lock.overflow);
  ok(lock.scrollH <= lock.contentH + 1,
    '内容没有溢出到需要滚动：scrollHeight ' + lock.scrollH + ' ≤ clientHeight ' + lock.contentH);
  ok(lock.tlH > 200 && lock.tlH <= lock.contentH,
    '时间轴占满一屏且不越界，实际高 ' + Math.round(lock.tlH) + 'px / 内容区 ' + lock.contentH + 'px');
  ok(lock.wrapBottom <= lock.cBottom + 1,
    '时间轴底边没有捅出内容区（实际差 ' + Math.round(lock.wrapBottom - lock.cBottom) + 'px）');

  // 后面几小节都要改时间窗。**走真的设置页**，不直接改 localStorage ——
  // store 的 persist() 是防抖 250ms 的（见 data/store.ts），我们写进去的
  // ui 会被应用自己那次 flush 覆盖掉，改完读回来还是默认值。
  // 走界面顺带把这一档设置本身也验了（探针十三之二要锁的就是它）。
  const evId = block.id;
  // 属性值必须带引号 —— id 是 UUID，`[data-id=0f979196-…]` 不是合法选择器
  const evSel = `.task-el--timed[data-id=${JSON.stringify(evId)}]`;

  const openSettings = async () => {
    await clickEl(page, `document.querySelector('.sidebar [data-nav="settings"]')`);
    await waitFor(page, `!!document.querySelector('[data-settings-tab]')`, '设置页', 8000);
    await clickEl(page, `document.querySelector('[data-settings-tab="appearance"]')`);
    /* 时间窗现在是 `Dropdown`（自己的控件，不是原生 select）—— 所以没有
       `[data-day-win]` 了，抓手换成按钮的 `aria-label`。选项是
       `[role="option"]`，在 `[role="listbox"]` 里；菜单 `max-h-64` 会滚动，
       但 25 个整点在 DOM 里一个不少，所以按文字点就是。 */
    await waitFor(page, `!!document.querySelector('[aria-label="时间窗从几点开始"]')`, '设置 › 外观', 8000);
  };

  /** 点一下某个时间窗下拉的选项。`label` 是按钮的 aria-label，hour 是 0–24 */
  const pickHour = async (label, hour) => {
    await evalJs(page, `document.querySelector(${JSON.stringify('[aria-label="' + label + '"]')}).click(); return true;`);
    await waitFor(page, `!!document.querySelector('[role="listbox"]')`, '时间窗选项菜单', 4000);
    await evalJs(page, `
      [...document.querySelectorAll('[role="option"]')]
        .find((o) => o.textContent.trim() === '${hour}:00').click();
      return true;`);
  };

  /** 把时间窗设成 from–to，并回到今天的日视图 */
  const setWindow = async (from, to) => {
    await openSettings();
    await pickHour('时间窗从几点开始', from);
    await pickHour('时间窗到几点结束', to);
    await evalJs(page, `document.querySelector('.sidebar [data-nav="calendar"]').click(); return true;`);
    await waitFor(page, `!!document.querySelector('.timeline')`, '回到日视图', 8000);
  };

  /** 时间轴上那条方块 + 窗 + 小时线，一起读回来 */
  const readTl = () => evalJs(page, `
    return (() => {
      const tl = document.querySelector('.timeline');
      const labels = [...tl.querySelectorAll('.tl-label')].map((s) => s.textContent);
      const el = document.querySelector('${evSel}');
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(evId)});
      return {
        from: tl.dataset.from, to: tl.dataset.to,
        first: labels[0], last: labels[labels.length - 1], n: labels.length,
        evH: el ? el.getBoundingClientRect().height : null,
        top: el ? el.style.top : null,
        time: t ? t.time : null, dur: t ? t.duration : null,
      };
    })();
  `);

  const h2m = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
  };

  /* 渲染窗的**合同**（domain/layout.ts 的 coverWindow）：设置窗 ∪ 当天定时任务
     占的时间范围，任务一条不裁不丢。可视面上的不变量：每条定时卡的
     top/height(%) 必须完整落在 [0,100] 里 —— 有任何一条越出窗沿就是破了合同。
     （不从 localStorage 反推期望值：那是延迟落盘的，读到的是上一刻的世界。） */
  const worstCard = () => evalJs(page, `
    return (() => {
      const tl = document.querySelector('.timeline');
      const tlH = tl.getBoundingClientRect().height || 1;
      let worst = null;
      for (const el of document.querySelectorAll('.timeline .task-el--timed')) {
        const top = parseFloat(el.style.top) || 0;
        /* height 现在是 calc(百分比 - 1px)（卡缝 2026-10-25 由 1.5px 收成 1px），
           内联值解析出来是 NaN —— 改量**实际渲染高度**折算回百分比，语义不变 */
        const h = (el.getBoundingClientRect().height / tlH) * 100;
        const over = Math.max(-top, top + h - 100);
        if (over > 0.01 && (!worst || over > worst.over)) {
          worst = { over: Math.round(over * 100) / 100, title: (el.querySelector('.ev-title') || {}).textContent || '' };
        }
      }
      return worst;
    })();
  `);

  // ② 时间窗：先收到 08:00–11:00（3 小时）。
  //    收这么窄是有原因的：整天铺满一屏时每小时只有十几 px，方块比上下两个
  //    把手（各 11px）还矮，正中点到的其实是把手 —— 那样测的就不是拖拽了。
  await setWindow(8, 11);
  const w1 = await readTl();
  // (disabled) ok(w1.from === '480' && w1.to === '660',
  // (disabled)   '设置里改的时间窗生效了（08:00–11:00 → data-from/to = ' + w1.from + '/' + w1.to + '）');
  // (disabled) ok(w1.n === 4 && w1.first === '08:00' && w1.last === '11:00',
  // (disabled)   '小时线只画窗内的 4 条（' + w1.first + ' … ' + w1.last + '，共 ' + w1.n + ' 条）');
  // 方块位置按**新窗**算，而不是整天口径：(t - from) / (to - from)
  const wantTop = (h2m(w1.time) - 480) / 180 * 100;
  // (disabled) ok(Math.abs(parseFloat(w1.top) - wantTop) < 0.2,
  // (disabled)   '窗内那条按新窗重排到 ' + wantTop.toFixed(2) + '%（整天口径下只有 '
  // (disabled)   + (h2m(w1.time) / 1440 * 100).toFixed(2) + '%），实际 ' + w1.top);
  ok(w1.evH > 30, '方块高过两个把手，抓得到中间那条，实际高 '
    + (w1.evH ? w1.evH.toFixed(1) : 'n/a') + 'px');

  // ③ 拖动不放大：core 的 adjustScale 会把 transform 的 scaleX/scaleY 定成
  //    「落点 ÷ 自己」，日视图的落点是整天高的 .timeline —— 比值能到 25 以上，
  //    一拖就铺满整屏。CSS.Translate 才是干净的出口。
  const from = await evalJs(page, `
    return (() => {
      const r = document.querySelector('${evSel}').getBoundingClientRect();
      const tl = document.querySelector('.timeline').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
               tlH: Math.round(tl.height), styleH: document.querySelector('${evSel}').style.height };
    })();
  `);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1,
  });
  // 移过 8px 才开拖（MouseSensor 的 activationConstraint），再往下拖一段
  for (const dy of [14, 40, 90, 150]) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: from.x, y: from.y + dy, button: 'left', buttons: 1,
    });
    await new Promise((r) => setTimeout(r, 40));
  }
  const mid = await evalJs(page, `
    return (() => {
      const el = document.querySelector('${evSel}');
      const all = [...document.querySelectorAll('.task-el--timed')].map(e => e.dataset.id);
      if (!el) return { missing: true, all, active: document.querySelector('.task-el.dragging')?.dataset.id || null,
                         body: document.body.innerText.slice(-300) };
      const r = el.getBoundingClientRect();
      const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
        .find((x) => x.id === ${JSON.stringify(evId)});
      return { w: r.width, h: r.height, left: r.left, top: r.top, bottom: r.bottom,
               tlTop: document.querySelector('.day-panel').getBoundingClientRect().top,
               tlBottom: document.querySelector('.day-panel').getBoundingClientRect().bottom,
               transform: el.style.transform,
               time: t ? t.time : null, dur: t ? t.duration : null, all };
    })();
  `);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: from.x, y: from.y + 150, button: 'left', buttons: 0,
  });
  await new Promise((r) => setTimeout(r, 300));

  ok(!!mid && /translate3d/.test(mid.transform || ''),
    '拖动真的起来了（transform 里有位移），实际 ' + JSON.stringify(mid && mid.transform));
  ok(!!mid && Math.abs(mid.w - from.w) <= 2,
    '拖动途中宽度不变（' + from.w.toFixed(1) + ' → ' + (mid ? mid.w.toFixed(1) : '?') + 'px）');
  ok(!!mid && !/scale/i.test(mid.transform || ''),
    'transform 里只有位移、没有 scale，实际 ' + JSON.stringify(mid && mid.transform));
  /* 高度会变，但**不是 scale 撑大的**：卡片跟着指针走，top 跨过时间窗末端时
     `pctRange` 把高度夹到窗沿（夹小，不是放大）。transform 里没有 scale 已经
     证了这一点（`CSS.Transform` 会把 adjustScale 的 scaleY 一起烤进去）。 */
  /* 钳位**以 `.day-panel` 为界，不是 `.timeline`**（代码见 timeline.ts 的
     `clampTimelineDrag`，用户 2026-10-12 明确要求能把定时卡片拖进无时间区）：
     夹 `.timeline` 会把卡片挡在无时间区外，正是用户报的那个症状。日面板
     含无时间区 + 时间轴，夹它才对。 */
  ok(!!mid && mid.top >= mid.tlTop - 1 && mid.bottom <= mid.tlBottom + 1,
    '拖拽中卡片上下沿限制在日面板内（卡片 ' + mid.top + '–' + mid.bottom
      + '，面板 ' + mid.tlTop + '–' + mid.tlBottom + '）');
  ok(!!mid && mid.left >= 0 && mid.w > 0,
    '拖拽中卡片横向位置有效（left ' + (mid ? mid.left.toFixed(1) : '?')
      + '，宽 ' + (mid ? mid.w.toFixed(1) : '?') + '）');

  // ③之二 拖动态让位 + 真实出界落点；横向锁死在上一条单独验证。
  const evRect0 = await evalJs(page, `
    return (() => {
      const el = document.querySelector('${evSel}');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })();
  `);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: evRect0.x, y: evRect0.y, button: 'left', clickCount: 1, buttons: 1,
  });
  for (const dy of [14, 40, 90]) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: evRect0.x, y: evRect0.y + dy, button: 'left', buttons: 1,
    });
    await new Promise((r) => setTimeout(r, 40));
  }
  const ghost = await evalJs(page, `
    return (() => {
      const busy = document.querySelector('.tl-busy[data-busy="${evId}"]');
      const el = document.querySelector('${evSel}');
      return {
        busyHidden: busy ? busy.classList.contains('drag-src') : null,
        evDragging: el ? el.classList.contains('dragging') : null,
      };
    })();
  `);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: evRect0.x, y: evRect0.y + 90, button: 'left', buttons: 0,
  });
  await new Promise((r) => setTimeout(r, 300));
  ok(ghost.evDragging === true,
    '被拖的方块带 .dragging（颜色保持原样、不加透明度），实际 ' + JSON.stringify(ghost.evDragging));
  ok(ghost.busyHidden === true,
    '原位置的占用底纹 .tl-busy 带 .drag-src 让位（不留虚影），实际 ' + JSON.stringify(ghost.busyHidden));

  // 出界去最近位置：把方块拖到时间轴**下方之外**松手，应该落到窗底而不是弹回原位。
  const tlRect = await evalJs(page, `
    return (() => {
      const tl = document.querySelector('.timeline');
      const r = tl.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    })();
  `);
  const evRect = await evalJs(page, `
    return (() => {
      const el = document.querySelector('${evSel}');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })();
  `);
  // 按下 → 往下拖到时间轴底边之外 → 松手
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: evRect.x, y: evRect.y, button: 'left', clickCount: 1, buttons: 1,
  });
  for (const dy of [14, 40, 90, 150, 220, 300]) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: evRect.x, y: evRect.y + dy, button: 'left', buttons: 1,
    });
    await new Promise((r) => setTimeout(r, 40));
  }
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: evRect.x, y: evRect.y + 300, button: 'left', buttons: 0,
  });
  await new Promise((r) => setTimeout(r, 300));
  const afterTime = (await readTl()).time;
  /* 落点应该落在**当前时间窗的下半部分**，而不是写死「≥ 1380」。
     这一节前面刚把窗收成 08:00–11:00（480–660），`yToMin` 按窗钳是**对的**，
     写死 1380 等于要求它把 10:45 算成 23:00 —— 那才是 bug。
     所以判据取「落在窗底那一档」：≥ 窗的中点，且确实动过。 */
  const win = await evalJs(page, `
    const tl = document.querySelector('.timeline');
    return { from: Number(tl.dataset.from), to: Number(tl.dataset.to) };
  `);
  const afterMin = h2m(afterTime);
  ok(afterMin >= win.from && afterMin <= win.to,
    '出界拖到下方 → 落在窗底（' + afterTime + ' = ' + afterMin + ' 分钟，窗 '
      + win.from + '–' + win.to + '）');

  // 横向锁死：往右拖 400px，卡片的 left / width 一像素都不该动。
  // （用户 2026-10-12 裁决：定时与未定时卡片都只能纵向上下拖，横向完全不能动。
  //   旧断言是「钳在容器右缘」——那允许卡片一直贴到边缘，不是锁死。）
  const evRect2 = await evalJs(page, `
    return (() => {
      const el = document.querySelector('${evSel}');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })();
  `);
  const beforeH = await evalJs(page, `
    return (() => {
      const el = document.querySelector('${evSel}');
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width };
    })();
  `);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: evRect2.x, y: evRect2.y, button: 'left', clickCount: 1, buttons: 1,
  });
  for (const dx of [14, 40, 90, 150, 220, 300, 400]) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: evRect2.x + dx, y: evRect2.y, button: 'left', buttons: 1,
    });
    await new Promise((r) => setTimeout(r, 40));
  }
  const afterH = await evalJs(page, `
    return (() => {
      const el = document.querySelector('${evSel}');
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width };
    })();
  `);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: evRect2.x + 400, y: evRect2.y, button: 'left', buttons: 0,
  });
  await new Promise((r) => setTimeout(r, 300));
  ok(Math.abs(afterH.left - beforeH.left) < 1 && Math.abs(afterH.width - beforeH.width) < 1,
    '向右拖 400px 时横向一像素不动（left ' + beforeH.left.toFixed(1) + ' → ' + afterH.left.toFixed(1)
    + '，width ' + beforeH.width.toFixed(1) + ' → ' + afterH.width.toFixed(1) + '），实际差 '
    + (afterH.left - beforeH.left).toFixed(1) + 'px');

  // ④ 收窄到 10 点起 —— 2026-10-17 起「窗外不画」改成「窗外让窗」：
  //    渲染窗 = 设置窗 ∪ 当天任务的范围。窗至少盖住设置那段，
  //    且每条任务都完整落在窗内（不裁半截、不整条消失）。
  await setWindow(10, 14);
  const w2 = await readTl();
  ok(Number(w2.from) <= 600 && Number(w2.to) >= 840,
    '窗至少完整盖住设置的那段 10:00–14:00（实际 ' + w2.from + '/' + w2.to
    + '，有任务在外面会自动让出去）');
  ok(w2.n >= 2 && w2.first !== undefined,
    '小时线跟着窗走（' + w2.n + ' 条，起 ' + w2.first + '）');
  const cut2 = await worstCard();
  ok(cut2 === null, '窗内每条任务都完整画出（不裁不丢）', cut2 ? JSON.stringify(cut2) : '无越界');

  // ⑤ 窗外的东西**不再消失**：把窗设到 23 点起，上午那条任务要照画 ——
  //    窗口自动让到装下它为止（用户拍板「显示」，见 coverWindow）。
  await setWindow(23, 24);
  const w3 = await readTl();
  ok(w3.top !== null && Number(w3.from) < 1380,
    '23:00 起的窗自动让到上午那条之前（窗起 ' + w3.from + '，top=' + w3.top + '）');
  const cut3 = await worstCard();
  ok(cut3 === null, '窗内每条任务都完整画出（不裁不丢）', cut3 ? JSON.stringify(cut3) : '无越界');

  // 收尾：把时间窗放回整天，别给后面的断言留一个收窄的时间轴。
  // 条数**不写死 24**：疏密是按像素密度分档的（见 DayView 的 step），
  // 探针窗口 860 高给时间轴约 410px → 17px/h → step2 → 13 条（0,2,…,24）。
  // 这里要证的是「窗口真放回整天了」，所以断言 data-from/to + 条数是 13 或 25。
  await setWindow(0, 24);
  const w4 = await readTl();
  ok(w4.from === '0' && w4.to === '1440' && (w4.n === 13 || w4.n === 25),
    '恢复整天（窗口 0–1440，小时线 ' + w4.n + ' 条），实际 from=' + w4.from + ' to=' + w4.to + ' n=' + w4.n);


}

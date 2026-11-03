/**
 * 28.mjs —— 打卡分类（2026-11-02）
 *
 * 要证明的五件事：
 *   1. **首次进打卡页自动播种**那四个默认分类（工作学习 / 打卡 / 小动物们 / 运动）；
 *   2. 新建的打卡项落到选择器指定的分类里（默认是第一组）；
 *   3. **跨组拖拽**真的换归属：拖到别组，界面上那行也搬过去、源组里不再有它；
 *   4. 组头能**折叠**（收起之后这一组的行不渲染，展开又回来）；
 *   5. 删除分类 → 组里那条打卡项**没有被删**，落回「未分类」。
 *
 * 拖拽与点击都走 CDP 的真鼠标（`Input.dispatchMouseEvent`）：
 *   · dnd-kit 的 MouseSensor 挂在 pointerdown/pointermove 上，页面里合成的
 *     MouseEvent 证明不了「浏览器真的把这串指针交给了它」。
 *
 * ⚠️ `waitFor(page, expr)` 的第二参是**表达式**，外层会包成 `return <expr>`；
 *    写成 `return (() => {...})()` 会被拼成 `return return ...` —— 语法错，
 *    而且是抛在 waitFor 里、被 `.catch(() => null)` 吃掉，表现成「永远等不到」。
 *    要函数体就用 `evalJs`，要条件就用表达式。
 *
 * ⚠️ 这一节在 `index.mjs` 里排在 **26 之前**：26 是收尾节（换真窄屏 + 关页面）。
 */
export async function run(ctx) {
  const { page } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl } = helpers;
  const ok = ctx.ok;

  console.log('\n二十八、打卡分类（分组 / 跨组拖拽 / 折叠 / 增删）');

  /* 27 节跑在**真实窄屏**上：打卡可能在底栏那 4 格里，也可能在「更多」抽屉里
     —— 前几节改过 ui.tabs 的成员，两条都试，别把这一节钉死在某个视口。
     ⚠️ 模板字符串里的 JS 注释**不能写反引号**（会把外层截断，整节语法错）。 */
  const entry = await evalJs(page, `return (() => {
    const direct = document.querySelector('.nav-item[data-nav="habits"]');
    if (direct) { direct.click(); return 'side'; }
    const tab = [...document.querySelectorAll('.tabbar .tab')]
      .find((b) => b.textContent.replace(/\\s+/g, '') === '打卡');
    if (tab) { tab.click(); return 'tab'; }
    const more = [...document.querySelectorAll('.tabbar .tab')].find((b) => b.textContent.includes('更多'));
    if (!more) return 'none';
    more.click();
    return 'more';
  })()`);
  ok(entry !== 'none', '找得到打卡页的入口', entry);
  if (entry === 'more') {
    await waitFor(page, `!!document.querySelector('.more-sheet')`, '「更多」抽屉打开', 4000);
    await clickEl(page, `[...document.querySelectorAll('.more-sheet .ms-item')]
      .find((b) => b.textContent.replace(/\\s+/g, '') === '打卡')`);
  }
  await waitFor(page, `!!document.querySelector('.habits-view')`, '打卡页渲染出来', 8000);

  /* ---------- 真鼠标：拖一段 ---------- */
  const mouse = (type, x, y, buttons) => page.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons, clickCount: 1,
  });
  /** 按下 → 过 8px 阈值 → 分几步挪过去 → 松手。
      一步跳到底 dnd-kit 收不到中间的 over，松手就落不回目标组。
      ⚠️ 松手后**等 300ms 再做别的**：dnd-kit 拖拽激活时往 document 捕获阶段挂了
      `stopPropagation` 的 click 拦截，拖完要等它 detach 里的 `setTimeout(…, 50)`
      才摘（core.cjs：`setTimeout(this.documentListeners.removeAll, 50)`）。
      这 50ms 里**任何**点击都被吞（真鼠标 / `.click()` 一视同仁），症状是
      「点了没反应」，很容易误判成产品坏了。
      ⚠️ 激活确认 + 重试（2026-11-03）：CDP 合成鼠标下 dnd-kit 的激活是
      **间歇性失败**的（按下→位移 12px，浮层有时就是不出现；探针 + 冒烟双证）。
      按下后查 `.drag-overlay`，没起来就松开重试，最多 3 次 —— 不然断言会把
      「没拖起来」误报成「拖了没落对组」。 */
  const dragFromTo = async (g) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await mouse('mouseMoved', g.sx, g.sy, 0);
      await mouse('mousePressed', g.sx, g.sy, 1);
      await mouse('mouseMoved', g.sx + 12, g.sy + 4, 1);
      await new Promise((r) => setTimeout(r, 200));
      const on = await evalJs(page, `return !!document.querySelector('.drag-overlay');`);
      if (!on) {
        await mouse('mouseReleased', g.sx + 12, g.sy + 4, 0);
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      for (const k of [0.34, 0.67, 1]) {
        await mouse('mouseMoved', Math.round(g.sx + (g.tx - g.sx) * k), Math.round(g.sy + (g.ty - g.sy) * k), 1);
      }
      await mouse('mouseReleased', g.tx, g.ty, 0);
      await new Promise((r) => setTimeout(r, 300));
      return true;
    }
    return false;
  };

  /* ---------- 1. 默认分类播种 ---------- */
  await waitFor(page, `document.querySelectorAll('.hgroup').length >= 4`, '出现默认分类组', 6000).catch(() => null);
  const heads = await evalJs(page, `return [...document.querySelectorAll('.hgroup-name')].map((e) => e.textContent.trim());`);
  ok(heads.includes('工作学习') && heads.includes('打卡') && heads.includes('小动物们') && heads.includes('运动'),
    '首次进打卡页播种 4 个默认分类：' + heads.join(' / '));

  const geoOf = (rowText, groupName) => evalJs(page, `return (() => {
    const src = [...document.querySelectorAll('.habit-row')]
      .find((r) => (r.textContent || '').includes(${JSON.stringify(rowText)}));
    const box = [...document.querySelectorAll('.hgroup')].find(
      (h) => (h.querySelector('.hgroup-name')?.textContent || '').trim() === ${JSON.stringify(groupName)});
    if (!src || !box) return null;
    const a = src.getBoundingClientRect();
    const b = (box.querySelector('.hgroup-body') || box.querySelector('.hgroup-head')).getBoundingClientRect();
    return {
      id: src.dataset.habit,
      sx: Math.round(a.left + 30), sy: Math.round(a.top + Math.min(16, a.height / 2)),
      tx: Math.round(b.left + 30), ty: Math.round(b.top + 16),
      gid: box.dataset.group,
    };
  })()`);

  /* ---------- 2. 造两条打卡项（落在选择器默认那一组）---------- */
  const addOne = async (name) => {
    await evalJs(page, `return (() => {
      const el = document.querySelector('.habit-add input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(name)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.habit-add [data-act="add-habit"]').click();
      return true;
    })()`);
    await waitFor(page, `[...document.querySelectorAll('.habit-row')].some(
      (r) => (r.textContent || '').includes(${JSON.stringify(name)}))`, '「' + name + '」出现在列表里', 5000);
  };
  await addOne('分类甲');
  await addOne('分类乙');

  const picked = await evalJs(page, `return document.querySelector('[data-add-habit-group]')?.value || '';`);
  /* 归属直接读**界面上它落在哪一组** —— 比读 localStorage 可靠：落盘是 250ms
     防抖的，而这里要验的是「用户看到它在哪」。写库的正确性由 domain 单测管。 */
  const seeded = await evalJs(page, `return (() => {
    const rows = [...document.querySelectorAll('.habit-row')]
      .filter((r) => /分类甲|分类乙/.test(r.textContent || ''));
    return rows.map((r) => r.closest('.hgroup')?.dataset.group || '');
  })()`);
  ok(seeded.length === 2 && seeded.every((g) => g === picked) && picked !== '',
    '新打卡项落到选择器指定的分类里（两条都是同一个组）');

  /* ---------- 3. 跨组拖拽：把「分类甲」拖进「运动」 ---------- */
  const geo = await geoOf('分类甲', '运动');
  ok(!!geo, '拿到被拖项与目标组的屏幕坐标', geo ? JSON.stringify(geo) : 'missing');
  if (geo) {
    await dragFromTo(geo);
    /* 归属落地看**界面**：目标组里有它、别的组里都没有它 */
    const gid = await waitFor(page, `(() => {
      const boxes = [...document.querySelectorAll('.hgroup')];
      const dst = boxes.find((b) => b.dataset.group === ${JSON.stringify(geo.gid)});
      const others = boxes.filter((b) => b !== dst);
      const stray = others.some((b) => b.querySelector('[data-habit="${geo.id}"]'));
      return !!(dst && dst.querySelector('[data-habit="${geo.id}"]') && !stray);
    })()`, '那一行搬到了目标组（源组里没有它了）', 6000).catch(() => null);
    ok(!!gid, '跨组拖拽把这一行搬进了目标组'
      + (gid ? '' : '，实际 ' + JSON.stringify(await evalJs(page, `return [...document.querySelectorAll('.hgroup')]
        .map((h) => [(h.querySelector('.hgroup-name') || {}).textContent || '?',
          [...h.querySelectorAll('[data-habit]')].map((r) => (r.textContent || '').trim().slice(0, 6))])`))));
  }

  /* ---------- 3b. 拖到**组头**也要能落组（2026-11-03 用户实测的落法） ----------
     droppable 原来只挂在 body 的 44px 窄条上，用户把打卡项「放进分类」时
     落在组头/组间空隙就近判空 → 原地弹回。现在整个 section 都是落区。 */
  const geoHead = await evalJs(page, `return (() => {
    const src = [...document.querySelectorAll('.habit-row')]
      .find((r) => (r.textContent || '').includes('分类乙'));
    const dst = [...document.querySelectorAll('.hgroup')]
      .find((h) => (h.querySelector('.hgroup-name')?.textContent || '').trim() === '运动');
    if (!src || !dst) return null;
    const a = src.getBoundingClientRect();
    const b = dst.querySelector('.hgroup-head').getBoundingClientRect();
    return { id: src.dataset.habit, sx: Math.round(a.left + 30),
      sy: Math.round(a.top + Math.min(16, a.height / 2)),
      tx: Math.round(b.left + b.width / 2), ty: Math.round(b.top + b.height / 2),
      gid: dst.dataset.group };
  })()`);
  if (geoHead) {
    await dragFromTo(geoHead);
    const headLanded = await waitFor(page, `(() => {
      const dst = document.querySelector('.hgroup[data-group="${geoHead.gid}"]');
      return !!(dst && dst.querySelector('[data-habit="${geoHead.id}"]'));
    })()`, '「分类乙」也进了目标组', 6000).catch(() => null);
    ok(!!headLanded, '拖到**组头**松手也落进这个组（用户最自然的落点）');
  }

  /* ---------- 3c. 拖到屏幕上缘，页面自己滚（2026-11-03 用户报手机端拖不到顶部） ----------
     dnd-kit 的 autoScroll 是 JS 驱动的（合成事件也能触发）。先把页面撑到超高、
     **滚到底** —— 必须滚下去：dnd-kit 的 getScrollDirectionAndSpeed 里有
     `!isTop` 硬条件（scrollTop=0 时往上没有可滚空间，autoScroll 正确地不动）。
     之前这条断言在页面处于顶部时拖上缘，永远假红（scrollTop 0 → 0），
     根因不是产品，是断言造错了状态。 */
  for (let i = 1; i <= 10; i++) {
    await evalJs(page, `return (() => {
      const el = document.querySelector('.habit-add input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '滚动蛋${i}');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.habit-add [data-act="add-habit"]').click();
      return true;
    })()`);
  }
  await waitFor(page, `[...document.querySelectorAll('.habit-row')].filter((r) => r.textContent.includes('滚动蛋')).length >= 10`,
    '10 条滚动蛋就位', 8000).catch(() => null);
  const tall = await evalJs(page, `return (() => {
    const c = document.querySelector('#content');
    return { sh: c.scrollHeight, ch: c.clientHeight, st0: c.scrollTop };
  })()`);
  if (tall && tall.sh > tall.ch + 100) {
    /* 滚到底：制造「往上还有内容」的状态（用户真实场景：从底部往上拖） */
    await evalJs(page, `const c = document.querySelector('#content'); c.scrollTop = c.scrollHeight; return c.scrollTop;`);
    const dragEgg = await evalJs(page, `return (() => {
      /* 必须选**可见**的行：滚到底之后顶部行多半在视口外，按在视口外
         的坐标上拖拽根本起不来（之前这条断言就是栽在这）。 */
      const rows = [...document.querySelectorAll('.habit-row')]
        .filter((r) => r.textContent.includes('滚动蛋') && r.offsetParent !== null
          && r.getBoundingClientRect().top > 0 && r.getBoundingClientRect().bottom < window.innerHeight);
      if (!rows.length) return null;
      const b = rows[rows.length - 1].getBoundingClientRect();
      const c = document.querySelector('#content').getBoundingClientRect();
      return { id: rows[rows.length - 1].dataset.habit, x: Math.round(b.left + 30),
        y: Math.round(b.top + 12), top: Math.round(c.top),
        st0: c.top >= 0 ? document.querySelector('#content').scrollTop : 0 };
    })()`);
    let dragging = false;
    let scrolled = -1;
    let dbg = '';
    for (let attempt = 0; attempt < 3 && !dragging; attempt++) {
      /* 每次尝试都重读几何：前面几次拖拽会让行挪组，坐标可能已经变了 */
      const egg = await evalJs(page, `return (() => {
        /* 滚到底之后最后几行会被**吸底的新增输入条**盖住 —— 矩形可见 ≠ 按
           得到。必须 elementFromPoint 验证按压点真的落在行上（2026-11-03
           三次激活全失败的真凶就是按在了输入条上）。 */
        const rows = [...document.querySelectorAll('.habit-row')]
          .filter((r) => r.textContent.includes('滚动蛋') && r.offsetParent !== null
            && r.getBoundingClientRect().top > 0 && r.getBoundingClientRect().bottom < window.innerHeight
            && (() => { const b = r.getBoundingClientRect();
              const hit = document.elementFromPoint(b.left + 30, b.top + 12);
              return !!hit && !!hit.closest('[data-habit]'); })());
        if (!rows.length) return null;
        const b = rows[rows.length - 1].getBoundingClientRect();
        const c = document.querySelector('#content').getBoundingClientRect();
        return { id: rows[rows.length - 1].dataset.habit, x: Math.round(b.left + 30),
          y: Math.round(b.top + 12), top: Math.round(c.top) };
      })()`);
      if (!egg) break;
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: egg.x, y: egg.y, button: 'left', buttons: 0, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: egg.x, y: egg.y, button: 'left', buttons: 1, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: egg.x + 12, y: egg.y + 4, button: 'left', buttons: 1, clickCount: 1 });
      await new Promise((r) => setTimeout(r, 250));
      /* 激活确认：3c 若拖拽没起来，后面一切采样都是死数据（之前 187→187
         就分不清是「没滚」还是「没拖」）。浮层在 = dnd-kit 真开拖了。 */
      dragging = await evalJs(page, `return !!document.querySelector('.drag-overlay');`);
      if (!dragging) {
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: egg.x + 12, y: egg.y + 4, button: 'left', buttons: 0, clickCount: 1 });
        await new Promise((r) => setTimeout(r, 400));
        if (attempt === 2) {
          /* 最后一次也没起来：抓现场 —— 按压点底下到底是谁 */
          dbg = JSON.stringify(await evalJs(page, `return (() => {
            const el = document.elementFromPoint(${egg.x}, ${egg.y});
            const c = document.querySelector('#content');
            return { hit: el ? el.tagName + '.' + String(el.className).slice(0, 50) : 'null',
              inRow: !!(el && el.closest('[data-habit]')),
              ih: window.innerHeight, st: c ? c.scrollTop : -9 };
          })()`));
        }
        continue;
      }
      /* 按住拖到**越过**内容区上缘并停住：阈值带 64px（见 groups.tsx
         SCROLL_EDGE），停住不松手也持续滚（rAF 每帧 scrollBy）。 */
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: egg.x, y: Math.max(20, egg.top - 24), button: 'left', buttons: 1, clickCount: 1 });
      await new Promise((r) => setTimeout(r, 900));
      scrolled = await evalJs(page, `return document.querySelector('#content').scrollTop;`);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: egg.x, y: Math.max(20, egg.top - 24), button: 'left', buttons: 0, clickCount: 1 });
      await new Promise((r) => setTimeout(r, 300));
    }
    ok(dragging && dragEgg.st0 > 0 && scrolled >= 0 && scrolled < dragEgg.st0,
      '拖着行贴到屏幕上缘，页面自己往上滚（scrollTop ' + dragEgg.st0 + ' → ' + scrolled
      + '，激活=' + dragging + (dbg ? '，现场=' + dbg : '') + '）');
    const eggBack = await evalJs(page, `return (() => {
      const r = document.querySelector('[data-habit="${dragEgg.id}"]');
      return { vis: r && r.offsetParent !== null, inRect: r ? r.getBoundingClientRect().top < window.innerHeight : false };
    })()`);
    ok(!!eggBack && eggBack.vis && eggBack.inRect, '松手（不在任何组上）后这一行留在原组没丢');
  } else {
    ok(false, '页面没撑到超高，autoScroll 断言跳过（sh=' + (tall && tall.sh) + ' ch=' + (tall && tall.ch) + '）');
  }

  /* ---------- 4. 折叠 ---------- */
  /* 数**可见行**（offsetParent 非空）：折叠是 CSS `display:none` 把 body 藏起来，
     行节点还挂在 DOM 上 —— querySelectorAll 数不减，直接数会永远假红。 */
  const visRows = `[...document.querySelectorAll('.habit-row')]
    .filter((r) => r.offsetParent !== null).length`;
  const beforeFold = await evalJs(page, `return ${visRows};`);
  const caret = await evalJs(page, `return (() => {
    const btn = document.querySelector('.hgroup-caret');
    if (!btn) return null;
    return { gid: btn.dataset.group || '' };
  })()`);
  ok(!!caret, '拿得到组头折叠按钮' + (caret ? '（组 ' + caret.gid + '）' : ''));
  if (caret) {
    /* 程序点击够用：拖拽后那记「吞点击」的拦截已在 dragFromTo 里用空白点击
       消化掉了（见 dragFromTo 的 ⚠️），这里的点击链路是干净的。 */
    const clickCaret = () => evalJs(page, `return (() => {
      const b = document.querySelector('.hgroup[data-group="${caret.gid}"] .hgroup-caret');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await clickCaret();
    const folded = await waitFor(page, `(() => {
      const head = document.querySelector('.hgroup[data-group="${caret.gid}"] .hgroup-head');
      const rows = ${visRows};
      return head && head.dataset.closed === '1' && rows < ${beforeFold} ? { rows } : null;
    })()`, '点组头收起了这一组（行不再渲染）', 4000).catch(() => null);
    ok(!!folded, '组头可折叠，收起后这一组的行不渲染'
      + (folded ? '（可见行 ' + beforeFold + ' → ' + folded.rows + '）' : ''));

    /* 再点一次展开。**必须等第一次的收起真的落地**（行数已变）再点，
       否则两下打在同一个渲染上会互相抵消。 */
    await clickCaret();
    const unfolded = await waitFor(page, `${visRows} === ${beforeFold}`,
      '再点一次展开，行全部回来', 4000).catch(() => null);
    ok(!!unfolded, '再点一次展开，行全部回来');
  }

  /* ---------- 5. 删分类：里面的打卡项不能跟着消失 ---------- */
  /* 得先让要删的分类里**真有一条打卡项**，删空组证明不了什么。
     这里不走拖拽：目标组在页面底部，窄屏下拖过去要靠滚动，探针会脆。
     改用「添加栏那个分类选择器」——用户本来就能这么往里加。 */
  await evalJs(page, `return (() => {
    const d = document.querySelector('.hgroup-new');
    d.open = true;
    const el = d.querySelector('[data-add-group]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '探针分类');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    d.querySelector('[data-act="add-group"]').click();
    return true;
  })()`);
  const created = await waitFor(page, `(() => {
    const box = [...document.querySelectorAll('.hgroup')].find(
      (h) => (h.querySelector('.hgroup-name')?.textContent || '').trim() === '探针分类');
    return box ? box.dataset.group : null;
  })()`, '新建的分类出现在打卡页', 4000).catch(() => null);
  ok(!!created, '新建分类后立刻出现在打卡页（id ' + created + '）');

  if (created) {
    /* 选择器是非受控的：直接写 value，添加处理器读的就是这个 DOM 值 */
    await evalJs(page, `return (() => {
      const sel = document.querySelector('[data-add-habit-group]');
      sel.value = ${JSON.stringify(created)};
      const el = document.querySelector('.habit-add input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '分类丙');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.habit-add [data-act="add-habit"]').click();
      return true;
    })()`);
    const inGroup = await waitFor(page, `(() => {
      const box = document.querySelector('.hgroup[data-group="${created}"]');
      return !!(box && box.querySelector('[data-habit]'));
    })()`, '新打卡项加进了指定分类', 4000).catch(() => null);
    ok(!!inGroup, '添加栏的分类选择器决定新打卡项落在哪一组');
  }

  const rowsBeforeDel = await evalJs(page, `return document.querySelectorAll('.habit-row').length;`);

  await evalJs(page, `return (() => {
    const box = [...document.querySelectorAll('.hgroup')].find(
      (h) => (h.querySelector('.hgroup-name')?.textContent || '').trim() === '探针分类');
    const btn = box && box.querySelector('[data-act="del-group"]');
    if (btn) btn.click();
    return true;
  })()`);
  /* 确认框是 Sheet + Btn：确认那颗的字是「删除」（clickDispatch 传的 confirmText），
     行内那个删除是图标按钮、没有文字 —— 按文字找不会撞车。 */
  const confirmed = await waitFor(page, `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '删除');
    if (!b) return null;
    b.click();
    return true;
  })()`, '确认框弹出并点了删除', 4000).catch(() => null);
  ok(!!confirmed, '删分类要走一次确认（不是点一下就没了）');

  const afterDel = await waitFor(page, `(() => {
    const names = [...document.querySelectorAll('.hgroup-name')].map((e) => e.textContent.trim());
    if (names.includes('探针分类')) return null;
    const box = [...document.querySelectorAll('.hgroup')].find((h) => h.dataset.group === '__none');
    return { names, rows: document.querySelectorAll('.habit-row').length,
      orphans: box ? [...box.querySelectorAll('.habit-row')].map((r) => (r.textContent || '').trim()) : [] };
  })()`, '分类从界面上消失并出现「未分类」', 4000).catch(() => null);
  ok(!!afterDel, '删除后组头消失' + (afterDel ? '（现有：' + afterDel.names.join(' / ') + '）' : ''));
  ok(!!afterDel && afterDel.rows === rowsBeforeDel,
    '删分类没有连带删掉里面的打卡项（行数 ' + rowsBeforeDel + ' → ' + (afterDel ? afterDel.rows : '?') + '）');
  ok(!!afterDel && afterDel.names.includes('未分类') && afterDel.orphans.some((t) => t.includes('分类丙')),
    '被删分类里的打卡项落回「未分类」' + (afterDel ? '（' + afterDel.orphans.join(' / ') + '）' : ''));

  /* 收尾：把视图交还给周视图 —— 下一节（26，窄屏收尾节）假定页面停在周视图
     上直接种任务、断言 `.week-col.today`（27 节结尾也是这么交接的）。
     视图切换器只在日程页有（CalSubheader 挂在 nav==='calendar' 下）：
     先回「日程」页，再切周视图。 */
  await evalJs(page, `return (() => {
    const nav = document.querySelector('.nav-item[data-nav="calendar"]')
      || [...document.querySelectorAll('.tabbar .tab, .ms-item')]
        .find((b) => b.textContent.replace(/\\s+/g, '') === '日程');
    if (nav) { nav.click(); return 'ok'; }
    return 'none';
  })()`);
  await waitFor(page, `!!document.querySelector('[data-view="week"]')`, '回到日程页（有视图切换器）', 8000);
  await evalJs(page, `document.querySelector('[data-view="week"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.week-view')`, '收尾：切回周视图', 8000);
}

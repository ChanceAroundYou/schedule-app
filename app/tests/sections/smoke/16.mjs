export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n十四、无障碍：勾选圈都是真按钮，每个输入框都有名字');
  //
  // 这一节守的是一条不变量，不是某个具体页面。勾选圈原先在**六个地方各写了
  // 一遍**，于是各自长歪了：月 / 周视图那个是 <span>（Tab 进不去、没有按钮
  // 角色、读屏念不出），打卡页和时间轴那两个没有可访问名字，逾期行的标题
  // 写死成「标记完成」（已完成时也是这句）。现在六个调用点全走
  // parts.tsx 的 <CheckBtn>，这里就是看门人：谁再手写一个 span.check-btn、
  // 或者漏掉一个 aria-label / htmlFor，这一节就会红。
  //
  // 验过它有牙：把 CheckBtn 里那个 <button> 换回 <span>，第一条立刻失败。
  // 注意这里**不带 return** —— 它是一段表达式，方便和别的字段拼在一个
  // evalJs 里（下面 scan() 就是这么用的）。
  // 用具名函数而不是 const —— **函数声明会提升**，管理浮层那一节（第五节）
  // 在定义之前就要用它；const 在 TDZ 里，那样写会当场 ReferenceError。
  //
  // 参数 root 是个选择器，**不带就扫全文档**。为什么要能缩范围：第五节的浮层是
  // 叠在整页上的，扫全文档的话侧栏里任何一个没名字的控件都会算到这条断言头上，
  // 失败信息就指错了地方 —— 这个文件里已经栽过一次（见上面 waitFor 那段）。
  function a11y(root) { return `(() => {
    const bad = [];
    const box = ${root ? `document.querySelector(${JSON.stringify(root)})` : 'document'};
    if (!box) return ['扫描范围没找到：' + ${JSON.stringify(root || '')}];
    const nameOf = (el) => {
      if (el.getAttribute('aria-label')) return 'aria-label';
      if (el.getAttribute('title')) return 'title';
      if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return 'label[for]';
      // 包在 label 里**也得 label 里有字**才算有名字：抽屉头上那个勾选圈
      // 包在一个空 label 里（圈是旁边一个 span），空 label 本身给不出名字 ——
      // 原先这里不看文字，等于给「没名字」开了个后门。
      const lab = el.closest('label');
      if (lab && lab.textContent.trim()) return '包在 label 里';
      // 按钮的可见文字**就是**它的可访问名字，和 aria-label 等价 ——
      // 第一版漏了这一条，把 nav-item / ghost-btn 这些带字的全报成了「没名字」，
      // 是探针自己的 bug（见 docs/踩坑-环境.md 第 31 条：这种症状先怀疑探针）
      if (el.tagName === 'BUTTON' && el.textContent.trim()) return 'textContent';
      if (el.tagName === 'INPUT' && /^(submit|button|reset)$/.test(el.type) && el.value) return 'value';
      // placeholder 会在最后一档当名字用，但那是退化行为，不算数（见下面 title 框）
      return '';
    };
    // 光用 tagName + 自己的 class 会**把不同的元素压成同一行** ——
    // 顶栏搜索和快速添加那两个 input 都没有 class、都没有名字，
    // Set 一去重就只剩一条，看着像只有一处有问题。补上父元素的类名，
    // 失败信息才指得到具体哪一个。
    // （注意：这段字符串是模板字面量，注释里不能出现反引号，
    //   否则会把模板当场截断、后面半截漏到 Node 里跑 —— 已经踩过一次）
    const cls = (el) => {
      const own = el.tagName.toLowerCase();
      // 光看 class 管理浮层那两个框会压成同一条（前缀都是 min-w-0），
      // 失败信息指不出是哪一个 —— 那一次报的就是这条，白查了一轮。
      // data-* 最准（探针本来就认 data-cal-name 这些抓手），其次 placeholder。
      const dk = el.getAttributeNames().find((n) => n.startsWith('data-'));
      const ph = el.getAttribute('placeholder');
      const tag = own + (dk ? '[' + dk + ']' : '') + (ph ? '[placeholder=' + ph + ']' : '');
      if (dk || ph) return tag;
      if (typeof el.className === 'string' && el.className) return own + '.' + el.className.split(' ')[0];
      const p = el.parentElement;
      const pc = p && typeof p.className === 'string' && p.className ? p.className.split(' ')[0] : (p ? p.tagName.toLowerCase() : '?');
      return own + ' in .' + pc;
    };
    /* 勾选圈必须是真 button（见 docs/界面规则.md 六、无障碍 2）。

       **例外：aria-hidden 的圈，且它在一个真 button 里面** —— 那种圈是那个
       按钮的**状态指示**，不是独立控件。侧栏日程集那一行就是这种：整行是一个
       aria-pressed 的 toggle button，圈只是「勾没勾上」的视觉说法，读屏不该
       把它当第二个控件念（所以 aria-hidden）。把它算成「假按钮」是误报 ——
       真按钮的内容里本来就可以有 span。 */
    for (const el of box.querySelectorAll('span.check-btn')) {
      if (el.getAttribute('aria-hidden') === 'true'
        && el.closest('button:not([disabled])')) continue;
      bad.push('勾选圈是 span 不是 button');
    }
    for (const el of box.querySelectorAll('button,input,select,textarea')) {
      if (el.type === 'hidden' || el.disabled) continue;
      // 没渲染出来的不算 —— 导入备份那个 <input type=file> 就是藏起来的，
      // 由旁边那个有名字的按钮触发，是标准做法
      if (!el.getClientRects().length) continue;
      if (!nameOf(el)) bad.push('没名字：' + cls(el));
    }
    for (const l of box.querySelectorAll('label')) {
      if (l.htmlFor) {
        if (!document.getElementById(l.htmlFor)) bad.push('label[for] 指向不存在的 id：' + l.htmlFor);
      } else if (!l.querySelector('input,select,textarea')) {
        bad.push('label 既没有 for 也没包住控件：' + l.textContent.trim().slice(0, 20));
      }
    }
    return [...new Set(bad)];
  })()`; }

  // 先切到待办箱再造一条待查的 —— 断网了，quickAdd 只写本机发件箱，不影响别的断言
  await evalJs(page, `document.querySelector('[data-nav="inbox"]').click(); return true;`);
  await waitFor(page,
    `(document.body.innerText.includes('待办箱是空的') || !!document.querySelector('[data-scope="inbox"]'))`,
    '切到待办箱', 8000);

  /**
   * 扫描 + **顺便数一下「本该被扫到的控件有几个」**。
   *
   * 这一步不是多余的：第一版只断言 `bad.length === 0`，而待办箱里根本没有
   * `task-pill`（胶囊只在月 / 周视图渲染），于是把 CheckBtn 换回 <span>
   * 重跑，断言照样整段绿 —— 一条没有候选的断言等于没写。
   * `cands` 就是用来堵这个的：候选为 0 时单独报错，而不是装作通过。
   */
  const scan = async () => {
    const r = await evalJs(page, `return { bad: ${a11y()}, cands: document.querySelectorAll('.task-el').length };`);
    return r;
  };

  // —— 先换集，再建任务 ——
  // **顺序不能反。** 任务建在「当前选中的集」里；先建后换的话，换过去之后
  // 月视图（按集）根本看不到它，下面那条又会空过一轮。
  //
  // 而且必须挑一个**有写权限的**集（owner / editor）：第十节把爸爸在别的集里
  // 降成了只读，随手挑「另一个集」正好挑中只读的那个 —— quickAdd 会被
  // deny() 挡下、任务根本不出现，探针卡在「等不到任务出现」上，
  // 报错却指向快速添加，看着像输入框坏了。按 role 挑就没有这个问题。
  //
  // 挑哪个集也**不按名字**：第六节把集改过名，照着名字找会静默找不到。
  const pickId = await evalJs(page, `
    const st = JSON.parse(localStorage.getItem('schedule-app-v4'));
    const canWrite = (r) => r === 'owner' || r === 'editor';
    const mine = (st.cals || []).filter((c) => canWrite(c.role));
    const pick = mine.find((c) => c.id !== st.ui.cal) || mine[0];
    return pick ? pick.id : '';
  `);
  ok(pickId !== '', '有一个有写权限的日程集可切');
  await focusCal(pickId);
  ok(await withCals(() => evalJs(page, `
    const on = [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .filter((x) => x.getAttribute('aria-pressed') === 'true');
    return on.length === 1 && on[0].dataset.calRow === ${JSON.stringify(pickId)};
  `)), '切到了有写权限的日程集，且只有它勾着');
  await closeCalMenu();

  await quickAdd(page, '无障碍检查');
  const list = await scan();
  ok(list.cands > 0, '待办箱里有任务行可查（候选 ' + list.cands + ' 个 —— 为 0 时下面那条是空过）');
  ok(list.bad.length === 0, '待办箱没有假按钮 / 无名控件'
    + (list.bad.length ? '：\n      ' + list.bad.join('\n      ') : ''));

  /* 圈的**大小**（2026-10-24 第四轮，用户第 2 条「打勾太大、位置不对」）：
     视觉直径 = 所在那一行的字号 × `--check-k`（夹在 `--check-min` ~ `--check-max`），
     命中区仍然 24×24 —— 靠 `.check-btn::before` 往外撑，不是把圆点画大（画大就毁了列表密度）。
     第五轮用户「打勾太小了 比例再大一点」→ k .85 → 1、上限 16 → 18。
     ⚠️ 三个数从 :root 读，不在探针里写死：写死过一次，改令牌那一轮就得手动追一遍探针，
        追漏的那处会红在别处。
     这里量的是**列表行**（卡片那两个尺寸由 card-geometry 钉）。 */
  const size = await evalJs(page, `
    const rows = [...document.querySelectorAll('.task-row')].filter((r) => r.querySelector('.check-btn'));
    if (!rows.length) return null;
    const cs = getComputedStyle(document.documentElement);
    const tok = (n, dflt) => { const x = parseFloat(cs.getPropertyValue(n)); return Number.isFinite(x) ? x : dflt; };
    return { k: tok('--check-k', 1), min: tok('--check-min', 9), max: tok('--check-max', 18),
             rows: rows.map((r) => {
               const btn = r.querySelector('.check-btn');
               const title = r.querySelector('.row-title') || r;
               const fs = parseFloat(getComputedStyle(title).fontSize);
               const box = getComputedStyle(btn, '::before');
               return {
                 fs, w: +btn.getBoundingClientRect().width.toFixed(2),
                 beforeW: parseFloat(box.width), beforeH: parseFloat(box.height),
               };
             }) };
  `);
  ok(!!size && size.rows.length > 0, '列表行里有带勾选圈的行可查（' + (size ? size.rows.length : 0) + ' 行）');
  for (const r of (size ? size.rows : [])) {
    const want = Math.min(size.max, Math.max(size.min, r.fs * size.k));
    ok(Math.abs(r.w - want) <= 0.6,
      `列表圈视觉直径 = 行字号 × ${size.k}（夹 ${size.min}~${size.max}），且不比任务名大`,
      `圈 ${r.w}px / 字号 ${r.fs}px（want ${want.toFixed(2)}）`);
    ok(r.w <= r.fs + 0.5, '列表圈不比任务名文字宽', `圈 ${r.w}px ≤ 字号 ${r.fs}px`);
    ok(r.beforeW >= 24 && r.beforeH >= 24,
      '命中区仍是 24×24（WCAG 2.5.8，靠 ::before 撑，不是把圈画大）',
      `::before ${r.beforeW}×${r.beforeH}`);
  }

  // 抽屉里字段最多（日期 / 时间 / 时长 / 重复 / 备注 + 重复面板里的几个），
  // label 配没配上在这里最容易露馅
  ok(await clickEl(page, `
    [...document.querySelectorAll('[data-scope="inbox"] .task-el')]
      .find((e) => e.textContent.includes('无障碍检查'))
  `) !== 'missing', '点开刚建的那条任务');
  await waitFor(page, `!!document.querySelector('.drawer.open .drawer-title')`, '抽屉打开', 8000);
  const draw = await evalJs(page, `return { bad: ${a11y()},
    cands: document.querySelectorAll('.drawer.open input, .drawer.open select, .drawer.open textarea').length
      + document.querySelectorAll('.drawer.open .dp-btn, .drawer.open .tp-btn').length };`);
  ok(draw.cands >= 5, '抽屉里有 ' + draw.cands + ' 个表单控件可查（日期 / 时间 / 时长 / 重复 / 备注）');
  ok(draw.bad.length === 0, '详情抽屉里每个输入框都有名字、每个 label 都配上了控件'
    + (draw.bad.length ? '：\n      ' + draw.bad.join('\n      ') : ''));

  // htmlFor 真配上没配上，光看属性不算数 —— 点一下 label，光标该进对应控件。
  // 这一条同时也是「移动端点小字标签能不能聚焦到框」的代理断言
  const focusOk = await evalJs(page, `
    const l = document.querySelector('.drawer.open .field label[for]');
    if (!l) return '没有带 for 的 label';
    const want = l.htmlFor;
    l.click();
    const a = document.activeElement;
    return a && a.id === want ? 'ok' : ('焦点跑到了 ' + (a ? (a.id || a.tagName) : 'null'));
  `);
  ok(focusOk === 'ok', '点「日期」这个 label 能把光标送进日期框，实际 ' + focusOk);

  // 顺手把这条任务填上日期 —— 下面月视图要用的那条**有日期的**任务就是它。
  //
  // 走抽屉的日期控件，不走快速添加的自然语言：本探针的 store 里本来一条有日期
  // 的任务都没有，而「快速添加 → 解析出日期」那条路别处已经单独覆盖过，
  // 这里再依赖一次只会多一个可能失败的地方。
  // 日期现在是自定义 DatePicker（一个日期按钮 + 月历面板），不是原生 input ——
  // 点日期按钮打开月历，再点一个日期。
  const dated = await evalJs(page, `
    const btn = document.querySelector('.drawer.open .dp-btn');
    if (!btn) return 'missing';
    btn.click();
    return 'ok';
  `);
  ok(dated === 'ok', '在抽屉里给它填上今天（' + new Date().toISOString().slice(0, 10) + '），实际 ' + dated);
  await waitFor(page, `document.querySelector('.drawer.open .dp-pop') ? 1 : null`, '月历面板打开了', 8000);
  const picked = await evalJs(page, `
    const cells = [...document.querySelectorAll('.drawer.open .dp-pop .jp-cell:not(.out)')];
    const today = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const iso = today.getFullYear() + '-' + p(today.getMonth() + 1) + '-' + p(today.getDate());
    const cell = cells.find((c) => c.classList.contains('today')) || cells[0];
    if (!cell) return 'missing';
    cell.click();
    return cell.classList.contains('today') ? 'ok' : 'picked-other';
  `);
  ok(picked === 'ok', '在月历里点了今天，实际 ' + picked);
  // waitFor 前面会被补一个 return，所以这里只能写一个**表达式**，不能带 const
  //（见 docs/踩坑-环境.md 第 29 条 ASI 那一段 —— 已经踩过一次）
  await waitFor(page, `
    (() => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const today = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      return Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks || {})
        .some((t) => t.title === '无障碍检查' && t.date === today) ? 1 : null;
    })()
  `, '日期落盘了', 8000);

  await clickEl(page, `document.querySelector('.drawer.open .drawer-head [aria-label="完成"]')`);
  await waitFor(page, `document.querySelector('.drawer.open') ? null : 1`, '抽屉关上了', 8000);

  // 先切回日程页再选月视图 —— `.view-switch` 只在 nav === 'calendar' 时才渲染，
  // 少了这一步 querySelector 直接拿到 null
  await evalJs(page, `document.querySelector('[data-nav="calendar"]').click(); return true;`);
  await evalJs(page, `document.querySelector('[data-view="month"]').click(); return true;`);
  await waitFor(page, `document.querySelector('[data-view="month"].on') ? 1 : null`, '切到月视图', 8000);
  await new Promise((r) => setTimeout(r, 400));   // 等这一帧画完再数
  const month = await scan();
  const pills = await evalJs(page, `return document.querySelectorAll('.task-pill').length;`);
  // 失败时把「为什么没有胶囊」直接打出来 —— 否则只能看到「0 个」，
  // 而 0 个有一堆可能：选中的集没切成、月份不对、格子被折叠成「还有 N 项」
  const diag = await evalJs(page, `return {
    // 勾了哪几个集从 localStorage 的 ui.cals 读（那是真相），不用打开下拉
    cals: (JSON.parse(localStorage.getItem('schedule-app-v4')).ui || {}).cals,
    activeCal: (JSON.parse(localStorage.getItem('schedule-app-v4')).ui || {}).cal,
    uiCursor: (JSON.parse(localStorage.getItem('schedule-app-v4')).ui || {}).cursor,
    monthCells: document.querySelectorAll('.month-cell').length,
    collapsed: (document.body.innerText.match(/还有 \\d+ 项/g) || []),
  };`);
  ok(pills > 0, '月视图里确实有胶囊可查（' + pills + ' 个 —— 为 0 时下面那条是空过）'
    + '　诊断：' + JSON.stringify(diag));
  ok(month.bad.length === 0, '月视图格子里的勾选圈也是真按钮'
    + (month.bad.length ? '：\n      ' + month.bad.join('\n      ') : ''));

  // 2026-10-22 用户三条（月视图宽屏）：①「改了这么多次还是有完全属于下个月的
  // 空白行」②「每行高度保持一致且固定，不被任务撑开或压扁」③「显示不完格内
  // 滚动，滚动条浮动不占横向空间」。三条一起锁在这：
  const mv = await evalJs(page, `return (() => {
    const cells = [...document.querySelectorAll('.month-cell')];
    if (!cells.length) return { err: 'no-cells' };
    // 行 = 按 y 聚类（网格同一行的格子 y 相同）
    const rows = new Map();
    for (const c of cells) {
      const y = Math.round(c.getBoundingClientRect().y);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(c);
    }
    const rowList = [...rows.values()]
      .sort((a, b) => a[0].getBoundingClientRect().y - b[0].getBoundingClientRect().y);
    // 纯下月行 = 整行都是 .out（邻月灰格）—— monthWeeks 不该产出这种行
    const pureOut = rowList.filter((row) => row.every((c) => c.classList.contains('out'))).length;
    const heights = [...new Set(rowList.map((row) => Math.round(row[0].getBoundingClientRect().height)))];
    const ct = document.querySelector('.cell-tasks');
    const cs = ct ? getComputedStyle(ct) : null;
    const grid = document.querySelector('.month-grid').getBoundingClientRect();
    return {
      rows: rowList.length, pureOut, heights, h0: heights[0],
      overflowY: cs ? cs.overflowY : null,
      scrollbarWidth: cs ? cs.scrollbarWidth : null,
      position: cs ? cs.position : null,
      gridH: Math.round(grid.height), viewH: window.innerHeight,
    };
  })();`);
  ok(!mv.err && mv.rows >= 4 && mv.rows <= 6 && mv.pureOut === 0,
    '月视图没有纯下月空白行（' + mv.rows + ' 行，纯下月 ' + mv.pureOut + ' 行）'
    + (mv.err ? '　诊断：' + JSON.stringify(mv) : ''));
  ok(!mv.err && mv.heights && mv.heights.length === 1 && mv.h0 > 40,
    '每行高度一致且固定（' + mv.rows + ' 行都是 ' + mv.h0 + 'px —— 任务多寡不改行高）');
  ok(!mv.err && mv.overflowY === 'auto' && mv.scrollbarWidth === 'none' && mv.position === 'relative',
    '宽屏格子溢出格内滚动、系统滚动条已藏（浮条不占横向宽度）');
  ok(!mv.err && mv.gridH <= mv.viewH, '月视图网格不超出一屏（' + mv.gridH + ' ≤ ' + mv.viewH + '）');


}

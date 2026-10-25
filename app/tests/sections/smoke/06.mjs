export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n五、设置页的日程集管理：改名能落库');
  // 侧栏那个「管理当前日程集」浮层删了 —— 设置页本来就是同一套（MembersSection
  // 都是抽出来共用的一份），所以这一段改走设置页。名字框 / 成员 / 危险区都还在，
  // 只是入口换了，顺带证明「删掉重复入口之后功能没跟着没」。
  await evalJs(page, `document.querySelector('[data-nav="settings"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[data-settings-tab]')`, '设置页打开', 8000);
  /* 设置页自己的 header 左上角要写页名（用户 2026-10-09：「设置页的 header 的左上角
     没有设置字样」）。**写在页面里、不写在顶栏** —— 顶栏那一栏再写一遍「设置」，
     两行同一个词看着像两个 header。所以这里查的是 `#content` 里那个 h1。 */
  /* 页名归**顶栏**（用户 2026-10-09：「设置页的 header 的左上角没有设置字样」，
     要求就是写进 header 里）。设置页那张 tab 栏是**页内的分段开关**、不是 header，
     所以页面里不写第二遍 —— 两行都是「设置」看着像两个 header。 */
  ok(await evalJs(page, `return (document.querySelector('.topbar .view-title') || {}).textContent;`) === '设置',
    '顶栏左上角写着页名「设置」，实际 '
    + JSON.stringify(await evalJs(page, `return (document.querySelector('.topbar .view-title') || {}).textContent;`)));
  ok(await evalJs(page, `return !document.querySelector('#content h1');`),
    '页面里不再写第二遍「设置」');
  await evalJs(page, `document.querySelector('[data-settings-tab="cals"]').click(); return true;`);
  // 当前集默认就是展开的（CalsTab 的 openId 初始值就是 ui.cal）。
  // **名字框此刻不在** —— 改名搬进标题行之后，平时是「一段字 + 铅笔」，
  // 点铅笔才变出输入框（`InlineRename`）。所以这里等的是那一行，不是输入框。
  await waitFor(page, `!!document.querySelector('[data-cal-item]')`, '日程集管理打开', 8000);
  // 成员是异步拉的，别在读之前就断言。
  // **不能等「创建者」**：那是 ROLE_LABEL，发邀请那个角色选择器的 <option>
  // 里就有一个，面板一开就存在 —— 等它等于没等，成员还没到就开始读，
  // 断言会随机失败（而且失败信息看着像「自己的名字没显示」，指向完全错的地方）。
  // 等成员**条数**变成非零才是真的加载完了。
  await waitFor(page,
    `/成员（[1-9]\\d*）/.test(document.getElementById('content').innerText) ? 1 : null`,
    '成员列表加载完');
  const sheetText = await evalJs(page, `return document.getElementById('content').innerText;`);
  ok(sheetText.includes('成员'), '面板里有成员区');
  ok(sheetText.includes('爸爸'), '成员列表里有自己');
  ok(sheetText.includes('创建者'), '自己的角色显示为「创建者」');
  // 「邀请成员」不再是单独一个小节了 —— 邀请行就是成员列表的最后一行，
  // 靠输入框的 placeholder 认（innerText 读不到 placeholder，要查 DOM）。
  // placeholder 从「输入邀请的成员的用户名」缩到「输入用户名」，2026-10-09 又按
  // 用户要求加回「邀请」三个字 → 「输入要邀请的用户名」：这一行是成员列表的
  // 最后一行，前面几行都是「谁有权看」，孤零零一个「输入用户名」读不出是在
  // 邀请谁，而 aria-label 眼睛看不见。9 个字，474px 的框放得下。
  // 30px 高、右边还并着两个控件的框里根本显示不完（2026-10-08）。
  ok(await evalJs(page, `return !!document.querySelector('#content input[placeholder="输入要邀请的用户名"]');`),
    '创建者能看到发邀请的入口（列表最后一行）');

  // 面板里的控件也要有名字。**这一段是补漏**：「每个输入框都有名字」原来只扫了
  // 抽屉（第十三节），这个名字框和角色选择器一个都没有可访问名字 ——
  // 它们从来就没被任何断言看过。
  //
  // 放在这里而不是第十三节：成员是**联网拉的**，第十三节跑在断网之后，
  // 那时成员列表是空的、角色选择器根本不渲染，扫过去等于空过（候选数为 0）。
  //
  // 数的是「这里真的有控件可查」，所以要把**选择器的触发按钮**也算进来：
  // 角色选择器是 `Dropdown`（`button[aria-haspopup="listbox"]`），不是原生
  // `<select>`、也不是 `aria-pressed` 的胶囊 —— 只认 `input/select/aria-pressed`
  // 的话，成员那几行换过组件之后就只剩名字框 + 邀请框两个，这条断言会假红
  // （控件的可访问名字其实都好好的，见下面那条）。
  const sheetA11y = await evalJs(page, `return { bad: ${a11y('#content')},
    cands: document.querySelectorAll('#content input, #content select, #content textarea, #content button[aria-haspopup]').length };`);
  ok(sheetA11y.cands >= 3, '日程集管理里有 ' + sheetA11y.cands + ' 个表单控件可查（成员权限 / 邀请用户名 / 邀请权限）');
  ok(sheetA11y.bad.length === 0, '日程集管理里每个控件都有名字'
    + (sheetA11y.bad.length ? '：\n      ' + sheetA11y.bad.join('\n      ') : ''));

  /* 行内改名：**点铅笔才出输入框**，而「切进编辑态时下面不许动」是这套组件
     存在的全部理由 —— 固定行高 + 右侧固定宽的动作槽。这里把编辑态前后的
     「成员区顶边」量一遍：差多少都算坏（哪怕只差 1px，用户看得见那一跳）。 */
  /* 写成**表达式**（IIFE）而不是语句块 —— 它要能塞进 `return ${GEOM};` 这种
     evalJs 的用法里。踩坑 29：evalJs 自己不补 return。 */
  const GEOM = `(() => {
    const body = document.querySelector('[data-cal-body]');
    const bar = body.previousElementSibling;          // 标题行（固定 h-[40px]）
    const first = body.firstElementChild;             // 成员区那一块
    return { head: bar.getBoundingClientRect().height, first: first.getBoundingClientRect().top };
  })()`;
  const beforeEdit = await evalJs(page, `return ${GEOM}`);

  /* 标题行的**三区**（用户 2026-10-08 定）：从左到右 名称区 · 操作区 · 箭头区。
     这里量的是**几何**，不是类名 —— 类名写对不代表摆对，而「谁在最右」正是
     这次要改的东西。顺带把字号也读回来：输入框该和显示态同一号字。 */
  const zones = await evalJs(page, `return (() => {
    const chev = document.querySelector('[data-cal-item]');
    const row = chev.parentElement;                   // 标题行
    const r = row.getBoundingClientRect();
    const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right }; };
    const nameEl = row.querySelector('span.truncate');
    const star = row.querySelector('[aria-label*="默认日程集"]');
    const del = row.querySelector('[aria-label="删除日程集"]');
    /* 把 var(--primary) 解析成 rgb() 再比 —— 直接比字符串的话，浏览器给的是
       rgb 形式，而令牌是 #27795a，永远不相等。 */
    const rgb = (v) => { const d = document.createElement('div');
      d.style.color = v; document.body.appendChild(d);
      const c = getComputedStyle(d).color; d.remove(); return c; };
    return {
      /* 标题行有 pr-2 这个类，所以「最右」要比**内容盒**的右边，不是边框盒 ——
         不然箭头永远差着那 7px 内边距，断言会一直红。
         （注释里不能写反引号：这一段住在模板字面量里，反引号会把模板当场截断） */
      rowInnerL: r.left + parseFloat(getComputedStyle(row).paddingLeft),
      rowInnerR: r.right - parseFloat(getComputedStyle(row).paddingRight),
      /* 标题条**外沿**（圆角条的两端）—— 正文那几行现在对齐的是这个，
         不是上面的内容盒。两个都留着：内容盒那条还压着「箭头在最右」。 */
      rowOuterL: r.left,
      rowOuterR: r.right,
      nameR: nameEl ? box(nameEl).r : null,
      nameFont: nameEl ? getComputedStyle(nameEl).fontSize : null,
      /* 正文那一块。**不占横向留白**（2026-10-09 用户：「宽度再宽一点点，
         让邀请输入框、新建按钮、header 对齐」）—— 成员行 / 邀请行的两条边与
         标题条那个圆角条的**外沿**齐平。上一轮是对齐到标题条的**内容盒**
         （pl-3 pr-2 = 10.5 / 7），结果每行都比标题条窄一截，看着就是没对齐。 */
      body: (() => {
        const b = document.querySelector('[data-cal-body]');
        if (!b) return null;
        const br = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return {
          l: br.left + parseFloat(cs.paddingLeft),
          r: br.right - parseFloat(cs.paddingRight),
          padL: cs.paddingLeft, padR: cs.paddingRight,
        };
      })(),
      /* 成员行自己那一条（借角色下拉往上找到行容器）—— 用户报的是
         「成员列比标题条微微宽出来一点」，所以量**这一条**的两条边。
         必须从 parentElement 往上找：closest 会先看自己，而那个按钮自己
         就带着 h-[30px]（Dropdown 的 sm 档），量出来是按钮不是行。 */
      memberRow: (() => {
        const el = document.querySelector('[aria-label$="的权限"]');
        const row = el && el.parentElement
          ? el.parentElement.closest('[class*="h-[30px]"]') : null;
        return row ? box(row) : null;
      })(),
      star: star ? box(star) : null,
      starColor: star ? getComputedStyle(star).color : null,
      wantPrimary: rgb('var(--primary)'),
      del: del ? box(del) : null,
      delOff: del ? del.disabled : null,
      delColor: del ? getComputedStyle(del).color : null,
      /* 邀请行与纸飞机（用户 2026-10-09 点名的那两个）。行容器从输入框的
         parentElement 往上找 —— closest 会先匹配自己，而输入框自己就带着
         h-[30px]，直接 closest 量到的是输入框不是行（见踩坑 46）。 */
      inviteRow: (() => {
        const el = document.querySelector('[data-cal-body] input');
        const row = el && el.parentElement
          ? el.parentElement.closest('[class*="h-[30px]"]') : null;
        return row ? box(row) : null;
      })(),
      inviteSend: box(document.querySelector('[aria-label="发出邀请"]')),
      chev: box(chev),
      chevTag: chev.tagName,
      chevExp: chev.getAttribute('aria-expanded'),
    };
  })()`);
  ok(Math.abs(zones.rowInnerR - zones.chev.r) < 1,
    '箭头在标题行最右（行内容右 ' + zones.rowInnerR + ' / 箭头右 ' + zones.chev.r + '）');
  ok(zones.chevTag === 'BUTTON' && zones.chevExp === 'true',
    '最右那一格才是折叠开关（button + aria-expanded=true），实际 '
    + zones.chevTag + '/' + zones.chevExp);
  ok(!!zones.star && zones.nameR !== null && zones.star.l >= zones.nameR - 1,
    '星标紧跟着名字（名字右 ' + zones.nameR + ' / 星标 ' + JSON.stringify(zones.star) + '）');
  ok(!!zones.star && !!zones.del
    && zones.del.l >= zones.star.r - 0.5 && zones.del.r <= zones.chev.l + 0.5,
    '删除按钮在操作区里（星标右边、箭头左边），实际 ' + JSON.stringify(zones.del));
  ok(zones.delOff === true,
    '默认日程集的删除按钮是禁用的（删了它，下次新建的东西就没地方落）');
  /* 星标是主色、删除钮是灰的。这条不是「好不好看」，是钉住**tone 走 prop 不走
     叠 className**：叠 `text-[var(--primary)]` 会被基类的 `text-[var(--text-3)]`
     按生成顺序压掉，两个都会变成灰的（实测过，见踩坑 17）。 */
  ok(zones.starColor === zones.wantPrimary && zones.delColor !== zones.wantPrimary,
    '默认集的星标是主色、删除钮是灰的（星 ' + zones.starColor + ' / 删 '
    + zones.delColor + ' / 主色 ' + zones.wantPrimary + '）');
  /* 成员行与标题条**外沿**齐平（左、右各一条）。上一轮是对齐到内容盒，
     这一轮用户要「再宽一点点」—— 贴齐圆角条的外沿。两条边都得量：
     只量右边会漏掉左边那个角色图标。 */
  ok(!!zones.memberRow && !!zones.body
    && Math.abs(zones.memberRow.l - zones.rowOuterL) < 0.6,
    '成员行左边和标题条外沿齐平（成员行 ' + (zones.memberRow ? zones.memberRow.l : 'null')
    + ' / 标题条 ' + zones.rowOuterL + ' / 正文留白 ' + (zones.body ? zones.body.padL : 'null') + '）');
  ok(!!zones.memberRow && !!zones.body
    && Math.abs(zones.memberRow.r - zones.rowOuterR) < 0.6,
    '成员行右边和标题条外沿齐平、不超出（成员行 ' + (zones.memberRow ? zones.memberRow.r : 'null')
    + ' / 标题条 ' + zones.rowOuterR + ' / 正文留白 ' + (zones.body ? zones.body.padR : 'null') + '）');
  /* 邀请行（用户 2026-10-09 点名的就是这一条）：输入框左缘、纸飞机右缘
     都要和标题条外沿齐平。量法同成员行 —— 从 parentElement 往上找行容器。 */
  ok(!!zones.inviteRow && Math.abs(zones.inviteRow.l - zones.rowOuterL) < 0.6,
    '邀请输入框左边和标题条外沿齐平（邀请行 ' + (zones.inviteRow ? zones.inviteRow.l : 'null')
    + ' / 标题条 ' + zones.rowOuterL + '）');
  ok(!!zones.inviteRow && Math.abs(zones.inviteRow.r - zones.rowOuterR) < 0.6,
    '邀请行右边和标题条外沿齐平（邀请行 ' + (zones.inviteRow ? zones.inviteRow.r : 'null')
    + ' / 标题条 ' + zones.rowOuterR + '）');
  ok(!!zones.inviteSend && Math.abs(zones.inviteSend.r - zones.rowOuterR) < 0.6,
    '纸飞机右缘和标题条外沿齐平（钮右 ' + (zones.inviteSend ? zones.inviteSend.r : 'null')
    + ' / 标题条 ' + zones.rowOuterR + '）');

  await evalJs(page, `document.querySelector('[aria-label="改名"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[data-cal-name]')`, '点铅笔后出现名字输入框', 4000);
  const afterEdit = await evalJs(page, `return { ...${GEOM},
    hasSave: !!document.querySelector('[data-cal-save]') };`);
  ok(afterEdit.hasSave, '编辑态右边是确认按钮（不是「保存」文字按钮）');
  /* ✓ 必须是主色、✕ 是灰的 —— 「两个灰按钮并排看不出哪个是哪个」。
     两条踩过的坑都在这一条断言里：
     ① 颜色不能靠外面叠 `className`（同特异度看生成顺序，实测 ✓ 拿到的是
        和 ✕ 一样的 `--text-3`）。所以要**读计算值**，读类名是读不出来的。
     ② React 复用了同一个 `<button>`（铅笔 → ✓），`transition` 150ms 会把颜色
        从灰动画到主色，**立刻读会读到动画中途**。先等它落定再读。 */
  const saveColor = await evalJs(page, `
    return (async () => {
      const rgb = (v) => { const d = document.createElement('div');
        d.style.color = v; document.body.appendChild(d);
        const c = getComputedStyle(d).color; d.remove(); return c; };
      const want = rgb('var(--primary)');
      const t0 = Date.now();
      for (;;) {
        const cf = document.querySelector('[data-cal-save]');
        const cx = document.querySelector('#content [aria-label="取消"]');
        const got = cf && getComputedStyle(cf).color;
        const gotX = cx && getComputedStyle(cx).color;
        if (got === want && gotX !== want) return { want, got, gotX, ms: Date.now() - t0 };
        if (Date.now() - t0 > 2000) return { want, got, gotX, ms: -1 };
        await new Promise((r) => setTimeout(r, 50));
      }
    })()`);
  ok(saveColor.got === saveColor.want && saveColor.gotX !== saveColor.want,
    '编辑态「确认」是主色、「取消」是灰的（确认 ' + saveColor.got + ' / 取消 '
    + saveColor.gotX + ' / 主色 ' + saveColor.want + '，等了 ' + saveColor.ms + 'ms）');
  ok(Math.abs(afterEdit.head - beforeEdit.head) <= 0.6,
    '切到编辑态时标题行高度不变（' + beforeEdit.head + ' → ' + afterEdit.head + '）');
  ok(Math.abs(afterEdit.first - beforeEdit.first) <= 0.6,
    '切到编辑态时下面的成员区一像素没动（' + beforeEdit.first + ' → ' + afterEdit.first + '）');

  /* 星标与删除按钮都住在**会被换掉的那两格里**（星标在 `display` 里、删除在
     InlineRename 的动作槽里）—— 编辑态整个换掉，所以它们**自己就消失了**，
     外面不用再判一次 `editing`，也就不会出现「名字已经变成输入框了，星标还
     杵在旁边」的错位。这两条钉住那个效果：谁把星标挪到 InlineRename 外面，
     这里立刻红。 */
  ok(await evalJs(page, `return !document.querySelector('#content [aria-label*="默认日程集"]');`),
    '编辑态里星标隐藏（它跟着名字走，名字变成输入框它就让位）');
  ok(await evalJs(page, `return !document.querySelector('#content [aria-label="删除日程集"]');`),
    '编辑态里删除按钮隐藏（操作区那两格换成了 √ / ✕）');

  /* 字号：输入框里的字必须和**非编辑态那一行字**一模一样。
     原先 `styles/tokens.css` 里有一条**没有层**的 `input { font-size: 14px }`，
     它把 `Input` / `Textarea` 上每一个 Tailwind `text-*` 都吃掉了 —— 输入框
     永远比它旁边那行字大一号，改类名毫无反应（踩坑 17 的延伸）。这两条就是
     那个坑的看门人：把 `font-size` 再挪回没有层的位置，它们当场变红。 */
  const fonts = await evalJs(page, `return (() => {
    const inp = document.querySelector('[data-cal-name]');
    const inv = document.querySelector('#content input[placeholder="输入要邀请的用户名"]');
    return {
      input: inp ? getComputedStyle(inp).fontSize : null,
      invite: inv ? getComputedStyle(inv).fontSize : null,
      invitePh: inv ? inv.placeholder : null,
    };
  })()`);
  ok(fonts.input === zones.nameFont,
    '输入框的字号和非编辑态那一行字一样（' + zones.nameFont + ' vs ' + fonts.input + '）');
  ok(fonts.invite === zones.nameFont,
    '邀请框也同一号字（' + zones.nameFont + ' vs ' + fonts.invite + '）');
  ok(!!fonts.invitePh && fonts.invitePh.length <= 9 && fonts.invitePh.includes('邀请'),
    '邀请框的 placeholder 短到放得下、且必须带「邀请」三个字，实际 ' + JSON.stringify(fonts.invitePh));

  await evalJs(page, `
    const inp = document.querySelector('[data-cal-name]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, '全家'); inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await evalJs(page, `document.querySelector('[data-cal-save]').click(); return true;`);
  const renamed = await withCals(() => waitFor(page, `
    [...document.querySelectorAll('.cal-menu-pop [data-cal-row]')]
      .some((b) => b.textContent.trim() === '全家') ? '全家' : null`,
    '下拉里名字变成「全家」'));
  ok(renamed === '全家', '改名同步到了顶栏那个下拉多选框');
  await closeCalMenu();

  const reloaded = await evalJs(page, `
    const r = await fetch('./api/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('schedule-app-token') } });
    const j = await r.json();
    return j.cals[0].name;
  `);
  ok(reloaded === '全家', '服务器上也是「全家」（不是只改了界面）');

  /* 星标 = 默认日程集。以前「哪个是默认」是 `name === '我的日程'` 判的，
     改名那一刻就失效；上面刚把这个集改成了「全家」，按老口径它已经不是默认了。
     这一段钉的是新口径：改名不影响默认，星标还能换到别的集上。 */
  const stars = await evalJs(page, `return [...document.querySelectorAll('#content [aria-label*="默认日程集"]')]
    .map((b) => ({ pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label') }));`);
  ok(stars.length === 1, '每个日程集标题行上有一个星标，实际 ' + stars.length);
  ok(stars[0].pressed === 'true',
    '改名之后默认身份没丢（老口径下这里会是 false）');

  /* 创建者那一行：权限下拉与移出按钮都禁用。下拉里也**不该有「创建者」**——
     那是集必须有的主人，不是能分下去的权限（见 ASSIGNABLE_ROLES）。 */
  const ownerRow = await evalJs(page, `return {
    dropdowns: [...document.querySelectorAll('#content button[aria-haspopup="listbox"]')]
      .map((b) => ({ off: b.disabled, name: b.getAttribute('aria-label') })),
  };`);
  const mineRow = ownerRow.dropdowns.find((d) => d.name && d.name.includes('爸爸'));
  ok(!!mineRow && mineRow.off, '创建者的权限下拉是禁用的');
  ok(await evalJs(page, `return !!document.querySelector('#content [aria-label="移出日程集"][disabled]');`),
    '创建者的移出按钮是禁用的（不变量 2：每个集至少留一个 owner）');
  /* 创建者的下拉是**禁用的**（`disabled={m.role === 'owner'}`，上面那条断言过了），
     所以「下拉里没有『创建者』」这件事的正确读法是：**点开它不会出现选项列表**。
     原先这里去读 `body [role="option"]` 的文本跟 '可编辑,只读' 比 —— 禁用的
     下拉根本不开列表，读到的是上一次别的下拉留下的残影，断言永远为假。
     真正要守的不变量是「创建者不是可以分下去的权限」，它体现在禁用上。 */
  ok(await evalJs(page, `
    const dd = [...document.querySelectorAll('#content button[aria-haspopup="listbox"]')]
      .find((b) => b.getAttribute('aria-label') && b.getAttribute('aria-label').includes('爸爸'));
    dd.click();
    return document.querySelectorAll('body [role="option"]').length;
  `) === 0, '创建者的权限下拉是禁用的，点不开选项列表（所以没有「创建者」这项）');


}

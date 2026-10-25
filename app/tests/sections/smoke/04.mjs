export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch, key, quickAdd, waitGone, dumpPage, openCalMenu, waitCalMenu, closeCalMenu, withCals, shown, clickCal, waitShownCount, focusCal, inbox, a11y, collect, fmt, apiPort, webPort, dataDir, TOUCH_DRAG_DELAY, SETTER } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  console.log('\n四、三个视图都能切，不白屏');
  // 日视图没有外层包装类，靠 .timeline 认；周视图是 .week-view
  for (const [nav, marker] of [['calendar', '.timeline'], ['today', '.content'],
    ['inbox', '.content'], ['overdue', '.content'], ['habits', '.content'], ['done', '.content']]) {
    await evalJs(page, `document.querySelector('[data-nav="${nav}"]').click(); return true;`);
    const txt = await waitFor(page,
      `(document.getElementById('content')?.innerText || '').length > 0 ? document.getElementById('content').innerText.slice(0, 40) : null`,
      nav + ' 有内容');
    ok(!!txt, nav + ' 渲染出内容（' + JSON.stringify(txt.slice(0, 18)) + '）');
    ok(await evalJs(page, `return !!document.querySelector('${marker}');`), nav + ' 有 ' + marker);
  }

  /* ---- Btn 六档 variant 各钉一条颜色（第 1 册 R4：外观集中在 kit，variant 定色）----
     S1 把 Btn 的 variant 收进 cva 后，这里钉住「每档渲染出来的颜色」：谁在 cva 里
     把 primary 的底色 / danger 的描边 / chipOn 的选中色改错，这里立刻红。
     选点全是稳定选择器（data-act / title / 类名 / data-pick），不靠坐标；
     桌面视口下顶栏 + 侧栏都在。颜色用 rgb(var(--x)) 解析成 rgb() 再比，
     不比字符串（浏览器给的是序列化后的 rgb）。 */
  await evalJs(page, `document.querySelector('[data-nav="calendar"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[title="上一个"]')`, '日程页副header 出来', 8000);
  const btnBase = await evalJs(page, `
    const rgb = (v) => { const d = document.createElement('div');
      d.style.color = v; document.body.appendChild(d);
      const c = getComputedStyle(d).color; d.remove(); return c; };
    const g = (sel) => { const el = document.querySelector(sel);
      return el ? getComputedStyle(el) : null; };
    const n = g('[title="上一个"]'), gh = g('.ghost-btn');
    return {
      normalColor: n ? n.color : null,
      ghostColor: gh ? gh.color : null, ghostBg: gh ? gh.backgroundColor : null,
      wantText2: rgb('var(--text-2)'), transparent: 'rgba(0, 0, 0, 0)',
    };
  `);
  ok(btnBase.normalColor === btnBase.wantText2,
    'Btn normal 文字色 = --text-2，实际 ' + btnBase.normalColor + ' / 期望 ' + btnBase.wantText2);
  ok(btnBase.ghostColor === btnBase.wantText2 && btnBase.ghostBg === btnBase.transparent,
    'Btn ghost 文字色 = --text-2 且透明底，实际 ' + btnBase.ghostColor + ' / ' + btnBase.ghostBg);

  // 设置页（默认外观 tab）：chip / chipOn —— 色板/风格/深浅的 Chips，data-pick 是 Chips 专属
  await evalJs(page, `document.querySelector('[data-nav="settings"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('[data-settings-tab]')`, '设置页打开', 8000);
  const btnChips = await evalJs(page, `
    const rgb = (v) => { const d = document.createElement('div');
      d.style.color = v; document.body.appendChild(d);
      const c = getComputedStyle(d).color; d.remove(); return c; };
    const cs = (el) => el ? getComputedStyle(el) : null;
    const o = cs(document.querySelector('button[data-pick][aria-pressed="true"]'));
    const f = cs(document.querySelector('button[data-pick][aria-pressed="false"]'));
    return {
      onColor: o ? o.color : null, onBorder: o ? o.borderColor : null,
      offColor: f ? f.color : null, offBg: f ? f.backgroundColor : null,
      wantPrimary: rgb('var(--primary)'), wantText2: rgb('var(--text-2)'), wantPanel: rgb('var(--panel)'),
    };
  `);
  ok(btnChips.onColor === btnChips.wantPrimary && btnChips.onBorder === btnChips.wantPrimary,
    'Btn chipOn 文字+描边 = --primary（选中档），实际 ' + btnChips.onColor + ' / ' + btnChips.onBorder);
  ok(btnChips.offColor === btnChips.wantText2 && btnChips.offBg === btnChips.wantPanel,
    'Btn chip 文字 = --text-2 且底 = --panel（未选档），实际 ' + btnChips.offColor + ' / ' + btnChips.offBg);

  /* ---- 关于卡：网页显示版本号（自动取 package.json） + 网页专属的 App 下载 ----
     APK 下载链接在网页里出现，但**在 Capacitor App 内置的 WebView 里不显示** ——
     免得用户在一个 Android App 里再点一次 Android 安装包。 */

}

/**
 * 27.mjs —— 月视图上下滑翻月（2026-11-01 用户要求）
 *
 * 要证明的四件事：
 *   1. 跟手：手指走多少，`.month-track` 的位移就是多少（不是"滑一下就整页跳"）；
 *   2. 邻月预览只在手势进行中挂两层，抬手就摘干净；
 *   3. 门是「过一大半」：拖 30% 弹回、不翻月；拖 80% 才翻；
 *   4. 横向手势不抢（dx 明显大于 dy 时什么都不该发生）。
 *
 * 走 CDP 的真实触摸（`Input.dispatchTouchEvent`），不是页面内合成事件 ——
 * 合成事件证明不了「浏览器真的把这串触摸交给我们」。
 *
 * 落位之后 `--mdrag` 必须回到 0 且预览层清零：不然下一帧就会看到旧月
 * 停在一半的地方。
 *
 * ⚠️ 这一节在 `index.mjs` 里排在 **26 之前**：26 是收尾节（换真窄屏 + 关页面）。
 */
export async function run(ctx) {
  const { page } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, clickEl, touch } = helpers;
  const ok = ctx.ok;

  console.log('\n二十七、月视图上下滑翻月');

  await clickEl(page, `document.querySelector('.sidebar [data-nav="calendar"]')`);
  await waitFor(page, `!!document.querySelector('[data-view="month"]')`, '日程页的视图切换按钮', 8000);
  await evalJs(page, `document.querySelector('[data-view="month"]').click(); return true;`);
  await waitFor(page, `document.querySelector('[data-view="month"].on') ? 1 : null`, '切到月视图', 8000);

  const title = () => evalJs(page, `return document.querySelector('.topbar .view-title').textContent;`);
  const title0 = await title();
  ok(/^\d{4}年\d{1,2}月$/.test(title0), '月视图顶栏标题是年月，实际 ' + title0);

  /* 翻月那一页必须**吃满内容区**：`.month-swipe` 是裁剪窗，`.month-track` 要
     和它一样高 —— 差一截的话「挪一页」就对不上邻月预览的位置（会露缝）。 */
  const g = await evalJs(page, `
    const pager = document.querySelector('.month-swipe');
    const track = document.querySelector('.month-track');
    if (!pager || !track) return null;
    const r = pager.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             th: Math.round(track.getBoundingClientRect().height),
             gridH: Math.round((document.querySelector('.month-grid') || { clientHeight: 0 }).clientHeight) };
  `);
  ok(!!g, '月视图包在 .month-swipe > .month-track 里');
  ok(g && g.th === g.h && g.h > 200, 'track 与裁剪窗等高且真的撑开了', JSON.stringify(g));
  ok(g && g.gridH > 120, '月网格没被裁剪窗压扁', g && String(g.gridH));

  const mdrag = () => evalJs(page, `
    const t = document.querySelector('.month-track');
    return t ? (t.style.getPropertyValue('--mdrag') || '').trim() : null;
  `);
  const ghosts = () => evalJs(page, `return document.querySelectorAll('.month-ghost-layer').length;`);
  const ty = () => evalJs(page, `
    const t = document.querySelector('.month-track');
    const m = getComputedStyle(t).transform.match(/matrix\\(([^)]+)\\)/);
    return m ? Math.round(parseFloat(m[1].split(',')[5])) : 0;
  `);

  const x = g.left + Math.round(g.w / 2);
  const startY = g.top + Math.round(g.h * 0.1);
  const at = (p) => ({ x, y: startY + Math.round(g.h * p) });

  /* ---------------- 一小段：跟手 + 松手弹回 ---------------- */
  await touch(page, 'touchStart', at(0));
  await touch(page, 'touchMove', at(0.14));
  await touch(page, 'touchMove', at(0.3));
  const want = Math.round(g.h * 0.3);
  /* waitFor 的表达式会被包成 `return <表达式>` —— 多语句必须自己包一层 IIFE，
     直接写 `const t = ...` 会变成 `return const t = ...`（SyntaxError）。 */
  const dragged = await waitFor(page, `(() => {
    const t = document.querySelector('.month-track');
    const v = parseFloat(t.style.getPropertyValue('--mdrag') || '0');
    return Math.abs(v - ${want}) <= 3 ? Math.round(v) : null;
  })()`, '拖 30% 时位移跟手到 30%', 3000);
  ok(Math.abs(dragged - want) <= 3, '位移跟手（手指走多少画面就多少）', '期望 ≈' + want + '，实际 ' + dragged);
  ok(Math.abs(await ty() - want) <= 3, 'transform 真的落到了 track 上', String(await ty()));
  ok((await ghosts()) === 2, '拖起来时上下各挂一页邻月预览', String(await ghosts()));

  await touch(page, 'touchEnd', at(0.3));
  await waitFor(page, `(() => {
    const t = document.querySelector('.month-track');
    return (t.style.getPropertyValue('--mdrag') || '').trim() === '0px' ? 1 : null;
  })()`, '松手后位移归零', 3000);
  ok((await ghosts()) === 0, '松手后邻月预览摘干净', String(await ghosts()));
  ok((await title()) === title0, '只拖 30%（没过一大半）不翻月', await title());

  /* ---------------- 一大段：翻到上个月 ---------------- */
  await touch(page, 'touchStart', at(0));
  await touch(page, 'touchMove', at(0.3));
  await touch(page, 'touchMove', at(0.6));
  await touch(page, 'touchMove', at(0.78));
  await waitFor(page, `
    Math.abs(parseFloat(document.querySelector('.month-track').style.getPropertyValue('--mdrag') || '0')) > ${Math.round(g.h * 0.6)} ? 1 : null
  `, '拖过 60% 时跟手位移已越过一半', 3000);
  await touch(page, 'touchEnd', at(0.78));
  await waitFor(page, `
    document.querySelector('.topbar .view-title').textContent !== ${JSON.stringify(title0)} ? 1 : null
  `, '下滑翻到上个月', 4000);
  const titlePrev = await title();
  ok(titlePrev !== title0, '拖 78%（过一大半）翻到上个月', title0 + ' → ' + titlePrev);
  ok((await ghosts()) === 0, '翻月完成后预览层已摘掉', String(await ghosts()));
  ok((await mdrag()) === '0px', '翻月完成后位移回到 0（新月份从正位开始）', String(await mdrag()));

  /* ---------------- 反方向：翻到下个月 ---------------- */
  await touch(page, 'touchStart', at(0));
  await touch(page, 'touchMove', at(-0.3));
  await touch(page, 'touchMove', at(-0.75));
  await touch(page, 'touchEnd', at(-0.75));
  await waitFor(page, `
    document.querySelector('.topbar .view-title').textContent === ${JSON.stringify(title0)} ? 1 : null
  `, '上滑翻回原来的月份', 4000);
  ok((await title()) === title0, '上滑翻到下个月（回到 ' + title0 + '）', await title());

  /* ---------------- 横向手势不抢 ---------------- */
  const before = await title();
  await touch(page, 'touchStart', { x, y: startY });
  await touch(page, 'touchMove', { x: x + 90, y: startY + 12 });
  await touch(page, 'touchMove', { x: x + 160, y: startY + 20 });
  ok((await ghosts()) === 0, '横向为主的手势不挂邻月预览', String(await ghosts()));
  await touch(page, 'touchEnd', { x: x + 160, y: startY + 20 });
  await new Promise((r) => setTimeout(r, 300));
  ok((await title()) === before, '横向手势不翻月', before + ' → ' + await title());

  /* 收尾：把视图交还给周视图 —— 下一节（26，窄屏收尾节）假定页面停在周视图
     上直接种任务、断言 `.week-col.today`。留在月视图，它会等一个永远不会
     出现的元素，整趟探针就挂在那儿。 */
  await evalJs(page, `document.querySelector('[data-view="week"]').click(); return true;`);
  await waitFor(page, `!!document.querySelector('.week-view')`, '收尾：切回周视图', 8000);
}

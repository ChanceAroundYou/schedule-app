/**
 * geom/10-month-cols.mjs —— 月视图 7 列必须**严格均分**（2026-11-06 用户报障）
 *
 * 症状：某一天里有一条超长任务名，那一列被撑到 559px、其余 6 列只剩 71px。
 *
 * 根因是 `grid-template-columns: repeat(7, 1fr)` —— 裸 `1fr` 的最小值是 **auto**
 * （= min-content），格子的内容能把它顶宽。改成 `minmax(0, 1fr)` 之后最小值是 0，
 * 7 列只按容器宽度分。
 *
 * 这个探针**故意造一条超长标题**再量：没有长内容时两种写法看起来一模一样，
 * 断言等于没写。造完自己删干净（用一次性专用集，成败都收）。
 */
export async function run(ctx) {
  const { page } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, apiCall, apiPort } = helpers;
  const ok = ctx.ok;

  console.log('\n十、月视图 7 列严格均分（长标题不许撑列）');

  const token = await evalJs(page, `return localStorage.getItem('schedule-app-token');`);
  const me = await apiCall(apiPort, 'GET', '/me', { token });
  const calId = (me.body && me.body.cals && me.body.cals[0] && me.body.cals[0].id) || null;
  if (!calId) { ok(false, '拿不到日程集，跳过（' + JSON.stringify(me.body).slice(0, 120) + '）'); return; }

  const LONG = '粘贴包给星星包发工资42000这份备注非常非常长而且没有任何空格用来测试列宽';
  let taskId = null;
  try {
    taskId = await evalJs(page, `return window.__probeLong || null;`);
    const now = Date.now();
    const id = 't_probe_cols_' + now;
    const iso = await evalJs(page, `return (() => { const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-06'; })()`);
    const r = await apiCall(apiPort, 'POST', '/sync', {
      token,
      body: {
        deviceId: 'probe-cols',
        ops: [{
          opId: 'op-cols-' + now, deviceId: 'probe-cols', calId, entity: 'task', entityId: id, ts: now,
          fields: {
            title: LONG, date: iso, time: null, duration: null, done: false, doneAt: null,
            repeat: { unit: 'none', n: 1, weekdays: [], monthday: 1, yearMonth: 1, end: null },
            seriesId: null,
          },
        }],
      },
    });
    ok(r.status === 200, '造一条超长标题的任务（200）', String(r.status));
    taskId = id;

    /* 造完必须**让它进本地库**：探针是直接 POST /api/sync 的，客户端那份
       state 还停在旧数据，界面上永远等不到这条。切一下页面 / 触发一次同步兜住。 */
    await evalJs(page, `return (() => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      return true;
    })()`);
    await new Promise((r2) => setTimeout(r2, 1500));

    /* 切到月视图，等这一条真的渲染出来 */
    /* card-geometry 的 helpers 里没有 clickEl（那是 browser-smoke 的），
       直接程序点击 —— 这里验的是布局，不是点击链路。 */
    await evalJs(page, `return (() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '月');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await waitFor(page, `!!document.querySelector('.month-grid')`, '月视图渲染出来', 8000);
    await waitFor(page, `[...document.querySelectorAll('.pill-title')].some(
      (e) => (e.textContent || '').includes('粘贴包给星星包'))`, '超长标题那条出现在月视图', 8000);
    await new Promise((r2) => setTimeout(r2, 300));

    const cols = await evalJs(page, `return (() => {
      const cells = [...document.querySelectorAll('.month-grid .month-cell')].slice(0, 7)
        .map((c) => Math.round(c.getBoundingClientRect().width * 100) / 100);
      const heads = [...document.querySelectorAll('.month-head > *')].slice(0, 7)
        .map((c) => Math.round(c.getBoundingClientRect().width * 100) / 100);
      return { cells, heads };
    })()`);

    const spread = (a) => (a.length ? Math.max(...a) - Math.min(...a) : -1);
    ok(cols.cells.length === 7, '量到了 7 格', JSON.stringify(cols.cells));
    /* 允许 1px 的亚像素余量：容器宽度除不尽 7 时各列会差一点点，这是正常的 */
    ok(spread(cols.cells) <= 1.5,
      '有超长标题时 7 列仍然严格均分（极差 ≤ 1.5px）', JSON.stringify(cols.cells));
    ok(spread(cols.heads) <= 1.5,
      '表头那 7 格同样均分（表头与网格不能各算各的）', JSON.stringify(cols.heads));

    /* 超长标题必须在格内被省略号收掉，不能溢出格子 */
    const overflow = await evalJs(page, `return (() => {
      const el = [...document.querySelectorAll('.pill-title')].find(
        (e) => (e.textContent || '').includes('粘贴包给星星包'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cell = el.closest('.month-cell');
      const cr = cell ? cell.getBoundingClientRect() : null;
      return { titleW: Math.round(r.width), cellW: cr ? Math.round(cr.width) : null,
        right: Math.round(r.right), cellRight: cr ? Math.round(cr.right) : null,
        scrollW: Math.round(el.scrollWidth) };
    })()`);
    ok(!!overflow && overflow.right <= overflow.cellRight + 1,
      '超长标题没有溢出格子（ellipsis 收住）', JSON.stringify(overflow));
    ok(!!overflow && overflow.scrollW > overflow.titleW,
      '确实是「被截断」而不是「格子被撑宽到刚好装下」', JSON.stringify(overflow));
  } finally {
    /* 收尾：删掉这条探针任务（墓碑），成败都删 */
    if (taskId) {
      const now = Date.now();
      const r = await apiCall(apiPort, 'POST', '/sync', {
        token,
        body: {
          deviceId: 'probe-cols',
          ops: [{
            opId: 'op-cols-del-' + now, deviceId: 'probe-cols', calId, entity: 'task', entityId: taskId, ts: now,
            fields: { deleted: true, deletedAt: now },
          }],
        },
      });
      ok(r.status === 200, '收尾：探针任务已删除（墓碑）', String(r.status));
    }
  }
}
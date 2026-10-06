/* 主控：渲染调度、交互事件、抽屉、弹窗、导入导出、快捷键 */
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  var content = $('#content');
  var ui = null;
  var drawerTaskId = null;
  var dragId = null;
  var dragEl = null;      /* 被拖的 DOM 元素（让位时要绕开它） */
  var dragKind = 'task';  /* task | habit —— 两者字段不同，落库走不同接口 */
  var dragGrabY = 0;   /* 按下位置相对方块顶部的偏移，保证「方块顶部」对应落点时间 */
  var dropRef = null;
  var pendingTime = null;
  var resizing = null;
  var justResized = false;
  var toastTimer = null;

  var UI = {};

  /* ================= 渲染调度 ================= */

  function renderAll() {
    ui = DB.state.ui;
    renderSidebar();
    renderTopbar();
    Views.beforeRender();
    content.innerHTML = Views.render();
    Views.afterRender();
    updateFastAdd();
  }
  UI.render = renderAll;

  function renderSidebar() {
    var c = DB.counts();
    setCount('inbox', c.inbox);
    setCount('today', c.today);
    setCount('overdue', c.overdue);
    setCount('trash', c.trash);
    setCount('habits', c.habits);

    $$('.nav-item').forEach(function (b) {
      b.classList.toggle('active', b.dataset.nav === ui.nav);
    });

    var tip = $('#sideTip');
    if (tip && DB.state.archive) {
      tip.textContent = '旧备忘录已归档，导出备份时会一起带上';
    }

    renderPulse();
    renderTabbar();
  }

  /** 窄屏判定：≤900px。侧栏在这个宽度以下收进「更多」抽屉，导航改走底部标签栏 */
  function isNarrow() { return window.matchMedia('(max-width: 900px)').matches; }

  /** 底部标签栏：只放 4 个高频入口 + 「更多」，其余功能在「更多」抽屉里 */
  function renderTabbar() {
    var bar = $('#tabbar');
    if (!bar) return;
    var narrow = isNarrow();
    bar.hidden = !narrow;
    document.body.classList.toggle('narrow', narrow);
    if (!narrow) { closeMore(); return; }

    $$('.tab', bar).forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab && b.dataset.tab === ui.nav);
    });
    /* 「更多」在当前页时也高亮，提示抽屉里有内容 */
    var more = $('.tab[data-more]', bar);
    if (more) more.classList.toggle('active', ['habits', 'done', 'trash'].indexOf(ui.nav) >= 0);

    var c = DB.counts();
    setBadge('today', c.today);
    setBadge('inbox', c.inbox);
    setBadge('overdue', c.overdue);
  }

  function setBadge(k, n) {
    var el = $('.tabbar [data-badge="' + k + '"]');
    if (el) el.textContent = n > 99 ? '99+' : (n || '');
  }

  /** 侧栏底部：今日完成进度，切到任何视图都能看见 */
  function renderPulse() {
    var el = $('#sidePulse');
    if (!el) return;
    var t = U.today();
    var todayAll = DB.state.tasks.filter(function (x) { return x.date === t; });
    var undone = todayAll.filter(function (x) { return !x.done; }).length;
    var done = todayAll.length - undone;
    var over = DB.state.tasks.filter(function (x) { return !x.done && x.date && x.date < t; }).length;
    var pct = todayAll.length ? Math.round(done / todayAll.length * 100) : 0;

    el.className = 'side-pulse' + (todayAll.length && !undone ? ' all-done' : '');
    el.innerHTML = '<div class="sp-head"><span class="sp-title">今日进度</span>'
      + '<span class="sp-num"><b>' + done + '</b>/' + todayAll.length + '</span></div>'
      + '<div class="sp-bar"><i style="width:' + pct + '%"></i></div>'
      + '<div class="sp-foot">'
      + (todayAll.length
        ? (undone ? '还剩 ' + undone + ' 件' : '今天清空了 🎉')
        : '今天还没有安排')
      + (over ? '<span class="sp-over">逾期 ' + over + '</span>' : '')
      + '</div>';
  }

  function setCount(key, n) {
    var el = $('[data-count="' + key + '"]');
    if (!el) return;
    el.textContent = n ? n : '';
    el.style.display = n ? '' : 'none';
  }

  function renderTopbar() {
    var cursor = ui.cursor;
    var isCal = ui.nav === 'calendar';
    $('#dateNav').style.display = isCal ? '' : 'none';
    $('#viewSwitch').style.display = isCal ? '' : 'none';

    var title = '今天';
    var range = '';
    if (ui.nav === 'inbox') title = '待办箱';
    else if (ui.nav === 'overdue') { title = '逾期'; range = '没做完的，重新安排一下'; }
    else if (ui.nav === 'done') title = '已完成';
    else if (ui.nav === 'trash') title = '垃圾箱';
    else if (ui.nav === 'habits') { title = '打卡'; range = '坚持每天的小事'; }
    else if (ui.nav === 'today') { title = '今天'; range = U.fmtFull(U.today()); }
    else if (ui.view === 'day') { title = U.fmtMD(cursor); range = U.fmtFull(cursor); }
    else if (ui.view === 'week') {
      var s = U.weekStart(cursor), e = U.addDays(s, 6);
      title = U.parse(s).getFullYear() + '年' + (U.parse(s).getMonth() + 1) + '月';
      range = U.fmtMD(s) + ' - ' + U.fmtMD(e);
    } else {
      var d = U.parse(cursor);
      title = d.getFullYear() + '年' + (d.getMonth() + 1) + '月';
      range = '第 ' + weekOfMonth(cursor) + ' 周';
    }
    $('#viewTitle').textContent = title;
    $('#dateRange').textContent = range;

    /* 「今天」按钮跟着当前光标走：
       在今天/week/month 就只作一个安静的标签，离开之后才亮起来，变成「回到今天」 */
    var btn = $('#todayBtn');
    if (isCal) {
      var atToday = cursor === U.today();
      if (ui.view === 'week') atToday = U.weekStart(cursor) === U.weekStart(U.today());
      else if (ui.view === 'month') {
        var c = U.parse(cursor), t0 = U.parse(U.today());
        atToday = c.getFullYear() === t0.getFullYear() && c.getMonth() === t0.getMonth();
      }
      btn.classList.toggle('away', !atToday);
      btn.textContent = atToday ? '今天' : '回到今天';
      btn.title = atToday ? '当前就在今天' : '跳回今天';
    }

    $$('#viewSwitch button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === ui.view);
    });
    /* 面板开着时，任务的增减要让圆点密度跟着变 */
    if (jumpOpen) renderJump();
    $('#fastAdd').style.display = (ui.nav === 'trash') ? 'none' : '';
  }

  function weekOfMonth(iso) {
    var d = U.parse(iso);
    var first = U.parse(U.monthStart(iso));
    var offset = (first.getDay() === 0 ? 7 : first.getDay()) - 1;
    return Math.floor((d.getDate() + offset) / 7) + 1;
  }

  function updateFastAdd() {
    var ph = '添加任务，可以直接写「明天下午3点 交周报 2小时」';
    if (ui.nav === 'inbox') ph = '丢进待办箱，不设日期（写了日期则以写的为准）';
    else if (ui.nav === 'today') ph = '添加到今天，也可以写「后天上午 给导师发邮件」';
    else if (ui.nav === 'overdue') ph = '新建任务，默认排到今天';
    else if (ui.nav === 'calendar') ph = '添加到 ' + U.fmtMD(ui.cursor) + '，写了日期就按写的来';
    else if (ui.nav === 'done') ph = '新建任务，回车保存';
    $('#fastInput').placeholder = ph;
    $('#fastClock').classList.toggle('set', !!pendingTime);
    var hint = $('#fastAdd .fast-hint');
    if (hint) hint.textContent = pendingTime ? ('时间 ' + pendingTime + ' · 再点 🕐 可改') : 'Ctrl + Enter 打开详细设置';
  }

  $('#fastClock').onclick = function () {
    Clock.open($('#fastClock'), pendingTime, function (v) {
      pendingTime = v;
      updateFastAdd();
    });
  };

  /* ================= toast ================= */

  UI.toast = function (msg, actionLabel, onAction) {
    var el = $('#toast');
    el.innerHTML = '<span>' + U.esc(msg) + '</span>'
      + (actionLabel ? '<button id="toastAct">' + U.esc(actionLabel) + '</button>' : '');
    el.classList.add('show');
    if (actionLabel) {
      $('#toastAct').onclick = function () {
        hideToast();
        if (onAction) onAction();
      };
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, actionLabel ? 5000 : 2200);
  };
  function hideToast() { $('#toast').classList.remove('show'); }

  /* ================= 任务抽屉 ================= */

  function openDrawer(id, opts) {
    var t = DB.taskById(id);
    if (!t) return;
    drawerTaskId = id;
    $('#dTitle').value = t.title;
    $('#dDone').checked = !!t.done;
    $('#dDate').value = t.date || '';
    setTimeView(t.time);
    $('#dDuration').value = t.duration || 60;
    $('#dRepeat').value = (t.repeat && t.repeat.unit) || 'none';
    $('#dNote').value = t.note || '';
    renderRepeatPanel();
    $('#dMeta').textContent = '创建于 ' + new Date(t.createdAt).toLocaleString('zh-CN');
    $('#drawer').classList.add('open');
    $('#mask').classList.add('show');
    if (!opts || !opts.keepFocus) setTimeout(function () { $('#dTitle').focus(); }, 60);
  }
  UI.openDrawer = openDrawer;

  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#mask').classList.remove('show');
    drawerTaskId = null;
  }

  /* ================= 时间：时钟选择器 ================= */

  function setTimeView(v) {
    var btn = $('#dTime');
    btn.querySelector('.tt-text').textContent = v || '设置时间';
    btn.classList.toggle('set', !!v);
  }

  /* ================= 重复：自定义规则 ================= */

  var UNIT_NAME = { day: '天', week: '周', month: '个月', year: '年' };

  function saveRepeat(patch) {
    var t = DB.taskById(drawerTaskId);
    if (!t) return;
    var r = U.toRepeat(t.repeat, t.date);
    Object.keys(patch).forEach(function (k) { r[k] = patch[k]; });
    DB.updateTask(drawerTaskId, { repeat: r });
    renderAll();
    renderRepeatPanel();
  }

  function renderRepeatPanel() {
    var t = DB.taskById(drawerTaskId);
    var box = $('#dRepeatPanel');
    if (!t || !t.repeat || t.repeat.unit === 'none') { box.hidden = true; box.innerHTML = ''; return; }
    var r = t.repeat;
    box.hidden = false;

    var unitOpts = ['day', 'week', 'month', 'year'].map(function (u) {
      return '<option value="' + u + '"' + (r.unit === u ? ' selected' : '') + '>' + UNIT_NAME[u] + '</option>';
    }).join('');

    var html = '<div class="rp-row">'
      + '<span class="rp-l">每</span>'
      + '<input type="number" id="rpN" min="1" max="99" value="' + Math.max(1, r.n || 1) + '">'
      + '<select id="rpUnit">' + unitOpts + '</select>'
      + '</div>';

    if (r.unit === 'week') {
      var wd = (r.weekdays && r.weekdays.length) ? r.weekdays : [U.weekdayOf(t.date || U.today())];
      html += '<div class="rp-row"><span class="rp-l">星期</span><div class="rp-chips">'
        + [1, 2, 3, 4, 5, 6, 0].map(function (d) {
          return '<button class="chip tiny' + (wd.indexOf(d) >= 0 ? ' active' : '') + '" data-wd="' + d + '">'
            + ['日', '一', '二', '三', '四', '五', '六'][d] + '</button>';
        }).join('') + '</div></div>';
    }

    if (r.unit === 'month') {
      html += '<div class="rp-row"><span class="rp-l">每月</span>'
        + '<input type="number" id="rpMonthDay" min="1" max="31" value="' + (r.monthday || 1) + '">'
        + '<span class="rp-tail">号，当月没这天就取最后一天</span></div>';
    }

    var endType = r.end ? r.end.type : 'never';
    html += '<div class="rp-row"><span class="rp-l">结束</span>'
      + '<select id="rpEnd">'
      + '<option value="never"' + (endType === 'never' ? ' selected' : '') + '>永不</option>'
      + '<option value="date"' + (endType === 'date' ? ' selected' : '') + '>到指定日期</option>'
      + '<option value="count"' + (endType === 'count' ? ' selected' : '') + '>重复几次后停</option>'
      + '</select>';
    if (endType === 'date') html += '<input type="date" id="rpEndDate" value="' + (r.end.date || '') + '">';
    else if (endType === 'count') html += '<input type="number" id="rpEndCount" min="1" max="999" value="' + (r.end.count || 1) + '">';
    html += '</div>';

    html += '<div class="rp-preview">↻ ' + U.esc(U.repeatLabel(r)) + '</div>';
    box.innerHTML = html;

    var nI = $('#rpN');
    if (nI) nI.onchange = function () { saveRepeat({ n: Math.max(1, Math.min(99, +nI.value || 1)) }); };
    var uI = $('#rpUnit');
    if (uI) uI.onchange = function () {
      var nt = DB.taskById(drawerTaskId);
      saveRepeat({
        unit: uI.value,
        weekdays: uI.value === 'week' ? [U.weekdayOf((nt && nt.date) || U.today())] : []
      });
    };
    var mdI = $('#rpMonthDay');
    if (mdI) mdI.onchange = function () { saveRepeat({ monthday: Math.max(1, Math.min(31, +mdI.value || 1)) }); };
    var eI = $('#rpEnd');
    if (eI) eI.onchange = function () {
      var v = eI.value;
      saveRepeat({ end: v === 'never' ? null : (v === 'date' ? { type: 'date', date: U.addDays(U.today(), 30) } : { type: 'count', count: 5 }) });
    };
    var edI = $('#rpEndDate');
    if (edI) edI.onchange = function () { saveRepeat({ end: { type: 'date', date: edI.value || null } }); };
    var ecI = $('#rpEndCount');
    if (ecI) ecI.onchange = function () { saveRepeat({ end: { type: 'count', count: Math.max(1, +ecI.value || 1) } }); };
    Array.prototype.slice.call(box.querySelectorAll('[data-wd]')).forEach(function (b) {
      b.onclick = function () {
        var d = +b.dataset.wd;
        var cur = (r.weekdays && r.weekdays.length) ? r.weekdays.slice() : [U.weekdayOf(t.date || U.today())];
        var i = cur.indexOf(d);
        if (i >= 0) { if (cur.length > 1) cur.splice(i, 1); }
        else cur.push(d);
        saveRepeat({ weekdays: cur });
      };
    });
  }

  /* ================= 新建任务 ================= */

  function defaultDate() {
    if (ui.nav === 'inbox') return null;
    if (ui.nav === 'today' || ui.nav === 'done') return U.today();
    /* 在逾期页新建的，默认先安排到今天，别又立刻变成逾期 */
    if (ui.nav === 'overdue') return U.today();
    return ui.cursor;
  }

  function createTask(title, extra) {
    var data = { title: title, date: defaultDate() };
    if (extra) Object.keys(extra).forEach(function (k) { data[k] = extra[k]; });
    var t = DB.addTask(data);
    renderAll();
    return t;
  }

  /* ================= 事件：侧栏 ================= */

  $('#nav').addEventListener('click', function (e) {
    var b = e.target.closest('[data-nav]');
    if (!b || navJustDragged) return;
    ui.nav = b.dataset.nav;
    if (ui.nav === 'calendar' && ui.cursor !== U.today() && ui.view !== 'month') ui.cursor = U.today();
    renderAll();
  });
  $('#navBottom').addEventListener('click', function (e) {
    var b = e.target.closest('[data-nav]');
    if (!b || navJustDragged) return;
    ui.nav = b.dataset.nav;
    renderAll();
  });

  /* ================= 侧栏导航可拖动排序 ================= */

  var sidebar = $('.sidebar');
  var navDragKey = null;      /* 正在拖动的 nav key */
  var navJustDragged = false; /* 拖完不要顺带触发点击切页 */

  /** 按 ui.navOrder / ui.navBottom 重排 DOM，只在启动和拖完后调用 */
  function applyNavOrder() {
    var order = (ui.navOrder && ui.navOrder.length) ? ui.navOrder : ['inbox', 'today', 'overdue', 'calendar', 'habits', 'done', 'trash'];
    var main = $('#nav'), bottom = $('#navBottom');
    var pool = {};
    $$('.nav-item').forEach(function (el) { pool[el.dataset.nav] = el; });
    order.forEach(function (k) {
      var el = pool[k];
      if (!el) return;
      delete pool[k];
      if (ui.navBottom && ui.navBottom.indexOf(k) >= 0) bottom.appendChild(el);
      else main.appendChild(el);
    });
    /* 兜底：新加的导航项直接进主区 */
    Object.keys(pool).forEach(function (k) { main.appendChild(pool[k]); });
  }

  /** 从 DOM 现状反推顺序并落盘 */
  function saveNavOrder() {
    var order = [];
    var bottom = $$('#navBottom .nav-item').map(function (el) {
      order.push(el.dataset.nav);
      return el.dataset.nav;
    });
    $$('#nav .nav-item').forEach(function (el) { order.push(el.dataset.nav); });
    ui.navOrder = order;
    ui.navBottom = bottom;
    DB.save();
  }

  sidebar.addEventListener('dragstart', function (e) {
    var el = e.target.closest('.nav-item');
    if (!el) return;
    navDragKey = el.dataset.nav;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', navDragKey); } catch (err) {}
    el.classList.add('nav-dragging');
  });

  sidebar.addEventListener('dragover', function (e) {
    if (!navDragKey) return;
    var zone = e.target.closest('.nav');
    if (!zone) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    var src = document.querySelector('.nav-item[data-nav="' + navDragKey + '"]');
    if (!src) return;

    /* 找落点：鼠标在目标上半区就插到它前面，下半区插到后面 */
    var items = $$('.nav-item', zone).filter(function (x) { return x !== src; });
    var ref = null;
    for (var i = 0; i < items.length; i++) {
      var r = items[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { ref = items[i]; break; }
    }
    if (ref) zone.insertBefore(src, ref);
    else zone.appendChild(src);

    /* 只画一条细插入线表示落点，不给整片底色 */
    $$('.nav-ins').forEach(function (x) { x.remove(); });
    var line = document.createElement('div');
    line.className = 'nav-ins';
    if (ref) zone.insertBefore(line, ref);
    else zone.appendChild(line);
  });

  sidebar.addEventListener('dragleave', function (e) {
    var zone = e.target.closest('.nav');
    if (zone && !zone.contains(e.relatedTarget)) {
      zone.classList.remove('nav-drop');
      $$('.nav-ins').forEach(function (x) { x.remove(); });
    }
  });

  sidebar.addEventListener('drop', function (e) {
    if (!navDragKey) return;
    e.preventDefault();
    $$('.nav-ins').forEach(function (x) { x.remove(); });
    saveNavOrder();
  });

  sidebar.addEventListener('dragend', function () {
    if (!navDragKey) return;
    navJustDragged = true;
    navDragKey = null;
    $$('.nav-dragging').forEach(function (x) { x.classList.remove('nav-dragging'); });
    $$('.nav-ins').forEach(function (x) { x.remove(); });
    $$('.nav-drop').forEach(function (x) { x.classList.remove('nav-drop'); });
    saveNavOrder();
    renderAll();
    /* 浏览器有时会在 dragend 后补一次 click，忽略掉 */
    setTimeout(function () { navJustDragged = false; }, 0);
  });

  /* ================= 事件：顶栏 ================= */

  function shift(n) {
    if (ui.view === 'day') ui.cursor = U.addDays(ui.cursor, n);
    else if (ui.view === 'week') ui.cursor = U.addDays(ui.cursor, n * 7);
    else ui.cursor = U.addMonths(ui.cursor, n);
    if (jumpOpen) { jumpMonth = U.monthStart(ui.cursor); renderJump(); }
    renderAll();
  }
  $('#prevBtn').onclick = function () { shift(-1); };
  $('#nextBtn').onclick = function () { shift(1); };
  $('#todayBtn').onclick = function () {
    ui.cursor = U.today();
    if (ui.nav !== 'calendar') ui.nav = 'today';
    closeJump();
    renderAll();
  };
  $('#viewSwitch').addEventListener('click', function (e) {
    var b = e.target.closest('[data-view]');
    if (!b) return;
    ui.view = b.dataset.view;
    ui.nav = 'calendar';
    closeJump();
    renderAll();
  });

  /* ================= 顶栏：找日期 =================
     有了 ‹ › 只能一天天挪，跨月跨年就得点几十下。这里给一个日历面板，
     直接挑一天；下面的输入框还能直接敲「10月15日」「下周三」这类话。 */

  var jumpOpen = false;
  var jumpMonth = null;   /* 面板当前翻到的月份（存该月任意一天即可） */

  /** 把用户敲的文本解析成 iso 日期，认不出来返回 null */
  function mkDate(y, mo, d) {
    if (!(y >= 1970 && y <= 2999)) return null;
    if (mo < 1 || mo > 12) return null;
    var last = new Date(y, mo, 0).getDate();
    if (d < 1 || d > 31) return null;
    return U.iso(new Date(y, mo - 1, Math.min(d, last)));
  }

  function parseJumpText(raw, baseIso) {
    var s = String(raw == null ? '' : raw).trim().replace(/\s+/g, '');
    if (!s) return null;
    var today = U.today();
    var base = U.parse(baseIso || today);
    var y = base.getFullYear();
    var m;

    /* ---- 相对说法：今天 / 明天 / 3 天后 ---- */
    if (/^(今天|今日|今|当天)$/.test(s)) return today;
    if (/^(昨天|昨日)$/.test(s)) return U.addDays(today, -1);
    if (/^前天$/.test(s)) return U.addDays(today, -2);
    if (/^(明天|明日)$/.test(s)) return U.addDays(today, 1);
    if (/^后天$/.test(s)) return U.addDays(today, 2);
    if (/^(大后天)$/.test(s)) return U.addDays(today, 3);
    if ((m = s.match(/^(\d+)天(后|後|前)$/))) {
      return m[2] === '前' ? U.addDays(today, -(+m[1])) : U.addDays(today, +m[1]);
    }

    /* ---- 周几：下周三 / 本周五 / 周一 ---- */
    if ((m = s.match(/^(下下|下|本|这)?(?:周|星期|礼拜)([一二三四五六日天1-7])?$/))) {
      var off = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }[m[2] || '一'];
      if (m[2] && /^[1-7]$/.test(m[2])) off = (+m[2]) - 1;
      var ws = U.weekStart(today);
      if (m[1] === '下') ws = U.addDays(ws, 7);
      else if (m[1] === '下下') ws = U.addDays(ws, 14);
      return U.addDays(ws, off);
    }

    /* ---- 月份偏移：下个月 / 上个月 / 本月 ---- */
    if (/^(下下个?月)$/.test(s)) return U.monthStart(U.addMonths(today, 2));
    if (/^(下个?月|下月)$/.test(s)) return U.monthStart(U.addMonths(today, 1));
    if (/^(这个?月|本月|当月)$/.test(s)) return U.monthStart(today);
    if (/^(上个?月|上月)$/.test(s)) return U.monthStart(U.addMonths(today, -1));

    /* ---- 完整日期 ---- */
    /* 2026-10-15 / 2026/10/15 / 2026.10.15 / 2026年10月15日 */
    if ((m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/))) return mkDate(+m[1], +m[2], +m[3]);
    /* 20261015 */
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return mkDate(+m[1], +m[2], +m[3]);
    /* 2026-10 / 2026年10月 / 202610 → 那个月的 1 号 */
    if ((m = s.match(/^(\d{4})[-/.年](\d{1,2})月?$/))) return mkDate(+m[1], +m[2], 1);
    if ((m = s.match(/^(\d{4})(\d{2})$/))) return mkDate(+m[1], +m[2], 1);

    /* ---- 只给月日：年份沿用面板当前所在的月 ---- */
    /* 10月15日 / 10-15 / 10/15 / 10.15 */
    if ((m = s.match(/^(\d{1,2})[-/.月](\d{1,2})日?$/))) return mkDate(y, +m[1], +m[2]);
    /* 1015 → 10月15日。月份必须合法，否则 2026 这种纯年份会被它吃掉 */
    if ((m = s.match(/^(\d{2})(\d{2})$/)) && +m[1] >= 1 && +m[1] <= 12) return mkDate(y, +m[1], +m[2]);
    /* 10月 / 10 → 那个月的 1 号 */
    if ((m = s.match(/^(\d{1,2})月?$/))) return mkDate(y, +m[1], 1);
    /* 2026 → 那年 1 月 1 日 */
    if ((m = s.match(/^(\d{4})$/))) return mkDate(+m[1], 1, 1);
    return null;
  }

  /** 某天还没完成的任务数，面板上用圆点密度表示「哪天忙」 */
  function jumpLoad(iso) {
    var n = 0;
    for (var i = 0; i < DB.state.tasks.length; i++) {
      var t = DB.state.tasks[i];
      if (t.date === iso && !t.done) n++;
    }
    return n;
  }

  function renderJump() {
    if (!jumpMonth) jumpMonth = ui.cursor;
    var d = U.parse(jumpMonth);
    $('#jpLabel').textContent = d.getFullYear() + '年' + (d.getMonth() + 1) + '月';

    var today = U.today();
    var cells = U.monthMatrix(jumpMonth);
    var html = '';
    for (var i = 0; i < cells.length; i++) {
      var iso = cells[i];
      var out = U.monthStart(iso) !== U.monthStart(jumpMonth);
      var n = jumpLoad(iso);
      var cls = 'jp-cell';
      if (out) cls += ' out';
      if (iso === today) cls += ' today';
      if (iso === ui.cursor) cls += ' cur';
      if (n) cls += ' has' + (n >= 6 ? ' lv3' : n >= 3 ? ' lv2' : '');
      html += '<button class="' + cls + '" data-jump="' + iso + '" title="'
        + U.fmtFull(iso) + ' · ' + (n ? n + ' 项待办' : '空闲') + '">'
        + U.parse(iso).getDate() + '</button>';
    }
    $('#jpGrid').innerHTML = html;
  }

  function openJump() {
    jumpOpen = true;
    jumpMonth = ui.cursor;
    $('#jumpPop').hidden = false;
    $('#jumpBtn').classList.add('on');
    $('#jpInput').value = '';
    $('#jpBad').hidden = true;
    renderJump();
  }

  function closeJump() {
    if (!jumpOpen) return;
    jumpOpen = false;
    $('#jumpPop').hidden = true;
    $('#jumpBtn').classList.remove('on');
  }

  /** 跳到指定的一天。日 / 周 / 月视图都只改 cursor，各自会定位到那天所在的那格 */
  function jumpTo(iso) {
    ui.cursor = iso;
    ui.nav = 'calendar';
    ui.search = '';
    $('#searchInput').value = '';
    $('#clearSearch').hidden = true;
    closeJump();
    renderAll();
  }

  function submitJump() {
    var v = $('#jpInput').value;
    var iso = parseJumpText(v, jumpMonth || ui.cursor);
    if (!iso) {
      $('#jpBad').hidden = false;
      $('#jpBad').textContent = '认不出这个日期，试试「10月15日」「下周三」「2026-10-15」';
      return;
    }
    jumpTo(iso);
  }

  $('#jumpBtn').addEventListener('click', function () {
    if (jumpOpen) { closeJump(); return; }
    openJump();
  });
  $('#jpPrev').addEventListener('click', function () {
    jumpMonth = U.monthStart(U.addMonths(jumpMonth || ui.cursor, -1));
    renderJump();
  });
  $('#jpNext').addEventListener('click', function () {
    jumpMonth = U.monthStart(U.addMonths(jumpMonth || ui.cursor, 1));
    renderJump();
  });
  $('#jpGo').addEventListener('click', submitJump);
  $('#jpInput').addEventListener('input', function () { $('#jpBad').hidden = true; });
  $('#jpInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submitJump(); }
    if (e.key === 'Escape') { e.stopPropagation(); closeJump(); $('#jumpBtn').focus(); }
  });
  $('#jpGrid').addEventListener('click', function (e) {
    var b = e.target.closest('[data-jump]');
    if (b) jumpTo(b.dataset.jump);
  });
  /* 点面板外面就收起。放在 capture 上，避免面板内输入框的 blur 先把它关掉 */
  document.addEventListener('mousedown', function (e) {
    if (!jumpOpen) return;
    if (e.target.closest('.jump-wrap')) return;
    closeJump();
  }, true);

  var searchTimer = null;
  $('#searchInput').addEventListener('input', function (e) {
    var v = e.target.value.trim();
    $('#clearSearch').hidden = !v;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      ui.search = v;
      renderAll();
    }, 200);
  });
  $('#clearSearch').onclick = function () {
    $('#searchInput').value = '';
    $('#clearSearch').hidden = true;
    ui.search = '';
    renderAll();
  };

  $('#themeBtn').onclick = function () {
    toggleTheme();
  };
  function toggleTheme() {
    ui.theme = ui.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    DB.save();
  }
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', ui.theme || 'light');
    $('#themeBtn').textContent = ui.theme === 'dark' ? '☀️' : '🌙';
    var ico = $('#msThemeIco');
    if (ico) ico.textContent = ui.theme === 'dark' ? '☀️' : '🌙';
    var mt = $('#msTheme .mt');
    if (mt) mt.textContent = ui.theme === 'dark' ? '浅色' : '深色';
  }

  /* ================= 窄屏：底部标签栏 + 更多抽屉 + 长按操作 ================= */

  /* ---- 更多抽屉 ---- */

  function openMore() {
    /* 侧栏里的今日进度搬过来，窄屏也看得见进度 */
    var pulse = $('#sidePulse');
    var mp = $('#msPulse');
    if (pulse && mp) {
      var clone = pulse.cloneNode(true);
      clone.id = '';
      mp.innerHTML = '';
      mp.appendChild(clone);
    }
    $('#moreMask').hidden = false;
    $('#moreSheet').hidden = false;
    document.body.classList.add('sheet-open');
    applyTheme();
  }
  function closeMore() {
    $('#moreMask').hidden = true;
    $('#moreSheet').hidden = true;
    document.body.classList.remove('sheet-open');
  }
  function toggleMore() {
    if ($('#moreSheet').hidden) openMore(); else closeMore();
  }

  $('#tabbar').addEventListener('click', function (e) {
    var b = e.target.closest('.tab');
    if (!b) return;
    if (b.dataset.more) { toggleMore(); return; }
    if (!b.dataset.tab) return;
    ui.nav = b.dataset.tab;
    if (ui.nav === 'today') ui.cursor = U.today();
    closeMore();
    renderAll();
  });
  $('#moreMask').addEventListener('click', closeMore);
  $('#moreSheet').addEventListener('click', function (e) {
    var go = e.target.closest('[data-go]');
    if (go) {
      ui.nav = go.dataset.go;
      closeMore();
      renderAll();
      return;
    }
    if (e.target.closest('#msTheme')) toggleTheme();
    if (e.target.closest('#msExport')) { closeMore(); $('#exportBtn').click(); }
    if (e.target.closest('#msImport')) { closeMore(); $('#importFile').click(); }
  });

  /* ---- 长按操作弹层 ----
     触屏没有 hover，也用不了 HTML5 拖拽：未定时排序、时间轴改时间/改时长
     在手机上全都用不了。长按弹这个层，用「上移/下移」「提前/延后」这些
     明确的动作补齐，比在窄屏上硬塞一套触摸拖拽可靠得多。 */

  var actTaskId = null;
  var longPressTimer = null;
  var longPressFired = false;
  var LONG_PRESS_MS = 480;

  function startLongPress(el) {
    /* 只有窄屏需要；桌面端继续用拖拽 */
    if (!isNarrow()) return;
    var box = el.closest('[data-id]');
    if (!box) return;
    clearLongPress();
    longPressFired = false;
    longPressTimer = setTimeout(function () {
      longPressFired = true;
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { } }
      openActions(box.dataset.id);
    }, LONG_PRESS_MS);
  }
  function clearLongPress() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }

  function openActions(id) {
    var t = DB.taskById(id);
    if (!t) return;
    actTaskId = id;
    $('#asTitle').textContent = t.title;

    var today = U.today();
    var btns = [];
    /* 定时任务给「挪时间」，未定时给「排序」—— 手机上拖不动，得以按钮代替 */
    if (t.time) {
      btns.push(['⏰', '改时间', 'time']);
      btns.push(['⏱', '改时长', 'pickdur']);
    }
    if (t.date !== today) {
      btns.push(['📌', '改到今天', 'today']);
    }
    if (t.date !== U.addDays(today, 1)) {
      btns.push(['🌙', '改到明天', 'tomorrow']);
    }
    if (t.date) {
      btns.push(['⬅️', '提前一天', 'earlier']);
      btns.push(['➡️', '延后一天', 'later']);
    }
    if (!t.time) {
      btns.push(['⬆️', '上移', 'up']);
      btns.push(['⬇️', '下移', 'down']);
    }
    if (!t.date) btns.push(['📅', '定个日期', 'date']);
    btns.push(['🗑', '删除', 'del']);

    renderActionGrid(btns);
    $('#actMask').hidden = false;
    $('#actSheet').hidden = false;
    document.body.classList.add('sheet-open');
  }

  /** 动作按钮组。传入 [[图标, 文案, 动作值]] */
  function renderActionGrid(btns, title) {
    if (title) $('#asTitle').textContent = title;
    $('#asGrid').innerHTML = btns.map(function (b) {
      return '<button class="as-btn' + (b[2] === 'del' ? ' danger' : b[3] ? ' on' : '') + '" data-as="' + b[2] + '">'
        + '<span class="ai">' + b[0] + '</span><span>' + b[1] + '</span></button>';
    }).join('');
  }

  /** 第二层：在已打开的动作层里再选一个时长。用一档一档选，而不是循环切换 */
  function openDurations() {
    var t = DB.taskById(actTaskId);
    if (!t) { closeActions(); return; }
    var steps = [15, 30, 45, 60, 90, 120, 180];
    renderActionGrid(steps.map(function (m) {
      return ['', U.fmtDuration(m), 'dur' + m, (t.duration || 60) === m];
    }), '时长 · ' + t.title);
  }

  function closeActions() {
    actTaskId = null;
    $('#actMask').hidden = true;
    $('#actSheet').hidden = true;
    document.body.classList.remove('sheet-open');
  }

  $('#actMask').addEventListener('click', closeActions);
  $('#asCancel').addEventListener('click', closeActions);
  $('#asGrid').addEventListener('click', function (e) {
    var b = e.target.closest('[data-as]');
    if (!b || !actTaskId) return;
    doAction(b.dataset.as);
  });

  function doAction(kind) {
    var id = actTaskId;
    var t = DB.taskById(id);
    if (!t) { closeActions(); return; }
    var today = U.today();

    /* 时长档位用 'dur60' 这种无歧义前缀。
       不能用 'd60'——'del' / 'date' / 'durlock' 都以 d 开头，
       靠 +slice(1) > 0 去猜必然踩到别的动作上 */
    var mDur = /^dur(\d+)$/.exec(kind);
    if (mDur) {
      DB.updateTask(id, { duration: +mDur[1] });
      openDurations();
      renderAll();
      return;
    }

    if (kind === 'time' || kind === 'date') { openDrawer(id, { keepFocus: true }); return; }
    if (kind === 'pickdur') { openDurations(); return; }

    closeActions();

    if (kind === 'today') DB.updateTask(id, { date: today });
    else if (kind === 'tomorrow') DB.updateTask(id, { date: U.addDays(today, 1) });
    else if (kind === 'earlier') {
      if (!t.date) { UI.toast('先给它定个日期'); return; }
      DB.updateTask(id, { date: U.addDays(t.date, -1) });
    } else if (kind === 'later') {
      if (!t.date) { UI.toast('先给它定个日期'); return; }
      DB.updateTask(id, { date: U.addDays(t.date, 1) });
    } else if (kind === 'del') {
      DB.removeTask(id);
      renderAll();
      UI.toast('已删除', '撤销', function () {
        var last = DB.state.trash[DB.state.trash.length - 1];
        if (last) DB.restoreTrash(last.id);
        renderAll();
      });
      return;
    } else if (kind === 'up' || kind === 'down') {
      moveInList(t, kind === 'up' ? -1 : 1);
    }
    renderAll();
  }

  /** 在同一天（同样有没有时间）的任务里上移/下移一位 */
  function moveInList(t, dir) {
    if (!t.date) { UI.toast('先给它定个日期'); return; }
    /* 注意：候选里**要包含自己**，否则找不到自己的位置，每次都插到最前面 */
    var all = DB.state.tasks.filter(function (x) {
      return !x.done && x.date === t.date && !!x.time === !!t.time;
    }).sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    var list = all.filter(function (x) { return x.id !== t.id; });
    if (!list.length) { UI.toast('这里只有它一个'); return; }

    var i = all.findIndex(function (x) { return x.id === t.id; });
    /*目标位置：下移 = 排在同组的下一条之后；上移 = 排在上一条之前。
       到头了就明确说，不要静默失败 */
    var refIdx = dir < 0 ? i - 1 : i + 1;
    if (i < 0 || refIdx < 0 || refIdx >= list.length) {
      UI.toast(dir < 0 ? '已经是第一个了' : '已经是最后一个了');
      return;
    }
    if (t.time) {
      /* 定时任务之间只调order，保持各自的时间不变 */
      var tmp = t.order;
      t.order = list[refIdx].order + (dir < 0 ? -0.5 : 0.5);
      list[refIdx].order = tmp;
    } else {
      DB.reorderUntimed(t.id, t.date, list[refIdx].id, dir < 0 ? 'before' : 'after');
    }
  }

  /* 长按的触发：pointerdown 计时，位移超过阈值就取消（说明用户是在滚动） */
  content.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse') return;   /* 鼠标交给拖拽 */
    var box = e.target.closest('[data-id]');
    if (!box) return;
    if (e.target.closest('.check-btn') || e.target.closest('.od-btn')) return;
    startLongPress(box);
  }, { passive: true });
  content.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'mouse') return;
    clearLongPress();
  }, { passive: true });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
    content.addEventListener(ev, clearLongPress, { passive: true });
  });
  /* 长按已经生效时，抬手那一下不要再当成点击（否则会顺带打开抽屉详情） */
  content.addEventListener('click', function (e) {
    if (longPressFired) {
      longPressFired = false;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
  }, true);

  /* 切到宽屏时把两个浮层都收掉，避免它们留在屏幕上 */
  window.addEventListener('resize', function () {
    if (!isNarrow()) { closeMore(); closeActions(); }
  });

  /* ================= 事件：内容区 ================= */

  content.addEventListener('click', function (e) {
    if (justResized) { justResized = false; return; }

    /* 「今天已完成」展开 / 收起：只改 class + 记住状态（下次重绘仍然保持展开） */
    var tdHead = e.target.closest('[data-toggle-tdone]');
    if (tdHead) {
      e.stopPropagation();
      var box = tdHead.closest('.today-done');
      if (box) {
        box.classList.toggle('open');
        ui.tdoneOpen = box.classList.contains('open');
        DB.save();
      }
      return;
    }

    var act = e.target.closest('[data-act]');
    if (act) {
      var a = act.dataset.act;
      if (a === 'toggle') {
        e.stopPropagation();
        var tid = act.dataset.id;
        var tt = DB.taskById(tid);
        var el = act.closest('.task-el');
        /* 勾完先播一小段动效再重绘，避免画面瞬跳 */
        if (tt && !tt.done && el) {
          el.classList.add('popping');
          setTimeout(function () {
            DB.toggleDone(tid);
            renderAll();
            /* 没定时间的任务勾完就从日程页让位了，告诉你它去了「今天已完成」，
               否则会以为任务丢了 */
            if (!tt.time && tt.date === U.today()) {
              UI.toast('已完成 · 收进「今天 › 今天已完成」');
            }
          }, 300);
        } else {
          DB.toggleDone(tid);
          renderAll();
        }
        return;
      }
      /* 每日打卡：勾选 / 取消今天的打卡 */
      if (a === 'habit') {
        e.stopPropagation();
        DB.toggleHabit(act.dataset.id);
        renderAll();
        return;
      }
      if (a === 'resize' || a === 'resize-top') return;
    }

    /* 逾期任务：重新安排到某一天，不用打开详情 */
    if (act && (act.dataset.act === 'reschedule' || act.dataset.act === 'pick-date')) {
      e.stopPropagation();
      var rid = act.dataset.id;
      if (act.dataset.act === 'reschedule') {
        DB.updateTask(rid, { date: act.dataset.date });
        renderAll();
        UI.toast('已改到 ' + U.relLabel(act.dataset.date));
      } else {
        /* 「改到…」用一个轻量的日期选择，不走完整抽屉 */
        var inp = document.createElement('input');
        inp.type = 'date';
        inp.value = (DB.taskById(rid) || {}).date || U.today();
        inp.min = U.addDays(U.today(), -365);
        inp.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(inp);
        inp.onchange = function () {
          if (inp.value) {
            DB.updateTask(rid, { date: inp.value });
            renderAll();
            UI.toast('已改到 ' + U.fmtMD(inp.value));
          }
        };
        if (inp.showPicker) { try { inp.showPicker(); } catch (err) { } }
        inp.click();
        setTimeout(function () { inp.remove(); }, 60000);
      }
      return;
    }

    /* 从「今天」顶部的逾期提示跳到逾期列表 */
    var odNav = e.target.closest('.od-strip');
    if (odNav) { ui.nav = 'overdue'; renderAll(); return; }

    /* 恢复 / 彻底删除 */
    var rs = e.target.closest('[data-restore]');
    if (rs) { DB.restoreTrash(rs.dataset.restore); renderAll(); UI.toast('已还原'); return; }
    var pg = e.target.closest('[data-purge]');
    if (pg) {
      if (confirm('彻底删除？无法恢复。')) { DB.removeTrashItem(pg.dataset.purge); renderAll(); }
      return;
    }
    var et = e.target.closest('#emptyTrashBtn');
    if (et) {
      if (confirm('清空垃圾箱？共 ' + DB.state.trash.length + ' 项，删除后无法恢复。')) {
        DB.emptyTrash(); renderAll(); UI.toast('垃圾箱已清空');
      }
      return;
    }

    /* 跳转到某天的日视图 */
    var jump = e.target.closest('[data-jump]');
    if (jump) {
      ui.nav = 'calendar'; ui.view = 'day'; ui.cursor = jump.dataset.jump;
      renderAll();
      return;
    }

    /* 从「今天」打卡条跳到打卡管理页 */
    if (e.target.closest('[data-jump-habits]')) {
      ui.nav = 'habits';
      renderAll();
      return;
    }

    /* 删除习惯 */
    var dh = e.target.closest('[data-del-habit]');
    if (dh) {
      if (confirm('删除这个习惯？打卡记录会一起清空。')) {
        DB.deleteHabit(dh.dataset.delHabit);
        renderAll();
      }
      return;
    }

    /* 添加习惯 */
    var ah = e.target.closest('[data-add-habit]');
    if (ah) {
      var inp = document.getElementById('habitInput');
      var v = inp ? inp.value.trim() : '';
      if (v) { DB.addHabit(v); renderAll(); }
      return;
    }

    /* 点击任务打开抽屉 */
    var taskEl = e.target.closest('.task-el');
    if (taskEl) { openDrawer(taskEl.dataset.id); return; }

    /* 点击日历空白新建 */
    var zone = e.target.closest('[data-drop]');
    if (zone) {
      var kind = zone.dataset.drop;
      if (kind === 'day') {
        openDrawer(createTask('', { date: zone.dataset.date }).id);
        return;
      }
      if (kind === 'timeline') {
        var rect = zone.getBoundingClientRect();
        var min = Math.round((e.clientY - rect.top) / DAY_H * 1440 / 15) * 15;
        openDrawer(createTask('', { date: zone.dataset.date, time: U.minToTime(min) }).id);
        return;
      }
      if (kind === 'week') {
        /* 周视图列内空白：按光标所在时刻新建 */
        var wr = zone.getBoundingClientRect();
        var wmin = Math.round((e.clientY - wr.top) / DAY_H * 1440 / 15) * 15;
        openDrawer(createTask('', { date: zone.dataset.date, time: U.minToTime(Math.max(0, Math.min(1425, wmin))) }).id);
        return;
      }
      if (kind === 'allday') {
        openDrawer(createTask('', { date: zone.dataset.date || ui.cursor, time: null }).id);
        return;
      }
    }
  });

  /* 打卡页：输入框回车即添加习惯 */
  content.addEventListener('keydown', function (e) {
    if (e.target.id === 'habitInput' && e.key === 'Enter') {
      e.preventDefault();
      var v = e.target.value.trim();
      if (v) { DB.addHabit(v); renderAll(); }
    }
  });

  /* ================= 拖拽 ================= */

  content.addEventListener('dragstart', function (e) {
    /* 点在上/下沿拖拽手柄上时，这是「改时间」不是「移动」，取消原生拖动 */
    if (e.target.closest('.ev-resize')) { e.preventDefault(); return; }
    var el = e.target.closest('.task-el, .habit-row');
    if (!el) return;
    /* 触屏上HTML5 拖拽本来就不触发，这里再挡一次：
       免得某些移动浏览器把它模拟成半截行为，按住时页面跟着乱滚 */
    if (isNarrow()) { e.preventDefault(); return; }
    dragId = el.dataset.id;
    dragEl = el;
    /* 习惯和任务是两套实体：习惯排 order，任务排 ord，落库接口不同 */
    dragKind = el.dataset.kind === 'habit' ? 'habit' : 'task';
    e.dataTransfer.setData('text/plain', dragId);
    e.dataTransfer.effectAllowed = 'move';
    dragGrabY = 0;
    /* 时间轴上的方块：用透明拖影 + 自绘预览（方块顶部跟随光标），
       这样落点时间由「方块顶部」决定，而不是方块的中线 */
    if (el.classList.contains('tl-event')) {
      var r = el.getBoundingClientRect();
      dragGrabY = e.clientY - r.top;
      var blank = new Image();
      blank.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      try { e.dataTransfer.setDragImage(blank, 0, 0); } catch (err) { }
      /* 原位置的那块占用底纹让位给方块，不然拖走后会留一块颜色在那里 */
      var busy = document.querySelector('.tl-busy[data-busy="' + dragId + '"]');
      if (busy) busy.classList.add('drag-src');
    }
    el.classList.add('dragging');
    document.body.classList.add('dragging-active');
    /* 新一次拖动：把当前 zone 的原始布局量好存下。
       必须在这里量 —— 此时让位还没开始，量到的是真实位置。
       之后整段拖动过程都复用这份，dragover 里不再重测
       （重测会读到让位后的坐标，落点判定会整体偏掉一格） */
    snapshotLayout(el);
  });

  /* 拖放排序：未定时间的任务可以插到同区域任意位置 */

  function clearDropUI() {
    $$('.ins-line, .ins-bar').forEach(function (x) { x.remove(); });
    $$('.tl-guide').forEach(function (x) { x.remove(); });
    $$('.ins-hl').forEach(function (x) { x.classList.remove('ins-hl'); });
    clearHole();
  }

  /** 结束拖动时清掉「原位置底纹」的标记（drop / dragend 都会走到） */
  function clearBusySrc() {
    $$('.tl-busy.drag-src').forEach(function (x) { x.classList.remove('drag-src'); });
  }

  /* ---------------------------------------------------------------
     落点判定：格子模型
     ---------------------------------------------------------------
     之前的做法是「找一个参照任务 + before/after」，再把线画在那个任务的边缘。
     在多列 grid 里这有两个硬伤：

     1) 参照任务和光标可以差得很远。拖左上角的任务、光标停在左列，
        判定却是「插到 B 之前」，线画到右列去了（实测偏差 568px），
        眼睛和手完全对不上。

     2) 同一个逻辑位置有多种画法。「插到 B 之后」和「插到 C 之前」
        得到的顺序完全一样，线却画在两个地方（右列底部 / 左列顶部），
        鼠标跨过行边界时线会突然跳到另一列 —— 这就是左右拖动老失手的原因。

     换成格子模型：grid 里一共有 N 个格子（含被拖的那个，它仍占着位置），
     而「把任务插到第 k 位」之后，它渲染出来正好落在第 k 个格子。
     所以 N 个格子 ↔ N 个插入位，一一对应，没有二义性：
       k % cols == 0 → 第 k 格是本行第一个 → 横线画在它上沿（换行）
       k % cols != 0 → 第 k 格在行中     → 竖线画在它左沿（左右挪）
     线画在哪，任务就落在哪 —— 指示物和落点终于是一回事。
  */

  /* ---------------------------------------------------------------
     落点判定与让位动画
     ---------------------------------------------------------------
     之前用「静态插入线 + 目标格描边」表示落点，视觉上是对的，
     但拖起来是「刻板」的：线条只在跨过格子边界时才跳一下，
     中间一大段位移完全没有反馈，眼睛得盯着线猜。

     换成让位模型：拖动时其他任务**实时地、平滑地挪开**，
     在光标处留出一个占位洞。落点由「洞在哪」直接表达 ——
     不再用一条线去「暗示」位置，位置本身就是位置。

     关键取舍：不用 FLIP（先量后补 transform）而是直接改 DOM 顺序 +
     CSS transition。HTML5 拖拽里每帧改 DOM 顺序代价太高，
     而且 transition 会和 dragover 的重排互相打断。实测让位移
     带 160ms 缓动就足够顺，逐帧插值反而更黏。
  */

  /* 让位动画的宿主：每次拖动只建一次，中途只改它的位置 */
  var shiftAnim = null;

  /** 落点容器里的可排序条目，按**视觉 row-major** 顺序排好。
      含被拖元素自己：它确实占着格子，算格子数必须算进去。

      注意：这个函数量到的是**实时**坐标。让位 transform 还在元素上时，
      它会读到位移后的值 —— 所以拖动过程中的判定与让位一律走
      dragstart 时量好的 rawLayout，不要直接调这里。 */
  function zoneCells(zone) {
    var sel = zone.dataset.kind === 'habit' ? '[data-habit]' : '[data-untimed="1"]';
    var cells = Array.prototype.slice.call(zone.querySelectorAll(sel))
      .map(function (el) { return { el: el, id: el.dataset.id, rect: el.getBoundingClientRect() }; });

    var rows = [];
    cells.forEach(function (c) {
      var row = null;
      for (var i = 0; i < rows.length; i++) {
        if (Math.abs(rows[i].top - c.rect.top) < 4) { row = rows[i]; break; }
      }
      if (!row) { row = { top: c.rect.top, cells: [] }; rows.push(row); }
      row.cells.push(c);
    });
    rows.sort(function (a, b) { return a.top - b.top; });
    var out = [];
    rows.forEach(function (r) {
      r.cells.sort(function (a, b) { return a.rect.left - b.rect.left; });
      out = out.concat(r.cells);
    });
    return out;
  }

  function zoneKey(zone) {
    if (!zone) return '';
    return (zone.dataset.scope || '') + '#' + (zone.dataset.date || '');
  }

  /** 拖动开始时量一次 zone 的原始布局，整段拖动过程复用。

      三个坑，缺一个量到的就不是真实位置：
      1) 要清掉上一轮遗留的 transform（否则量到位移后的坐标）；
      2) 清 transform 后**过渡动画还在跑** —— 元素要 180ms 才归位，
         立刻量依然是半路坐标。必须临时关掉 transition 强制同步归位；
      3) 量完恢复 transition，否则让位动画会失效。

      这三条都是实测踩出来的：症状是第二次拖动时整列被甩到容器外
      （x 变成 -306 / 1398），而第一次完全正常。 */
  function snapshotLayout(el) {
    var rows = $$('.task-row, .task-pill, .habit-row');
    var dirty = rows.filter(function (x) { return x.style.transform; });
    if (!dirty.length) { rawLayout = {}; }
    else {
      /* 关掉过渡 → 清位移 → 强制回流让归位立即生效 → 量 → 恢复 */
      dirty.forEach(function (x) { x.style.transition = 'none'; x.style.transform = ''; });
      void document.body.offsetHeight;
    }

    rawLayout = {};
    var homeZone = el && el.closest ? el.closest('[data-drop]') : null;
    if (homeZone) rawLayout[zoneKey(homeZone)] = zoneCells(homeZone);

    if (dirty.length) {
      dirty.forEach(function (x) { x.style.transition = ''; });
      void document.body.offsetHeight;
    }
  }
  /* 原始布局缓存：按 zone 存，dragstart 时清空 */
  var rawLayout = {};

  /** 推断列数：同一行里最多有几个格子。按几何推断对 block 单列和 grid 多列都成立。 */
  function inferCols(cells) {
    var max = 1;
    for (var i = 0; i < cells.length; i++) {
      var n = 0;
      for (var j = 0; j < cells.length; j++) {
        if (Math.abs(cells[j].rect.top - cells[i].rect.top) < 4) n++;
      }
      if (n > max) max = n;
    }
    return max;
  }

  /** 找出光标落在（或最近）的格子。格内距离为 0，格外按到矩形的距离。 */
  function cellUnder(e, cells) {
    var best = null, bestD = Infinity;
    cells.forEach(function (c, i) {
      var r = c.rect;
      var dx = e.clientX < r.left ? r.left - e.clientX : (e.clientX > r.right ? e.clientX - r.right : 0);
      var dy = e.clientY < r.top ? r.top - e.clientY : (e.clientY > r.bottom ? e.clientY - r.bottom : 0);
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) { bestD = d; best = { cell: c, index: i }; }
    });
    return best;
  }

  /** 落点位次 k → 排序接口需要的 (refId, pos)。
      sibs 是「去掉自己之后」的列表，插到第 k 位 = 插到 sibs[k-1] 之后（k>0）。 */
  function refForIndex(cells, k) {
    var sibs = cells.filter(function (c) { return c.id !== dragId; });
    if (k <= 0) return sibs.length ? { id: sibs[0].id, pos: 'before' } : { id: null, pos: 'after' };
    var prev = sibs[Math.min(k, sibs.length) - 1];
    return prev ? { id: prev.id, pos: 'after' } : { id: null, pos: 'after' };
  }

  /** 占位洞：拖动期间插在列表里，代表「任务最终会待的那个位置」。
      尺寸跟着被拖元素走，不同类型（任务行 / 习惯行）都能对上。 */
  function makeHole(h, w) {
    var hole = document.createElement('div');
    hole.className = 'drop-hole';
    hole.style.height = h + 'px';
    if (w) hole.style.width = w + 'px';
    return hole;
  }

  /** 让位：被拖元素**留在原位压暗**，其余格子各挪一格给它让出位置。

      这里必须自己算 transform，不能靠把洞 insertBefore 到兄弟节点之间：
      洞是 position:absolute（脱离文档流），它插在中间**不会挤开任何行** ——
      之前就是这么写的，结果 DOM 顺序变了、落库也对，画面却一动不动，
      看起来就是「让位没生效」。

      被拖元素不参与位移：它留在原地当「出处」的锚点，用户能同时看到
      「从哪来」和「到哪去」。之前让它也滑到目标格，结果它和洞叠在同一个
      位置 —— 两份占位叠着，原位又空出来，比不做还乱。

      跨行移动只有自己算才做得到：那种情况相邻两列的格子要一起动，
      布局流表达不了。 */
  function shiftCells(cells, k, cols) {
    var selfIdx = -1;
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].el === dragEl) { selfIdx = i; break; }
    }
    /* 先全部复位：上次让位留下的 transform 必须清掉，否则两次位移叠加，
       格子会越拖越歪。被拖元素不动，它没有位移 */
    cells.forEach(function (c) {
      if (c.el !== dragEl && c.el.style.transform) c.el.style.transform = '';
    });
    if (selfIdx < 0 || selfIdx === k) return;

    /* k 与 selfIdx 都是 row-major 序号（含被拖元素自己）。
       落在两者之间的格子各挪一格让开，区间外的原地不动。
       被拖元素自己原地不动 —— 它就是要当那个锚点。

       挪的方向只有一个：朝「远离出处」的那一侧挪一格。
         k > selfIdx（往下拖）→ 前面那几格整体前移一格
         k < selfIdx（往上拖）→ 后面那几格整体后移一格
       终态就是「去掉自己、插到第 k 位」，两种方向共用同一个 step。

       这里踩过的坑：原来按 `i < k ? i+1 : i-1` 逐格判断方向，
       符号是反的 —— 单列下相邻两格会挪到同一位置（画面上凭空少一条任务），
       洞也被压在下层看不见。方向必须整段统一，不能逐格算。 */
    var lo = Math.min(selfIdx, k), hi = Math.max(selfIdx, k);
    var first = cells[0].rect;
    var dy = first.height + rowGap(cells);
    var step = k > selfIdx ? -1 : 1;

    cells.forEach(function (c, i) {
      if (i === selfIdx || i < lo || i > hi) return;
      if (cols > 1) {
        /* 多列：按「序列里挪一格」算目标序号，
           再换算成像素位移 —— 同一行内只横移，跨行则同时竖移 */
        var dx = first.width + colGap(cells);
        var target = i + step;
        var dCol = (target % cols) - (i % cols);
        var dRow = Math.floor(target / cols) - Math.floor(i / cols);
        c.el.style.transform = 'translate(' + dCol * dx + 'px,' + dRow * dy + 'px)';
      } else {
        c.el.style.transform = 'translateY(' + step * dy + 'px)';
      }
    });
  }

  /* 网格行距 / 列距：从实际 rect 反推，不写死 ——
     分列断点会改 gap，写死值换个宽度就算错 */
  function rowGap(cells) {
    for (var i = 1; i < cells.length; i++) {
      var d = cells[i].rect.top - cells[i - 1].rect.top;
      if (d > 0.5) return d - cells[i - 1].rect.height;
    }
    return 0;
  }
  function colGap(cells) {
    for (var i = 1; i < cells.length; i++) {
      var d = cells[i].rect.left - cells[i - 1].rect.left;
      if (d > 0.5) return d - cells[i - 1].rect.width;
    }
    return 0;
  }

  /** 落点判定 + 让位。只看「光标落在哪一格」，不比较到各条线的远近。
      用「最近线段」会串行：光标在格子中心时，上方那条线反而更近，
      于是整片区域被判成同一档，左右拖动又变得没准头。 */
  function showDropGuide(e, zone) {
    /* 判定与让位一律用 dragstart 时量的原始布局。
       绝不能用 zoneCells 的实时值：让位是加在元素上的 transform，
       getBoundingClientRect 读到的是位移后的坐标 ——
       拿它当基准，落点会整体偏掉一格（实测跨行拖动整列甩出容器） */
    var cells = rawLayout[zoneKey(zone)] || zoneCells(zone);
    if (!cells.length) return null;

    var hit = cellUnder(e, cells);
    if (!hit) return null;
    var k = hit.index;
    var r = hit.cell.rect;

    /* 洞的位置 = 目标格。洞是 position:absolute，left/top 都得按容器坐标算 ——
       只设 left 的话它会一直停在原处，视觉上「让位」根本没发生
       （这类 bug 很隐蔽：落库也对、DOM 也动，就是看不见） */
    var zr = zone.getBoundingClientRect();
    var hole = shiftAnim && shiftAnim.hole;
    if (!hole || !hole.parentNode) {
      hole = makeHole(r.height, r.width);
      zone.appendChild(hole);
      shiftAnim = { hole: hole, zone: zone, key: '', cells: cells };
    }
    hole.style.left = (r.left - zr.left) + 'px';
    hole.style.top = (r.top - zr.top) + 'px';
    hole.style.height = r.height + 'px';
    hole.style.width = r.width + 'px';

    /* 只有落点真的变了才重新让位：dragover 每秒能触发几十次，
       每次都重算 transform 会让过渡动画一直重启，看起来反而更卡 */
    var key = zone.dataset.scope + '|' + k + '|' + cells.length;
    if (shiftAnim.key !== key) {
      shiftAnim.key = key;
      shiftCells(cells, k, inferCols(cells));
      /* 让被拖元素自己淡出一点：它马上要让位，别和洞抢注意力 */
      if (dragEl) dragEl.classList.add('drag-muted');
    }

    return refForIndex(cells, k);
  }

  /** 拖动结束 / 离开落点容器：收掉洞，让被让位的元素回到原位 */
  function clearHole() {
    if (!shiftAnim) return;
    if (shiftAnim.hole && shiftAnim.hole.parentNode) shiftAnim.hole.parentNode.removeChild(shiftAnim.hole);
    /* 让位是加在元素上的 transform，必须复位 —— 不清的话下一次拖动
       会接着上次的偏移算，格子越拖越歪 */
    /* 让位是加在元素上的 transform，复位时同样要处理过渡动画：
       不断 transition 直接清，元素会用 180ms 滑回原位而不是立刻归位，
       拖动中途就会看到「列表先弹回去再重新让位」的抖动 */
    var moved = $$('.task-row, .task-pill, .habit-row').filter(function (el) {
      return el.style.transform;
    });
    if (moved.length) {
      moved.forEach(function (el) { el.style.transition = 'none'; el.style.transform = ''; });
      void document.body.offsetHeight;
      moved.forEach(function (el) { el.style.transition = ''; });
    }
    /* 原始布局缓存也作废：下次拖动要重新量，
       否则会拿上一次让位后的坐标当基准 */
    rawLayout = {};
    shiftAnim = null;
    if (dragEl) dragEl.classList.remove('drag-muted');
  }

  /* ---------------------------------------------------------------
     边缘自动滚动
     ---------------------------------------------------------------
     拖到视口上下缘时自动滚屏。列表比屏幕长时，没有这个就拖不到
     远处的位置 —— 用户得先松手、滚屏、再重新拖，非常打断。

     用 requestAnimationFrame 持续滚，而不是在 dragover 里挪一点：
     dragover 的触发频率跟着鼠标走，鼠标不动就不触发，滚动会一顿一顿的。 */
  var autoScrollRAF = null;
  var autoScrollSpeed = 0;
  /* 最近一次 dragover 的坐标与容器：滚完位置变了，落点得按新位置重算，
     否则洞会停在旧处 —— 用户明明看到列表已经滚到别处，指示却还指着原来那条 */
  var dragProbe = null;
  var dragProbeZone = null;

  function edgeScrollSpeed(clientY) {
    var h = window.innerHeight;
    var EDGE = 84;        /* 上下各 84px 进入自动滚动区 */
    var MAX = 17;         /* 最快每帧滚多少 px */
    if (clientY < EDGE) return -MAX * (1 - clientY / EDGE);
    if (clientY > h - EDGE) return MAX * (1 - (h - clientY) / EDGE);
    return 0;
  }

  function runAutoScroll() {
    autoScrollRAF = null;
    if (!dragId || !autoScrollSpeed) return;
    content.scrollTop += autoScrollSpeed;
    if (dragProbe && dragProbeZone && dragProbeZone.isConnected) {
      showDropGuide(dragProbe, dragProbeZone);
    }
    autoScrollRAF = requestAnimationFrame(runAutoScroll);
  }

  function stopAutoScroll() {
    autoScrollSpeed = 0;
    if (autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
  }

  /** 时间轴落点指引：画一条线 + 时间徽章（只画线，不改整片底色） */
  function drawTimeGuide(zone, min) {
    var line = document.createElement('div');
    line.className = 'tl-guide';
    line.style.top = (min / 1440 * DAY_H) + 'px';
    line.innerHTML = '<span>' + U.minToTime(min) + '</span>';
    zone.appendChild(line);
  }

  /** 由拖拽位置算出时间轴落点（用方块顶部对齐光标，而不是中线） */
  function timeGuideMin(zone, e) {
    var rect = zone.getBoundingClientRect();
    var topMin = e.clientY - rect.top - dragGrabY;
    topMin = Math.max(0, Math.min(DAY_H - 24, topMin));
    return Math.max(0, Math.min(1425, Math.round(topMin / DAY_H * 1440 / 15) * 15));
  }

  /** 落点容器接不接受当前被拖的东西。
      习惯和任务是两套实体，交叉拖放会写坏数据（习惯没有 date 字段等），
      所以直接判掉，不给任何视觉反馈 —— 让用户以为是拖不动。 */
  function zoneAccepts(zone) {
    var kind = zone.dataset.drop;
    if (kind === 'timeline' || kind === 'week') return dragKind === 'task';
    if (kind === 'allday' || kind === 'day') return dragKind === 'task';
    /* 列表容器（data-drop="list"）：两边实体类型必须一致 */
    return (zone.dataset.kind === 'habit') === (dragKind === 'habit');
  }

  content.addEventListener('dragover', function (e) {
    var zone = e.target.closest('[data-drop]');
    if (!zone || !dragId) return;
    if (!zoneAccepts(zone)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    var t = DB.taskById(dragId);
    var kind = zone.dataset.drop;

    /* 时间轴：方块顶部跟随光标，并画一条顶部引导线，整片不变色 */
    if (kind === 'timeline') {
      dropRef = null;
      clearDropUI();
      var min = timeGuideMin(zone, e);
      var src = document.querySelector('.tl-event[data-id="' + dragId + '"]');
      if (src) src.style.top = (min / 1440 * DAY_H) + 'px';
      drawTimeGuide(zone, min);
      return;
    }

    clearDropUI();
    /* 已定时的任务拖到别处只改日期，不参与排序（不再整片高亮） */
    if (dragKind === 'task' && t && t.time) { dropRef = null; return; }

    /* 记下坐标供边缘自动滚动后重算落点 */
    dragProbe = { clientX: e.clientX, clientY: e.clientY };
    dragProbeZone = zone;

    var ref = showDropGuide(e, zone);
    dropRef = ref && ref.id ? { id: ref.id, pos: ref.pos } : null;

    /* 上下缘自动滚屏 */
    var sp = edgeScrollSpeed(e.clientY);
    if (sp !== autoScrollSpeed) {
      autoScrollSpeed = sp;
      if (sp && !autoScrollRAF) autoScrollRAF = requestAnimationFrame(runAutoScroll);
      if (!sp && autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
    }
  });
  content.addEventListener('dragleave', function (e) {
    /* 离开整个落点容器时收掉指示物。relatedTarget 为 null（拖出窗口）也要清，
       否则指示线会僵在原地 —— 之前漏了这个判断，拖出列表后线还亮着。 */
    var zone = e.target.closest('[data-drop]');
    if (zone && !zone.contains(e.relatedTarget)) clearDropUI();
    if (!e.relatedTarget) stopAutoScroll();
  });

  /** 取出落点容器里当前的视觉顺序（落库时要按这个顺序写） */
  function zoneOrder(zone) {
    return zoneCells(zone).map(function (c) { return c.id; });
  }

  content.addEventListener('drop', function (e) {
    var zone = e.target.closest('[data-drop]');
    stopAutoScroll();
    if (!zone || !dragId) return;
    if (!zoneAccepts(zone)) { clearDropUI(); return; }
    e.preventDefault();
    var id = dragId;
    var kind = zone.dataset.drop;
    var task = DB.taskById(id);
    var wasHabit = dragKind === 'habit';
    clearDropUI();
    clearBusySrc();

    if (kind === 'timeline') {
      var min = timeGuideMin(zone, e);
      DB.updateTask(id, { date: zone.dataset.date, time: U.minToTime(min) });
      UI.toast('已改到 ' + U.minToTime(min));
    } else if (kind === 'week') {
      /* 周视图的每一列也是一根时间轴：落下时按光标所在的时刻定时 */
      var r = zone.getBoundingClientRect();
      var wmin = Math.round((e.clientY - r.top) / DAY_H * 1440 / 15) * 15;
      wmin = Math.max(0, Math.min(1425, wmin));
      DB.updateTask(id, { date: zone.dataset.date, time: U.minToTime(wmin) });
      UI.toast('已改到 ' + U.fmtMD(zone.dataset.date) + ' ' + U.minToTime(wmin));
    } else if (kind === 'list') {
      /* 列表内排序：用容器当前的视觉顺序落库。
         跨作用域（拖到别的日期组 / 已完成区）也只改顺序，不改日期 ——
         「搬家」是改期按钮的职责，拖动顺手做掉会让人措手不及 */
      var ids = zoneOrder(zone);
      if (wasHabit) {
        var habits = (DB.state.habits || []).slice();
        DB.reorderHabits(id, habits.sort(function (a, b) { return (a.order || 0) - (b.order || 0); }),
          dropRef ? dropRef.id : null, dropRef ? dropRef.pos : 'after');
        DB.save();
      } else {
        var sibs = ids.map(function (x) { return DB.taskById(x); })
          .filter(Boolean)
          .sort(function (a, b) { return DB.ordCmp(DB.orderCmp)(a, b); });
        /* 落点参照的 id 要跟着容器的最终顺序一起算：
           dropRef 是拖动过程中缓存的，容器重排后它可能已经不在序列里，
           那样就会退化成「插到最后」—— 看着像没生效 */
        var refId = dropRef ? dropRef.id : null;
        if (refId && ids.indexOf(refId) < 0) refId = ids[ids.length - 1];
        DB.reorderWithin(id, sibs.concat([task].filter(Boolean)), refId, dropRef ? dropRef.pos : 'after');
      }
      UI.toast('顺序已调整');
    } else {
      var date = zone.dataset.date || (kind === 'allday' ? ui.cursor : null);
      if (task && task.time) {
        DB.updateTask(id, { date: date });
        UI.toast('已改到 ' + U.fmtMD(date));
      } else {
        DB.reorderUntimed(id, date, dropRef ? dropRef.id : null, dropRef ? dropRef.pos : 'after');
        UI.toast(dropRef ? '顺序已调整' : (date ? '已改到 ' + U.fmtMD(date) : '已移回待办箱'));
      }
    }
    dragId = null;
    dragEl = null;
    dropRef = null;
    document.body.classList.remove('dragging-active');
    renderAll();
  });

  content.addEventListener('dragend', function () {
    stopAutoScroll();
    dragProbe = null;
    dragProbeZone = null;
    dragId = null;
    dragEl = null;
    dropRef = null;
    dragGrabY = 0;
    $$('.dragging').forEach(function (x) { x.classList.remove('dragging'); });
    document.body.classList.remove('dragging-active');
    clearDropUI();
    clearBusySrc();
    /* 重绘复位：拖动时临时移动过的方块位置、让位后重排的列表都会还原 */
    renderAll();
  });

  /* ================= 调试接口 =================
     只在本地测试用（tests/ 下的脚本靠它驱动拖放逻辑）。
     暴露的是「动作 + 状态」，不暴露内部实现，线上不需要它也能跑。 */
  window.__schedDebug = {
    render: renderAll,
    setNav: function (nav) { ui.nav = nav; renderAll(); },
    /* 让 dragover 处理器以为正在拖某个任务（真实拖动时由 dragstart 设置）。
       kind 要跟真实拖动一致：习惯和任务走不同的落库接口 */
    beginDrag: function (id, kind) {
      dragId = id;
      dragKind = kind === 'habit' ? 'habit' : 'task';
      dragEl = document.querySelector('.task-el[data-id="' + id + '"], .habit-row[data-id="' + id + '"]');
      snapshotLayout(dragEl);
    },
    endDrag: function () {
      stopAutoScroll(); dragProbe = null; dragProbeZone = null;
      dragId = null; dragEl = null; dropRef = null; clearDropUI();
    },
    getDropRef: function () { return dropRef; },
    /* 让位自检：确认「判定基准」没被让位 transform 污染。
       rawLayout 是 dragstart 时量的原始坐标（应与实时坐标一致），
       若两者不等就说明基准已脏 —— 那会让落点整体偏掉一格。 */
    shiftDebug: function (zoneSel) {
      var zone = document.querySelector(zoneSel || '[data-drop="list"]');
      if (!zone) return { error: '无容器' };
      var snap = rawLayout[zoneKey(zone)] || [];
      var live = zoneCells(zone);
      var selfIdx = -1;
      live.forEach(function (c, i) { if (c.el === dragEl) selfIdx = i; });
      var dirty = 0;
      snap.forEach(function (c, i) {
        if (!live[i]) return;
        var d = Math.abs(c.rect.left - live[i].rect.left)
              + Math.abs(c.rect.top - live[i].rect.top);
        if (d > 2) dirty++;
      });
      return {
        列数: inferCols(snap.length ? snap : live),
        selfIdx: selfIdx,
        快照数: snap.length,
        基准被污染: dirty,
        让位中: live.filter(function (c) { return c.el.style.transform; }).length,
      };
    },
    /* 当前落点会在 zone 上画什么指示物 —— 测试要对比「判定」与「视觉」是否一致 */
    getGuides: function () {
      return $$('.ins-line, .ins-bar, .tl-guide, .drop-hole').map(function (el) {
        var r = el.getBoundingClientRect();
        return { cls: el.className, x: Math.round(r.left), y: Math.round(r.top),
                 w: Math.round(r.width), h: Math.round(r.height) };
      });
    },
    /* 让位洞当前排在第几格（0 起）—— 落点判定的直接结果，
       比反推 dropRef 更能说明「用户看到的位置对不对」 */
    holeIndex: function (zoneSel) {
      var zone = document.querySelector(zoneSel || '[data-drop="list"]');
      if (!zone) return -1;
      var hole = zone.querySelector('.drop-hole');
      if (!hole) return -1;
      var cells = zoneCells(zone);
      for (var i = 0; i < cells.length; i++) {
        var r = cells[i].rect;
        if (r.top >= hole.getBoundingClientRect().top - 4) return i;
      }
      return cells.length;
    },
    /* 某任务最终会被排到第几位（读 DB.sortTasks 的真实口径，不重新实现一遍） */
    orderOf: function (id) {
      var list = DB.sortTasks(DB.state.tasks.filter(function (x) {
        return !x.done && !x.time && !x.date && x.id !== id;
      }));
      return list.map(function (x) { return x.title; });
    },
  };

  /* 拖动下沿改时长（与移动拖拽相互独立） */
  var resizeTip = null;
  function showResizeTip(evEl, dur, timeText) {
    hideResizeTip();
    if (!evEl) return;
    resizeTip = document.createElement('div');
    resizeTip.className = 'tl-resize-tip';
    document.body.appendChild(resizeTip);
    updateResizeTip(evEl, dur, timeText);
  }
  function updateResizeTip(evEl, dur, timeText) {
    if (!resizeTip || !evEl) return;
    var r = evEl.getBoundingClientRect();
    /* 上沿拖动时把浮标放在方块上方，避免挡住正在拖的那条边 */
    var above = timeText != null;
    resizeTip.style.top = (above ? r.top - 26 : r.bottom + 6) + 'px';
    resizeTip.style.left = r.left + 'px';
    resizeTip.textContent = (timeText ? timeText + ' · ' : '') + U.fmtDuration(dur);
  }
  function hideResizeTip() {
    if (resizeTip) { resizeTip.remove(); resizeTip = null; }
  }

  content.addEventListener('mousedown', function (e) {
    var h = e.target.closest('[data-act="resize"],[data-act="resize-top"]');
    if (!h) return;
    var t = DB.taskById(h.dataset.id);
    if (!t) return;
    var evEl = document.querySelector('.tl-event[data-id="' + h.dataset.id + '"]');
    /* 上沿改开始时间（结束时间不动），下沿改时长（开始时间不动） */
    var edge = h.dataset.act === 'resize-top' ? 'top' : 'bottom';
    var start = U.timeToMin(t.time) || 0;
    resizing = {
      id: h.dataset.id, y: e.clientY, edge: edge,
      start: start, end: start + (t.duration || 60),
      dur: t.duration || 60, el: evEl, cur: t.duration || 60
    };
    if (evEl) evEl.classList.add('resizing');
    showResizeTip(evEl, resizing.dur);
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('mousemove', function (e) {
    if (!resizing) return;
    var addMin = Math.round((e.clientY - resizing.y) / HOUR_H * 60 / 15) * 15;

    if (resizing.edge === 'top') {
      /* 底边固定：新的开始 = 旧开始 + 位移，且不能越过底边、不能早于 0:00 */
      var ns = Math.max(0, Math.min(resizing.end - 15, resizing.start + addMin));
      var nd = resizing.end - ns;
      resizing.curStart = ns;
      resizing.cur = nd;
      if (resizing.el) {
        resizing.el.style.top = (ns / 1440 * DAY_H) + 'px';
        resizing.el.style.height = (nd / 1440 * DAY_H) + 'px';
        updateResizeTip(resizing.el, nd, U.minToTime(ns));
      }
    } else {
      var nb = Math.max(15, resizing.dur + addMin);
      resizing.cur = nb;
      if (resizing.el) {
        resizing.el.style.height = (nb / 1440 * DAY_H) + 'px';
        updateResizeTip(resizing.el, nb);
      }
    }
  });

  document.addEventListener('mouseup', function () {
    if (!resizing) return;
    var nd = resizing.cur || resizing.dur;
    var id = resizing.id;
    var patch = { duration: Math.max(15, nd) };
    if (resizing.edge === 'top' && resizing.curStart != null) {
      patch.time = U.minToTime(resizing.curStart);
    }
    if (resizing.el) resizing.el.classList.remove('resizing');
    hideResizeTip();
    resizing = null;
    justResized = true;
    DB.updateTask(id, patch);
    renderAll();
  });

  /* ================= 快速添加 ================= */

  /* ================= 快速添加（含自然语言解析） ================= */

  /** 把解析结果渲染成一行标签，让用户在回车前看清会发生什么 */
  function renderParsePreview() {
    var el = $('#fastParse');
    if (!el) return;
    var v = $('#fastInput').value.trim();
    if (!v) { el.className = 'fast-parse'; el.innerHTML = ''; return; }

    var p = Parse.parse(v);
    var chips = [];
    if (p.date) chips.push(['date', U.relLabel(p.date)]);
    if (p.time) chips.push(['time', p.time]);
    if (p.duration) chips.push(['dur', U.fmtDuration(p.duration)]);
    if (p.repeat) chips.push(['rep', U.repeatLabel(p.repeat)]);

    if (!chips.length) { el.className = 'fast-parse'; el.innerHTML = ''; return; }
    el.className = 'fast-parse show';
    el.innerHTML = '<span class="fp-chip k-title">' + U.esc(p.title) + '</span>'
      + '<span class="fp-arrow">→</span>'
      + chips.map(function (c) {
        return '<span class="fp-chip k-' + c[0] + '">' + U.esc(c[1]) + '</span>';
      }).join('');
  }

  function submitFast(openDetail) {
    var inp = $('#fastInput');
    var raw = inp.value.trim();
    if (!raw) return;
    var p = Parse.parse(raw);

    var data = { title: p.title || raw };
    if (p.date) data.date = p.date;
    else data.date = defaultDate();
    if (p.time) data.time = p.time;
    else if (pendingTime) data.time = pendingTime;
    if (p.duration) data.duration = p.duration;
    if (p.repeat) data.repeat = p.repeat;

    inp.value = '';
    pendingTime = null;
    renderParsePreview();
    updateFastAdd();

    var t = createTask(data.title, data);
    if (openDetail) openDrawer(t.id);
    else UI.toast('已添加：' + t.title + (t.date ? ' · ' + U.relLabel(t.date) : '') + (t.time ? ' ' + t.time : ''));
  }

  $('#fastInput').addEventListener('input', renderParsePreview);
  $('#fastInput').addEventListener('focus', renderParsePreview);
  $('#fastInput').addEventListener('blur', function () {
    setTimeout(function () { $('#fastParse').className = 'fast-parse'; }, 120);
  });
  $('#fastInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitFast(e.ctrlKey || e.metaKey);
    }
    if (e.key === 'Escape') {
      e.target.blur();
      $('#fastParse').className = 'fast-parse';
    }
  });
  $('#quickAddTop').onclick = function () {
    var t = createTask('新任务');
    openDrawer(t.id);
  };

  /* ================= 抽屉事件 ================= */

  function patchTask(patch) {
    if (!drawerTaskId) return;
    DB.updateTask(drawerTaskId, patch);
    renderAll();
  }
  $('#dTitle').addEventListener('input', function (e) { patchTask({ title: e.target.value }); });
  $('#dNote').addEventListener('input', function (e) { patchTask({ note: e.target.value }); });
  $('#dDate').addEventListener('change', function (e) { patchTask({ date: e.target.value || null }); });
  $('#dTime').addEventListener('click', function () {
    var t = DB.taskById(drawerTaskId);
    if (!t) return;
    Clock.open($('#dTime'), t.time, function (v) {
      if (!drawerTaskId) return;
      DB.updateTask(drawerTaskId, { time: v });
      setTimeView(v);
      renderAll();
    });
  });
  $('#dDuration').addEventListener('change', function (e) { patchTask({ duration: +e.target.value }); });
  $('#dRepeat').addEventListener('change', function (e) {
    var unit = e.target.value;
    var t = DB.taskById(drawerTaskId);
    if (!t) return;
    if (unit === 'none') {
      DB.updateTask(drawerTaskId, { repeat: U.emptyRepeat(t.date) });
    } else {
      var r = U.toRepeat(t.repeat, t.date);
      r.unit = unit;
      if (unit === 'week' && !r.weekdays.length) r.weekdays = [U.weekdayOf(t.date || U.today())];
      if (unit === 'month' && !r.monthday) r.monthday = U.parse(t.date || U.today()).getDate();
      DB.updateTask(drawerTaskId, { repeat: r });
    }
    renderAll();
    renderRepeatPanel();
  });
  $('#dDone').addEventListener('change', function (e) {
    if (!drawerTaskId) return;
    var t = DB.taskById(drawerTaskId);
    if (t.done !== e.target.checked) DB.toggleDone(drawerTaskId);
    renderAll();
  });

  $('#dDelete').onclick = function () {
    if (!drawerTaskId) return;
    var id = drawerTaskId;
    closeDrawer();
    DB.removeTask(id);
    renderAll();
    UI.toast('已移入垃圾箱', '撤销', function () {
      var item = DB.state.trash.filter(function (x) {
        return x.kind === 'task' && x.payload.id === id;
      })[0];
      if (item) { DB.restoreTrash(item.id); renderAll(); }
    });
  };
  $('#dSave').onclick = closeDrawer;
  $('#dClose').onclick = closeDrawer;
  $('#mask').onclick = closeDrawer;

  /* ================= 导入导出 ================= */

  $('#exportBtn').onclick = function () {
    var blob = new Blob([JSON.stringify(DB.state, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '日程清单备份-' + U.today().replace(/-/g, '') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    UI.toast('备份已导出');
  };
  $('#importBtn').onclick = function () { $('#importFile').click(); };
  $('#importFile').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var data = JSON.parse(fr.result);
        if (!data || !Array.isArray(data.tasks)) throw new Error('格式不对');
        if (!confirm('导入会覆盖当前所有数据，确定继续？')) return;
        DB.state = data;
        DB.normalize();
        DB.save();
        closeDrawer();
        renderAll();
        UI.toast('导入成功');
      } catch (err) {
        UI.toast('导入失败：文件不是有效的备份');
      }
      e.target.value = '';
    };
    fr.readAsText(f);
  });

  /* ================= 快捷键 ================= */

  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (e.key === 'Escape') {
      /* 窄屏的浮层优先收起，否则 Esc 会一层层穿透 */
      if (!$('#actSheet').hidden) { closeActions(); return; }
      if (!$('#moreSheet').hidden) { closeMore(); return; }
      if (jumpOpen) { closeJump(); $('#jumpBtn').focus(); return; }
      closeDrawer(); return;
    }
    if (typing) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); $('#fastInput').focus(); }
    else if (e.key === 'd' || e.key === 'D') {
      if (ui.nav === 'calendar') { e.preventDefault(); openJump(); $('#jpInput').focus(); }
    }
    else if (e.key === 't' || e.key === 'T') { ui.nav = 'today'; ui.cursor = U.today(); renderAll(); }
    else if (e.key === '1') { ui.nav = 'calendar'; ui.view = 'day'; renderAll(); }
    else if (e.key === '2') { ui.nav = 'calendar'; ui.view = 'week'; renderAll(); }
    else if (e.key === '3') { ui.nav = 'calendar'; ui.view = 'month'; renderAll(); }
    else if (e.key === 'ArrowLeft') { if (ui.nav === 'calendar' || ui.nav === 'today') shift(-1); }
    else if (e.key === 'ArrowRight') { if (ui.nav === 'calendar' || ui.nav === 'today') shift(1); }
  });

  /* ================= 启动 ================= */

  DB.load();
  ui = DB.state.ui;
  if (!ui.cursor) ui.cursor = U.today();
  /* 「未来 7 天」已移除：旧状态回落到今天 */
  if (['inbox', 'today', 'overdue', 'calendar', 'done', 'trash', 'habits'].indexOf(ui.nav) < 0) ui.nav = 'today';
  applyNavOrder();
  applyTheme();
  renderAll();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { });
    });
  }

  window.UI = UI;
})();

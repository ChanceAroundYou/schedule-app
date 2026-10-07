/* 视图渲染：日 / 周 / 月 日历视图，待办箱 / 今天 / 已完成 列表视图，垃圾箱视图 */
var HOUR_H = 64;          /* 时间轴每小时高度 px */
var DAY_H = HOUR_H * 24;  /* 时间轴总高 */

var Views = {

  /* ================= 通用小工具 ================= */

  /** 月视图格子里的负载简写。手机上格子只有 45px 宽，
      「3小时45分」会折行把日期数字挤扁，这里压成「3¾」这类极短形式 */
  shortLoad: function (mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    if (!h) return m + '分';
    if (!m) return h + '时';
    return h + '¾';
  },

  /* ================= 重叠分列 ================= */

  /** 把同一段时间内互相重叠的任务并排摆放。
      只有真正重叠的那一组才分列，各组独立按自己的列数算宽度：
      后面不再重叠的任务照样占满整行，不会被前面的重叠拖成半宽。
      就地给每个事件补上 col（第几列）和 cols（这一组共几列）。 */
  layoutOverlap: function (events) {
    events.sort(function (a, b) { return a.start - b.start || a.end - b.end; });

    /* 先按「重叠簇」切分：和当前簇最后一个任务有交集就并入，否则另起一组 */
    var clusters = [], cur = null;
    events.forEach(function (e) {
      if (cur && e.start < cur.end) {
        cur.items.push(e);
        if (e.end > cur.end) cur.end = e.end;
      } else {
        cur = { items: [e], end: e.end };
        clusters.push(cur);
      }
    });

    /* 组内再贪心分列：找最靠左且已空闲的那一列 */
    clusters.forEach(function (cl) {
      var colEnds = [];
      cl.items.forEach(function (e) {
        for (var i = 0; i < colEnds.length; i++) {
          if (e.start >= colEnds[i]) { e.col = i; colEnds[i] = e.end; return; }
        }
        e.col = colEnds.length;
        colEnds.push(e.end);
      });
      var cols = Math.max(1, colEnds.length);
      cl.items.forEach(function (e) { e.cols = cols; });
    });

    return events;
  },

  /** 时间段文案：09:30 – 10:30，跨零点标「次日」 */
  timeRange: function (start, dur) {
    var s = U.minToTime(start);
    var end = start + (dur || 0);
    var e = end >= 1440 ? ('次日 ' + U.minToTime(Math.max(0, end - 1440))) : U.minToTime(Math.min(1439, end));
    return s + ' – ' + e;
  },

  /* ================= 公共片段 ================= */

  /** 列表行：待办箱 / 今天 / 已完成 共用。opts.bare = 只显示标题 */
  taskRow: function (t, opts) {
    opts = opts || {};
    var meta = [];
    if (!opts.bare) {
      if (t.time) meta.push('<span class="m-time">' + U.esc(t.time) + '</span>');
      if (t.date) meta.push('<span class="m-date' + (t.date < U.today() && !t.done ? ' over' : '') + '">' + U.relLabel(t.date) + '</span>');
      if (t.duration && t.time) meta.push('<span class="m-dur">' + U.fmtDuration(t.duration) + '</span>');
      if (t.repeat && t.repeat.unit && t.repeat.unit !== 'none') {
        meta.push('<span class="m-repeat">↻ ' + U.esc(U.repeatLabel(t.repeat)) + '</span>');
      }
      if (t.note) meta.push('<span class="m-note">备注</span>');
    }
    if (opts.doneAt && t.doneAt) {
      var d = new Date(t.doneAt);
      meta.push('<span class="m-date">完成于 ' + (d.getMonth() + 1) + '/' + d.getDate() + '</span>');
    }

    return '<div class="task-row task-el' + (t.done ? ' done' : '') + '" data-id="' + t.id + '" data-untimed="' + (t.time ? '' : '1') + '" draggable="true">'
      + '<button class="check-btn' + (t.done ? ' on' : '') + '" data-act="toggle" data-id="' + t.id + '" title="标记完成"></button>'
      + '<div class="row-main"><div class="row-title">' + U.esc(t.title) + '</div>'
      + (meta.length ? '<div class="row-meta">' + meta.join('<span class="dot">·</span>') + '</div>' : '')
      + '</div>'
      + '</div>';
  },

  /** 月视图 / 全天区里的小胶囊 */
  taskPill: function (t, showTime) {
    var cls = 'task-pill task-el' + (t.done ? ' done' : '');
    return '<div class="' + cls + '" data-id="' + t.id + '" data-untimed="' + (t.time ? '' : '1') + '" draggable="true" title="' + U.esc(t.title) + '">'
      + '<span class="check-btn sm' + (t.done ? ' on' : '') + '" data-act="toggle" data-id="' + t.id + '"></span>'
      + (showTime && t.time ? '<span class="pill-time">' + U.esc(t.time) + '</span>' : '')
      + '<span class="pill-title">' + U.esc(t.title) + '</span>'
      + '</div>';
  },

  empty: function (text) {
    return '<div class="empty"><div class="empty-ico">🗒️</div><div>' + U.esc(text) + '</div></div>';
  },

  /** 某一天的任务负载：已排分钟数（周/月视图负载感知用） */
  dayLoad: function (iso) {
    var mins = 0, count = 0;
    DB.state.tasks.forEach(function (x) {
      if (x.done || x.date !== iso) return;
      count++;
      if (x.time) mins += (x.duration || 60);
    });
    return { mins: mins, count: count };
  },

  /* ================= 日视图 ================= */

  /** 某一天的未定时任务（已完成的剔除：它们不再占日程位置） */
  untimedOn: function (iso) {
    return DB.tasksOn(iso).filter(function (t) { return !t.time && !t.done; });
  },

  day: function (iso) {
    var tasks = DB.tasksOn(iso);
    var timed = [], allday = [];
    tasks.forEach(function (t) {
      if (t.time) timed.push(t);
      /* 已完成的未定时任务不再占日程位置，它去了「今天 › 今天已完成」 */
      else if (!t.done) allday.push(t);
    });

    /* 未定时区。data-drop 挂在最外层：里面的留白、任务之间的空隙也都算落点，
       挂在内层的话拖到 padding 上会找不到 zone，drop 静默失败（表现为「有的任务拖不动」）。
       任务名短、数量可能很多，排两列，省得把下面的时间轴挤出屏幕 */
    var COLS = 2;
    var alldayHTML = '<div class="allday-zone" data-drop="allday" data-date="' + iso + '">'
      + '<div class="allday-items" data-cols="' + (allday.length > 3 ? COLS : 1) + '"'
      + ' style="--cols:' + (allday.length > 3 ? COLS : 1) + '">'
      + allday.map(function (t) {
        return Views.taskPill(t, false);
      }).join('')
      + (allday.length ? '' : '<div class="zone-empty">没有未定时间的任务</div>')
      + '</div></div>';

    /* 时间轴 */
    var grid = '';
    for (var h = 0; h < 24; h++) {
      grid += '<div class="tl-hour" style="top:' + (h * HOUR_H) + 'px"><span class="tl-label">'
        + (h < 10 ? '0' + h : h) + ':00</span></div>';
    }
    var nowTop = U.nowMin() / 1440 * DAY_H;
    var isToday = iso === U.today();

    var events = timed.map(function (t) {
      var start = U.timeToMin(t.time) || 0;
      var dur = t.duration || 60;
      return { task: t, start: start, end: start + dur };
    });
    Views.layoutOverlap(events);

    var nowTs = isToday ? U.nowMin() : null;
    var evHTML = events.map(function (e) {
      var top = e.start / 1440 * DAY_H;
      var hgt = Math.max(24, (e.end - e.start) / 1440 * DAY_H);
      var w = 100 / e.cols;
      var t = e.task;
      var live = nowTs !== null && nowTs >= e.start && nowTs < e.end;
      /* 方框太矮（不到两行）时把时间省掉，只留标题，避免挤成两半 */
      var roomy = hgt >= 46;
      return '<div class="tl-event task-el' + (t.done ? ' done' : '')
        + (live ? ' live' : '')
        + '" data-id="' + t.id + '" draggable="true" style="top:' + top + 'px;height:' + hgt + 'px;left:' + (e.col * w) + '%;width:calc(' + w + '% - 4px)"'
        + ' title="' + U.esc(t.title + '　' + Views.timeRange(e.start, e.end - e.start) + '　' + U.fmtDuration(e.end - e.start)) + '"'
        + '>'
        + '<div class="ev-head">'
        + '<button class="check-btn sm' + (t.done ? ' on' : '') + '" data-act="toggle" data-id="' + t.id + '"></button>'
        + '<span class="ev-title">' + U.esc(t.title) + '</span>'
        + '</div>'
        + (roomy ? '<span class="ev-time">' + U.esc(Views.timeRange(e.start, e.end - e.start)) + '</span>' : '')
        + '<span class="ev-resize ev-resize-top" data-act="resize-top" data-id="' + t.id + '"></span>'
        + '<span class="ev-resize" data-act="resize" data-id="' + t.id + '"></span>'
        + '</div>';
    }).join('');

    /* 已占用时段底纹：跟着任务所在列走，重叠的两个任务各占自己那一列，
       不会连成一片把整段时间都染色 */
    var busyHTML = events.map(function (e) {
      var w = 100 / e.cols;
      return '<div class="tl-busy" data-busy="' + e.task.id + '" style="top:' + (e.start / 1440 * DAY_H) + 'px;height:'
        + (Math.max(2, (e.end - e.start) / 1440 * DAY_H)) + 'px;left:'
        + (e.col * w) + '%;width:calc(' + w + '% - 4px)"></div>';
    }).join('');

    var timeline = '<div class="timeline" data-date="' + iso + '" data-drop="timeline" style="height:' + DAY_H + 'px">'
      + grid
      + '<div class="tl-layer">' + busyHTML + '</div>'
      + (isToday ? '<div class="tl-now" style="top:' + nowTop + 'px"><i></i><span>' + U.minToTime(U.nowMin()) + '</span></div>' : '')
      + '<div class="tl-events">' + evHTML + '</div>'
      + '</div>';

    return alldayHTML + '<div class="tl-wrap">' + timeline + '</div>';
  },

  /* ================= 周视图 ================= */

  /** 把某一天的定时任务摊到时间轴上（周视图每列都用它） */
  weekTimed: function (iso) {
    var timed = DB.tasksOn(iso).filter(function (t) { return t.time; });
    var events = timed.map(function (t) {
      var start = U.timeToMin(t.time) || 0;
      var dur = t.duration || 60;
      return { task: t, start: start, end: start + dur };
    });
    Views.layoutOverlap(events);

    return events.map(function (e) {
      var t = e.task;
      var top = e.start / 1440 * DAY_H;
      var hgt = Math.max(20, (e.end - e.start) / 1440 * DAY_H);
      var w = 100 / e.cols;
      return '<div class="wk-event task-el' + (t.done ? ' done' : '')
        + '" data-id="' + t.id + '" draggable="true" title="' + U.esc(t.title + ' ' + t.time + ' · ' + U.fmtDuration(t.duration || 60)) + '"'
        + ' style="top:' + top + 'px;height:' + hgt + 'px;left:' + (e.col * w) + '%;width:calc(' + w + '% - 3px)">'
        + '<span class="wk-time">' + U.esc(t.time) + '</span>'
        + '<span class="wk-title">' + U.esc(t.title) + '</span>'
        + '</div>';
    }).join('');
  },

  week: function (iso) {
    var start = U.weekStart(iso);

    /* 左侧时间刻度：与日视图同一套刻度，和右侧任务格共用一个滚动容器，永远对齐 */
    var hours = '';
    for (var h = 0; h < 24; h++) {
      hours += '<div class="wk-hour" style="top:' + (h * HOUR_H) + 'px"><span>'
        + (h < 10 ? '0' + h : h) + ':00</span></div>';
    }

    var head = '', untimedRow = '', cols = '';
    for (var i = 0; i < 7; i++) {
      var d = U.addDays(start, i);
      var isToday = d === U.today();
      var isWeekend = i >= 5;
      var ts = DB.tasksOn(d);
      var untimed = Views.untimedOn(d);
      var load = Views.dayLoad(d);
      var lv = load.mins === 0 ? 0 : (load.mins > 8 * 60 ? 3 : (load.mins > 4 * 60 ? 2 : 1));

      head += '<button class="week-head-cell' + (isToday ? ' today' : '') + (isWeekend ? ' weekend' : '')
        + '" data-jump="' + d + '" title="跳到 ' + U.fmtMD(d) + '">'
        + '<span class="wh-week">周' + U.weekdayShort(d) + '</span>'
        + '<span class="wh-day">' + U.parse(d).getDate() + '</span>'
        + '<span class="wh-load lv' + lv + '"><i style="width:' + Math.min(100, load.mins / 480 * 100) + '%"></i></span>'
        + '<span class="wh-count">' + ts.length + '</span>'
        + '</button>';

      /* 未定时的单独一行，固定高度，保证下面各列的刻度线横向对齐 */
      untimedRow += '<div class="wun-cell' + (isToday ? ' today' : '') + '" data-drop="allday" data-date="' + d + '">'
        + (untimed.length
          ? untimed.map(function (t) { return Views.taskPill(t, false); }).join('')
          : '<span class="wun-empty"></span>')
        + '</div>';

      /* 定时任务按时间落格 */
      cols += '<div class="week-col' + (isToday ? ' today' : '') + '" data-drop="week" data-date="' + d + '">'
        + Views.weekTimed(d)
        + '</div>';
    }

    return '<div class="week-view" id="weekView">'
      + '<div class="week-head" id="weekHead"><div class="week-head-gutter"></div>'
      + '<div class="week-head-cols">' + head + '</div></div>'
      + '<div class="week-un-row">'
      + '<div class="week-un-gutter">未定时</div>'
      + '<div class="week-un-cols">' + untimedRow + '</div>'
      + '</div>'
      + '<div class="week-grid">'
      + '<div class="week-gutter">' + hours + '</div>'
      + '<div class="week-cols">' + cols + '</div>'
      + '</div></div>';
  },

  /* ================= 月视图 ================= */

  month: function (iso) {
    var days = U.monthMatrix(iso);
    var cur = U.parse(iso);
    var head = ['一', '二', '三', '四', '五', '六', '日'].map(function (w) {
      return '<div class="month-head-cell">周' + w + '</div>';
    }).join('');
    /* 列出当天全部任务（超过 MONTH_CELL_MAX 才折叠），
       不再固定截 3 条——藏起来的信息用户永远看不到 */
    var cells = days.map(function (d) {
      var dt = U.parse(d);
      var out = dt.getMonth() !== cur.getMonth();
      var isToday = d === U.today();
      var ts = DB.tasksOn(d);
      var show = ts.slice(0, MONTH_CELL_MAX);
      var more = ts.length - show.length;
      var load = Views.dayLoad(d);
      var lv = load.mins === 0 ? 0 : (load.mins > 8 * 60 ? 3 : (load.mins > 4 * 60 ? 2 : 1));
      return '<div class="month-cell' + (out ? ' out' : '') + (isToday ? ' today' : '')
        + (lv ? ' lv' + lv : '') + '" data-date="' + d + '" data-drop="day">'
        + '<div class="cell-head">'
        + '<span class="cell-date' + (load.count ? ' busy' : '') + '" data-jump="' + d + '" title="看这一天的日程">' + dt.getDate() + '</span>'
        + (isToday ? '<span class="cell-today">今天</span>' : '')
        + (load.mins ? '<span class="cell-load" title="已排 ' + U.fmtDuration(load.mins) + '">' + Views.shortLoad(load.mins) + '</span>' : '')
        + '</div>'
        + '<div class="cell-tasks">' + show.map(function (t) {
          return Views.taskPill(t, true);
        }).join('') + (more > 0
          ? '<div class="cell-more" data-jump="' + d + '" title="查看 ' + U.fmtMD(d) + ' 的完整日程">还有 ' + more + ' 项 ›</div>'
          : '') + '</div>'
        + '</div>';
    }).join('');
    return '<div class="month-view"><div class="month-head">' + head + '</div>'
      + '<div class="month-grid">' + cells + '</div></div>';
  },

  /* ================= 逾期视图 ================= */

  /** 逾期：所有「有日期、已过期、还没完成」的任务，按逾期天数从多到少排 */
  overdueList: function () {
    var t = U.today();
    var kw = DB.state.ui.search || '';
    return DB.state.tasks.filter(function (x) {
      if (x.done || !x.date || x.date >= t) return false;
      if (kw && x.title.indexOf(kw) < 0 && (x.note || '').indexOf(kw) < 0) return false;
      return true;
    }).sort(function (a, b) {
      /* 先按逾期日期（同一天归一组），组内按手动顺序 ——
         组内如果还按日期排，用户拖过的顺序下次渲染就弹回去了 */
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return DB.ordCmp(DB.orderCmp)(a, b);
    });
  },

  overdue: function () {
    var list = Views.overdueList();
    if (!list.length) {
      return '<div class="list-view">' + Views.checkinStrip() + '</div>'
        + Views.empty('没有逾期任务，都跟上了');
    }

    /* 按日期分组，组标题写清逾期了几天 */
    var groups = {};
    var order = [];
    list.forEach(function (x) {
      if (!groups[x.date]) { groups[x.date] = []; order.push(x.date); }
      groups[x.date].push(x);
    });

    var html = '<div class="list-view od-view">';
    order.forEach(function (d) {
      var days = Math.round((U.parse(U.today()) - U.parse(d)) / 86400000);
      html += '<div class="list-group">'
        + '<div class="group-title over">逾期 ' + days + ' 天'
        + '<span class="group-count">' + groups[d].length + '</span>'
        + '<span class="od-date">' + U.fmtMD(d) + ' ' + U.weekdayShort(d) + '</span>'
        + '</div>'
        /* 每个日期组是独立的排序作用域：组内随便拖，跨组只改顺序不搬家
           （搬家会改变逾期天数，那是「改期」的语义，不该由拖动顺手做掉） */
        + '<div class="mc" data-drop="list" data-scope="day:' + d + '">'
        + groups[d].map(function (x) { return Views.overdueRow(x, days); }).join('') + '</div>'
        + '</div>';
    });
    return html + '</div>';
  },

  /** 逾期行：比普通任务行多一组「重新安排」的快捷键 */
  overdueRow: function (t, days) {
    var t0 = U.today();
    var quick = [
      { label: '今天', date: t0 },
      { label: '明天', date: U.addDays(t0, 1) }
    ];
    return '<div class="task-row task-el od-row" data-id="' + t.id + '" data-untimed="1" draggable="true">'
      + '<button class="check-btn" data-act="toggle" data-id="' + t.id + '" title="标记完成"></button>'
      + '<div class="row-main">'
      + '<div class="row-title">' + U.esc(t.title) + '</div>'
      + '<div class="row-meta">'
      + '<span class="m-time od-late">逾期 ' + days + ' 天</span>'
      + (t.time ? '<span class="dot">·</span><span class="m-time">' + U.esc(t.time) + '</span>' : '')
      + (t.duration && t.time ? '<span class="dot">·</span><span class="m-dur">' + U.fmtDuration(t.duration) + '</span>' : '')
      + '<span class="od-quick">'
      + quick.map(function (q) {
        return '<button class="od-btn" data-act="reschedule" data-id="' + t.id + '" data-date="' + q.date + '">' + q.label + '</button>';
      }).join('')
      + '<button class="od-btn ghost" data-act="pick-date" data-id="' + t.id + '">改到…</button>'
      + '</span>'
      + '</div></div></div>';
  },

  /* ================= 列表视图 ================= */

  inbox: function () {
    var kw = DB.state.ui.search || '';
    var list = DB.state.tasks.filter(function (t) {
      if (t.done || t.date) return false;
      if (kw && t.title.indexOf(kw) < 0 && (t.note || '').indexOf(kw) < 0) return false;
      return true;
    });
    /* 排序口径：用户拖过的（ord 有值）听用户的，没拖过的仍按原来的
       orderCmp（手动位次 > 创建时间）。两者不能混用 —— 拖动写的是 ord，
       读取也必须认 ord，否则拖完下次渲染就弹回原位。 */
    list = DB.sortTasks(list).sort(DB.ordCmp(DB.orderCmp));
    if (!list.length) return Views.empty(kw ? '没有匹配的任务' : '待办箱是空的，想到什么先扔进来');
    /* 只显示任务本身：不要分组标题、不要右侧快捷日期、不要「未定日期」标注。
       mc = 宽屏下这个容器内的条目会自动分成多列。
       data-drop 让这里可拖动排序；data-scope="inbox" 声明排序作用域是「无日期」这一组，
       重排不会污染其他日期 */
    return '<div class="list-view"><div class="group-items mc" data-drop="list" data-scope="inbox">'
      + list.map(function (t) { return Views.taskRow(t, { bare: true }); }).join('')
      + '</div></div>';
  },

  today: function () {
    var t = U.today();
    var kw = DB.state.ui.search || '';
    /* 「今天」只放今天要做的事；逾期的单独去「逾期」标签看，避免混在一起。

       排序：用户拖过的（ord 有值）听用户的，没拖过的仍按原口径
       （定时在前按时间、未定时按手动位次）。用户不该靠拖动去改「几点做什么」，
       那是日程页时间轴的职责。 */
    var list = DB.state.tasks.filter(function (x) {
      if (x.done || x.date !== t) return false;
      if (kw && x.title.indexOf(kw) < 0 && (x.note || '').indexOf(kw) < 0) return false;
      return true;
    });
    list = DB.sortTasks(list).sort(DB.ordCmp(function (a, b) {
      return DB.sortTasks([a, b])[0] === a ? -1 : 1;
    }));

    /* 今天已经做完的：日程页不再显示它们（尤其是没定时间的，勾完就该让位），
       在这里留一个收口，随时能回看今天做完了什么、也可以反悔取消 */
    var doneToday = DB.state.tasks.filter(function (x) {
      if (!x.done || x.date !== t) return false;
      if (kw && x.title.indexOf(kw) < 0 && (x.note || '').indexOf(kw) < 0) return false;
      return true;
    }).sort(DB.ordCmp(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); }));

    var strip = Views.checkinStrip();
    var over = DB.overdueCount();

    /* 顶部只给一条很轻的逾期提示，点进去就是「逾期」标签 */
    var odTip = over
      ? '<button class="od-strip" data-nav="overdue">'
        + '<span class="od-dot"></span>'
        + (over === 1 ? '有 1 项任务逾期了' : ('有 ' + over + ' 项任务逾期了'))
        + '<span class="od-go">去处理 →</span></button>'
      : '';

    var doneSec = Views.todayDoneBlock(doneToday);

    if (!list.length && !strip && !doneToday.length) {
      return Views.empty(kw ? '没有匹配的任务' : '今天没有安排，享受一下');
    }

    var html = '<div class="list-view">' + strip + odTip;
    /* 任务行包一层 .mc：宽屏下自动分列。
       打卡条、逾期提示、已完成区块是「整块」内容，不参与分列。
       data-drop 让这里也能拖动排序；data-scope="day:<日期>" 声明排序作用域，
       重排只影响这一天这一组，不会污染待办箱或其他日期 */
    html += '<div class="mc" data-drop="list" data-scope="day:' + t + '">'
      + list.map(function (x) { return Views.taskRow(x, {}); }).join('') + '</div>';
    html += doneSec;
    return html + '</div>';
  },

  /** 「今天已完成」区块：可折叠，默认收起，做完多少一眼看得见 */
  todayDoneBlock: function (list) {
    if (!list.length) return '';
    var n = list.length;
    var open = DB.state.ui.tdoneOpen ? ' open' : '';
    return '<div class="today-done' + open + '" id="todayDone">'
      + '<button class="td-head" data-toggle-tdone="1">'
      + '<span class="td-caret">▸</span>'
      + '<span class="td-title">今天已完成</span>'
      + '<span class="td-count">' + n + '</span>'
      + '</button>'
      + '<div class="td-body mc" data-drop="list" data-scope="done:' + t + '">' + list.map(function (x) {
        return Views.taskRow(x, { doneAt: true });
      }).join('') + '</div>'
      + '</div>';
  },

  /* 今天顶部的每日打卡条：完成即勾，顺手提醒，不占时间轴 */
  checkinStrip: function () {
    var habits = DB.state.habits || [];
    if (!habits.length) return '';
    var t = U.today();
    var done = habits.length - DB.habitsTodayRemaining();
    var items = habits.map(function (h) {
      var hd = !!(h.log && h.log[t]);
      var st = DB.habitStreak(h);
      return '<div class="ci-item' + (hd ? ' done' : '') + '" data-habit="' + h.id + '">'
        + '<button class="check-btn sm' + (hd ? ' on' : '') + '" data-act="habit" data-id="' + h.id + '" title="今日打卡"></button>'
        + '<span class="ci-title">' + U.esc(h.title) + '</span>'
        + (st > 1 ? '<span class="ci-streak" title="连续打卡天数">🔥' + st + '</span>' : '')
        + '</div>';
    }).join('');
    return '<div class="checkin-strip">'
      + '<div class="ci-head">每日打卡<span class="ci-sub">今天 ' + done + '/' + habits.length + '</span>'
      + '<button class="ci-manage" data-jump-habits="1">管理</button></div>'
      + '<div class="ci-list">' + items + '</div></div>';
  },

  done: function () {
    var kw = DB.state.ui.search || '';
    var list = DB.state.tasks.filter(function (t) {
      if (!t.done) return false;
      if (kw && t.title.indexOf(kw) < 0) return false;
      return true;
    }).sort(DB.ordCmp(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); }))
      .slice(0, 200);

    if (!list.length) return Views.empty('还没有完成的任务');

    var groups = {};
    list.forEach(function (t) {
      var d = t.doneAt ? U.iso(new Date(t.doneAt)) : '未知';
      (groups[d] = groups[d] || []).push(t);
    });
    var html = '<div class="list-view">';
    Object.keys(groups).sort().reverse().forEach(function (d) {
      html += '<div class="list-group"><div class="group-title">' + (d === '未知' ? '未知时间' : U.relLabel(d)) + ' <span class="group-count">' + groups[d].length + '</span></div>'
        /* 按完成日分组，每组独立排序：组内可以拖，跨组不搬家 */
        + '<div class="mc" data-drop="list" data-scope="done:' + d + '">'
        + groups[d].map(function (t) { return Views.taskRow(t, { doneAt: true }); }).join('')
        + '</div></div>';
    });
    return html + '</div>';
  },

  /* ================= 打卡（习惯）视图 ================= */

  /** 最近 14 天打卡热力点 */
  habitHeat: function (h) {
    var out = '';
    for (var i = 13; i >= 0; i--) {
      var d = U.addDays(U.today(), -i);
      var on = !!(h.log && h.log[d]);
      out += '<i class="heat-dot' + (on ? ' on' : '') + '" title="' + d + (on ? ' 已打卡' : '') + '"></i>';
    }
    return out;
  },

  habits: function () {
    var habits = (DB.state.habits || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    var addBar = '<div class="habit-add"><input type="text" id="habitInput" placeholder="添加一个习惯，如：学英语" autocomplete="off" spellcheck="false">'
      + '<button class="primary-btn" data-add-habit="1">添加</button></div>';
    if (!habits.length) {
      return '<div class="habits-view">' + addBar + Views.empty('还没有习惯，先加一个每天想坚持的事') + '</div>';
    }
    var t = U.today();
    var rows = habits.map(function (h) {
      var done = !!(h.log && h.log[t]);
      var st = DB.habitStreak(h);
      return '<div class="habit-row' + (done ? ' done' : '') + '" data-habit="' + h.id + '" data-id="' + h.id + '" data-kind="habit" draggable="true">'
        + '<button class="check-btn sm' + (done ? ' on' : '') + '" data-act="habit" data-id="' + h.id + '"></button>'
        + '<div class="habit-main">'
        + '<div class="habit-title">' + U.esc(h.title) + (st > 1 ? ' <span class="ci-streak">🔥' + st + '</span>' : '') + '</div>'
        + '<div class="habit-heat">' + Views.habitHeat(h) + '</div>'
        + '</div>'
        + '<button class="habit-del" data-del-habit="' + h.id + '" title="删除习惯">✕</button>'
        + '</div>';
    }).join('');
    /* 打卡也用 data-drop，data-kind="habit" 告诉拖放层「这是习惯不是任务」——
       两者字段不同（habit 用 order，任务用 ord），走错会写坏数据 */
    return '<div class="habits-view">' + addBar + '<div class="habit-list mc" data-drop="list" data-scope="habits" data-kind="habit">' + rows + '</div></div>';
  },

  /* ================= 垃圾箱 ================= */

  trash: function () {
    var tr = DB.state.trash;
    var html = '<div class="list-view">';
    if (!tr.length) {
      return Views.emptyTip();
    }
    html += '<div class="trash-head">'
      + '<div class="trash-tip">删除的任务都在这里，永久保留，你可以随时还原。</div>'
      + '<button class="danger-btn" id="emptyTrashBtn">清空垃圾箱</button>'
      + '</div>';
    var icons = { task: '☑️' };
    var names = { task: '任务' };
    html += '<div class="list-group"><div class="mc">' + tr.map(function (it) {
      var title = it.payload.title || '';
      var d = new Date(it.deletedAt);
      return '<div class="task-row trash-row">'
        + '<span class="trash-ico">' + (icons[it.kind] || '🗑') + '</span>'
        + '<div class="row-main"><div class="row-title">' + U.esc(title) + '</div>'
        + '<div class="row-meta"><span class="m-date">' + names[it.kind] + '</span>'
        + '<span class="dot">·</span><span class="m-date">来自 ' + U.esc(it.from || '—') + '</span>'
        + '<span class="dot">·</span><span class="m-date">' + (d.getMonth() + 1) + '/' + d.getDate() + ' 删除</span>'
        + '</div></div>'
        + '<span class="row-actions">'
        + '<button class="chip tiny" data-restore="' + it.id + '">还原</button>'
        + '<button class="chip tiny danger" data-purge="' + it.id + '">彻底删除</button>'
        + '</span></div>';
    }).join('') + '</div></div>';
    return html;
  },

  emptyTip: function () {
    return '<div class="empty"><div class="empty-ico">🗑</div><div>垃圾箱是空的</div></div>';
  },

  /* ================= 分发 ================= */

  render: function () {
    var ui = DB.state.ui;
    if (ui.nav === 'inbox') return Views.inbox();
    if (ui.nav === 'today') return Views.today();
    if (ui.nav === 'overdue') return Views.overdue();
    if (ui.nav === 'done') return Views.done();
    if (ui.nav === 'trash') return Views.trash();
    if (ui.nav === 'habits') return Views.habits();
    if (ui.view === 'day') return Views.day(ui.cursor);
    if (ui.view === 'week') return Views.week(ui.cursor);
    return Views.month(ui.cursor);
  }
};

/* ================= 渲染前后的滚动位置 ================= */

/* innerHTML 重写会把滚动位置清零，所以重绘前先记住。
   只有「切到另一个视图 / 另一天」时才重新定位，同一页面内的增删改保持原位，
   这样勾选任务、拖动排序时画面不会突然跳走。 */
var lastViewKey = null;
var savedScroll = 0;
var savedWeekScroll = 0;

Views.beforeRender = function () {
  var el = document.getElementById('content');
  savedScroll = el ? el.scrollTop : 0;
  /* 周视图的滚动发生在内部容器里，单独记住 */
  var g = el && el.querySelector('.week-view');
  savedWeekScroll = g ? g.scrollTop : 0;
};

/** 周视图按可见区域铺满：先量出内容区减去内边距的净高，
   再把表头高度写成 CSS 变量，让下面那行 sticky 精确吸在表头底下。
   不用 calc(100vh - N)：浏览器工具栏、缩放、系统字号都会让 N 猜错。 */
Views.fitWeekHeight = function () {
  var el = document.getElementById('content');
  var wv = el && el.querySelector('.week-view');
  if (!wv) return;
  var head = wv.querySelector('.week-head');
  if (head) wv.style.setProperty('--week-head-h', head.getBoundingClientRect().height + 'px');

  var cs = window.getComputedStyle(el);
  var avail = el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  var h = Math.max(420, avail);
  wv.style.height = h + 'px';
};

/* 月视图的行高策略：
   之前是把富余高度「均分」到6 行、强行铺满一屏。副作用有两个：
     ① 屏幕越大格子越空（1920 宽下每行 167px，却只塞得下 3 条任务）
     ② 刚好铺满时 scrollHeight == clientHeight，滚轮怎么滚都没反应
   改成：行高按可用高度算，夹在 [104, 132] 之间作为**下限**；
   某天任务多时行自己长高（minmax 的 auto），页面随之出现滚动条。
   同时不再截断任务条数——「还有 N 项」把信息藏起来，用户只能滚去看更远的行，
   却永远看不到自己那格到底有什么。 */
var MONTH_ROW_MIN = 104;
var MONTH_ROW_MAX = 132;
var MONTH_HEAD_H = 30;/* .month-head 实测约 30px（含 6px 下边距） */
var MONTH_CELL_MAX = 8;   /* 单格最多直接列出多少条，再多才折叠。
                              太大（比如 15）会把整行撑到几百像素、
                              同一行其他天全被拉空，得不偿失 */

/** 算月视图的行高下限。在渲染前调用（此时 content 已有布局尺寸）。 */
Views.monthRowHeight = function () {
  var el = document.getElementById('content');
  var avail = 0;
  if (el) {
    var cs = window.getComputedStyle(el);
    avail = el.clientHeight
      - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  }
  return Math.round(
    Math.max(MONTH_ROW_MIN, Math.min(MONTH_ROW_MAX, (avail - MONTH_HEAD_H) / 6))
  );
};

/** 渲染后把行高下限落上去。minmax(下限, auto)：
    下限保证月视图尽量占满一屏，auto 让内容多的行自己长高，页面就能滚。 */
Views.fitMonthHeight = function () {
  var el = document.getElementById('content');
  var g = el && el.querySelector('.month-grid');
  if (!g) return;
  g.style.gridTemplateRows = '';
  g.style.gridAutoRows = 'minmax(' + Views.monthRowHeight() + 'px, auto)';
};
window.addEventListener('resize', function () { Views.fitMonthHeight(); Views.fitWeekHeight(); });

Views.afterRender = function () {
  var ui = DB.state.ui;
  var el = document.getElementById('content');
  if (!el) return;
  Views.fitMonthHeight();
  Views.fitWeekHeight();
  var key = ui.nav + '|' + ui.view + '|' + ui.cursor;
  if (key === lastViewKey) {
    el.scrollTop = savedScroll;
    var g0 = el.querySelector('.week-view');
    if (g0) g0.scrollTop = savedWeekScroll;
    return;
  }
  lastViewKey = key;

  if (ui.nav === 'calendar' && ui.view === 'day') {
    el.scrollTop = Math.max(0, U.nowMin() / 1440 * DAY_H - 160);
    return;
  }
  if (ui.nav === 'calendar' && ui.view === 'week') {
    el.scrollTop = 0;
    /* 周视图先滚到当前时间附近（早上别一上来就是半夜） */
    var grid = el.querySelector('.week-view');
    if (grid) {
      var anchor = U.nowMin();
      /* 早上 9 点前先定位到 7:00，其余按当前时间 */
      if (anchor < 7 * 60) anchor = 7 * 60;
      grid.scrollTop = Math.max(0, anchor / 1440 * DAY_H - 40);
    }
    return;
  }
  el.scrollTop = 0;
};

window.Views = Views;

/* 数据层：模型定义、本地存储、增删改查 */
var STORE_KEY = 'schedule-app-v1';

var U = {
  pad: function (n) { return n < 10 ? '0' + n : '' + n; },

  iso: function (d) {
    return d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate());
  },
  today: function () { return U.iso(new Date()); },
  parse: function (s) {
    var p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  },
  addDays: function (iso, n) {
    var d = U.parse(iso);
    d.setDate(d.getDate() + n);
    return U.iso(d);
  },
  addMonths: function (iso, n) {
    var d = U.parse(iso);
    var day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return U.iso(d);
  },
  diffDays: function (a, b) {
    return Math.round((U.parse(a) - U.parse(b)) / 86400000);
  },
  /** 周一为一周起点 */
  weekStart: function (iso) {
    var d = U.parse(iso);
    var w = d.getDay() === 0 ? 7 : d.getDay();
    return U.addDays(iso, 1 - w);
  },
  monthStart: function (iso) {
    var d = U.parse(iso);
    d.setDate(1);
    return U.iso(d);
  },
  /** 月视图网格：返回 42 天（6 周）的 iso 数组 */
  monthMatrix: function (iso) {
    var start = U.weekStart(U.monthStart(iso));
    var out = [];
    for (var i = 0; i < 42; i++) out.push(U.addDays(start, i));
    return out;
  },
  fmtMD: function (iso) {
    var d = U.parse(iso);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  },
  fmtFull: function (iso) {
    var d = U.parse(iso);
    var wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + wd;
  },
  weekdayShort: function (iso) {
    var d = U.parse(iso);
    return ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  },
  weekdayOf: function (iso) { return U.parse(iso).getDay(); },
  relLabel: function (iso) {
    var n = U.diffDays(iso, U.today());
    if (n === 0) return '今天';
    if (n === 1) return '明天';
    if (n === 2) return '后天';
    if (n === -1) return '昨天';
    if (n < 0) return '逾期 ' + (-n) + ' 天';
    return U.fmtMD(iso);
  },
  timeToMin: function (t) {
    if (!t) return null;
    var p = String(t).split(':');
    return (+p[0]) * 60 + (+p[1]);
  },
  minToTime: function (m) {
    m = Math.max(0, Math.min(1439, Math.round(m)));
    return U.pad(Math.floor(m / 60)) + ':' + U.pad(m % 60);
  },
  fmtDuration: function (min) {
    if (!min) return '';
    if (min < 60) return min + '分钟';
    var h = Math.floor(min / 60), r = min % 60;
    return r ? h + '小时' + r + '分' : h + '小时';
  },
  fmtMoney: function (n) {
    n = Number(n) || 0;
    return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  },
  nowMin: function () {
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  },

  /* ---------- 重复规则 ---------- */

  /** 生成一份空的重复规则 */
  emptyRepeat: function (date) {
    return {
      unit: 'none',          /* none | day | week | month | year */
      n: 1,                  /* 每隔几个单位 */
      weekdays: [],          /* unit=week 时生效；空表示沿用原日期的星期 */
      monthday: (date ? U.parse(date).getDate() : U.parse(U.today()).getDate()),
      end: null              /* null | {type:'date',date:'YYYY-MM-DD'} | {type:'count',count:N} */
    };
  },

  /** 把旧的字符串型 repeat 升级成对象 */
  toRepeat: function (old, date) {
    var r = U.emptyRepeat(date);
    if (!old) return r;
    if (typeof old === 'string') {
      var map = { none: 'none', daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };
      r.unit = map[old] || 'none';
      if (r.unit === 'week') r.weekdays = [U.weekdayOf(date || U.today())];
      return r;
    }
    r.unit = old.unit || 'none';
    r.n = Math.max(1, Number(old.n) || 1);
    r.weekdays = Array.isArray(old.weekdays) ? old.weekdays.slice() : [];
    r.monthday = old.monthday || r.monthday;
    r.end = old.end || null;
    return r;
  },

  repeatLabel: function (r) {
    if (!r || r.unit === 'none') return '';
    var n = Math.max(1, r.n || 1);
    var wd = (r.weekdays && r.weekdays.length)
      ? r.weekdays.slice().sort().map(function (d) { return ['日', '一', '二', '三', '四', '五', '六'][d]; }).join('、')
      : '';
    if (r.unit === 'day') return n === 1 ? '每天' : '每 ' + n + ' 天';
    if (r.unit === 'week') {
      if (n === 1) return wd ? '每周' + wd : '每周';
      return '每 ' + n + ' 周' + (wd ? ' 的周' + wd : '');
    }
    if (r.unit === 'month') {
      var md = r.monthday ? r.monthday + ' 号' : '';
      return n === 1 ? ('每月' + (md ? ' ' + md : '')) : ('每 ' + n + ' 个月' + (md ? ' ' + md : ''));
    }
    return n === 1 ? '每年' : '每 ' + n + ' 年';
  },

  esc: function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
};

var DB = {
  state: null,

  uid: function () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  },

  /* ---------- 存储 ---------- */
  load: function () {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && s.tasks) { DB.state = s; DB.normalize(); return; }
      }
    } catch (e) { console.warn('读取本地数据失败', e); }
    DB.state = DB.seed();
    DB.save();
  },

  save: function () {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(DB.state));
    } catch (e) {
      console.warn('保存失败', e);
      if (window.UI && UI.toast) UI.toast('保存失败，可能是存储空间已满');
    }
  },

  normalize: function () {
    var s = DB.state;
    s.version = 3;
    s.tasks = s.tasks || [];
    s.trash = (s.trash || []).filter(function (x) {
      return x.kind !== 'list' && x.kind !== 'note' && x.kind !== 'notebook';
    });
    s.ui = s.ui || {};

    /* 清单功能已移除 */
    delete s.lists;
    delete s.ui.listFilter;

    /* 定位改为纯任务管理：备忘录模块移除，旧数据转存到 archive（导出备份时会带上） */
    if ((s.notes && s.notes.length) || (s.notebooks && s.notebooks.length)) {
      s.archive = {
        notebooks: s.notebooks || [],
        notes: s.notes || [],
        archivedAt: Date.now()
      };
      try {
        localStorage.setItem('schedule-app-notes-archive', JSON.stringify(s.archive));
      } catch (e) { console.warn('备忘录归档失败', e); }
    }
    delete s.notebooks;
    delete s.notes;
    delete s.ui.notebookId;
    delete s.ui.noteId;

    if (s.ui.theme !== 'dark') s.ui.theme = 'light';
    if (!s.ui.view) s.ui.view = 'day';
    if (!s.ui.nav) s.ui.nav = 'today';
    if (!s.ui.cursor) s.ui.cursor = U.today();
    if (s.ui.nav === 'notes') s.ui.nav = 'today';

    /* 侧栏顺序：可拖动自定义，落盘保存 */
    var NAV_ALL = ['inbox', 'today', 'overdue', 'calendar', 'habits', 'done', 'trash'];
    var order = Array.isArray(s.ui.navOrder) ? s.ui.navOrder.filter(function (k) {
      return NAV_ALL.indexOf(k) >= 0;
    }) : [];
    NAV_ALL.forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    s.ui.navOrder = order;
    var bottom = Array.isArray(s.ui.navBottom) ? s.ui.navBottom.filter(function (k) {
      return order.indexOf(k) >= 0;
    }) : null;
    /* 只有「从未设置过」才给默认分组；空数组是用户主动把垃圾箱拖出底部后的合法状态 */
    s.ui.navBottom = bottom === null ? ['trash'] : bottom;

    /* 每日打卡习惯 */
    s.habits = s.habits || [];
    s.habits.forEach(function (h) {
      h.log = h.log || {};
      if (h.order == null) h.order = 0;
    });

    /* 任务字段升级：repeat 对象化 + 排序位 */
    var bucket = {};
    s.tasks.forEach(function (t) {
      t.repeat = U.toRepeat(t.repeat, t.date);
      if (!t.time && t.order == null) {
        var key = t.date || '_';
        bucket[key] = (bucket[key] || 0);
        t.order = bucket[key]++;
      }
      if (!t.duration) t.duration = 60;
    });
  },

  seed: function () {
    var t = U.today();
    var s = {
      version: 3,
      tasks: [
        { id: DB.uid(), title: '团队早会', note: '', date: t, time: '09:30', duration: 30, done: true, repeat: { unit: 'day', n: 1, weekdays: [], monthday: 4, end: null }, repeatSeq: 0, order: 0, createdAt: Date.now(), doneAt: Date.now(), source: null },
        { id: DB.uid(), title: '整理季度汇报大纲', note: '先列结构，再填数据', date: t, time: '14:00', duration: 90, done: false, repeat: { unit: 'none', n: 1, weekdays: [], monthday: 4, end: null }, order: 0, createdAt: Date.now(), doneAt: null, source: null },
        { id: DB.uid(), title: '取快递', note: '', date: t, time: null, duration: 60, done: false, repeat: { unit: 'none', n: 1, weekdays: [], monthday: 4, end: null }, order: 0, createdAt: Date.now(), doneAt: null, source: null },
        { id: DB.uid(), title: '牙医复诊', note: '带上次的片子', date: U.addDays(t, 1), time: '15:30', duration: 60, done: false, repeat: { unit: 'none', n: 1, weekdays: [], monthday: 5, end: null }, order: 0, createdAt: Date.now(), doneAt: null, source: null },
        { id: DB.uid(), title: '交房租', note: '', date: U.addDays(t, -2), time: null, duration: 60, done: false, repeat: { unit: 'month', n: 1, weekdays: [], monthday: 2, end: null }, order: 0, createdAt: Date.now() - 86400000 * 3, doneAt: null, source: null },
        { id: DB.uid(), title: '研究一下新显示器', note: '等发工资再说', date: null, time: null, duration: 60, done: false, repeat: { unit: 'none', n: 1, weekdays: [], monthday: 4, end: null }, order: 0, createdAt: Date.now(), doneAt: null, source: null },
        { id: DB.uid(), title: '给导师发季度进展', note: '', date: null, time: null, duration: 60, done: false, repeat: { unit: 'none', n: 1, weekdays: [], monthday: 4, end: null }, order: 1, createdAt: Date.now() + 1000, doneAt: null, source: null }
      ],
      trash: [],
      habits: [
        { id: DB.uid(), title: '学英语', order: 0, log: {}, createdAt: Date.now() },
        { id: DB.uid(), title: '学西班牙语', order: 1, log: {}, createdAt: Date.now() },
        { id: DB.uid(), title: '训练小狗', order: 2, log: {}, createdAt: Date.now() }
      ],
      ui: {
        nav: 'today', view: 'day', cursor: t, theme: 'light', search: '',
        navOrder: ['inbox', 'today', 'overdue', 'calendar', 'habits', 'done', 'trash'],
        navBottom: ['trash']
      }
    };
    return s;
  },

  /* ---------- 查询 ---------- */
  taskById: function (id) {
    return DB.state.tasks.filter(function (t) { return t.id === id; })[0] || null;
  },

  /** 未定时任务之间的比较：手动顺序 > 优先级 > 创建时间 */
  orderCmp: function (a, b) {
    var oa = a.order == null ? 1e9 : a.order;
    var ob = b.order == null ? 1e9 : b.order;
    if (oa !== ob) return oa - ob;
    return (a.createdAt || 0) - (b.createdAt || 0);
  },

  /** 排序：有时间的按时间排前面，未定时的按手动顺序 */
  sortTasks: function (list) {
    return list.slice().sort(function (a, b) {
      var ta = U.timeToMin(a.time), tb = U.timeToMin(b.time);
      if (ta !== null && tb !== null) return ta - tb;
      if (ta !== null) return -1;
      if (tb !== null) return 1;
      return DB.orderCmp(a, b);
    });
  },

  tasksOn: function (iso) {
    var kw = DB.state.ui.search || '';
    return DB.sortTasks(DB.state.tasks.filter(function (t) {
      if (t.date !== iso) return false;
      if (kw && t.title.indexOf(kw) < 0 && (t.note || '').indexOf(kw) < 0) return false;
      return true;
    }));
  },

  /** 逾期未完成的任务数（有日期、已过期、还没做完） */
  overdueCount: function () {
    var t = U.today();
    return DB.state.tasks.filter(function (x) {
      return !x.done && x.date && x.date < t;
    }).length;
  },

  counts: function () {
    var t = U.today();
    return {
      inbox: DB.state.tasks.filter(function (x) { return !x.done && !x.date; }).length,
      today: DB.state.tasks.filter(function (x) { return !x.done && x.date === t; }).length,
      overdue: DB.overdueCount(),
      trash: DB.state.trash.length,
      habits: DB.habitsTodayRemaining()
    };
  },

  /* ---------- 任务 ---------- */

  /** 某一天（或待办箱）里下一个可用的排序位 */
  nextOrder: function (date) {
    var mx = -1;
    DB.state.tasks.forEach(function (t) {
      if (t.date === date && !t.time && t.order != null && t.order > mx) mx = t.order;
    });
    return mx + 1;
  },

  addTask: function (data) {
    var repeat = U.toRepeat(data.repeat, data.date);
    var t = {
      id: DB.uid(),
      title: data.title || '未命名任务',
      note: data.note || '',
      date: data.date || null,
      time: data.time || null,
      duration: data.duration || 60,
      done: false,
      repeat: repeat,
      repeatSeq: data.repeatSeq || 0,
      order: data.order != null ? data.order : DB.nextOrder(data.date || null),
      createdAt: Date.now(),
      doneAt: null,
      source: data.source || null
    };
    DB.state.tasks.push(t);
    DB.save();
    return t;
  },

  updateTask: function (id, patch) {
    var t = DB.taskById(id);
    if (!t) return null;
    Object.keys(patch).forEach(function (k) { t[k] = patch[k]; });
    DB.save();
    return t;
  },

  /** 组内重排：把 id 插到 sibs 里的 refId 之前 / 之后。

      写的是 ord 而不是 order —— 两者语义不同，不能混用：
        order : 「同一天、未定时间」这一组里的位次，由 addTask / reorderUntimed 维护
        ord   : 用户在**任意列表里手动拖出来的顺序**，独立于日期和时间
      混用会出事：已完成页默认按完成时刻排、今天页里的定时任务按时间排，
      一旦共用 order，用户拖完下次渲染又弹回原位，看起来就是「拖不动」。

      sibs 必须是「当前视觉顺序」的同组任务（含 id 自己）。 */
  reorderWithin: function (id, sibs, refId, pos) {
    var me = null;
    var rest = [];
    sibs.forEach(function (t) {
      if (t.id === id) me = t; else rest.push(t);
    });
    if (!me) return false;
    var idx = rest.length;
    if (refId) {
      for (var i = 0; i < rest.length; i++) {
        if (rest[i].id === refId) { idx = (pos === 'before') ? i : i + 1; break; }
      }
    }
    rest.splice(idx, 0, me);
    /* 整组重排而不是只改被拖的那一个：这是个序列，
       只写一个会留下空洞或重复，下次渲染顺序就乱了 */
    rest.forEach(function (t, i) { t.ord = i; });
    DB.save();
    return true;
  },

  /** 习惯（打卡）重排：与任务同构，只是字段住在 habit 上。
      习惯没有 order / ord 的语义冲突，直接用 order 即可 */
  reorderHabits: function (id, sibs, refId, pos) {
    var me = null;
    var rest = [];
    sibs.forEach(function (h) {
      if (h.id === id) me = h; else rest.push(h);
    });
    if (!me) return false;
    var idx = rest.length;
    if (refId) {
      for (var i = 0; i < rest.length; i++) {
        if (rest[i].id === refId) { idx = (pos === 'before') ? i : i + 1; break; }
      }
    }
    rest.splice(idx, 0, me);
    rest.forEach(function (h, i) { h.order = i; });
    DB.save();
    return true;
  },

  /** 列表排序：用户手动排过（ord 有值）就听用户的，否则用页面默认顺序。

      fallback 是各页面自己的默认口径（完成时刻倒序 / 逾期天数 / 未定时间位次）。
      没拖过的任务 ord 为 null，所以默认行为跟以前完全一样。 */
  ordCmp: function (fallback) {
    return function (a, b) {
      var oa = a.ord, ob = b.ord;
      if (oa != null && ob != null && oa !== ob) return oa - ob;
      /* 只排过一部分时，没排过的接在后面，仍按页面默认顺序 */
      if (oa != null && ob == null) return -1;
      if (oa == null && ob != null) return 1;
      return fallback(a, b);
    };
  },

  /** 把未定时的任务移到 refId 之前 / 之后，并重排同一天的顺序位 */
  reorderUntimed: function (id, date, refId, pos) {
    var t = DB.taskById(id);
    if (!t) return;
    t.date = date;
    t.time = null;
    var sibs = DB.state.tasks.filter(function (x) {
      return !x.done && !x.time && x.date === date && x.id !== id;
    }).sort(DB.orderCmp);
    var idx = sibs.length;
    if (refId) {
      for (var i = 0; i < sibs.length; i++) {
        if (sibs[i].id === refId) { idx = (pos === 'before') ? i : i + 1; break; }
      }
    }
    sibs.splice(idx, 0, t);
    sibs.forEach(function (x, i) { x.order = i; });
    DB.save();
  },

  /* ---------- 重复 ---------- */

  /** 单步推进：返回 base 之后的下一个发生日 */
  repeatAdvance: function (t, base) {
    var r = t.repeat;
    if (!r || r.unit === 'none') return null;
    var n = Math.max(1, r.n || 1);
    if (r.unit === 'day') return U.addDays(base, n);
    if (r.unit === 'week') {
      var wd = (r.weekdays && r.weekdays.length) ? r.weekdays : [U.weekdayOf(base)];
      var span = 7 * n;
      for (var i = 1; i <= span; i++) {
        var d = U.addDays(base, i);
        if (wd.indexOf(U.weekdayOf(d)) >= 0) return d;
      }
      return U.addDays(base, span);
    }
    if (r.unit === 'month') {
      var day = r.monthday || U.parse(base).getDate();
      var m = U.parse(U.addMonths(U.monthStart(base), n));
      var last = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      return m.getFullYear() + '-' + U.pad(m.getMonth() + 1) + '-' + U.pad(Math.min(day, last));
    }
    return U.addMonths(base, 12 * n);
  },

  /** 下一个实例日期：补到今天之后，并检查结束条件 */
  repeatNext: function (t, base) {
    var r = t.repeat;
    if (!r || r.unit === 'none') return null;
    var next = DB.repeatAdvance(t, base);
    var guard = 0;
    while (next && next < U.today() && guard++ < 800) next = DB.repeatAdvance(t, next);
    if (!next) return null;
    if (r.end) {
      if (r.end.type === 'date' && r.end.date && next > r.end.date) return null;
      if (r.end.type === 'count' && (t.repeatSeq || 0) + 1 > (r.end.count || 0)) return null;
    }
    return next;
  },

  toggleDone: function (id) {
    var t = DB.taskById(id);
    if (!t) return null;
    t.done = !t.done;
    t.doneAt = t.done ? Date.now() : null;
    if (t.done && t.repeat && t.repeat.unit !== 'none') {
      var base = t.date || U.today();
      var next = DB.repeatNext(t, base);
      if (next) {
        t.repeatSeq = (t.repeatSeq || 0) + 1;
        DB.addTask({
          title: t.title, note: t.note, date: next, time: t.time,
          duration: t.duration,
          repeat: JSON.parse(JSON.stringify(t.repeat)),
          repeatSeq: t.repeatSeq, source: t.source
        });
      }
    }
    DB.save();
    return t;
  },

  removeTask: function (id) {
    var t = DB.taskById(id);
    if (!t) return;
    DB.state.tasks = DB.state.tasks.filter(function (x) { return x.id !== id; });
    DB.toTrash('task', t, '任务列表');
    DB.save();
  },

  /* ---------- 每日打卡（习惯） ---------- */

  habitById: function (id) {
    return DB.state.habits.filter(function (h) { return h.id === id; })[0] || null;
  },

  addHabit: function (title) {
    title = (title || '').trim();
    if (!title) return null;
    var h = { id: DB.uid(), title: title, order: DB.state.habits.length, log: {}, createdAt: Date.now() };
    DB.state.habits.push(h);
    DB.save();
    return h;
  },

  deleteHabit: function (id) {
    DB.state.habits = DB.state.habits.filter(function (h) { return h.id !== id; });
    DB.save();
  },

  /** 勾选 / 取消某一天的打卡（默认今天） */
  toggleHabit: function (id, iso) {
    var h = DB.habitById(id);
    if (!h) return null;
    iso = iso || U.today();
    h.log = h.log || {};
    if (h.log[iso]) delete h.log[iso]; else h.log[iso] = true;
    DB.save();
    return h;
  },

  /** 连续打卡天数：今天已打则从今天起算，否则从昨天起算 */
  habitStreak: function (h) {
    if (!h || !h.log) return 0;
    var n = 0;
    var d = U.today();
    if (!h.log[d]) {
      d = U.addDays(d, -1);
      if (!h.log[d]) return 0;
    }
    while (h.log[d]) { n++; d = U.addDays(d, -1); }
    return n;
  },

  habitsTodayRemaining: function () {
    var t = U.today();
    return DB.state.habits.filter(function (h) { return !h.log || !h.log[t]; }).length;
  },

  /* ---------- 垃圾箱 ---------- */
  toTrash: function (kind, payload, from, groupId) {
    DB.state.trash.unshift({
      id: DB.uid(), kind: kind, payload: JSON.parse(JSON.stringify(payload)),
      from: from || '', groupId: groupId || null, deletedAt: Date.now()
    });
  },

  restoreTrash: function (id) {
    var item = DB.state.trash.filter(function (x) { return x.id === id; })[0];
    if (!item) return;
    var group = item.groupId;
    var items = group
      ? DB.state.trash.filter(function (x) { return x.groupId === group; })
      : [item];
    items.forEach(function (it) {
      if (it.kind === 'task') {
        var t = it.payload;
        t.repeat = U.toRepeat(t.repeat, t.date);
        DB.state.tasks.push(t);
      }
    });
    DB.state.trash = DB.state.trash.filter(function (x) { return items.indexOf(x) < 0; });
    DB.save();
  },

  removeTrashItem: function (id) {
    DB.state.trash = DB.state.trash.filter(function (x) { return x.id !== id; });
    DB.save();
  },

  emptyTrash: function () {
    DB.state.trash = [];
    DB.save();
  }
};

window.U = U;
window.DB = DB;

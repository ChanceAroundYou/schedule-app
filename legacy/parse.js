/* 自然语言解析：把「明天下午3点 交周报 2小时 每周一」拆成任务字段
 * 识别成功的片段会从原文里摘掉，剩下干净的任务标题。
 * 返回 { title, date, time, duration, repeat, chips }，未识别的字段为 null。
 */
var Parse = (function () {

  var CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  var WD = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  var PERIOD = { 早上: 0, 早晨: 0, 上午: 0, 凌晨: 0, 中午: 12, 下午: 12, 傍晚: 12, 晚上: 12, 夜里: 12, 半夜: 0 };

  var PERIODS = '早上|早晨|上午|凌晨|中午|下午|傍晚|晚上|夜里|半夜';
  var NUM = '(?:[0-9]{1,2}|[一二三四五六七八九十两]{1,3})';

  function cn(s) {
    if (s == null || s === '') return null;
    s = String(s);
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    var i = s.indexOf('十');
    if (i >= 0) {
      var a = s.slice(0, i), b = s.slice(i + 1);
      var A = a === '' ? 1 : CN[a];
      if (A == null) return null;
      var n = A * 10;
      if (b !== '') {
        var B = CN[b];
        if (B == null) return null;
        n += B;
      }
      return n;
    }
    if (s.length === 1) return CN[s] == null ? null : CN[s];
    return null;
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function padMonthLabel(iso) { return U.fmtMD(iso); }

  /** 未来某周的第 N 天 */
  function nthWeekday(today, weeks, wd) {
    var base = U.addDays(U.weekStart(today), weeks * 7);
    var want = wd === 0 ? 7 : wd;
    return U.addDays(base, want - 1);
  }

  function rulesOf(today) {
    var curMonth = U.parse(today).getMonth() + 1;
    var curYear = U.parse(today).getFullYear();

    /** 组装 YYYY-MM-DD，自动处理跨年与当月天数上限 */
    function mkDate(mo, dd) {
      var y = curYear;
      if (mo < curMonth) y += 1;
      var last = new Date(y, mo, 0).getDate();
      return y + '-' + pad(mo) + '-' + pad(Math.min(dd, last));
    }

    return [

      /* ============ 重复（必须在日期之前，否则「每周一」会被「周一」吃掉） ============ */
      {
        re: /工作日/g,
        fn: function (o) {
          o.repeat = { unit: 'week', n: 1, weekdays: [1, 2, 3, 4, 5], monthday: 1, end: null };
          return '工作日重复';
        }
      },
      {
        re: /(?:每个?|每)\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
        fn: function (o, m) {
          o.repeat = { unit: 'week', n: 1, weekdays: [WD[m[1]]], monthday: 1, end: null };
          return '每周' + m[1];
        }
      },
      {
        re: /(?:每个?|每)\s*(?:周|星期|礼拜)/g,
        fn: function (o) {
          o.repeat = { unit: 'week', n: 1, weekdays: [U.weekdayOf(o.date || today)], monthday: 1, end: null };
          return '每周';
        }
      },
      {
        re: /(?:每个?|每)\s*月\s*([0-9]{1,2}|[一二三四五六七八九十]{1,2})\s*[号日]/g,
        fn: function (o, m) {
          o.repeat = { unit: 'month', n: 1, weekdays: [], monthday: cn(m[1]) || 1, end: null };
          return '每月' + (cn(m[1]) || 1) + '号';
        }
      },
      {
        re: /(?:每个?|每)\s*月/g,
        fn: function (o) {
          o.repeat = { unit: 'month', n: 1, weekdays: [], monthday: U.parse(o.date || today).getDate(), end: null };
          return '每月';
        }
      },
      { re: /(?:每天|每日|天天)/g, fn: function (o) { o.repeat = { unit: 'day', n: 1, weekdays: [], monthday: 1, end: null }; return '每天'; } },
      { re: /(?:每个?|每)\s*年/g, fn: function (o) { o.repeat = { unit: 'year', n: 1, weekdays: [], monthday: 1, end: null }; return '每年'; } },

      /* ============ 日期 ============ */
      {
        re: /([0-9]{4})\s*[\-\/年]\s*([0-9]{1,2})\s*[\-\/月]\s*([0-9]{1,2})\s*[日号]?/g,
        fn: function (o, m) {
          var mo = +m[2], dd = +m[3];
          if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null;
          o.date = m[1] + '-' + pad(mo) + '-' + pad(dd);
          return padMonthLabel(o.date);
        }
      },
      { re: /(?:今天|今日)/g, fn: function (o) { o.date = today; return '今天'; } },
      { re: /(?:明天|明日)/g, fn: function (o) { o.date = U.addDays(today, 1); return '明天'; } },
      { re: /大后天/g, fn: function (o) { o.date = U.addDays(today, 3); return '大后天'; } },
      { re: /后天/g, fn: function (o) { o.date = U.addDays(today, 2); return '后天'; } },

      {
        re: /下下\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
        fn: function (o, m) { o.date = nthWeekday(today, 2, WD[m[1]]); return padMonthLabel(o.date); }
      },
      {
        re: /下\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
        fn: function (o, m) { o.date = nthWeekday(today, 1, WD[m[1]]); return padMonthLabel(o.date); }
      },
      {
        re: /(?:本|这)\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
        fn: function (o, m) { o.date = nthWeekday(today, 0, WD[m[1]]); return padMonthLabel(o.date); }
      },
      {
        re: /(?:周|星期|礼拜)\s*([一二三四五六日天])/g,
        fn: function (o, m) {
          var d = nthWeekday(today, 0, WD[m[1]]);
          if (d < today) d = U.addDays(d, 7);
          o.date = d;
          return padMonthLabel(d);
        }
      },
      {
        re: new RegExp(NUM + '\\s*(?:天|日)\\s*(?:以)?后', 'g'),
        fn: function (o, m, ctx) {
          if (!ctx.isolated) return null;
          var n = cn(m[0].replace(/[天日以后\s]/g, ''));
          if (n == null) return null;
          o.date = U.addDays(today, n);
          return n + '天后';
        }
      },
      {
        re: /(?:下个?月|下月)\s*([0-9]{1,2}|[一二三四五六七八九十]{1,2})\s*[号日]/g,
        fn: function (o, m) {
          var d = U.parse(U.addMonths(today, 1));
          var dd = cn(m[1]);
          if (!dd) return null;
          var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
          o.date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(Math.min(dd, last));
          return padMonthLabel(o.date);
        }
      },
      {
        re: new RegExp('([0-9]{1,2}|[一二三四五六七八九十]{1,2})\\s*月\\s*(' + NUM + ')\\s*[号日]', 'g'),
        fn: function (o, m, ctx) {
          if (!ctx.leftOk) return null;
          var mo = cn(m[1]), dd = cn(m[2]);
          if (!mo || !dd || mo < 1 || mo > 12) return null;
          o.date = mkDate(mo, dd);
          return padMonthLabel(o.date);
        }
      },
      {
        re: new RegExp('(' + NUM + ')\\s*[号日](?![\\u4e00-\\u9fa5])', 'g'),
        fn: function (o, m, ctx) {
          if (!ctx.isolated) return null;
          var dd = cn(m[1]);
          if (!dd || dd > 31) return null;
          o.date = mkDate(curMonth, dd);
          if (o.date < today) o.date = mkDate(curMonth + 1, dd);
          return padMonthLabel(o.date);
        }
      },
      {
        re: /([0-9]{1,2})\s*[\/\-]\s*([0-9]{1,2})(?![0-9])/g,
        fn: function (o, m, ctx) {
          if (ctx.beforeNum) return null;
          var mo = +m[1], dd = +m[2];
          if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null;
          o.date = mkDate(mo, dd);
          return padMonthLabel(o.date);
        }
      },
      {
        re: /(?:这个?月底|这个?月末|月底|月末)/g,
        fn: function (o) {
          var d = U.parse(today);
          var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
          o.date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(last);
          return '月底';
        }
      },
      {
        re: /(?:下个?月|下月)/g,
        fn: function (o) {
          o.date = U.addMonths(today, 1);
          return padMonthLabel(o.date);
        }
      },

      /* ============ 时长 ============ */
      {
        re: new RegExp(NUM + '\\s*(?:个)?\\s*(?:小时|钟头)(?:\\s*(' + NUM + ')\\s*分(?:钟)?)?', 'g'),
        fn: function (o, m) {
          var hm = m[0].match(new RegExp('^(' + NUM + ')'));
          if (!hm) return null;
          var v = (cn(hm[1]) || 0) * 60 + (m[1] ? (cn(m[1]) || 0) : 0);
          if (!v) return null;
          o.duration = Math.min(720, v);
          return U.fmtDuration(v);
        }
      },
      {
        re: new RegExp('([0-9]{1,3}|[一二三四五六七八九十]{1,3})\\s*分钟', 'g'),
        fn: function (o, m) {
          var v = cn(m[1]);
          if (!v) return null;
          o.duration = Math.min(720, v);
          return U.fmtDuration(v);
        }
      },
      { re: /半小时/g, fn: function (o) { o.duration = 30; return '30分钟'; } },

      /* ============ 时间 ============ */
      {
        re: new RegExp('(' + PERIODS + ')?\\s*([0-9]{1,2})\\s*[:：]\\s*([0-9]{1,2})', 'g'),
        fn: function (o, m) {
          var h = +m[2], mi = +m[3];
          if (h > 23 || mi > 59) return null;
          if (m[1] && PERIOD[m[1]] === 12 && h < 12) h += 12;
          o.time = pad(h % 24) + ':' + pad(mi);
          return o.time;
        }
      },
      {
        re: new RegExp('(' + PERIODS + ')?\\s*(' + NUM + ')\\s*点(?:\\s*(半|一刻|三刻))?(?:\\s*(' + NUM + ')\\s*分(?:钟)?)?', 'g'),
        fn: function (o, m, ctx) {
          var h = cn(m[2]), mi = 0;
          if (h == null || h > 23) return null;
          if (m[3]) mi = { 半: 30, 一刻: 15, 三刻: 45 }[m[3]];
          if (m[4]) mi = cn(m[4]) || 0;
          if (m[1]) {
            if (PERIOD[m[1]] === 12 && h < 12) h += 12;
            else if (PERIOD[m[1]] === 0 && h === 12) h = 0;
            o.time = pad(h % 24) + ':' + pad(mi);
            return o.time;
          }
          /* 没有时段修饰：要求整段独立成词，避免「有三点要说明」被误判 */
          /* 带「半/刻/分」时信号足够强，不需要独立成词；单独「N点」才要求 */
          if (mi === 0 && !ctx.isolated) return null;
          if (h < 8) h += 12;   /* 口语里不修饰的「3点」多半指下午 */
          o.time = pad(h % 24) + ':' + pad(mi);
          return o.time;
        }
      },
      {
        re: /([0-9]{1,2})\s*(?:pm|PM)/g,
        fn: function (o, m) {
          var h = +m[1];
          if (h > 23) return null;
          o.time = pad((h < 12 ? h + 12 : h) % 24) + ':00';
          return o.time;
        }
      },
      {
        re: /([0-9]{1,2})\s*(?:am|AM)/g,
        fn: function (o, m) {
          var h = +m[1];
          if (h > 23) return null;
          o.time = pad(h % 24) + ':00';
          return o.time;
        }
      }
    ];
  }

  /** 解析入口 */
  function parse(input, today) {
    today = today || U.today();
    var text = String(input || '').trim();
    if (!text) return null;

    var o = { title: '', date: null, time: null, duration: null, repeat: null, chips: [] };
    var s = text;

    rulesOf(today).forEach(function (rule) {
      var re = new RegExp(rule.re.source, 'g');
      s = s.replace(re, function (full) {
        var args = Array.prototype.slice.call(arguments);
        var groups = args.slice(1, args.length - 2);
        var offset = args[args.length - 2];
        var whole = args[args.length - 1];
        var before = whole.slice(0, offset);
        var after = whole.slice(offset + full.length);
        var ctx = {
          leftOk: offset === 0 || /\s$/.test(before),
          rightOk: offset + full.length === whole.length || /^\s/.test(after),
          beforeNum: /[0-9\/.\-]$/.test(before)
        };
        ctx.isolated = ctx.leftOk && ctx.rightOk;

        var m = { 0: full };
        groups.forEach(function (g, i) { m[i + 1] = g; });
        var label = rule.fn(o, m, ctx);
        if (label) {
          o.chips.push(String(label));
          return ' ';
        }
        return full;
      });
    });

    o.title = s.replace(/\s{2,}/g, ' ')
      .replace(/^[，,。.、；;：:\-\s]+/, '')
      .replace(/[，,。.、；;：:\-\s]+$/, '')
      .trim();
    if (!o.title) o.title = text;
    o.chips = o.chips.filter(Boolean);
    return o;
  }

  return { parse: parse, cn: cn };
})();

window.Parse = Parse;

/* 时间选择器：点时钟图标弹出表盘，分别选「时」和「分」。
   表盘按真实时钟画成 12 小时（12 在顶部，顺时针 1→11），再用「上午 / 下午」区分。 */
var Clock = (function () {
  var pop = null, anchor = null, cb = null;
  var mode = 'h';          /* h = 选小时，m = 选分钟 */
  var hour = 9, minute = 0; /* hour 始终用 24 小时制内部保存 */
  var C = 122, R = 94;     /* 表盘中心与半径 */

  function close() {
    if (!pop) return;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
    if (pop.parentNode) pop.parentNode.removeChild(pop);
    pop = null; anchor = null; cb = null;
  }

  function onDocDown(e) {
    if (!pop) return;
    if (pop.contains(e.target)) return;
    if (anchor && anchor.contains(e.target)) return;
    close();
  }

  function onDocKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.stopImmediatePropagation(); close(); }
  }

  function place() {
    var r = anchor.getBoundingClientRect();
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var top = r.bottom + 6;
    var left = r.left;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
  }

  /* 由内部 24 小时 hour 推导出 12 小时制显示 */
  function hour12() { return (hour % 12 === 0) ? 12 : (hour % 12); }
  function ampm() { return hour < 12 ? 'am' : 'pm'; }

  function value() { return U.pad(hour) + ':' + U.pad(minute); }

  function render() {
    var isH = mode === 'h';

    /* 表盘数字：选小时时画 12,1,2…11；选分钟时画 0,5,10…55 */
    var list, cur, idx;
    if (isH) {
      list = [];
      for (var k = 0; k < 12; k++) list.push(k === 0 ? 12 : k);
      cur = hour12();
      idx = (hour12() === 12) ? 0 : hour12();
    } else {
      list = [];
      for (var j = 0; j < 12; j++) list.push(j * 5);
      cur = minute;
      idx = Math.round(minute / 5) % 12;
    }
    var ang = (idx / 12) * 360 - 90;

    var nums = list.map(function (v, k) {
      var a = (k / 12) * 360 - 90;
      var rr = a * Math.PI / 180;
      var x = C + R * Math.cos(rr);
      var y = C + R * Math.sin(rr);
      return '<button class="cp-num' + (v === cur ? ' on' : '') + '" data-v="' + v + '"'
        + ' style="left:' + x.toFixed(1) + 'px;top:' + y.toFixed(1) + 'px">' + (isH ? v : U.pad(v)) + '</button>';
    }).join('');

    /* 中心到选中数字的指针 */
    var hand = '<i class="cp-hand" style="width:' + R + 'px;transform:rotate(' + ang.toFixed(2) + 'deg)"></i>';

    pop.innerHTML =
      '<div class="cp-ampm">'
      + '<button class="cp-ap' + (ampm() === 'am' ? ' on' : '') + '" data-ampm="am">上午</button>'
      + '<button class="cp-ap' + (ampm() === 'pm' ? ' on' : '') + '" data-ampm="pm">下午</button>'
      + '</div>'
      + '<div class="cp-display">'
      + '<button class="cp-cell' + (isH ? ' active' : '') + '" data-mode="h">' + U.pad(hour12()) + '</button>'
      + '<span class="cp-colon">:</span>'
      + '<button class="cp-cell' + (!isH ? ' active' : '') + '" data-mode="m">' + U.pad(minute) + '</button>'
      + '</div>'
      + '<div class="cp-face">' + hand + '<span class="cp-dot"></span>' + nums + '</div>'
      + '<div class="cp-tip">' + (isH ? '选小时（12 在顶部，配合上方上午 / 下午）' : '选分钟，每格 5 分钟') + '</div>'
      + '<div class="cp-foot">'
      + '<button class="chip tiny" data-cp="now">现在</button>'
      + '<button class="chip tiny" data-cp="clear">清除</button>'
      + '<span class="grow"></span>'
      + '<button class="ghost-btn" data-cp="cancel">取消</button>'
      + '<button class="primary-btn" data-cp="ok">确定</button>'
      + '</div>';

    pop.querySelectorAll('.cp-num').forEach(function (b) {
      b.onclick = function () {
        var v = +b.dataset.v;              /* 1..12 */
        if (isH) {
          var base = v % 12;              /* 12→0, 其余→v */
          hour = base + (ampm() === 'pm' ? 12 : 0);
          mode = 'm';
        } else {
          minute = v;
        }
        render();
      };
    });
    pop.querySelectorAll('.cp-cell').forEach(function (b) {
      b.onclick = function () { mode = b.dataset.mode; render(); };
    });
    pop.querySelectorAll('.cp-ap').forEach(function (b) {
      b.onclick = function () {
        var ap = b.dataset.ampm;
        var base = hour % 12;             /* 0..11 */
        hour = base + (ap === 'pm' ? 12 : 0);
        render();
      };
    });
    pop.querySelectorAll('[data-cp]').forEach(function (b) {
      b.onclick = function () {
        var a = b.dataset.cp;
        if (a === 'now') {
          var n = U.nowMin(); hour = Math.floor(n / 60); minute = n % 60; render();
        } else if (a === 'clear') {
          var f = cb; close(); if (f) f(null);
        } else if (a === 'ok') {
          var f2 = cb; var val = value(); close(); if (f2) f2(val);
        } else {
          close();
        }
      };
    });
  }

  return {
    open: function (el, current, onChange) {
      close();
      anchor = el;
      cb = onChange;
      var m = U.timeToMin(current);
      if (m == null) { var n = U.nowMin(); hour = Math.floor(n / 60); minute = 0; }
      else { hour = Math.floor(m / 60); minute = m % 60; }
      mode = 'h';
      pop = document.createElement('div');
      pop.className = 'clock-pop';
      document.body.appendChild(pop);
      render();
      place();
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onDocKey, true);
    },
    close: close,
    isOpen: function () { return !!pop; }
  };
})();

window.Clock = Clock;

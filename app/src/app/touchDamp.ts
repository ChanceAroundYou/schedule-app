/**
 * touchDamp.ts —— 未定时任务区滚到边界时的「橡皮筋」阻尼
 *
 * 为什么要有：未定时区现在是**限高 + 格内滚动**（日视图的 `.allday-zone`、
 * 周视图每列的 `.wun-cell`）。浏览器自己的滚动是"硬停"的 —— 手指还在往下
 * 拖，内容却已经不动了，手感像撞墙。这里在**越过边界**的那一段给出跟手位移，
 * 越拉越沉、松手弹回，和系统列表一个手感。
 *
 * 三条设计约束（都是踩出来的）：
 *
 * 1. **只在真能滚的容器上启用**（scrollHeight 明显大于 clientHeight）。
 *    内容没超出时也给弹性位移的话，手指一划整块内容就跑 -- 用户点空白新建
 *    那一下会点偏，得不偿失。
 * 2. **不改滚动本身**：不 preventDefault、不接管 scrollTop，原生滚动和惯性
 *    照常。我们只写一个 CSS 变量 `--pull`，由样式把内容挪开那一点。
 * 3. **位移挂在内容上，不挂在容器上**：容器有边框和底色，挪容器等于挪格子。
 *
 * 监听装在 `#content` 上一个（和点击一样走委托），不往视图里塞回调 ——
 * 视图仍然是纯展示。
 */

/** 两处限高滚动的容器 —— 改选择器记得同步 styles/calendar.css 的 `> *` 规则 */
const TARGETS = '.allday-zone, .wun-cell';

/** 最多能拉开多少（CSS px）。再大就成"把格子扯掉"了。
 *  56 → 96（2026-10-22 用户反馈「太硬」）：上限太近会让手指很快就拉不动，
 *  手感像撞在一条橡胶墙上。放宽之后同样的位移跟手更多，末端才慢慢吃劲。 */
const MAX_PULL = 96;

/** 小于这个位移压根不算拉 —— 手指轻颤不该让内容动。
 *  6 → 4（2026-10-22「太硬」）：6px 的死区之后才动，起步那一下是"跳"出去的。 */
const SLOP = 4;

/** 浮条淡出前等多久（ms）。滚动一停就开始计时 */
const THUMB_IDLE = 800;

export function installTouchDamp(root: HTMLElement): () => void {
  /** 本次触摸锁定的容器（null = 这次触摸不归我们管） */
  let el: HTMLElement | null = null;
  let startY = 0;
  let raf = 0;

  /** 阻尼曲线：一开始几乎 1:1 跟手，越拉越沉，渐近 MAX_PULL */
  const damp = (over: number) => MAX_PULL * (1 - Math.exp(-over / MAX_PULL));

  const reset = (node: HTMLElement) => {
    node.removeAttribute('data-pull');           // 有过渡了：这一下要弹回去
    node.style.setProperty('--pull', '0px');
    // 过渡走完把内联变量撤掉，别在 DOM 上留垃圾
    window.setTimeout(() => {
      if (!node.hasAttribute('data-pull')) node.style.removeProperty('--pull');
    }, 400);
  };

  const onStart = (ev: TouchEvent) => {
    if (ev.touches.length !== 1) { if (el) { reset(el); el = null; } return; }
    const t = ev.target as Element | null;
    const hit = t && typeof t.closest === 'function'
      ? (t.closest(TARGETS) as HTMLElement | null)
      : null;
    if (!hit) return;
    // 约束 1：没溢出就别掺和
    if (hit.scrollHeight <= hit.clientHeight + 4) return;
    el = hit;
    startY = ev.touches[0].clientY;
  };

  const onMove = (ev: TouchEvent) => {
    if (!el || ev.touches.length !== 1) return;
    const node = el;
    const dy = ev.touches[0].clientY - startY;
    const atTop = node.scrollTop <= 0;
    const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;

    let pull = 0;
    if (dy > SLOP && atTop) pull = damp(dy - SLOP);
    else if (dy < -SLOP && atBottom) pull = -damp(-dy - SLOP);

    if (pull === 0) {
      // 拉回滚动区间内（或者方向反过来）→ 归零，但**保持 data-pull**：
      // 这里要跟手归零，不能把过渡打开 —— 打开就会"啪"地弹一下，正是那种
      // 硬邦邦的感觉。真正的弹回只在抬手时（onEnd → reset）发生。
      if (node.hasAttribute('data-pull')) node.style.setProperty('--pull', '0px');
      return;
    }

    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (!node.isConnected) return;
      node.setAttribute('data-pull', '');   // 拉扯中不要过渡：必须跟手
      node.style.setProperty('--pull', `${pull.toFixed(1)}px`);
    });
  };

  const onEnd = () => {
    if (!el) return;
    const node = el;
    el = null;
    cancelAnimationFrame(raf);
    reset(node);
  };

  root.addEventListener('touchstart', onStart, { passive: true });
  root.addEventListener('touchmove', onMove, { passive: true });
  root.addEventListener('touchend', onEnd, { passive: true });
  root.addEventListener('touchcancel', onEnd, { passive: true });

  return () => {
    cancelAnimationFrame(raf);
    if (el) { el.style.removeProperty('--pull'); el.removeAttribute('data-pull'); }
    root.removeEventListener('touchstart', onStart);
    root.removeEventListener('touchmove', onMove);
    root.removeEventListener('touchend', onEnd);
    root.removeEventListener('touchcancel', onEnd);
  };
}

/* ---------------------------------------------------------------- 滚动条浮条 */

/**
 * 浮动滚动指示条（2026-10-22 九条第 1 条）。
 *
 * 系统滚动条已经被 CSS 藏掉（不占布局宽度），这里在容器滚动的**时候**把
 * ::after 那根 3px 浮条的位置和长短写进 `--thumb-y / --thumb-h`，并把
 * `data-thumb` 置 on 让它淡入；停止滚动 THUMB_IDLE 毫秒后摘掉，自动淡出。
 *
 * 监听装在 root 上（capture —— scroll 事件不冒泡，只能捕获），和橡皮筋同一套
 * 委托思路：视图照旧零回调。
 */
export function attachScrollThumb(root: HTMLElement): () => void {
  const timers = new WeakMap<HTMLElement, number>();

  const paint = (el: HTMLElement) => {
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight + 1) {
      // 没溢出就没有「条」可言
      el.removeAttribute('data-thumb');
      el.style.removeProperty('--thumb-h');
      el.style.removeProperty('--thumb-y');
      return;
    }
    const h = Math.max(24, (clientHeight / scrollHeight) * clientHeight);
    const y = (scrollTop / scrollHeight) * clientHeight;
    el.style.setProperty('--thumb-h', h.toFixed(1) + 'px');
    el.style.setProperty('--thumb-y', Math.min(y, clientHeight - h).toFixed(1) + 'px');
    el.setAttribute('data-thumb', 'on');
    window.clearTimeout(timers.get(el));
    timers.set(el, window.setTimeout(() => {
      el.removeAttribute('data-thumb');
    }, THUMB_IDLE));
  };

  const onScroll = (ev: Event) => {
    const t = ev.target as Element | null;
    if (!t || typeof t.closest !== 'function' || !(t instanceof HTMLElement)) return;
    if (!t.matches(TARGETS)) return;
    paint(t);
  };

  root.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => root.removeEventListener('scroll', onScroll, { capture: true });
}

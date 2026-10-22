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

/** 最多能拉开多少（CSS px）。再大就成"把格子扯掉"了 */
const MAX_PULL = 56;

/** 小于这个位移压根不算拉 —— 手指轻颤不该让内容动 */
const SLOP = 6;

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
      // 拉回滚动区间内（或者方向反过来）→ 立刻归零，让原生滚动接手
      if (node.hasAttribute('data-pull')) { node.removeAttribute('data-pull'); node.style.setProperty('--pull', '0px'); }
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

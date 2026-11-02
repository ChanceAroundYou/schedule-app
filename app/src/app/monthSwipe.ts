/**
 * monthSwipe.ts —— 手机端月视图「上下滑翻月」
 *
 * 用户 2026-11-01 的要求（原话）：
 *   「我希望对于手机端月视图来说……当我用手指往上或者往下滑屏幕，都能像在
 *     电脑端使用鼠标滑轮一样，达到翻阅下个月的目的」
 *   「灵活翻月，比如手指下拉一点点，那就对应显示上个月的一点点，而不是一整个月」
 *   「过一大半才翻」「只在月视图」
 *
 * 三条实现要点：
 *
 * 1. **跟手，不跟"页"**：手指走多少，`--mdrag` 就写多少（位移写在一个 CSS 变量上，
 *    由 `.month-track` 的 transform 吃），中间**不 setState、不写 store** ——
 *    一次手势里最多两次 React 更新（挂/摘邻月预览），不是每帧一次。
 * 2. **邻月是"预览"不是"第二个视图"**：拖起来那一刻才把上下两个月的静态副本
 *    挂上（`MonthGhost`，见 views/calendar/MonthView.tsx）。整月真视图挂三份会
 *    让 dnd-kit 的 `day:<日期>` 放置区、`useDraggable` 的任务 id 全部重名 ——
 *    拖拽落点会错位。预览层带 `pointer-events: none`，不参与任何交互。
 * 3. **门是"过一大半"**：`|dy| > 55% 视口高` 才算翻月，否则弹回。用户明确
 *    否掉了「一点点就翻」—— 那会让人不敢滑。
 *
 * 落位：翻月复用 `store.setUi({ cursor: addMonths(±1) })`，和 `useNav().shift`
 * 同一个口径（月视图里 shift 就是 addMonths）。**视图层依旧零回调**：
 * 监听装在 `#content` 上的委托（和 touchDamp.ts 同一套模式），中间态靠模块级
 * 小 store + `useSyncExternalStore` 给视图读（shared.ts 的 stackTop 也是这么干的）。
 *
 * ⚠️ 不要动日/周视图：那两个视图上下滑是**滚动时间轴**，只有 `view === 'month'`
 *    才认这条手势（用户 2026-11-01 明确"只在月视图"）。
 */

import { useSyncExternalStore } from 'react';
import * as D from '../domain/date.ts';
import * as store from '../data/store.ts';
import { isDragging } from '../ui/dragState.ts';

/** 手指轻颤不算数（和 touchDamp 的 SLOP 同量级） */
const SLOP = 6;

/** 纵向位移必须**明显**大于横向才算翻月，否则横向手势（画动、选文字）会被吃掉 */
const DIR_RATIO = 1.2;

/** 「过一大半才翻」—— 视口高的 55%。 */
const COMMIT_RATIO = 0.55;

/** 翻月/弹回的动画时长（ms）。比系统 sheet 短一点，手感利落 */
const ANIM_MS = 200;

/* ------------------------------------------------------------ 拖拽中？ */

let active = false;
const subs = new Set<() => void>();

function setActive(v: boolean): void {
  if (active === v) return;
  active = v;
  subs.forEach((f) => f());
}

/** 手势进行中（邻月预览要不要挂） */
export function useMonthSwipeActive(): boolean {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
    () => active,
    () => false,
  );
}

/* ------------------------------------------------------------ 委托 */

/** 手势不从这里起：输入框里（就地新建）、正在拖卡片、多选、非月视图 */
function blocked(el: Element | null): boolean {
  if (!el || typeof el.closest !== 'function') return true;
  const ui = store.get().ui;
  if (ui.nav !== 'calendar' || ui.view !== 'month') return true;
  if (ui.sel !== null) return true;
  if (isDragging()) return true;
  if (el.closest('input, textarea, select, [contenteditable="true"]')) return true;
  return false;
}

export function installMonthSwipe(root: HTMLElement): () => void {
  /** 本次手势锁定的翻月容器（null = 这次不归我们管） */
  let pager: HTMLElement | null = null;
  let track: HTMLElement | null = null;
  let startX = 0;
  let startY = 0;
  let height = 0;
  /** 方向已判定为纵向 → 从此拦原生滚动 */
  let locked = false;
  let last = 0;
  let raf = 0;
  let timer = 0;

  const clearAnim = () => {
    window.clearTimeout(timer);
    timer = 0;
    track?.removeAttribute('data-md-anim');
  };

  /** 收拾干净：摘预览、归零、解绑。`keepMove` 为 false 时连拖动痕迹一起抹掉 */
  const reset = () => {
    cancelAnimationFrame(raf);
    clearAnim();
    if (track) {
      track.style.setProperty('--mdrag', '0px');
      track.removeAttribute('data-md-anim');
    }
    setActive(false);
    pager = null;
    track = null;
    locked = false;
    last = 0;
  };

  const onStart = (ev: TouchEvent) => {
    if (pager || ev.touches.length !== 1) return;
    const t = ev.target as Element | null;
    if (blocked(t)) return;
    const host = (t as Element).closest('.month-swipe') as HTMLElement | null;
    if (!host) return;
    const tr = host.querySelector('.month-track') as HTMLElement | null;
    if (!tr) return;
    pager = host;
    track = tr;
    startX = ev.touches[0].clientX;
    startY = ev.touches[0].clientY;
    last = 0;
    locked = false;
    /* 量一次高度就够：手势期间布局不会变（翻月已在手指抬起后）。
       容器高度就是「一页」，正好是翻月要走的距离。 */
    height = host.clientHeight || 1;
  };

  const onMove = (ev: TouchEvent) => {
    if (!pager || !track) return;
    /* 按住 250ms 起拖（TouchSensor 的 delay）之后这条手势归 dnd-kit 管 ——
       再写 --mdrag 就是替整屏内容搬家，和 touchDamp 里那条约束同源。 */
    if (isDragging()) { reset(); return; }
    if (ev.touches.length !== 1) { reset(); return; }

    const dx = ev.touches[0].clientX - startX;
    const dy = ev.touches[0].clientY - startY;

    if (!locked) {
      if (Math.abs(dy) < SLOP) return;
      /* 横向为主 → 永久放弃这次手势（继续往下判会跟横向滑动打架） */
      if (Math.abs(dy) <= Math.abs(dx) * DIR_RATIO) { pager = null; track = null; return; }
      locked = true;
      /* 邻月预览现在挂 —— 再晚就露黑边了 */
      setActive(true);
    }

    /* 拦原生滚动/下拉刷新。**只在判定纵向之后**拦：还没判方向就
       preventDefault 会把横向滑动、点按后的轻微位移一起弄坏。 */
    if (ev.cancelable) ev.preventDefault();

    last = Math.max(-height, Math.min(height, dy));
    const node = track;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      node.style.setProperty('--mdrag', last.toFixed(1) + 'px');
    });
  };

  /** 松手：过一大半 → 动画走到邻月再换 cursor；否则弹回 */
  const onEnd = () => {
    if (!pager || !track) { reset(); return; }
    const node = track;
    const h = height;
    const dy = last;
    const flip = Math.abs(dy) > h * COMMIT_RATIO ? (dy > 0 ? -1 : 1) : 0;

    cancelAnimationFrame(raf);

    /** 换月的同一处把位移归零：一次任务内完成，中间不会有一帧拿旧内容露脸 */
    const finish = () => {
      clearAnim();
      node.style.setProperty('--mdrag', '0px');
      setActive(false);
      pager = null;
      track = null;
      locked = false;
      last = 0;
      if (flip) {
        const ui = store.get().ui;
        store.setUi({ cursor: D.addMonths(ui.cursor, flip) });
      }
    };

    node.setAttribute('data-md-anim', '');
    node.style.setProperty('--mdrag', (flip ? (flip < 0 ? h : -h) : 0).toFixed(1) + 'px');

    /* transitionend 不一定来（后台标签、动画被合并）—— 兜个底，
       否则一次手势没走完，`pager` 一直占着，后续手势全被忽略。 */
    const done = (ev: Event) => {
      if (ev.target !== node) return;
      node.removeEventListener('transitionend', done);
      finish();
    };
    node.addEventListener('transitionend', done);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      node.removeEventListener('transitionend', done);
      finish();
    }, ANIM_MS + 120);
  };

  root.addEventListener('touchstart', onStart, { passive: true });
  root.addEventListener('touchmove', onMove, { passive: false });
  root.addEventListener('touchend', onEnd, { passive: true });
  root.addEventListener('touchcancel', onEnd, { passive: true });

  return () => {
    reset();
    root.removeEventListener('touchstart', onStart);
    root.removeEventListener('touchmove', onMove);
    root.removeEventListener('touchend', onEnd);
    root.removeEventListener('touchcancel', onEnd);
  };
}

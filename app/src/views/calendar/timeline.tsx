import { useRef, useEffect, type RefObject } from 'react';
import * as D from '../../domain/date.ts';
/**
 * timeline.tsx —— 日 / 周两视图共用的时间轴小件（P0-3）
 *
 * 抽取前这四段在 `DayView.tsx` 与 `WeekView.tsx` 里逐字重复，
 * 改一处漏一处。收口后两视图只给数据（`hours` / `win` / `range`），
 * DOM 与类名只此一处。
 *
 *   · `TimeGutter` —— 小时刻度 + 标签。**两视图都放在 `.tl-gutter` 里**，
 *     里面只有 `.tl-hour`（纯定位壳，一个像素都不画）和 `.tl-label` 这一对类；
 *     小时线由轴容器的背景渐变统一画（见 calendar.css 的 `.tl-axis, .week-cols`）。
 *   · `NowLine` —— 现在时刻那条绿线（线在轴体里）。`span` 只多一个
 *     `week-now` 修饰类（横贯整周的那条）。
 *   · `NowBall` —— 线左端那颗绿球，**画在刻度列里**。以前它是 `.tl-now::before`
 *     的 `left: -4.5px`，等于让球探进刻度列 4.5px —— 窄屏刻度列 sticky +
 *     z-index 5 就把球盖掉半边（2026-10-25 用户报的）。拆出来之后球属于刻度列
 *     那一层，天生画在它上面，不用抬任何 z-index；线仍然只在轴体里。
 *     球心仍在「刻度列 ↔ 轴体」的交界线上，一个像素没挪。
 *   · `DragRangePreview` —— 拉时间段的预览框（橡皮筋），
 *     松手就照这段开草稿。`dragBox` 在内算，调用方只给 `range + win`。
 *   · `BlankRow` —— 未定时区末尾那一整行可点空白。
 *     日用 `.allday-blank`、周用 `.wun-blank`（两者的 `--row` 兜底
 *     与 `flex` 不同，见 calendar.css），类名由调用方给，
 *     `Array.from` 的铺格逻辑只此一处。
 */

import { pctRange, spanOf, timeRange, type DayWindow } from '../../domain/layout.ts';
import { pad2 } from './shared.ts';
import type { DragRange } from './dragCreate.ts';

/** 小时刻度 + 标签。外层容器两视图都是 `.tl-gutter`（刻度列），由调用方给。 */
export function TimeGutter({ hours, win }: { hours: number[]; win: DayWindow }) {
  const span = spanOf(win);
  return (
    <>
      {hours.map((h) => (
        <div className="tl-hour" key={h} style={{ top: ((h * 60 - win.from) / span) * 100 + '%' }}>
          <span className="tl-label">{pad2(h)}:00</span>
        </div>
      ))}
    </>
  );
}

/**
 * 每分钟（对齐整分钟）重算一次百分比并**直接写进元素的 style**。
 *
 * 走 DOM 而不是 state：这条线每分钟动一次，setState 会把整棵日历重渲染一遍。
 * 窗外（`now < from` / `now > to`）时把元素藏起来而不是删掉 —— 元素由 React 挂载、
 * 样式由这里管，删掉会让两边对不上。
 */
function useNowTick(
  ref: RefObject<HTMLDivElement | null>,
  pct: number | null,
  win?: DayWindow,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || pct === null) return;
    const tick = () => {
      const now = D.nowMin();
      const p = win && (now < win.from || now > win.to) ? null
        : win ? ((now - win.from) / spanOf(win)) * 100 : pct;
      if (p === null) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.top = p + '%';
    };
    tick();
    const now = new Date();
    const delay = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    let iv = 0;
    const t0 = setTimeout(() => { tick(); iv = window.setInterval(tick, 60000); }, delay);
    return () => { clearTimeout(t0); clearInterval(iv); };
  }, [pct, win]);
}

/**
 * 现在时刻那条线。`pct` 为 null = 窗外 / 今天不在这一周，不画
 * （画出来是贴边的一条假线）。
 *
 * **线在轴体里**（`.tl-axis` / `.week-cols`），球不在这儿 —— 见 `NowBall`。
 */
export function NowLine({ pct, span = 'day', win }: { pct: number | null; span?: 'day' | 'week'; win?: DayWindow }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useNowTick(ref, pct, win);
  if (pct === null) return null;
  return (
    <div
      ref={ref}
      className={'tl-now' + (span === 'week' ? ' week-now' : '')}
      style={{ top: pct + '%' }}
    />
  );
}

/**
 * 绿球：线左端那一颗，**挂在刻度列里**（`.tl-gutter`），不是线的一部分。
 *
 * 为什么必须分开：球心的横坐标在线与刻度列的交界线上，所以它有一半在刻度列里。
 * 以前是 `.tl-now::before` 的 `left: -4.5px` —— 球跟着线一起落在轴体那一层，
 * 窄屏刻度列 `position: sticky; z-index: 5` 就把它盖掉半边（用户报
 * 「z-index 5 还是会盖在球上面」）。放进刻度列之后球属于那一层，天生画在上面，
 * **不用抬任何 z-index**，也就不会把 2026-10-22「横滑时绿线糊到刻度列」放回来。
 * 球心的纵坐标和线同一个分钟值（`top` 同一份算式），横坐标靠 CSS 的
 * `right: -4.5px` 跨在交界线上 —— 位置一个像素没挪。
 */
export function NowBall({ pct, win }: { pct: number | null; win?: DayWindow }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useNowTick(ref, pct, win);
  if (pct === null) return null;
  return <div ref={ref} className="tl-now-ball" style={{ top: pct + '%' }} />;
}

/** 拉时间段的预览框：跟着橡皮筋长，松手就照这段开草稿。 */
export function DragRangePreview({ range, win }: { range: DragRange | null; win: DayWindow }) {
  const dragBox = range ? pctRange(range.start, range.end, win) : null;
  if (!range || !dragBox) return null;
  return (
    <div className="drag-range" style={{ top: dragBox.top + '%', height: dragBox.height + '%' }}>
      <span>{timeRange(range.start, range.end - range.start)}</span>
    </div>
  );
}

/**
 * 未定时区末尾的可点空白行。`n` = 要铺几格（调用方已按
 * `untimedBlanks` 算好、草稿开着减过 1）；`cls` =
 * 日视图 `allday-blank` / 周视图 `wun-blank`。
 */
export function BlankRow({ n, cls }: { n: number; cls: 'allday-blank' | 'wun-blank' }) {
  if (n <= 0) return null;
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div className={cls} key={`blank-${i}`} aria-hidden="true" />
      ))}
    </>
  );
}

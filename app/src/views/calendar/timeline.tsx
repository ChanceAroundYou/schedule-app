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

/**
 * 小时刻度 + 标签。外层容器两视图都是 `.tl-gutter`（刻度列），由调用方给。
 *
 * ⚠️ 定位方式（2026-11-06 改）：**整数像素**，不是百分比。
 * 以前写 `top: ((h*60 - from) / span) * 100 + '%'`，而容器高度是 flex 量出来的
 * 小数（实测 575.516px）—— 每个落点都在半像素上，浏览器逐帧抗锯齿时同一条
 * 1px 线/同一个数字的相位会漂移，用户看到「横向细线和刻度数字在严重抖动」，
 * 全屏后高度凑整就不抖了。现在调用方给整数的 `pxPerHour`，这里按格计算。
 *
 * `hourPx` 传 0（还没量到）时退回百分比 —— 首帧只用一瞬间，之后就会被整数覆盖。
 */
export function TimeGutter({ hours, win, hourPx }: {
  hours: number[]; win: DayWindow; hourPx: number;
}) {
  const span = spanOf(win);
  /* 末端那根整点（win.to 正好是整点时）**钉到容器底**，不用整数坐标算：
     hourPx 向下取整后 `hourPx × spanH` 会比容器矮几像素，按坐标算末端标签
     会浮在空白上方、末端线又和日列竖线差一截。线（HourLines）和标签
     （这里）同时钉底，两者与竖线共用同一个底边（2026-11-11 真机截图实证）。 */
  const atEnd = hours.length > 0 && hours[hours.length - 1] * 60 === win.to;
  return (
    <>
      {hours.map((h, i) => {
        const last = atEnd && i === hours.length - 1;
        const top = hourPx > 0
          ? Math.round((h * 60 - win.from) / 60 * hourPx)
          : ((h * 60 - win.from) / span) * 100 + '%';
        return (
          <div
            className={last ? 'tl-hour tl-hour--last' : 'tl-hour'}
            key={h}
            style={last ? { top: 'auto', bottom: 0 } : { top }}
          >
            <span className="tl-label">{pad2(h)}:00</span>
          </div>
        );
      })}
    </>
  );
}

/**
 * 横向小时线（2026-11-06 从「背景渐变」改成**真元素**）。
 *
 * 为什么不再用 `repeating-linear-gradient`：渐变的步长只能是 `100% / 24` 这种
 * 相对值，而容器高度是 flex 量出来的小数（实测 575.516px）。两个后果：
 *   ① 落点全是半像素 → 浏览器逐帧抗锯齿时相位会漂，整排线看起来在**抖**
 *      （用户报的「横向细线严重抖动」，全屏后高度凑整就消失，正是这个）；
 *   ② 把步长改成整数像素后，`24 × step` 又凑不满容器高度（如 18×24=432 vs 438.656），
 *      底部缺一截、和按百分比定位的卡片累积错位。
 * 改成真元素之后，线、刻度标签、卡片全都走 `时间 × hourPx` 这一套整数坐标，
 * 不存在两套坐标系打架的问题。`hourPx` 由 `useTimelineMetrics` 取整给出。
 *
 * **只为看得见的整点画线**（`hours` 已经按抽稀档位过滤过），一层一个元素，
 * 数量在 8~25 之间，比渐变多不了几个节点。
 */
export function HourLines({ hours, win, hourPx }: {
  hours: number[]; win: DayWindow; hourPx: number;
}) {
  if (!hourPx) return null;
  const atEnd = hours.length > 0 && hours[hours.length - 1] * 60 === win.to;
  return (
    <div className="tl-hours" aria-hidden="true">
      {hours.map((h, i) => {
        const last = atEnd && i === hours.length - 1;
        return (
          <i
            key={h}
            className={last ? 'tl-hline tl-hline--last' : 'tl-hline'}
            style={last
              ? { top: 'auto', bottom: 0 }
              : { top: Math.round(((h * 60 - win.from) / 60) * hourPx) + 'px' }}
          />
        );
      })}
      {/* 2026-11-09 用户报「20:00 那里有两条横线，只显示一条」：
          `hours` 用 `<= win.to` 过滤，最后一项本来就是窗口末端的整点线；
          这里以前又补了一条 `.tl-hline--end` 钉底（渐变时代的遗产），
          两条线隔着 hourPx 取整的那几像素并排出现。末端线就此删掉，
          只留整点线 —— 刻度标签也还是由同一份 `hours` 驱动，不会少数字。
          2026-11-11：改成把**最后一根整点线本身**钉底（不是另补一条），
          既不会双线，又让它和日列竖线共用同一个底边。 */}
    </div>
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

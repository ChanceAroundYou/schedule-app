import { useRef, useEffect } from 'react';
import * as D from '../../domain/date.ts';
/**
 * timeline.tsx —— 日 / 周两视图共用的时间轴小件（P0-3）
 *
 * 抽取前这四段在 `DayView.tsx` 与 `WeekView.tsx` 里逐字重复，
 * 改一处漏一处。收口后两视图只给数据（`hours` / `win` / `range`），
 * DOM 与类名只此一处。
 *
 *   · `TimeGutter` —— 小时刻度 + 标签。日视图包在 `.timeline` 里
 *     （标签挂轴外）、周视图包在 `.week-gutter` 里（标签贴格内，
 *     见 calendar.css 的 `.week-gutter .tl-label` 覆盖），
 *     里面的 `.tl-hour / .tl-label` 是同一对类。
 *   · `NowLine` —— 现在线（实线 + 绿球）与拖拽线（虚线 + 绿球）
 *     同一组件，`week` 只多一个 `week-now` 修饰类（横贯整周的那条）。
 *     球心落时间轴与任务区交界线：9px 球 + 1.5px 线，
 *     `top: -3.75px` 起步（(9 − 1.5) / 2 = 3.75），
 *     在 calendar.css 的 `.tl-now::before` / lists.css 的
 *     `.tl-guide::before` 两处对齐验证。
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

/** 小时刻度 + 标签。外层容器（`.timeline` / `.week-gutter`）由调用方给。 */
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
 * 现在线 / 拖拽线。`pct` 为 null = 窗外 / 今天不在这一周，不画
 * （画出来是贴边的一条假线）。
 */
export function NowLine({ pct, span = 'day', win }: { pct: number | null; span?: 'day' | 'week'; win?: DayWindow }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || pct === null) return;
    const tick = () => {
      const now = D.nowMin();
      const p = (win && (now < win.from || now > win.to)) ? null
        : (win ? (now - win.from) / spanOf(win) * 100 : pct);
      if (p === null) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.top = p + '%';
    };
    tick();
    const now = new Date();
    const delay = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    const t0 = setTimeout(() => { tick(); const id = setInterval(tick, 60000); (el as any).__iv = id; }, delay);
    return () => { clearTimeout(t0); if ((el as any).__iv) clearInterval((el as any).__iv); };
  }, [pct, win]);
  if (pct === null) return null;
  return (
    <div
      ref={ref}
      className={'tl-now' + (span === 'week' ? ' week-now' : '')}
      style={{ top: pct + '%' }}
    />
  );
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

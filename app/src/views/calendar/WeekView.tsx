/**
 * WeekView.tsx —— 周视图
 *
 * ## 与日视图同构（2026-10-17）
 *
 * 以前周视图是「另一套东西」：自己的 `.week-*` / `.wk-*` 皮肤、写死 24 小时的
 * 像素高度、纵向能滚，跟日视图「锁单屏 + 百分比」的套路没有一处共用，
 * 于是每个改动都要问「另一边要不要跟上」。现在三件事拿到同一处：
 *
 *   1. **锁单屏、不纵向滚动**。高度交给 flex（`.week-view` 是 `#content` 的
 *      flex 子项，`.week-grid` 再 `flex:1`），窗口缩放不用重算 —— 和日视图
 *      `.content-day` 那套是同一个办法。
 *   2. **事件卡就是日视图那张**（`TaskCard.tsx`）。勾选圈、时间行、上下沿拉伸
 *      把手一行代码不差；差别只有 `lockX={false}`（7 列并排要能跨天拖）。
 *   3. **时间窗同一套换算**。`windowOf` → `coverWindow` → `pctRange`，
 *      刻度疏密用 `metrics.ts`。
 *
 * **横向还是能滑的**：窄屏装不下 7 列，左右滑是唯一出路（见 responsive.css）。
 * 用户说的「不要让我滚动」指的是纵向 —— 一天的时间不该藏在屏幕底下。
 */

import { useRef, type CSSProperties } from 'react';
import type { LocalState, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import {
  layoutOverlap, minToPct, pctRange, spanOf, timeRange, coverWindow, windowOf,
  type DayWindow, type Slot,
} from '../../domain/layout.ts';
import { tasksOn, untimedOn } from '../../domain/model.ts';
import { TaskCard, TimedCard, draftBox } from './TaskCard.tsx';
import { useDragSession, useDroppableZone } from '../../ui/dndkit.tsx';
import { useOverlayScrollbar } from '../../ui/scroll.ts';
import { pad2, type LayoutEvent } from './shared.ts';
import { draftOn, NewCellSlot } from './NewCell.tsx';
import { useDragCreate, type DragRange } from './dragCreate.ts';
import { useTimelineMetrics } from './metrics.ts';
import { useElementHeight } from '../../ui/hooks.ts';

function dayEvents(state: LocalState, iso: string): LayoutEvent[] {
  const slots: Slot<Task>[] = tasksOn(state, iso).filter((t) => t.time).map((t) => {
    const start = D.timeToMin(t.time) || 0;
    return { item: t, start, end: start + D.durOf(t.duration) };
  });
  return layoutOverlap(slots);
}

/**
 * 一周里的一列 —— **就是一根日视图的时间轴**（差在有没有左侧刻度列）。
 *
 * `.week-col` 的盒子等价于「可见时间窗那一整段」：顶边 = `win.from`、
 * 底边 = `win.to`。所以落点换算（`minFromY`）、拖拽拉段（`dragCreate`）、
 * 卡片百分比定位三者不必再区分日和周 —— 都按同一个 rect 走。
 */
function WeekColumn({
  state, d, today, win, events, nowMin, range,
}: {
  state: LocalState; d: string; today: string;
  win: DayWindow;
  events: LayoutEvent[];
  nowMin: number;
  range: DragRange | null;
}) {
  const zone = useDroppableZone(`week:${d}`);
  const { activeId } = useDragSession();
  const seed = draftOn(state.ui, `week:${d}`);
  const dragBox = range ? pctRange(range.start, range.end, win) : null;

  return (
    <div
      className={'week-col' + (d === today ? ' today' : '')}
      ref={zone.ref} data-zone-id={`week:${d}`} data-date={d}
      data-from={win.from} data-to={win.to} data-timeline=""
    >
      <div className="tl-events">
        {events.map((e) => (
          <TimedCard
            key={e.item.id} e={e} isToday={d === today} nowMin={nowMin}
            win={win} isDragSrc={activeId === e.item.id} lockX={false}
          />
        ))}
      </div>

      {/* 草稿框。有了 `seed.duration`（从时间轴上拉出来的），框就有真实长度 */}
      {seed?.time && (
        <NewCellSlot
          state={state} zoneId={`week:${d}`} className="new-cell--abs"
          style={draftBox(seed, win)}
        />
      )}
      {/* 拉时间段时的预览框：跟着橡皮筋长，松手就照这段开草稿 */}
      {range && dragBox && (
        <div className="drag-range" style={{ top: dragBox.top + '%', height: dragBox.height + '%' }}>
          <span>{timeRange(range.start, range.end - range.start)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * 未定时那一格。卡片复用日视图未定时那张（`task-el--untimed`）。
 *
 * **一条都不截断**（2026-10-22 用户：3 条以上时只给个「+3」看不懂，要全部露出来）。
 * 高度由 CSS 的 `max-height` + `overflow-y` 兜住：这一行是给时间轴让地方的，
 * 任务多的时候**在格子里自己上下滚**，不让整棵周视图被顶扁。
 *
 * 末尾**永远多留一整行空白**（`.wun-blank`，和日视图同一个约定）：点它就是
 * 「这一天再加一条未定时的」。有 `flex: 1`，所以某一列任务少、这一行被别的列
 * 撑高时，它会把剩下的空白一起接住 —— 整格都是可点的空位。
 */
function WunCell({ state, d, today }: { state: LocalState; d: string; today: string }) {
  const zone = useDroppableZone(`allday:${d}`);
  const un = untimedOn(state, d);
  const draft = draftOn(state.ui, `allday:${d}`);
  return (
    <div className={'wun-cell' + (d === today ? ' today' : '')} ref={zone.ref} data-zone-id={`allday:${d}`} data-date={d}>
      {un.map((t) => (
        <TaskCard
          key={t.id} t={t}
          cls={'task-el task-el--untimed' + (t.done ? ' done' : '')}
          style={{}} timeText={null} noteText={null}
          title={t.title} resizable={false} lockX={false}
        />
      ))}
      <NewCellSlot state={state} zoneId={`allday:${d}`} />
      {/* 草稿开着时少铺一格：输入框自己占了一格，高度不该跟着跳 */}
      {!draft && <div className="wun-blank" aria-hidden="true" />}
    </div>
  );
}

export function WeekView({ state, iso }: { state: LocalState; iso: string }) {
  const start = D.weekStart(iso);
  const osbWeek = useOverlayScrollbar<HTMLDivElement>();
  const days = Array.from({ length: 7 }, (_, i) => D.addDays(start, i));
  const today = D.today();
  const nowMin = D.nowMin();

  /* 七天的事件先算出来 —— 时间窗要按它们自动往外让（coverWindow） */
  const perDay = days.map((d) => dayEvents(state, d));
  const win = coverWindow(windowOf(state.ui), perDay.flat());

  const colsRef = useRef<HTMLDivElement | null>(null);
  const { hours } = useTimelineMetrics(win, colsRef);
  /* 容器实测高度给卡片算圆角用（半径 = 卡高 × 30%，见 calendar.css 的
     .task-el--timed）。卡的高度是百分比，乘上这个 px 才是真正的像素高。 */
  const colsH = useElementHeight(colsRef);

  const drag = useDragCreate({
    win,
    zoneAt: (target) => {
      const col = target.closest<HTMLElement>('.week-col');
      const date = col?.dataset.date;
      /* 坐标取**列本身**：列高 = 可见窗口那一整段（顶边就是 win.from），
         和日视图 `.timeline` 完全同构 */
      return col && date ? { zone: `week:${date}`, date, frame: col } : null;
    },
  });

  return (
    <div className="week-view osb" id="weekView" ref={osbWeek}>
      <div className="week-head" id="weekHead">
        <div className="week-head-gutter" />
        <div className="week-head-cols">
          {days.map((d, i) => (
            <button
              className={'week-head-cell' + (d === today ? ' today' : '') + (i >= 5 ? ' weekend' : '')}
              key={d}
              data-jump={d}
              title={'跳到 ' + D.fmtMD(d)}
            >
              <span className="wh-week">周{D.weekdayShort(d)}</span>
              <span className="wh-day">{D.parseISO(d).getDate()}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 未定时单独一行、固定高度，保证下面各列的刻度线横向对齐。
          左格只占位不写字 —— 日视图的全天区也没有标题（2026-10-18 用户）。 */}
      <div className="week-un-row">
        <div className="week-un-gutter" />
        <div className="week-un-cols">
          {days.map((d) => (
            <WunCell key={d} state={state} d={d} today={today} />
          ))}
        </div>
      </div>

      <div className="week-grid">
        {/* 左侧刻度列。**标签用的是日视图那两个类**（.tl-hour / .tl-label），
            只是把「挂在轴外」改成「贴在格子内」—— 这里右边是七天的起点，
            没有位置往左伸。 */}
        <div className="week-gutter">
          {hours.map((h) => (
            <div className="tl-hour" key={h} style={{ top: ((h * 60 - win.from) / spanOf(win)) * 100 + '%' }}>
              <span className="tl-label">{pad2(h)}:00</span>
            </div>
          ))}
        </div>
        <div
          className="week-cols" ref={colsRef} onPointerDown={drag.onPointerDown}
          data-from={win.from} data-to={win.to}
          style={{ '--wk-hours': spanOf(win) / 60, '--tl-h': colsH } as CSSProperties}
        >
          {days.map((d, i) => (
            <WeekColumn
              key={d} state={state} d={d} today={today} win={win}
              events={perDay[i]} nowMin={nowMin}
              range={drag.range && drag.range.date === d ? drag.range : null}
            />
          ))}
          {/* 「现在」这条线**横贯整周**（2026-10-22 用户要求：从周一到周日）。
              画在 .week-cols 上而不是每一列各画一段 —— 各画一段会在列与列之间
              的 1px 分隔线上断开，看着是七根短线。今天不在这一周时整条不画。 */}
          {days.includes(today) && (
            <div className="tl-now week-now" style={{ top: minToPct(nowMin, win) + '%' }} />
          )}
        </div>
      </div>
    </div>
  );
}

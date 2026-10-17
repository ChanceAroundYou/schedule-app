/**
 * WeekView.tsx —— 周视图
 *
 * ## 时间窗（2026-10-17）
 *
 * 设置里的「可调起止时间」以前只管日视图，周视图永远 0–24 点。现在两边共用
 * 同一份 `windowOf(state.ui)`。
 *
 * **做法是裁而不是缩**：每列的内容仍然是整整一天（`DAY_H` 像素、列顶代表
 * 00:00），只是把窗外那截用负偏移挪出可视区、再让外层 `overflow: hidden`
 * 剪掉。好处是三处原本按「距列顶 px ÷ DAY_H」换算的代码（tapSnap 的按下快照、
 * clickDispatch 的点击落点、layout 的初始滚动位置）一个字都不用改 ——
 * 它们读到的 rect 依旧是同一个坐标系，只是人看不见窗外那截了。
 */

import { type CSSProperties } from 'react';
import type { LocalState, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { DAY_H, HOUR_H, layoutOverlap, spanOf, timeRange, windowOf, type Slot } from '../../domain/layout.ts';
import { tasksOn, untimedOn } from '../../domain/model.ts';
import { TaskPill } from '../parts.tsx';
import { useDraggableEvent, useDroppableZone } from '../../ui/dndkit.tsx';
import { useOverlayScrollbar } from '../../ui/scroll.ts';
import { pad2, hours24, type LayoutEvent } from './shared.ts';
import { draftOn, NewCellSlot } from './NewCell.tsx';
import { useDragCreate, type DragRange } from './dragCreate.ts';

function weekEvents(state: LocalState, iso: string) {
  const slots: Slot<Task>[] = tasksOn(state, iso).filter((t) => t.time).map((t) => {
    const start = D.timeToMin(t.time) || 0;
    return { item: t, start, end: start + D.durOf(t.duration) };
  });
  return layoutOverlap(slots);
}

function WeekEvent({ e }: { e: LayoutEvent }) {
  const drag = useDraggableEvent(e.item.id);
  const t = e.item;
  const w = 100 / e.cols;
  return (
    <div
      className={'wk-event task-el' + (t.done ? ' done' : '')}
      ref={drag.ref}
      style={{ ...drag.style, top: e.start / 1440 * DAY_H, height: Math.max(20, (e.end - e.start) / 1440 * DAY_H), left: `${e.col * w}%`, width: `calc(${w}% - 3px)` }}
      {...drag.attributes}
      {...drag.listeners}
      data-id={t.id}
      title={`${t.title} ${t.time} · ${D.fmtDuration(D.durOf(t.duration))}`}
    >
      <span className="wk-time">{t.time}</span>
      <span className="wk-title">{t.title}</span>
    </div>
  );
}

function WeekColumn({ state, d, today, range }: { state: LocalState; d: string; today: string; range: DragRange | null }) {
  const zone = useDroppableZone(`week:${d}`);
  /* 周视图的高度是写死的像素（整天 DAY_H），所以草稿框也用 px 定位，
     跟 `WeekEvent` 那套换算保持一致 —— 有了具体时长就画成那一段，
     没有（点一下开的）仍是默认的一小时 */
  const seed = draftOn(state.ui, `week:${d}`);
  const min = seed?.time ? D.timeToMin(seed.time) : null;
  const len = seed?.duration && seed.duration > 0 ? seed.duration : D.durOf(null);
  return (
    <div className={'week-col' + (d === today ? ' today' : '')} ref={zone.ref} data-zone-id={`week:${d}`} data-date={d}>
      {weekEvents(state, d).map((e) => (
        <WeekEvent key={e.item.id} e={e} />
      ))}
      {min != null && (
        <NewCellSlot
          state={state} zoneId={`week:${d}`} className="new-cell--abs"
          style={{ top: (min / 1440) * DAY_H, height: Math.max(18, (len / 1440) * DAY_H) }}
        />
      )}
      {/* 拉时间段时的预览框。跟着橡皮筋长，告诉用户「松开就是这一段」 */}
      {range && (
        <div
          className="drag-range"
          style={{ top: (range.start / 1440) * DAY_H, height: ((range.end - range.start) / 1440) * DAY_H }}
        >
          <span>{timeRange(range.start, range.end - range.start)}</span>
        </div>
      )}
    </div>
  );
}

function WunCell({ state, d, today }: { state: LocalState; d: string; today: string }) {
  const zone = useDroppableZone(`allday:${d}`);
  const un = untimedOn(state, d);
  return (
    <div className={'wun-cell' + (d === today ? ' today' : '')} ref={zone.ref} data-zone-id={`allday:${d}`} data-date={d}>
      {un.length
        ? un.map((t) => <TaskPill key={t.id} task={t} />)
        : <span className="wun-empty" />}
      {/* 点这一格的任何空位 → 未定时任务就建在这一天 */}
      <NewCellSlot state={state} zoneId={`allday:${d}`} />
    </div>
  );
}

export function WeekView({ state, iso }: { state: LocalState; iso: string }) {
  const start = D.weekStart(iso);
  /* 周视图自己滚（整屏时间轴），换浮条 —— 见 ui/scroll.ts */
  const osbWeek = useOverlayScrollbar<HTMLDivElement>();
  const days = Array.from({ length: 7 }, (_, i) => D.addDays(start, i));
  const today = D.today();

  /* 可见时间窗 —— 与日视图同一个设置、同一份换算 */
  const win = windowOf(state.ui);
  const gridStyle = {
    '--wk-h': (spanOf(win) / 60) * HOUR_H + 'px',
    '--wk-offset': -(win.from / 60) * HOUR_H + 'px',
    '--wk-full': DAY_H + 'px',
  } as CSSProperties;
  /* 只画窗内的小时线。`<=` 而非 `<`：把 dayTo 设成 22:00 时底部那条结束线得在 */
  const hours = hours24().filter((h) => h * 60 >= win.from && h * 60 <= win.to);

  const drag = useDragCreate({
    win,
    zoneAt: (target) => {
      const col = target.closest<HTMLElement>('.week-col');
      const date = col?.dataset.date;
      /* 坐标取**.week-cols 容器**而不是列本身：容器的 rect 正好是可见时间窗
         （顶边 = win.from、底边 = win.to）；列自己仍是整天那么高（列顶代表
         0:00），拿它换算会把拉 1 小时算成拉半小时。 */
      const winBox = col?.parentElement;
      return col && winBox && date ? { zone: `week:${date}`, date, frame: winBox } : null;
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

      {/* 未定时单独一行、固定高度，保证下面各列的刻度线横向对齐 */}
      <div className="week-un-row">
        <div className="week-un-gutter">未定时</div>
        <div className="week-un-cols">
          {days.map((d) => (
            <WunCell key={d} state={state} d={d} today={today} />
          ))}
        </div>
      </div>

      <div className="week-grid" style={gridStyle}>
        <div className="week-gutter">
          <div className="week-hours">
            {hours.map((h) => (
              <div className="wk-hour" key={h} style={{ top: h * HOUR_H }}>
                <span>{pad2(h)}:00</span>
              </div>
            ))}
          </div>
        </div>
        {/* data-from / data-to 是给初始滚动位置读的：它按「这一屏覆盖哪一段
            分钟」折算 scrollTop，窗口收窄之后不能再按整天算 */}
        <div
          className="week-cols" onPointerDown={drag.onPointerDown}
          data-from={win.from} data-to={win.to}
        >
          {days.map((d) => (
            <WeekColumn
              key={d} state={state} d={d} today={today}
              range={drag.range && drag.range.date === d ? drag.range : null}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

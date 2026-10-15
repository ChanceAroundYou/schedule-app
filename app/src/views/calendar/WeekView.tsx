/**
 * WeekView.tsx —— 周视图
 */

import type { LocalState, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { DAY_H, HOUR_H, layoutOverlap, type Slot } from '../../domain/layout.ts';
import { tasksOn, untimedOn } from '../../domain/model.ts';
import { TaskPill } from '../parts.tsx';
import { useDraggableEvent, useDroppableZone } from '../../ui/dndkit.tsx';
import { useOverlayScrollbar } from '../../ui/scroll.ts';
import { pad2, hours24, type LayoutEvent } from './shared.ts';
import { draftOn, NewCellSlot } from './NewCell.tsx';

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

function WeekColumn({ state, d, today }: { state: LocalState; d: string; today: string }) {
  const zone = useDroppableZone(`week:${d}`);
  /* 周视图的高度是写死的像素（整天 DAY_H），所以草稿框也用 px 定位，
     跟 `WeekEvent` 那套换算保持一致 —— 高度是一小时，即新任务的默认时长 */
  const seed = draftOn(state.ui, `week:${d}`);
  const min = seed?.time ? D.timeToMin(seed.time) : null;
  return (
    <div className={'week-col' + (d === today ? ' today' : '')} ref={zone.ref} data-zone-id={`week:${d}`} data-date={d}>
      {weekEvents(state, d).map((e) => (
        <WeekEvent key={e.item.id} e={e} />
      ))}
      {min != null && (
        <NewCellSlot
          state={state} zoneId={`week:${d}`} className="new-cell--abs"
          style={{ top: (min / 1440) * DAY_H, height: HOUR_H }}
        />
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

      <div className="week-grid">
        <div className="week-gutter">
          {hours24().map((h) => (
            <div className="wk-hour" key={h} style={{ top: h * HOUR_H }}>
              <span>{pad2(h)}:00</span>
            </div>
          ))}
        </div>
        <div className="week-cols">
          {days.map((d) => (
            <WeekColumn key={d} state={state} d={d} today={today} />
          ))}
        </div>
      </div>
    </div>
  );
}

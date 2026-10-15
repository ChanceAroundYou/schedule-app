/**
 * MonthView.tsx —— 月视图
 */

import type { LocalState } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { dayLoad, tasksOn } from '../../domain/model.ts';
import { TaskPill, loadLevel } from '../parts.tsx';
import { useDroppableZone } from '../../ui/dndkit.tsx';
import { NewCellSlot } from './NewCell.tsx';

const MONTH_CELL_MAX = 8;

function MonthCell({ state, d, curMonth, today }: { state: LocalState; d: string; curMonth: number; today: string }) {
  const zone = useDroppableZone(`day:${d}`);
  const dt = D.parseISO(d);
  const out = dt.getMonth() !== curMonth;
  const ts = tasksOn(state, d);
  const more = ts.length - Math.min(ts.length, MONTH_CELL_MAX);
  const load = dayLoad(state, d);
  const lv = loadLevel(load.mins);
  return (
    <div
      className={'month-cell' + (out ? ' out' : '') + (d === today ? ' today' : '') + (lv ? ' lv' + lv : '')}
      ref={zone.ref}
      data-zone-id={`day:${d}`}
      data-date={d}
    >
      <div className="cell-head">
        <span
          className={'cell-date' + (load.count ? ' busy' : '')}
          data-jump={d}
          title="看这一天的日程"
        >{dt.getDate()}</span>
        {d === today && <span className="cell-today">今天</span>}
        {!!load.mins && (
          <span className="cell-load" title={'已排 ' + D.fmtDuration(load.mins)}>
            {D.shortLoad(load.mins)}
          </span>
        )}
      </div>
      <div className="cell-tasks">
        {ts.slice(0, MONTH_CELL_MAX).map((t) => (
          <TaskPill key={t.id} task={t} showTime />
        ))}
        {more > 0 && (
          <div className="cell-more" data-jump={d} title={'查看 ' + D.fmtMD(d) + ' 的完整日程'}>
            还有 {more} 项 ›
          </div>
        )}
        {/* 点这一格的任何空位 → 任务就建在这一天（月视图不带时间） */}
        <NewCellSlot state={state} zoneId={`day:${d}`} />
      </div>
    </div>
  );
}

export function MonthView({ state, iso }: { state: LocalState; iso: string }) {
  const days = D.monthMatrix(iso);
  const curMonth = D.parseISO(iso).getMonth();
  const today = D.today();

  return (
    <div className="month-view">
      <div className="month-head">
        {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
          <div className="month-head-cell" key={w}>周{w}</div>
        ))}
      </div>
      <div className="month-grid">
        {days.map((d) => (
          <MonthCell key={d} state={state} d={d} curMonth={curMonth} today={today} />
        ))}
      </div>
    </div>
  );
}

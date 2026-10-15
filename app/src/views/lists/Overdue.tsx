/**
 * Overdue.tsx —— 逾期
 */

import { ListChecks } from 'lucide-react';
import type { LocalState, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { liveHabits, overdueTasks } from '../../domain/model.ts';
import { CheckinStrip, Empty } from '../parts.tsx';
import { CheckBtn, SelDot } from '../parts/CheckBtn.tsx';
import { SelBar } from './SelBar.tsx';
import { SortableList } from '../../ui/dndkit.tsx';
import { Btn } from '../../ui/kit.tsx';
import { reorderList } from '../../data/store.ts';

/** 逾期行：比普通任务行多一组「重新安排」的快捷键，都走事件委托 */
function OverdueRow({ task: t, days, sel }: { task: Task; days: number; sel: boolean | null }) {
  const t0 = D.today();
  return (
    <div
      className={'task-row task-el od-row'
        + (sel === null ? '' : ' sel-mode' + (sel ? ' sel-on' : ''))}
      data-id={t.id}
      data-untimed="1"
      data-sel={sel === null ? undefined : sel ? '1' : '0'}
    >
      {sel === null
        ? <CheckBtn id={t.id} on={!!t.done} />
        : <SelDot id={t.id} on={sel} />}
      <div className="row-main">
        <div className="row-title">{t.title}</div>
        <div className="row-meta">
          <span className="m-time od-late">逾期 {days} 天</span>
          {t.time && <><span className="dot">·</span><span className="m-time">{t.time}</span></>}
          {t.duration && t.time && <><span className="dot">·</span><span className="m-dur">{D.fmtDuration(t.duration)}</span></>}
          <span className="od-quick">
            <Btn variant="normal" size="sm" data-act="reschedule" data-id={t.id} data-date={t0}>今天</Btn>
            <Btn variant="normal" size="sm" data-act="reschedule" data-id={t.id} data-date={D.addDays(t0, 1)}>明天</Btn>
            {/* 「改到…」用离屏 <input type="date"> + showPicker()，不走完整抽屉 */}
            <Btn variant="ghost" size="sm" data-act="pick-date" data-id={t.id}>改到…</Btn>
          </span>
        </div>
      </div>
    </div>
  );
}

export function OverdueView({ state }: { state: LocalState }) {
  const list = overdueTasks(state);
  const habits = liveHabits(state);
  const sel = state.ui.sel;
  const ids = list.map((t) => t.id);
  const isSel = (id: string): boolean | null => (sel === null ? null : sel.includes(id));

  if (!list.length) {
    return (
      <>
        <CheckinStrip habits={habits} />
        <Empty text="没有逾期任务，都跟上了" icon={<ListChecks size={30} strokeWidth={1.4} />} />
      </>
    );
  }

  // 按原定日期分组，标题写清逾期了几天
  const groups = new Map<string, Task[]>();
  for (const t of list) {
    const d = t.date!;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push(t);
  }

  return (
    <div className="list-view od-view">
      <SelBar kind="overdue" sel={sel} ids={ids} />
      {[...groups.entries()].map(([d, items]) => {
        const days = Math.round((D.parseISO(D.today()).getTime() - D.parseISO(d).getTime()) / 86400000);
        return (
          <div className="list-group" key={d}>
            <div className="group-title over">
              逾期 {days} 天
              <span className="group-count">{items.length}</span>
              <span className="od-date">{D.fmtMD(d)} {D.weekdayShort(d)}</span>
            </div>
            {/* 每个日期组是独立排序作用域：组内随便拖，跨组只改顺序不搬家 ——
                搬家会改变逾期天数，那是「改期」的语义，不该由拖动顺手做掉 */}
            <SortableList
              items={items.map((t) => t.id)}
              onReorder={reorderList}
              renderItem={(id) => (
                <OverdueRow task={state.tasks[id]} days={days} sel={isSel(id)} />
              )}
              className="mc"
              scope={'day:' + d}
            />
          </div>
        );
      })}
    </div>
  );
}

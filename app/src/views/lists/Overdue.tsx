/**
 * Overdue.tsx —— 逾期
 */

import { ListChecks } from 'lucide-react';
import type { LocalState, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { overdueTasks } from '../../domain/model.ts';
import { Empty, RepeatFlag } from '../parts.tsx';
import { CheckBtn, SelDot } from '../parts/CheckBtn.tsx';
import { SelBar } from './SelBar.tsx';
import { SortableList } from '../../ui/dndkit.tsx';
import { Btn } from '../../ui/kit.tsx';

/** 逾期行：比普通任务行多一组「重新安排」的快捷键，都走事件委托 */
function OverdueRow({ task: t, days, sel, showRepeatMark }: { task: Task; days: number; sel: boolean | null; showRepeatMark: boolean }) {
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
        {/* 逾期行原先既没有循环图标、meta 里也没有周期文字 —— 一条「每周三」的任务
            逾期了却看着像一次性的，而这一页恰恰是要决定「补到今天还是扔掉」的地方。
            2026-10-28 用户定「可以加重复」：加**图标**，受同一个「重复标记」开关管
            （必填 prop，同 TaskRow / TaskCard）。周期文字「每周三」没加 —— 这一行
            meta 本来就排着「逾期 N 天 · 时间 · 时长 · 三个快捷按钮」，窄屏装不下。 */}
        <div className="row-title">{t.title}{showRepeatMark && <RepeatFlag t={t} />}</div>
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
  /* 逾期页只谈**逾期的日程**（用户 2026-10-17：「只需要显示逾期的日程，
     并不需要显示逾期的打卡」）。打卡条在「今天」页有，这里不再带一份 ——
     打卡本身也没有「逾期」这个概念，把它摆在这儿只会让人以为它也过期了。 */
  const sel = state.ui.sel;
  const ids = list.map((t) => t.id);
  const isSel = (id: string): boolean | null => (sel === null ? null : sel.includes(id));

  if (!list.length) {
    return <Empty text="没有逾期任务，都跟上了" icon={<ListChecks size={30} strokeWidth={1.4} />} />;
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
              entity="task"
              renderItem={(id) => (
                <OverdueRow task={state.tasks[id]} days={days} sel={isSel(id)} showRepeatMark={state.ui.showRepeatMark} />
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

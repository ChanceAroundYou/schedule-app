/**
 * Lists.tsx —— 待办箱 / 今天 / 逾期 / 已完成
 *
 * 「逾期」是全应用唯一的口径来源：`!done && date && date < today`。
 * 「今天」**不含逾期** —— 这两条 2026-10-05 明确拆开过，之前混在一起
 * 会让同一条任务在两个徽标里各数一次。今天页顶部只给一条很轻的逾期提示。
 *
 * 每个 `data-drop="list"` 都要有自己的 `data-scope`：拖动排序的作用域就是它，
 * 跨作用域只改顺序、不搬家。「搬家」是改期按钮的职责。
 *
 * 这些组件**不接回调**，只写 `data-act` / `data-id` —— 点击由 App 统一委托。
 */

import { Boxes, CalendarCheck, CheckCircle2, ListChecks } from 'lucide-react';
import type { LocalState, Task } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import {
  doneTasks, liveHabits, overdueCount, overdueTasks, todayDoneTasks, todayTasks, inboxTasks,
} from '../domain/model.ts';
import { Caret, CheckBtn, CheckinStrip, Empty, TaskRow } from './parts.tsx';

/* ============================== 待办箱 ============================== */

export function InboxView({ state }: { state: LocalState }) {
  const list = inboxTasks(state);
  if (!list.length) {
    return (
      <Empty
        text={state.ui.search ? '没有匹配的任务' : '待办箱是空的，想到什么先扔进来'}
        icon={<Boxes size={30} strokeWidth={1.4} />}
      />
    );
  }
  // 只显示任务本身：不要分组标题、不要右侧快捷日期、不要「未定日期」标注
  return (
    <div className="list-view">
      <div className="group-items mc" data-drop="list" data-scope="inbox">
        {list.map((t) => <TaskRow key={t.id} task={t} bare />)}
      </div>
    </div>
  );
}

/* =============================== 今天 =============================== */

export function TodayView({ state, onNav }: { state: LocalState; onNav: (nav: string) => void }) {
  const today = D.today();
  const list = todayTasks(state);
  const doneToday = todayDoneTasks(state);
  const over = overdueCount(state);
  const habits = liveHabits(state);
  // 展开状态**读 store 里的 ui.tdoneOpen**，不是组件自己的 useState。
  // 用本地状态的话，离开这一页再回来（以及刷新）都会复位 —— 用户刚展开的
  // 「今天已完成」莫名其妙又收起来了。开关走事件委托，见 App 的 toggle-tdone
  const doneOpen = state.ui.tdoneOpen;

  if (!list.length && !habits.length && !doneToday.length) {
    return (
      <Empty
        text={state.ui.search ? '没有匹配的任务' : '今天没有安排，享受一下'}
        icon={<CalendarCheck size={30} strokeWidth={1.4} />}
      />
    );
  }

  return (
    <div className="list-view">
      <CheckinStrip habits={habits} onManage={() => onNav('habits')} />

      {/* 顶部只给一条很轻的逾期提示，点进去就是「逾期」标签 */}
      {!!over && (
        <button className="od-strip" data-nav="overdue">
          <span className="od-dot" />
          {over === 1 ? '有 1 项任务逾期了' : `有 ${over} 项任务逾期了`}
          <span className="od-go">去处理 →</span>
        </button>
      )}

      <div className="mc" data-drop="list" data-scope={'day:' + today}>
        {list.map((t) => <TaskRow key={t.id} task={t} />)}
      </div>

      {/* 今天已完成的收口：日程页不再显示它们，这里随时能回看、也能反悔取消 */}
      {!!doneToday.length && (
        <div className={'today-done' + (doneOpen ? ' open' : '')} id="todayDone">
          {/* 不挂 onClick：views/ 是纯展示，开关交给 App 的点击委托去写 store */}
          <button className="td-head" data-act="toggle-tdone">
            <Caret open={doneOpen} />
            <span className="td-title">今天已完成</span>
            <span className="td-count">{doneToday.length}</span>
          </button>
          <div className="td-body mc" data-drop="list" data-scope={'done:' + today}>
            {doneToday.map((t) => <TaskRow key={t.id} task={t} showDoneAt />)}
          </div>
        </div>
      )}
    </div>
  );
}

/* =============================== 逾期 =============================== */

/** 逾期行：比普通任务行多一组「重新安排」的快捷键，都走事件委托 */
function OverdueRow({ task: t, days }: { task: Task; days: number }) {
  const t0 = D.today();
  return (
    <div className="task-row task-el od-row" data-id={t.id} data-untimed="1" draggable>
      <CheckBtn id={t.id} on={!!t.done} />
      <div className="row-main">
        <div className="row-title">{t.title}</div>
        <div className="row-meta">
          <span className="m-time od-late">逾期 {days} 天</span>
          {t.time && <><span className="dot">·</span><span className="m-time">{t.time}</span></>}
          {t.duration && t.time && <><span className="dot">·</span><span className="m-dur">{D.fmtDuration(t.duration)}</span></>}
          <span className="od-quick">
            <button className="od-btn" data-act="reschedule" data-id={t.id} data-date={t0}>今天</button>
            <button className="od-btn" data-act="reschedule" data-id={t.id} data-date={D.addDays(t0, 1)}>明天</button>
            {/* 「改到…」用离屏 <input type="date"> + showPicker()，不走完整抽屉 */}
            <button className="od-btn ghost" data-act="pick-date" data-id={t.id}>改到…</button>
          </span>
        </div>
      </div>
    </div>
  );
}

export function OverdueView({ state }: { state: LocalState }) {
  const list = overdueTasks(state);
  const habits = liveHabits(state);

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
            <div className="mc" data-drop="list" data-scope={'day:' + d}>
              {items.map((t) => <OverdueRow key={t.id} task={t} days={days} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ============================== 已完成 ============================== */

export function DoneView({ state }: { state: LocalState }) {
  const list = doneTasks(state);
  if (!list.length) {
    return <Empty text="还没有完成的任务" icon={<CheckCircle2 size={30} strokeWidth={1.4} />} />;
  }

  const groups = new Map<string, Task[]>();
  for (const t of list) {
    const d = t.doneAt ? D.isoOfTs(t.doneAt) : '未知';
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push(t);
  }

  return (
    <div className="list-view">
      {[...groups.keys()].sort().reverse().map((d) => (
        <div className="list-group" key={d}>
          <div className="group-title">
            {d === '未知' ? '未知时间' : D.relLabel(d)}
            <span className="group-count">{groups.get(d)!.length}</span>
          </div>
          {/* 按完成日分组，每组独立排序：组内可以拖，跨组不搬家 */}
          <div className="mc" data-drop="list" data-scope={'done:' + d}>
            {groups.get(d)!.map((t) => <TaskRow key={t.id} task={t} showDoneAt />)}
          </div>
        </div>
      ))}
    </div>
  );
}

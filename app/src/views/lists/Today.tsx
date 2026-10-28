/**
 * Today.tsx —— 今天
 */

import { CalendarCheck } from 'lucide-react';
import type { LocalState } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import {
  liveHabits, overdueCount, todayDoneTasks, todayTasks,
} from '../../domain/model.ts';
import { Caret, CheckinStrip, Empty, TaskRow } from '../parts.tsx';
import { colorOf } from '../../domain/people.ts';
import { SortableList } from '../../ui/dndkit.tsx';

export function TodayView({ state }: { state: LocalState }) {
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
      <CheckinStrip habits={habits} />

      {/* 顶部只给一条很轻的逾期提示，点进去就是「逾期」标签 */}
      {!!over && (
        <button className="od-strip" data-nav="overdue">
          <span className="od-dot" />
          {over === 1 ? '有 1 项任务逾期了' : `有 ${over} 项任务逾期了`}
          <span className="od-go">去处理 →</span>
        </button>
      )}

      <SortableList
        items={list.map((t) => t.id)}
        entity="task"
        renderItem={(id) => <TaskRow task={state.tasks[id]} calColor={colorOf(state.cals, state.tasks[id].calId)} showRepeatMark={state.ui.showRepeatMark} />}
        className="mc"
        scope={'day:' + today}
      />

      {/* 今天已完成的收口：日程页也会灰显它们，这里集中回看、也能反悔取消 */}
      {!!doneToday.length && (
        <div className={'today-done' + (doneOpen ? ' open' : '')} id="todayDone">
          {/* 不挂 onClick：views/ 是纯展示，开关交给 App 的点击委托去写 store。
              aria-expanded / aria-controls 要留着 —— 读屏只认这两个，
              不然「展开了什么」是句空话。 */}
          <button
            className="td-head"
            data-act="toggle-tdone"
            aria-expanded={doneOpen}
            aria-controls="todayDone"
          >
            <Caret open={doneOpen} />
            <span className="td-title">今天已完成</span>
            <span className="td-count">{doneToday.length}</span>
          </button>
          <SortableList
            items={doneToday.map((t) => t.id)}
            entity="task"
            renderItem={(id) => <TaskRow task={state.tasks[id]} showDoneAt calColor={colorOf(state.cals, state.tasks[id].calId)} showRepeatMark={state.ui.showRepeatMark} />}
            className="td-body mc"
            scope={'done:' + today}
          />
        </div>
      )}
    </div>
  );
}

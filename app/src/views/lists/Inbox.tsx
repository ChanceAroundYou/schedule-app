/**
 * Inbox.tsx —— 待办箱
 */

import { Boxes } from 'lucide-react';
import type { LocalState } from '../../domain/types.ts';
import { inboxTasks } from '../../domain/model.ts';
import { colorOf } from '../../domain/people.ts';
import { Empty, TaskRow } from '../parts.tsx';
import { SortableList } from '../../ui/dndkit.tsx';
import { SelBar } from './SelBar.tsx';

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
  const sel = state.ui.sel;
  const ids = list.map((t) => t.id);
  // 只显示任务本身：不要分组标题、不要右侧快捷日期、不要「未定日期」标注
  return (
    <div className="list-view">
      <SelBar kind="inbox" sel={sel} ids={ids} />
      <SortableList
        items={ids}
        entity="task"
        renderItem={(id) => (
          <TaskRow task={state.tasks[id]} bare sel={sel === null ? null : sel.includes(id)} calColor={colorOf(state.cals, state.tasks[id].calId)} showRepeatMark={state.ui.showRepeatMark} />
        )}
        className="mc"
        scope="inbox"
      />
    </div>
  );
}

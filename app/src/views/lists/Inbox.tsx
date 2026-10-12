/**
 * Inbox.tsx —— 待办箱
 */

import { Boxes } from 'lucide-react';
import type { LocalState } from '../../domain/types.ts';
import { inboxTasks } from '../../domain/model.ts';
import { Empty, TaskRow } from '../parts.tsx';
import { SortableList } from '../../ui/dndkit.tsx';
import * as store from '../../data/store.ts';

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
      <SortableList
        items={list.map((t) => t.id)}
        onReorder={(newOrder) => store.reorder('task', newOrder)}
        renderItem={(id) => <TaskRow task={state.tasks[id]} bare />}
        className="group-items mc"
        scope="inbox"
      />
    </div>
  );
}

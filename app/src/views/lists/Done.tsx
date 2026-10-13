/**
 * Done.tsx —— 已完成
 */

import { CheckCircle2 } from 'lucide-react';
import type { LocalState, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { doneTasks } from '../../domain/model.ts';
import { Empty, TaskRow } from '../parts.tsx';
import { SortableList } from '../../ui/dndkit.tsx';
import { reorderList } from '../../data/store.ts';

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
          <SortableList
            items={groups.get(d)!.map((t) => t.id)}
            onReorder={reorderList}
            renderItem={(id) => <TaskRow task={state.tasks[id]} showDoneAt />}
            className="mc"
            scope={'done:' + d}
          />
        </div>
      ))}
    </div>
  );
}

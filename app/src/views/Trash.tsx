/**
 * Trash.tsx —— 垃圾箱
 *
 * 删除永远是**软删除**（写 `deleted: true` 字段），没有物理删除。
 * 所以垃圾箱能还原，而且这个删除会同步到别的设备 —— 在手机删掉的任务，
 * 桌面上也会从列表消失、出现在垃圾箱里。
 *
 * 「彻底删除」写 `purged: true`，服务器快照从此不再带这条实体。
 *
 * 旧版这里用的是原生 `confirm()`，装成 PWA 后会被静默吞掉 ——
 * 「点了清空完全没反应」。现在一律走 App 委托处理器里的 `useConfirm()`。
 */

import { Trash2 } from 'lucide-react';
import type { Habit, LocalState, Task } from '../domain/types.ts';
import { trashedHabits, trashedTasks } from '../domain/model.ts';
import { Empty } from './parts.tsx';

interface Item {
  id: string;
  kind: 'task' | 'habit';
  title: string;
  from: string;
  deletedAt: number;
}

export function TrashView({ state }: { state: LocalState }) {
  const items: Item[] = [
    ...trashedTasks(state).map((t: Task) => ({
      id: t.id, kind: 'task' as const, title: t.title,
      from: t.trashFrom || '—', deletedAt: t.deletedAt || 0,
    })),
    ...trashedHabits(state).map((h: Habit) => ({
      id: h.id, kind: 'habit' as const, title: h.title,
      from: '打卡', deletedAt: h.deletedAt || 0,
    })),
  ].sort((a, b) => b.deletedAt - a.deletedAt);

  if (!items.length) {
    return <Empty text="垃圾箱是空的" icon={<Trash2 size={30} strokeWidth={1.4} />} />;
  }

  return (
    <div className="list-view">
      <div className="trash-head">
        <div className="trash-tip">删除的任务都在这里，随时可以还原。</div>
        <button className="danger-btn" data-act="empty-trash" data-count={items.length}>
          <Trash2 size={14} /> 清空垃圾箱
        </button>
      </div>

      <div className="list-group">
        <div className="mc">
          {items.map((it) => {
            const d = new Date(it.deletedAt);
            return (
              <div className="task-row trash-row" key={it.kind + ':' + it.id}>
                <span className="trash-ico"><Trash2 size={15} /></span>
                <div className="row-main">
                  <div className="row-title">{it.title}</div>
                  <div className="row-meta">
                    <span className="m-date">{it.kind === 'habit' ? '打卡' : '任务'}</span>
                    <span className="dot">·</span>
                    <span className="m-date">来自 {it.from}</span>
                    <span className="dot">·</span>
                    <span className="m-date">{d.getMonth() + 1}/{d.getDate()} 删除</span>
                  </div>
                </div>
                <span className="row-actions">
                  <button className="chip tiny" data-act="restore" data-kind={it.kind} data-id={it.id}>还原</button>
                  <button
                    className="chip tiny danger"
                    data-act="purge"
                    data-kind={it.kind}
                    data-id={it.id}
                    data-title={it.title}
                  >彻底删除</button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

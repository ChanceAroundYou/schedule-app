/**
 * app/useTaskActions.ts —— 从列表上直接动手的两件事：新建、删除
 *
 * 两个都有同一个共同点：**做完之后必须说一句话**（toast）。静默返回是最糟的
 * 一类反馈 —— 用户点了没反应，只会以为程序卡了。
 *
 * 「改字段」不在这里：那就是 `store.patchTask`，一行包一层没意义，
 * 调用方直接传 `store.patchTask` 即可（模块级函数，身份恒定）。
 */
import { useCallback } from 'react';
import * as D from '../domain/date.ts';
import * as store from '../data/store.ts';
import { toast } from '../ui/kit.tsx';
import { navLabel } from './navLabel.ts';

export interface QuickAddDraft {
  title: string;
  date: string | null;
  time: string | null;
  duration?: number | null;
  repeat?: unknown;
}

export function useTaskActions(setOpenId: (id: string | null) => void) {
  const createTask = useCallback((d: QuickAddDraft, openDetail: boolean) => {
    const id = store.addTask({
      title: d.title, date: d.date, time: d.time,
      duration: d.duration, repeat: d.repeat,
      source: 'quick-add',
    });
    if (openDetail) setOpenId(id);
    else {
      const t = store.get().tasks[id];
      toast('已添加：' + t.title + (t.date ? ' · ' + D.relLabel(t.date) : '') + (t.time ? ' ' + t.time : ''));
    }
  }, [setOpenId]);

  const removeTask = useCallback((id: string) => {
    if (!store.get().tasks[id]) return;
    store.deleteTask(id, navLabel(store.get().ui.nav));
    // 撤销靠还原墓碑，不是把快照塞回去 —— 这样撤销和别的设备是同一套语义
    toast('已删除', { label: '撤销', run: () => store.restoreTask(id) });
  }, []);

  return { createTask, removeTask };
}

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
import { seriesRootOf } from '../domain/repeat.ts';

export interface QuickAddDraft {
  title: string;
  date: string | null;
  time: string | null;
  duration?: number | null;
  repeat?: unknown;
}

export interface RepeatDeleteAsk {
  id: string;
  title: string;
  date: string | null;
}

export function useTaskActions(
  setOpenId: (id: string | null) => void,
  /** 重复任务删除时弹「删哪些」浮层（2026-10-14） */
  onRepeatAsk: (ask: RepeatDeleteAsk) => void,
) {
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

  /**
   * 删除任务。**重复任务走「删哪些」浮层**（2026-10-14 用户要求）——
   * 直接删会让「明天那一次」悄悄消失，而用户往往只是想跳过今天这一次。
   *
   * 非重复任务保持原样：直接删 + 给一次撤销。
   */
  const removeTask = useCallback((id: string) => {
    const t = store.get().tasks[id];
    if (!t) return;
    const root = seriesRootOf(t);
    // repeat.unit === 'none' 的任务 seriesRootOf 会返回 null —— 那种直接删
    if (root) {
      onRepeatAsk({ id, title: t.title, date: t.date ?? null });
      return;
    }
    store.deleteTask(id, navLabel(store.get().ui.nav));
    // 撤销靠还原墓碑，不是把快照塞回去 —— 这样撤销和别的设备是同一套语义
    toast('已删除', { label: '撤销', run: () => store.restoreTask(id) });
  }, [onRepeatAsk]);

  return { createTask, removeTask };
}

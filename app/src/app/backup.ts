/**
 * backup.ts —— 导出 / 导入备份
 *
 * **必须是一个 hook**：`exportBackup` / `importBackup` 里用了 `useCallback`，
 * `importBackup` 还要用 `useConfirm()` 拿到确认框。原先它们被拆成模块顶层的
 * 两个常量 —— 于是模块一被 import 就在 React 的渲染之外调 `useCallback`，
 * `ReactCurrentDispatcher.current` 是 null，直接抛
 * 「Cannot read properties of null (reading 'useCallback')」，
 * **整个应用白屏**（表现成「页面空的、Service Worker 也没注册」）。
 * 组件里调 hook 就该包成 hook。
 */

import { useCallback } from 'react';
import type { Project, Task } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import * as store from '../data/store.ts';
import * as engine from '../sync/engine.ts';
import { toast, useConfirm } from '../ui/kit.tsx';

export function useBackup() {
  const confirm = useConfirm();

  const exportBackup = useCallback(() => {
    const s = store.get();
    const blob = new Blob([JSON.stringify({
      version: 5,
      exportedAt: Date.now(),
      tasks: Object.values(s.tasks),
      habits: Object.values(s.habits),
      projects: Object.values(s.projects),
      ui: s.ui,
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `日程备份-${D.today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出备份');
  }, []);

  const importBackup = useCallback(async (file: File) => {
    // projects 可选：**旧备份（version 4）没有这个键**，缺了就是「没有项目」，
    // 不该拒绝整个文件 —— 那会让用户以为备份坏了。
    let data: { tasks?: Task[]; habits?: never[]; projects?: Project[] };
    try {
      data = JSON.parse(await file.text());
    } catch (_) { toast('这个文件不是有效的备份'); return; }
    if (!Array.isArray(data?.tasks)) { toast('备份里没有任务数据'); return; }

    // 打卡也要导进来。**导出时是写了 habits 的，这里曾经写死传空数组** ——
    // 于是导出的备份丢光了所有打卡项，而且界面上完全看不出少了什么
    const habits = Array.isArray(data.habits) ? data.habits as never[] : [];
    const n = data.tasks.length + habits.length;
    const ok = await confirm({
      title: `导入 ${n} 条？`,
      body: `其中任务 ${data.tasks.length} 条、打卡 ${habits.length} 条。` +
        '会和现有数据合并（同 id 覆盖，其余保留），不会先清空。',
      confirmText: '导入',
    });
    if (!ok) return;
    const added = store.loadMigrated(data.tasks, habits, data.projects || []);
    toast(`已导入 ${added} 条，正在同步`);
    void engine.syncNow();
  }, [confirm]);

  return { exportBackup, importBackup };
}

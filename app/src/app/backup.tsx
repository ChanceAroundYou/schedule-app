/**
 * backup.ts —— 导出 / 导入备份
 */

import { useCallback, useState } from 'react';
import type { Project, Task, Cal } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import * as store from '../data/store.ts';
import * as engine from '../sync/engine.ts';
import { roleOf } from '../domain/model/permission.ts';
import { canWrite } from '../domain/types/Cal.ts';
import { api } from '../data/api.ts';
import { refreshCals } from '../ui/settings/CalItem.tsx';
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
    let data: { tasks?: Task[]; habits?: never[]; projects?: Project[] };
    try {
      data = JSON.parse(await file.text());
    } catch (_) { toast('这个文件不是有效的备份'); return; }
    if (!Array.isArray(data?.tasks)) { toast('备份里没有任务数据'); return; }

    const habits = Array.isArray(data.habits) ? data.habits as never[] : [];
    const projects = Array.isArray(data.projects) ? data.projects as Project[] : [];
    const tasks = data.tasks as Task[];
    const state = store.get();

    // 收集引用到的集
    const referenced = new Map<string, string>(); // calId -> name
    for (const p of projects) {
      if (p.calId) referenced.set(p.calId, p.name || '');
    }
    for (const t of tasks) {
      if (t.calId && !referenced.has(t.calId)) referenced.set(t.calId, '');
    }
    for (const h of habits) {
      const cid = (h as { calId?: string }).calId;
      if (cid && !referenced.has(cid)) referenced.set(cid, '');
    }
    if (referenced.size === 0) referenced.set(state.ui.cal || '', '');

    // 名称兜底：从 state.cals
    for (const [cid, name] of referenced) {
      if (!name) {
        const c = state.cals.find((x) => x.id === cid);
        if (c) referenced.set(cid, c.name);
      }
    }

    // 候选：无写权限的集
    const candidates: { sourceCalId: string; name: string; existing: Cal | null }[] = [];
    for (const [cid, name] of referenced) {
      if (canWrite(roleOf(state, cid))) continue;
      const nm = name || '未命名集';
      const existing = state.cals.find((c) => c.name === nm) || null;
      candidates.push({ sourceCalId: cid, name: nm, existing });
    }

    // 选择结果
    const choices = new Map<string, { checked: boolean; useExisting: boolean }>();
    if (candidates.length > 0) {
      const body = <ImportCalPicker candidates={candidates} onChange={(m) => {
        for (const [k, v] of m) choices.set(k, v);
      }} />;
      const n = tasks.length + habits.length;
      const ok = await confirm({
        title: `导入 ${n} 条？`,
        body,
        confirmText: '导入',
      });
      if (!ok) return;
    } else {
      const n = tasks.length + habits.length;
      const ok = await confirm({
        title: `导入 ${n} 条？`,
        body: `其中任务 ${tasks.length} 条、打卡 ${habits.length} 条。会和现有数据合并。`,
        confirmText: '导入',
      });
      if (!ok) return;
    }

    // 默认全选
    for (const c of candidates) {
      if (!choices.has(c.sourceCalId)) choices.set(c.sourceCalId, { checked: true, useExisting: false });
    }

    // 解析目标 calId
    const remap = new Map<string, string>();
    const skipped = new Set<string>();
    for (const c of candidates) {
      const ch = choices.get(c.sourceCalId)!;
      if (!ch.checked) { skipped.add(c.sourceCalId); continue; }
      if (ch.useExisting && c.existing) {
        remap.set(c.sourceCalId, c.existing.id);
      } else {
        try {
          const nc = await api.createCal(c.name);
          await refreshCals();
          remap.set(c.sourceCalId, nc.id);
        } catch (_) {
          toast('创建日程集失败：' + c.name);
          skipped.add(c.sourceCalId);
        }
      }
    }

    // 过滤 + 重写
    const newTasks = tasks.filter((t) => !skipped.has(t.calId || state.ui.cal || ''));
    const newHabits = habits.filter((h) => !skipped.has((h as { calId?: string }).calId || state.ui.cal || ''));
    const newProjects = projects.filter((p) => !skipped.has(p.calId || state.ui.cal || ''));

    const target = state.ui.cal || '';
    for (const t of newTasks) {
      const cid = t.calId || target;
      t.calId = remap.get(cid) || cid;
    }
    for (const h of newHabits) {
      const hh = h as { calId?: string };
      const cid = hh.calId || target;
      hh.calId = remap.get(cid) || cid;
    }
    for (const p of newProjects) {
      const cid = p.calId || target;
      p.calId = remap.get(cid) || cid;
    }

    const added = store.loadMigrated(newTasks, newHabits, newProjects);
    toast(`已导入 ${added} 条，正在同步`);
    void engine.syncNow();
  }, [confirm]);

  return { exportBackup, importBackup };
}

function ImportCalPicker({ candidates, onChange }: {
  candidates: { sourceCalId: string; name: string; existing: Cal | null }[];
  onChange: (m: Map<string, { checked: boolean; useExisting: boolean }>) => void;
}) {
  const [state, setState] = useState(() => {
    const m = new Map<string, { checked: boolean; useExisting: boolean }>();
    for (const c of candidates) m.set(c.sourceCalId, { checked: true, useExisting: false });
    return m;
  });

  const update = (cid: string, patch: Partial<{ checked: boolean; useExisting: boolean }>) => {
    setState((prev) => {
      const next = new Map(prev);
      const cur = next.get(cid)!;
      next.set(cid, { ...cur, ...patch });
      onChange(next);
      return next;
    });
  };

  // choices 默认值在 importBackup 侧补齐，这里只在交互时通知

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12.5px]">以下日程集需要确认：</p>
      {candidates.map((c) => {
        const ch = state.get(c.sourceCalId)!;
        return (
          <label key={c.sourceCalId} className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" checked={ch.checked}
              onChange={(e) => update(c.sourceCalId, { checked: e.target.checked })} />
            <span className="flex-1">
              {c.name}
              {c.existing && ch.checked && (
                <span className="ml-2 text-[11px]">
                  <label><input type="radio" checked={!ch.useExisting}
                    onChange={() => update(c.sourceCalId, { useExisting: false })} /> 新建</label>
                  <label className="ml-2"><input type="radio" checked={ch.useExisting}
                    onChange={() => update(c.sourceCalId, { useExisting: true })} /> 使用现有「{c.existing.name}」</label>
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}

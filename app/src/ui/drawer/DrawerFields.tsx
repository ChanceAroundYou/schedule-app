/**
 * DrawerFields.tsx —— 抽屉正文的字段行
 *
 * 每个字段都是**就地改、失焦即存**（2026-10-09 精简），所以这里没有 onOk /
 * onSave，只有 onChange / onBlur，一律落在 `patch` / `setEnd` 上。
 *
 * 四行排布（2026-10-11）：日期+时间一行、日程集+项目一行、重复一行、
 * 备注一行。原先六个字段各占一整行，抽屉要滚很久才够到备注。
 */

import type { Project, Task } from '../../domain/types.ts';
import { DatePicker } from '../DatePicker.tsx';
import { TimePicker } from '../TimePicker.tsx';
import { Dropdown, Input } from '../kit.tsx';

/** 日历集 / 项目那一行的两个下拉。**项目和日程集用同一个简单下拉框**
 *  （2026-10-11）：原先项目走 SheetPicker（弹一整张 Sheet），两个并排放着时
 *  一个下拉一个弹层，看着像两种控件。项目数量有限，下拉完全够用。 */
function CalProjRow({ task, fid, calOptions, projs, onPatch, onMoveToCal }: {
  task: Task;
  fid: string;
  /** `{value,label}` 已经在 useDrawer 里算好（只列有写权限的集） */
  calOptions: { value: string; label: string }[];
  projs: Project[];
  onPatch: (id: string, fields: Partial<Task>) => void;
  onMoveToCal: (id: string, calId: string) => void;
}) {
  return (
    <div className="field-row">
      <div className="field">
        <span className="flabel" id={fid + '-cal-l'}>日程集</span>
        <Dropdown
          value={task.calId}
          options={calOptions}
          onPick={(v) => onMoveToCal(task.id, v)}
          label="日程集"
          labelledBy={fid + '-cal-l'}
          className="w-full"
        />
      </div>

      <div className="field">
        <span className="flabel" id={fid + '-proj-l'}>项目</span>
        <Dropdown
          value={task.projectId || ''}
          options={[
            { value: '', label: '无' },
            ...projs.map((p) => ({ value: p.id, label: p.name })),
          ]}
          onPick={(v) => onPatch(task.id, { projectId: v || null })}
          label="项目"
          labelledBy={fid + '-proj-l'}
          className="w-full"
        />
      </div>
    </div>
  );
}

/** 日期 + 时间那行。时间选两次：开始、结束 —— 结束设了就是一条持续任务，
 *  没设就是默认的一小时。 */
function DateTimeRow({ task, endTime, onPatch, setEnd }: {
  task: Task;
  endTime: string | null;
  onPatch: (id: string, fields: Partial<Task>) => void;
  setEnd: (v: string | null) => void;
}) {
  return (
    <div className="field-row">
      <div className="field">
        <span className="flabel">日期</span>
        <DatePicker
          value={task.date}
          onChange={(v) => onPatch(task.id, { date: v })}
        />
      </div>

      <div className="field">
        <span className="flabel">时间</span>
        <div className="time-row">
          <TimePicker
            value={task.time}
            onChange={(v) => {
              setEnd(null);
              onPatch(task.id, { time: v, ...(v === null ? { duration: null } : {}) });
            }}
          />
          {task.time && (
            <>
              <span className="time-sep" aria-hidden="true">–</span>
              <TimePicker
                value={endTime}
                onChange={setEnd}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 重复那一行：**一个按钮开一个浮层**。原先是 chips + 一整个面板摊在抽屉里 ——
 *  展开之后比「项目」和「备注」加起来还长。 */
function RepeatRow({ repLabel, onOpen }: { repLabel: string; onOpen: () => void }) {
  return (
    <div className="field">
      <button
        type="button"
        className={'rep-open' + (repLabel !== '不重复' ? ' on' : '')}
        onClick={onOpen}
      >
        <span className="rep-label">{repLabel}</span>
      </button>
    </div>
  );
}

/** 提醒那一行。值形如 "HH:mm"（同一天），null = 不提醒。
 *
 *  2026-10-14 新增：小组件也能设提醒，到点由小组件的通知负责；这里让 App
 *  也能看到 / 编辑同一个字段，两端口径一致。复用 TimePicker（自带清除 ✕）。 */
function ReminderRow({ task, onPatch }: {
  task: Task;
  onPatch: (id: string, fields: Partial<Task>) => void;
}) {
  return (
    <div className="field">
      <span className="flabel">提醒</span>
      <TimePicker
        value={task.reminder ?? null}
        onChange={(v) => onPatch(task.id, { reminder: v })}
      />
    </div>
  );
}

/** 备注那一行。placeholder 只作格式示例，不算名字 —— 名字是上面那个 `<label>`。 */
function NoteRow({ fid, note, onPatch }: { fid: string; note: string; onPatch: (v: string) => void }) {
  return (
    <div className="field">
      <label htmlFor={fid + '-note'}>备注</label>
      <Input
        id={fid + '-note'}
        type="text"
        placeholder="补充说明…"
        value={note}
        onChange={(e) => onPatch(e.target.value)}
      />
    </div>
  );
}

export { CalProjRow, DateTimeRow, RepeatRow, ReminderRow, NoteRow };

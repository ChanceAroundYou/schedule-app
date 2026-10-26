/**
 * DrawerFields.tsx —— 抽屉正文的字段行
 *
 * 每个字段都是**就地改、失焦即存**（2026-10-09 精简），所以这里没有 onOk /
 * onSave，只有 onChange / onBlur，一律落在 `patch` / `setEnd` 上。
 *
 * 四行排布（2026-10-11）：日期+时间一行、日程集+项目一行、重复一行、
 * 详细内容一行。原先六个字段各占一整行，抽屉要滚很久才够到底。
 *
 * 2026-10-26：重复和提醒并成一行（两个都是「什么时候再提醒我」这一类，
 * 各占一整行太浪费纵向空间），详细内容从 textarea 换成富文本编辑器。
 */

import type { Project, Task } from '../../domain/types.ts';
import { DatePicker } from '../overlays/DatePicker.tsx';
import { TimePicker } from '../overlays/TimePicker.tsx';
import { Dropdown } from '../kit.tsx';
import { RichNote } from '../editor/RichNote.tsx';

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
 *  展开之后比「项目」和「详细内容」加起来还长。 */
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
function ReminderRow({ task, onPatch, half }: {
  task: Task;
  onPatch: (id: string, fields: Partial<Task>) => void;
  /** 和「重复」并排时占一半宽（2026-10-26） */
  half?: boolean;
}) {
  return (
    <div className={'field' + (half ? ' field--half' : '')}>
      <span className="flabel">提醒</span>
      <TimePicker
        value={task.reminder ?? null}
        onChange={(v) => onPatch(task.id, { reminder: v })}
      />
    </div>
  );
}

/**
 * 详细内容（2026-10-15 起是「标题之外放正文的地方」；2026-10-26 升级成富文本）。
 *
 * 为什么必须是可排版的富文本而不是 textarea：用户真实写的东西是「会议要点 +
 * 一串待办 + 一条会议链接 + 现场照片」，纯文本只能把它们压成一坨 ——
 * 长链接断成两截、清单没法勾、图片贴不进来。
 *
 * 字段名仍然是 `note`（服务端按字段名存，改名等于做一次数据迁移），
 * **只有界面上叫它「详细内容」** —— 用户的口径是「标题 + 详细内容」。
 *
 * ⚠️ `key` 由调用方给（`task.id`）：编辑器是**非受控**的，只在挂载时灌一次
 * 内容。不换 key 的话切到另一个任务，里面还是上一条任务的字。
 */
function NoteRow({ fid, note, onChange }: {
  fid: string;
  note: string;
  /** 已节流后的 HTML。空内容回空串 */
  onChange: (html: string) => void;
}) {
  return (
    <div className="field field--note">
      <span className="flabel" id={fid + '-note-l'}>详细内容</span>
      <RichNote initial={note} onChange={onChange} labelledBy={fid + '-note-l'} />
    </div>
  );
}

export { CalProjRow, DateTimeRow, RepeatRow, ReminderRow, NoteRow };

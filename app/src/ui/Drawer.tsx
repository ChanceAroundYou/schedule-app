/**
 * Drawer.tsx —— 任务详情 / 编辑抽屉
 *
 * 交互统一是「列表 → 详情 → 编辑」三段式（用户 2026-10-05 裁决）：
 * 点行开抽屉看详情，改字段就地改、失焦即存。这里**没有**独立的编辑页。
 *
 * `confirm()` 一律不用 —— 原生 confirm 在 PWA 里会被静默吞掉，用户点删除
 * 完全没反应。走 useConfirm()。
 *
 * **底部没有按钮**（2026-10-09 精简）：每个字段都是就地改、失焦即存，
 * 「完成」只是关掉抽屉 —— 用标题栏那个打勾。删除也上移到标题栏。
 * 底部那排按钮唯一的用处是让人确认「我改完了」，可改完本来就不用确认。
 *
 * 日期和时间用自定义控件（DatePicker / TimePicker），不用原生 input，
 * **也没有「今天 / 明天」「12 点」这类快捷格**。时间选两次：开始、结束 ——
 * 结束时间设了就是一条持续任务，没设就是默认的一小时。
 *
 * 重复设置收在字段旁的复合浮层里，不再摊成一片 chips + 面板。
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Trash2, Check, Repeat, History, X } from 'lucide-react';
import { DatePicker } from './DatePicker.tsx';
import { TimePicker } from './TimePicker.tsx';
import { WheelPicker } from './WheelPicker.tsx';
import { MiniCalendar } from './MiniCalendar.tsx';
import type { FieldConflict, LocalState, RepeatRule, Task } from '../domain/types.ts';
import { canWrite } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import { REPEAT_UNITS, repeatLabel, repeatNext, toRepeat } from '../domain/repeat.ts';
import { liveProjects } from '../domain/model.ts';
import { Chips, Dropdown, IconBtn, Input, SheetPicker, useConfirm } from './kit.tsx';
import { useFocusTrap } from './hooks.ts';
import { useOverlayScrollbar } from './scroll.ts';

/** 没设结束时间时的默认时长。`duration` 是 `number`、不是可空的，
 *  所以「没有结束时间」只能表达成「一小时」—— 建任务那一版就是这个行为。 */
const DEFAULT_DURATION = 60;

/**
 * 「另一台设备也改过这里」。
 *
 * LWW 已经判完了，数据本身是一致的 —— 这一条**不是**要用户裁决什么，
 * 只是把静默合并的那一下说出来：不说的话，用户看到的是「我刚打的字变回
 * 旧的了」，他不知道为什么，只会以为程序坏了（跟权限那一条同一个道理）。
 *
 * 显示的是**输的那一方**的值 —— 赢的那一方的值就在上面那几个输入框里，
 * 再说一遍等于没说。
 */
function ConflictBox({ list, onDismiss }: {
  list: FieldConflict[];
  onDismiss: (field: string) => void;
}) {
  if (!list.length) return null;
  return (
    <div className="conflict-box">
      <div className="cb-head"><History size={12} /> 另一台设备也改过这个任务</div>
      {list.map((c) => (
        <div className="cb-row" key={c.field}>
          <span className="cb-text">
            {c.winner === 'theirs'
              ? <>「{FIELD_NAME[c.field] || c.field}」以那边为准：{showVal(c.field, c.theirs)}（你改的「{showVal(c.field, c.mine)}」被盖住了）</>
              : <>「{FIELD_NAME[c.field] || c.field}」以你这版为准：那边是 {showVal(c.field, c.theirs)}</>}
          </span>
          <button className="cb-x" onClick={() => onDismiss(c.field)}>知道了</button>
        </div>
      ))}
    </div>
  );
}

/** 冲突提示里那个字段叫什么。没列到的（将来加的）就直接显示字段名，不猜。 */
const FIELD_NAME: Record<string, string> = {
  title: '标题', note: '备注', date: '日期', time: '时间',
  duration: '时长', done: '完成状态', repeat: '重复',
};

/** 把值写成一句人话。null 在日期 / 时间 / 备注上是「清空」，得说出来 */
function showVal(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '（空）';
  if (field === 'date') return D.fmtMD(String(v));
  if (field === 'duration') return D.fmtDuration(Number(v));
  if (field === 'done') return v ? '已完成' : '未完成';
  if (field === 'repeat' || field === 'time') return typeof v === 'string' ? v : JSON.stringify(v);
  return String(v);
}

export function Drawer({ state, id, onClose, onPatch, onMoveToCal, onToggle, onDelete, onDismissConflict }: {
  state: LocalState;
  id: string | null;
  onClose: () => void;
  onPatch: (id: string, fields: Partial<Task>) => void;
  onMoveToCal: (id: string, calId: string) => void;
  /**
   * 勾选完成。**必须走 `store.toggleTask()`，不能自己 patch `done`。**
   *
   * 差别只在重复任务上：勾完一条「每天」的任务，要由 toggleTask 派生出下一个
   * 实例，否则下一次永远不会出现 —— 这条曾经在抽屉里被写成 `onPatch({done})`，
   * 于是「在抽屉里勾掉重复任务 = 这个系列到此为止」，而且没有任何提示。
   */
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onDismissConflict: (entityId: string, field: string) => void;
}) {
  const confirm = useConfirm();
  const task = id ? state.tasks[id] : null;
  const panel = useRef<HTMLElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  useFocusTrap(panel, !!task);
  // 归属跨集选不了：项目是**按集**的（跟日程 / 打卡 / 已完成一样），
  // 所以这里列的是当前这个集里的项目 —— 挂到别的集的项目上，
  // 那条泳道在那边会凭空多出一张卡，而用户从没在那边建过它
  const projs = liveProjects(state);
  /** 每个字段的 label / 控件配对用的 id 前缀。
   *  `.field label` 是**兄弟**关系且没有 htmlFor —— 点 label 不会聚焦控件，
   *  读屏也念不出这个框是干什么的。用 useId 配上，别写死字符串（同页面
   *  万一渲染两份就撞了）。见 CLAUDE.md 五、无障碍。 */
  const fid = useId();

  // 标题是本地草稿：每敲一个字就写库会让输入框在重渲染里跳光标（旧版踩过）
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [endTime, setEndTime] = useState<string | null>(null);
  const [repOpen, setRepOpen] = useState(false);
  const repAnchor = useRef<HTMLButtonElement>(null);
  const repPanel = useRef<HTMLDivElement>(null);
  /* 浮条：抽屉正文和「重复」面板都会滚 —— 见 ui/scroll.ts */
  const osbBody = useOverlayScrollbar<HTMLDivElement>();
  const osbRep = useOverlayScrollbar<HTMLDivElement>(repPanel);
  const [repPos, setRepPos] = useState<{ top: number; left: number } | null>(null);
  const lastId = useRef<string | null>(null);

  useEffect(() => {
    if (!task) return;
    if (lastId.current === task.id) return;   // 同一任务的重渲染不要覆盖正在输入的内容
    lastId.current = task.id;
    setTitle(task.title);
    setNote(task.note || '');
    setEndTime(null);
  }, [task]);

  useEffect(() => {
    if (!id) { lastId.current = null; return; }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [id, onClose]);

  useLayoutEffect(() => {
    if (!repOpen || !repAnchor.current || !repPanel.current) { setRepPos(null); return; }
    const r = repAnchor.current.getBoundingClientRect();
    const w = repPanel.current.offsetWidth;
    const h = repPanel.current.offsetHeight;
    let top = r.bottom + 6;
    let left = r.left;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    setRepPos({ top, left });
  }, [repOpen, task?.repeat.unit, task?.repeat.n, task?.repeat.end?.type]);

  useEffect(() => {
    if (!repOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!repPanel.current?.contains(t) && !repAnchor.current?.contains(t)) setRepOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      setRepOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [repOpen]);

  /**
   * 开的时候把焦点送进来、关的时候还回去。
   *
   * **送进来的是抽屉本身，不是第一个输入框** —— 送进输入框会当场弹出手机软键盘，
   * 挡住半个屏幕，而用户点一行只是想「看看」。所以面板吃 tabIndex={-1}，
   * Tab 从它开始往第一个真控件走（读屏会先念出 aria-label 那句）。
   *
   * 还回去的是**原来那一行**：不还的话焦点掉到 body 上，键盘用户得从页首
   * 重新 Tab 一遍才能回到刚才那一行旁边。
   *
   * 记录前先看焦点在不在抽屉里 —— 从一条任务直接切到另一条时 id 变了、
   * 抽屉不卸载，这时 activeElement 就是抽屉自己，记下来等于把「还回哪」擦掉。
   */
  useEffect(() => {
    if (!id) return;
    if (!panel.current?.contains(document.activeElement)) {
      prevFocus.current = document.activeElement as HTMLElement | null;
    }
    panel.current?.focus({ preventScroll: true });
    return () => {
      const el = prevFocus.current;
      prevFocus.current = null;
      if (el && el.isConnected) el.focus({ preventScroll: true });
    };
  }, [id]);

  if (!task) return null;

  const patch = (fields: Partial<Task>) => onPatch(task.id, fields);
  const rep: RepeatRule = task.repeat;

  /**
   * 下一次落在哪天。**实时算给用户看** —— 重复规则是「每周三 + 隔 2 周 + 到某天为止」
   * 这种组合，光看几个下拉框想象不出结果。
   */
  const nextOcc = rep.unit !== 'none' ? repeatNext(task, task.date || D.today()) : null;

  const startMin = D.timeToMin(task.time);
  const setEnd = (v: string | null) => {
    const s = startMin;
    if (v == null || s == null) {
      setEndTime(null);
      patch({ duration: DEFAULT_DURATION });
      return;
    }
    const e = D.timeToMin(v);
    if (e == null) {
      setEndTime(null);
      patch({ duration: DEFAULT_DURATION });
      return;
    }
    setEndTime(v);
    patch({ duration: e > s ? e - s : e - s + 1440 });
  };

  const remove = async () => {
    const ok = await confirm({
      title: '删除这个任务？',
      body: `「${task.title}」会移到垃圾箱，可以还原。`,
      confirmText: '删除',
      danger: true,
    });
    if (ok) { onDelete(task.id); onClose(); }
  };

  return (
    <>
      {/* 遮罩是纯鼠标目标（键盘走 Escape），对读屏没有意义，别让它念出一个空 div */}
      <div className="mask show" aria-hidden="true" onClick={onClose} />
      <aside
        className="drawer open"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={'任务详情：' + task.title}
        tabIndex={-1}
      >
        <div className="drawer-head">
          <label className="check-wrap">
            <input
              type="checkbox"
              checked={!!task.done}
              /* 包着它的 <label> 里一个字都没有，所以它自己没有名字 ——
                 名字只能从这儿给。措辞和 parts.tsx 的 <CheckBtn> 对齐。 */
              aria-label={task.done ? '取消完成' : '标记完成'}
              onChange={() => onToggle(task.id)}
            />
            <span className="check-circle" />
          </label>
          <Input
            type="text"
            className="drawer-title"
            placeholder="任务名称"
            aria-label="任务名称"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { const v = title.trim() || '未命名任务'; setTitle(v); if (v !== task.title) patch({ title: v }); }}
          />
          {/* 标题栏右边两个图标：删除、完成。**底部那排按钮整个删了** ——
              字段都是就地改、失焦即存，「完成」只是关掉抽屉。 */}
          <IconBtn label="删除任务" className="icon-btn" onClick={remove}>
            <Trash2 size={15} />
          </IconBtn>
          <IconBtn label="完成" className="icon-btn" onClick={onClose}>
            <Check size={16} />
          </IconBtn>
        </div>

        <div className="drawer-body osb" ref={osbBody}>
          <ConflictBox
            list={state.conflicts.filter((c) => c.entityId === task.id)}
            onDismiss={(field) => onDismissConflict(task.id, field)}
          />

          <div className="field">
            <span className="flabel">日期</span>
            <DatePicker
              value={task.date}
              onChange={(v) => patch({ date: v })}
            />
          </div>

          <div className="field">
            <span className="flabel">时间</span>
            <div className="time-row">
              <TimePicker
                value={task.time}
                onChange={(v) => {
                  setEndTime(null);
                  patch({ time: v, ...(v === null ? { duration: DEFAULT_DURATION } : {}) });
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

          <div className="field">
            <span className="flabel" id={fid + '-rep-l'}>重复</span>
            {/* 一个按钮开一个 Sheet。原先是 chips + 一整个面板摊在抽屉里 ——
                展开之后比「项目」和「备注」加起来还长。 */}
            <button
              ref={repAnchor}
              type="button"
              className={'rep-open' + (rep.unit !== 'none' ? ' on' : '')}
              aria-labelledby={fid + '-rep-l'}
              onClick={() => setRepOpen(true)}
            >
              <span className="rep-label">{rep.unit === 'none' ? '不重复' : repeatLabel(rep)}</span>
              {rep.unit !== 'none' && (
                <span
                  className="rep-x"
                  aria-label="清除重复"
                  onClick={(e) => {
                    e.stopPropagation();
                    patch({ repeat: toRepeat({ unit: 'none', n: 1, end: null }, task.date) });
                    setRepOpen(false);
                  }}
                >✕</span>
              )}
            </button>
          </div>

          {/*
            项目归属**只在这一处改**，拖拽不改它。
            拖进泳道列只换「哪一列」，搬归属是这条下拉的职责 ——
            拖动顺手把「搬家」也做掉，比什么都不做更让人措手不及。
          */}
          <div className="field">
            <span className="flabel" id={fid + '-cal-l'}>日程集</span>
            <Dropdown
              value={task.calId}
              options={state.cals.filter((c) => canWrite(c.role)).map((c) => ({ value: c.id, label: c.name }))}
              onPick={(v) => onMoveToCal(task.id, v)}
              label="日程集"
              labelledBy={fid + '-cal-l'}
              className="w-full"
            />
          </div>

          <div className="field">
            <span className="flabel" id={fid + '-proj-l'}>项目</span>
            <SheetPicker<string>
              value={task.projectId || ''}
              options={[
                { value: '', label: '不属于任何项目' },
                ...projs.map((p) => ({ value: p.id, label: p.name })),
              ]}
              onPick={(v) => onPatch(task.id, { projectId: v || null })}
              label="项目"
              labelledBy={fid + '-proj-l'}
            />
          </div>

          <div className="field">
            <label htmlFor={fid + '-note'}>备注</label>
            <Input
              id={fid + '-note'}
              type="text"
              placeholder="补充说明…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => { if (note !== (task.note || '')) patch({ note }); }}
            />
          </div>

          <div className="drawer-meta">
            <span><Repeat size={11} /> {rep.unit === 'none' ? '不重复' : repeatLabel(rep)}</span>
            {task.seriesId && <span>· 重复系列第 {(task.repeatSeq || 0) + 1} 次</span>}
            {task.createdAt > 0 && <span>· 创建于 {D.fmtMD(D.isoOfTs(task.createdAt))}</span>}
          </div>
        </div>
      </aside>

      {/* 重复设置的复合浮层。两个滚轮 + 下方自适应内容。 */}
      {repOpen && <div ref={osbRep} className="repeat-pop osb" role="dialog" aria-label="重复" style={{ top: repPos ? repPos.top : 0, left: repPos ? repPos.left : 0, visibility: repPos ? 'visible' : 'hidden' }}>
        <div className="repeat-pop-head"><strong>重复</strong><IconBtn label="关闭" onClick={() => setRepOpen(false)}><X size={15} /></IconBtn></div>
        {rep.unit === 'none' ? (
          <div className="repeat-none">
            <button
              type="button"
              className="repeat-none-btn"
              onClick={() => patch({ repeat: toRepeat({ unit: 'day', n: 1, end: null }, task.date) })}
            >不重复</button>
          </div>
        ) : (
          <>
            <div className="rp-row">
              <span>每</span>
              <WheelPicker
                leftOptions={Array.from({ length: 99 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
                rightOptions={REPEAT_UNITS.filter((u) => u.value !== 'none').map((u) => ({ value: u.value, label: u.label }))}
                leftValue={String(rep.n)}
                rightValue={rep.unit}
                onLeftChange={(n) => {
                  patch({ repeat: { ...rep, n: Math.max(1, +n || 1) } });
                }}
                onRightChange={(unit) => {
                  patch({ repeat: toRepeat({ ...rep, unit, n: 1, end: null }, task.date) });
                }}
                leftLabel="每"
                rightLabel="单位"
              />
            </div>
            {rep.unit === 'week' && (
              <div className="rp-row rp-wd">
                {['一', '二', '三', '四', '五', '六', '日'].map((w, i) => {
                  const v = i === 6 ? 0 : i + 1;
                  const on = rep.weekdays.includes(v);
                  return (
                    <button
                      className={'rp-day' + (on ? ' on' : '')}
                      key={w}
                      aria-pressed={on}
                      onClick={() => patch({
                        repeat: {
                          ...rep,
                          weekdays: on ? rep.weekdays.filter((x) => x !== v) : [...rep.weekdays, v],
                        },
                      })}
                    >{w}</button>
                  );
                })}
              </div>
            )}
            {rep.unit === 'month' && (
              <div className="rp-row">
                <span>每月</span>
                <MiniCalendar
                  month={D.monthStart(task.date || D.today())}
                  value={String(rep.monthday || 1)}
                  todayIso={D.today()}
                  loadOf={() => 0}
                  onMonth={() => {}}
                  onPick={(iso) => {
                    const day = D.parseISO(iso).getDate();
                    patch({ repeat: { ...rep, monthday: day } });
                  }}
                />
              </div>
            )}
            {rep.unit === 'year' && (
              <>
                <div className="rp-row">
                  <span>每年</span>
                  <select
                    value={rep.yearMonth || 1}
                    aria-label="每年几月"
                    onChange={(e) => patch({
                      repeat: {
                        ...rep,
                        yearMonth: Math.max(1, Math.min(12, +e.target.value || 1)),
                      },
                    })}
                  >
                    {Array.from({ length: 12 }, (_, i) => (
                      <option key={i + 1} value={i + 1}>{i + 1} 月</option>
                    ))}
                  </select>
                </div>
                <div className="rp-row">
                  <MiniCalendar
                    month={`${new Date().getFullYear()}-${D.pad(rep.yearMonth || 1)}-01`}
                    value={String(rep.monthday || 1)}
                    todayIso={D.today()}
                    loadOf={() => 0}
                    onMonth={() => {}}
                    onPick={(iso) => {
                      const day = D.parseISO(iso).getDate();
                      patch({ repeat: { ...rep, monthday: day } });
                    }}
                  />
                </div>
              </>
            )}
            <div className="rp-row">
              <span>结束</span>
              <Chips<string>
                value={rep.end?.type || 'never'}
                options={['never', 'date', 'count']}
                onPick={(v) => {
                  patch({
                    repeat: {
                      ...rep,
                      end: v === 'date' ? { type: 'date', date: D.addMonths(D.today(), 3) }
                        : v === 'count' ? { type: 'count', count: 10 }
                          : null,
                    },
                  });
                }}
                labelOf={(v) => ({ never: '不限', date: '到某天', count: '重复几次' } as Record<string, string>)[v] || v}
                label="重复结束方式"
              />
              {rep.end?.type === 'date' && (
                <DatePicker
                  value={rep.end.date}
                  onChange={(v) => {
                    if (v) patch({ repeat: { ...rep, end: { type: 'date', date: v } } });
                  }}
                />
              )}
              {rep.end?.type === 'count' && (
                <Input
                  type="number" min={1} max={999} value={rep.end.count}
                  onChange={(e) => patch({ repeat: { ...rep, end: { type: 'count', count: Math.max(1, +e.target.value || 1) } } })}
                />
              )}
            </div>
            {nextOcc && <div className="rp-preview">下一次：{D.fmtMD(nextOcc)}</div>}
          </>
        )}
      </div>}
    </>
  );
}

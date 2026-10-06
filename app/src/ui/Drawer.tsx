/**
 * Drawer.tsx —— 任务详情 / 编辑抽屉
 *
 * 交互统一是「列表 → 详情 → 编辑」三段式（用户 2026-10-05 裁决）：
 * 点行开抽屉看详情，改字段就地改、失焦即存。这里**没有**独立的编辑页。
 *
 * `confirm()` 一律不用 —— 原生 confirm 在 PWA 里会被静默吞掉，用户点删除
 * 完全没反应。走 useConfirm()。
 *
 * 时间选择用原生 `<input type="time">`，不再自造 12 小时制时钟：
 * 系统选择器在手机上更好用，也省掉 300 行 clock.js。时长仍旧是固定档位的
 * 下拉 —— 自由输入迟早会有人填 7 分钟，而 15 分钟是时间轴的最小步进。
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Trash2, Check, Repeat, History } from 'lucide-react';
import type { FieldConflict, LocalState, RepeatRule, Task } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import { REPEAT_UNITS, repeatLabel, toRepeat } from '../domain/repeat.ts';
import { Btn, useConfirm } from './kit.tsx';

const DURATIONS = [15, 30, 45, 60, 90, 120, 180];

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

export function Drawer({ state, id, onClose, onPatch, onDelete, onDismissConflict }: {
  state: LocalState;
  id: string | null;
  onClose: () => void;
  onPatch: (id: string, fields: Partial<Task>) => void;
  onDelete: (id: string) => void;
  onDismissConflict: (entityId: string, field: string) => void;
}) {
  const confirm = useConfirm();
  const task = id ? state.tasks[id] : null;
  /** 每个字段的 label / 控件配对用的 id 前缀。
   *  `.field label` 是**兄弟**关系且没有 htmlFor —— 点 label 不会聚焦控件，
   *  读屏也念不出这个框是干什么的。用 useId 配上，别写死字符串（同页面
   *  万一渲染两份就撞了）。见 CLAUDE.md 五、无障碍。 */
  const fid = useId();

  // 标题是本地草稿：每敲一个字就写库会让输入框在重渲染里跳光标（旧版踩过）
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const lastId = useRef<string | null>(null);

  useEffect(() => {
    if (!task) return;
    if (lastId.current === task.id) return;   // 同一任务的重渲染不要覆盖正在输入的内容
    lastId.current = task.id;
    setTitle(task.title);
    setNote(task.note || '');
  }, [task]);

  useEffect(() => {
    if (!id) { lastId.current = null; return; }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [id, onClose]);

  if (!task) return null;

  const patch = (fields: Partial<Task>) => onPatch(task.id, fields);
  const rep: RepeatRule = task.repeat;

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
      <div className="mask show" onClick={onClose} />
      <aside className="drawer open">
        <div className="drawer-head">
          <label className="check-wrap">
            <input
              type="checkbox"
              checked={!!task.done}
              onChange={() => onPatch(task.id, { done: !task.done, doneAt: !task.done ? Date.now() : null })}
            />
            <span className="check-circle" />
          </label>
          <input
            type="text"
            className="drawer-title"
            placeholder="任务名称"
            aria-label="任务名称"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { const v = title.trim() || '未命名任务'; setTitle(v); if (v !== task.title) patch({ title: v }); }}
          />
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <Check size={16} />
          </button>
        </div>

        <div className="drawer-body">
          <ConflictBox
            list={state.conflicts.filter((c) => c.entityId === task.id)}
            onDismiss={(field) => onDismissConflict(task.id, field)}
          />

          <div className="field-row">
            <div className="field">
              <label htmlFor={fid + '-date'}>日期</label>
              <input
                id={fid + '-date'}
                type="date"
                value={task.date || ''}
                onChange={(e) => patch({ date: e.target.value || null })}
              />
            </div>
            <div className="field">
              <label htmlFor={fid + '-time'}>时间 <span className="sub">（可留空）</span></label>
              <input
                id={fid + '-time'}
                type="time"
                value={task.time || ''}
                step={900}
                onChange={(e) => patch({ time: e.target.value || null })}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor={fid + '-dur'}>时长</label>
            <select id={fid + '-dur'} value={task.duration || 60} onChange={(e) => patch({ duration: +e.target.value })}>
              {DURATIONS.map((m) => <option value={m} key={m}>{D.fmtDuration(m)}</option>)}
            </select>
          </div>

          <div className="field">
            <label htmlFor={fid + '-rep'}>重复</label>
            <select
              id={fid + '-rep'}
              value={rep.unit}
              onChange={(e) => {
                const unit = e.target.value as RepeatRule['unit'];
                patch({ repeat: toRepeat({ ...rep, unit, n: 1, end: null }, task.date) });
              }}
            >
              {REPEAT_UNITS.map((u) => <option value={u.value} key={u.value}>{u.label}</option>)}
            </select>
            {rep.unit !== 'none' && (
              <div className="repeat-panel">
                <div className="rp-row">
                  <span>每</span>
                  <input
                    type="number" min={1} max={99} value={rep.n}
                    aria-label="重复间隔"
                    onChange={(e) => patch({ repeat: { ...rep, n: Math.max(1, +e.target.value || 1) } })}
                  />
                  <span>{{ day: '天', week: '周', month: '个月', year: '年', none: '' }[rep.unit]}</span>
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
                <div className="rp-row">
                  <span>结束</span>
                  <select
                    value={rep.end?.type || 'never'}
                    aria-label="重复结束方式"
                    onChange={(e) => {
                      const v = e.target.value;
                      patch({
                        repeat: {
                          ...rep,
                          end: v === 'date' ? { type: 'date', date: D.addMonths(D.today(), 3) }
                            : v === 'count' ? { type: 'count', count: 10 }
                              : null,
                        },
                      });
                    }}
                  >
                    <option value="never">不限</option>
                    <option value="date">到某天</option>
                    <option value="count">重复几次</option>
                  </select>
                  {rep.end?.type === 'date' && (
                    <input
                      type="date" value={rep.end.date}
                      onChange={(e) => patch({ repeat: { ...rep, end: { type: 'date', date: e.target.value } } })}
                    />
                  )}
                  {rep.end?.type === 'count' && (
                    <input
                      type="number" min={1} max={999} value={rep.end.count}
                      onChange={(e) => patch({ repeat: { ...rep, end: { type: 'count', count: Math.max(1, +e.target.value || 1) } } })}
                    />
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="field">
            <label htmlFor={fid + '-note'}>备注</label>
            <textarea
              id={fid + '-note'}
              rows={5}
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

        <div className="drawer-foot">
          <Btn variant="danger" onClick={remove}><Trash2 size={14} /> 删除任务</Btn>
          <Btn variant="primary" onClick={onClose}>完成</Btn>
        </div>
      </aside>
    </>
  );
}

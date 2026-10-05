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

import { useEffect, useRef, useState } from 'react';
import { Trash2, Check, Repeat } from 'lucide-react';
import type { LocalState, RepeatRule, Task } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import { REPEAT_UNITS, repeatLabel, toRepeat } from '../domain/repeat.ts';
import { Btn, useConfirm } from './kit.tsx';

const DURATIONS = [15, 30, 45, 60, 90, 120, 180];

export function Drawer({ state, id, onClose, onPatch, onDelete }: {
  state: LocalState;
  id: string | null;
  onClose: () => void;
  onPatch: (id: string, fields: Partial<Task>) => void;
  onDelete: (id: string) => void;
}) {
  const confirm = useConfirm();
  const task = id ? state.tasks[id] : null;

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
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { const v = title.trim() || '未命名任务'; setTitle(v); if (v !== task.title) patch({ title: v }); }}
          />
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <Check size={16} />
          </button>
        </div>

        <div className="drawer-body">
          <div className="field-row">
            <div className="field">
              <label>日期</label>
              <input
                type="date"
                value={task.date || ''}
                onChange={(e) => patch({ date: e.target.value || null })}
              />
            </div>
            <div className="field">
              <label>时间 <span className="sub">（可留空）</span></label>
              <input
                type="time"
                value={task.time || ''}
                step={900}
                onChange={(e) => patch({ time: e.target.value || null })}
              />
            </div>
          </div>

          <div className="field">
            <label>时长</label>
            <select value={task.duration || 60} onChange={(e) => patch({ duration: +e.target.value })}>
              {DURATIONS.map((m) => <option value={m} key={m}>{D.fmtDuration(m)}</option>)}
            </select>
          </div>

          <div className="field">
            <label>重复</label>
            <select
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
            <label>备注</label>
            <textarea
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

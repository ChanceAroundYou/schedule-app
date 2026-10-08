/**
 * ActSheet.tsx —— 长按操作弹层
 *
 * 触屏没有 HTML5 拖拽，也没有 hover，所以「改期 / 排序 / 删除」得有一组按钮
 * 兜底。长按 480ms 弹出来（`LONG_PRESS_MS`），鼠标走拖拽、不走这里。
 *
 * **动作值用无歧义前缀**：时长是 `dur60` 而不是 `d60` —— 后者与 `del` /
 * `date` 撞车，靠 `+slice(1) > 0` 去猜必然误伤到别的动作上。
 */

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeftRight, ArrowDown, ArrowUp, CalendarDays, CalendarPlus,
  ChevronLeft, ChevronRight, Clock, Moon, Timer, Trash2,
} from 'lucide-react';
import type { LocalState, Task } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import { Btn } from './kit.tsx';
import { useFocusTrap } from './hooks.ts';

const DURATIONS = [15, 30, 45, 60, 90, 120, 180];

interface Action {
  icon: React.ReactNode;
  label: string;
  value: string;
  danger?: boolean;
  on?: boolean;
}

export function ActSheet({ state, id, onClose, onPatch, onDelete, onOpenDrawer, onMove }: {
  state: LocalState;
  id: string | null;
  onClose: () => void;
  onPatch: (id: string, fields: Partial<Task>) => void;
  onDelete: (id: string) => void;
  onOpenDrawer: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  // 第二层：在已打开的浮层里再选一档时长。一档一档选，不是循环切换
  const [durOpen, setDurOpen] = useState(false);

  // 浮层开着时给 body 一个标记：窄屏下要压住底栏的按下态，别在浮层后面乱闪
  useEffect(() => {
    document.body.classList.toggle('sheet-open', !!id);
    return () => document.body.classList.remove('sheet-open');
  }, [id]);

  const panel = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  useFocusTrap(panel, !!id);

  /**
   * 开的时候把焦点送进来、关的时候还回去 —— 与 Drawer 同一套（见那边的注释：
   * 送进来的是**面板本身**，送进第一个控件会当场弹手机软键盘）。
   *
   * 长按弹层有个 Drawer 没有的坑：`durOpen` 切到时长档时**不关浮层**，
   * 这时 id 没变、这个 effect 不重跑，所以「还回哪儿」不能被擦掉 ——
   * 判据和 Drawer 一样，先看焦点在不在面板里。
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

  const task = id ? state.tasks[id] : null;
  if (!task) return null;

  const today = D.today();
  const t = task;

  const actions: Action[] = [];
  if (t.time) {
    actions.push({ icon: <Clock size={18} />, label: '改时间', value: 'time' });
    actions.push({ icon: <Timer size={18} />, label: '改时长', value: 'pickdur' });
  }
  if (t.date !== today) actions.push({ icon: <CalendarDays size={18} />, label: '改到今天', value: 'today' });
  if (t.date !== D.addDays(today, 1)) actions.push({ icon: <Moon size={18} />, label: '改到明天', value: 'tomorrow' });
  if (t.date) {
    actions.push({ icon: <ChevronLeft size={18} />, label: '提前一天', value: 'earlier' });
    actions.push({ icon: <ChevronRight size={18} />, label: '延后一天', value: 'later' });
  }
  if (!t.time) {
    actions.push({ icon: <ArrowUp size={18} />, label: '上移', value: 'up' });
    actions.push({ icon: <ArrowDown size={18} />, label: '下移', value: 'down' });
  }
  if (!t.date) actions.push({ icon: <CalendarPlus size={18} />, label: '定个日期', value: 'date' });
  actions.push({ icon: <Trash2 size={18} />, label: '删除', value: 'del', danger: true });

  const durationActions: Action[] = DURATIONS.map((m) => ({
    icon: <ArrowLeftRight size={16} />,
    label: D.fmtDuration(m),
    value: 'dur' + m,
    on: (t.duration || 60) === m,
  }));

  const list = durOpen ? durationActions : actions;

  const run = (kind: string) => {
    // 时长档位靠这个正则认，不用 slice 猜
    const m = /^dur(\d+)$/.exec(kind);
    if (m) { onPatch(t.id, { duration: +m[1] }); return; }   // 保持浮层开着，方便连着调几档

    if (kind === 'time' || kind === 'date') { onOpenDrawer(t.id); return; }
    if (kind === 'pickdur') { setDurOpen(true); return; }

    onClose();
    if (kind === 'today') onPatch(t.id, { date: today });
    else if (kind === 'tomorrow') onPatch(t.id, { date: D.addDays(today, 1) });
    else if (kind === 'earlier') { if (t.date) onPatch(t.id, { date: D.addDays(t.date, -1) }); }
    else if (kind === 'later') { if (t.date) onPatch(t.id, { date: D.addDays(t.date, 1) }); }
    else if (kind === 'up') onMove(t.id, -1);
    else if (kind === 'down') onMove(t.id, 1);
    else if (kind === 'del') onDelete(t.id);
  };

  return (
    <>
      <div className="sheet-mask open" onClick={onClose} />
      <div
        className="act-sheet open"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={durOpen ? '选择时长' : '任务操作：' + task.title}
        tabIndex={-1}
      >
        <div className="as-grab" />
        <div className="as-title">
          {durOpen ? '时长 · ' + t.title : t.title}
        </div>
        <div className="as-grid">
          {list.map((a) => (
            <Btn
              variant="normal"
              size="sm"
              className={'as-btn' + (a.danger ? ' danger' : '') + (a.on ? ' on' : '')}
              key={a.value}
              onClick={() => run(a.value)}
            >
              <span className="ai">{a.icon}</span>
              <span>{a.label}</span>
            </Btn>
          ))}
        </div>
        {/* 浮层底部的「取消」保持原样：它是**整宽**的浮层 chrome，有自己的
            :active 按压反馈，而 Btn 的 normal 档是描边透明按钮 —— 换过去会
            丢掉按压态、还会把文字从左对齐改成居中 */}
        <button className="as-cancel" onClick={onClose}>取消</button>
      </div>
    </>
  );
}

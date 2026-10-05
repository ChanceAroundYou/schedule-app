/**
 * parts.tsx —— 列表行 / 胶囊 / 打卡条等公共片段
 *
 * 这里的类名和 DOM 结构是**照抄 legacy/views.js 的**，一个字都不能改 ——
 * styles.css（68KB）就是按这套类名写的，改名等于把设计系统推倒重来。
 *
 * 两处有意的改进：
 *   · 旧版用字符串拼 HTML，标题必须过一遍 U.esc()，漏一处就是 XSS。
 *     React 默认转义，所以这里**没有** esc，也不可能漏。
 *   · 行内按钮**不挂 onClick**，只写 `data-act` —— 全部由 App 在容器上做
 *     一次事件委托。行是 React 渲染的，拖动落库、同步落地都会换掉节点，
 *     逐行挂处理器会跟着一起丢；而委托只挂在容器上，永远有效。
 */

import type { ReactNode } from 'react';
import { Repeat, Flame, ChevronRight } from 'lucide-react';
import type { Habit, Task } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import { repeatLabel } from '../domain/repeat.ts';
import { habitStreak } from '../domain/model.ts';

/* ============================== 分隔点 ============================== */

function Meta({ items }: { items: ReactNode[] }) {
  if (!items.length) return null;
  return (
    <div className="row-meta">
      {items.map((node, i) => (
        <span key={i} style={{ display: 'contents' }}>
          {i > 0 && <span className="dot">·</span>}
          {node}
        </span>
      ))}
    </div>
  );
}

/* ============================== 列表行 ============================== */

export interface TaskRowProps {
  task: Task;
  /** 只显示标题（待办箱用） */
  bare?: boolean;
  /** 额外显示「完成于 M/D」 */
  showDoneAt?: boolean;
  /** 逾期行等需要额外内容时用 */
  extra?: ReactNode;
  /** 覆盖 .task-row 的附加类（逾期行用 od-row） */
  className?: string;
}

export function TaskRow({ task: t, bare, showDoneAt, extra, className }: TaskRowProps) {
  const meta: ReactNode[] = [];
  if (!bare) {
    if (t.time) meta.push(<span className="m-time" key="t">{t.time}</span>);
    if (t.date) {
      const over = t.date < D.today() && !t.done;
      meta.push(<span className={'m-date' + (over ? ' over' : '')} key="d">{D.relLabel(t.date)}</span>);
    }
    if (t.duration && t.time) meta.push(<span className="m-dur" key="u">{D.fmtDuration(t.duration)}</span>);
    if (t.repeat && t.repeat.unit !== 'none') {
      meta.push(
        <span className="m-repeat" key="r">
          <Repeat size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} />
          {repeatLabel(t.repeat)}
        </span>,
      );
    }
    if (t.note) meta.push(<span className="m-note" key="n">备注</span>);
  }
  if (showDoneAt && t.doneAt) {
    const d = new Date(t.doneAt);
    meta.push(<span className="m-date" key="a">完成于 {d.getMonth() + 1}/{d.getDate()}</span>);
  }
  if (extra) meta.push(<span key="x" style={{ display: 'contents' }}>{extra}</span>);

  return (
    <div
      className={'task-row task-el' + (t.done ? ' done' : '') + (className ? ' ' + className : '')}
      data-id={t.id}
      data-untimed={t.time ? undefined : '1'}
      draggable
    >
      <button
        className={'check-btn' + (t.done ? ' on' : '')}
        data-act="toggle"
        data-id={t.id}
        title={t.done ? '取消完成' : '标记完成'}
      />
      <div className="row-main">
        <div className="row-title">{t.title}</div>
        <Meta items={meta} />
      </div>
    </div>
  );
}

/* ============================== 小胶囊 ============================== */

export function TaskPill({ task: t, showTime }: { task: Task; showTime?: boolean }) {
  return (
    <div
      className={'task-pill task-el' + (t.done ? ' done' : '')}
      data-id={t.id}
      data-untimed={t.time ? undefined : '1'}
      draggable
      title={t.title}
    >
      <span
        className={'check-btn sm' + (t.done ? ' on' : '')}
        data-act="toggle"
        data-id={t.id}
      />
      {showTime && t.time && <span className="pill-time">{t.time}</span>}
      <span className="pill-title">{t.title}</span>
    </div>
  );
}

/* ============================== 空状态 ============================== */

export function Empty({ text, icon }: { text: string; icon: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-ico" aria-hidden="true">{icon}</div>
      <div>{text}</div>
    </div>
  );
}

/* ============================== 打卡条 ============================== */

export function CheckinStrip({ habits, onManage }: {
  habits: Habit[];
  /** 「管理」按钮跳去打卡页。其余交互（勾选）走事件委托 */
  onJumpHabits?: () => void;
  onManage?: () => void;
}) {
  if (!habits.length) return null;
  const t = D.today();
  const done = habits.filter((h) => h.log && h.log[t]).length;

  return (
    <div className="checkin-strip">
      <div className="ci-head">
        每日打卡
        <span className="ci-sub">今天 {done}/{habits.length}</span>
        <button className="ci-manage" data-jump-habits="1" onClick={onManage}>管理</button>
      </div>
      <div className="ci-list">
        {habits.map((h) => {
          const hd = !!(h.log && h.log[t]);
          const st = habitStreak(h);
          return (
            <div className={'ci-item' + (hd ? ' done' : '')} key={h.id} data-habit={h.id}>
              <button
                type="button"
                className={'check-btn sm' + (hd ? ' on' : '')}
                data-act="habit"
                data-id={h.id}
                title="今日打卡"
              />
              <span className="ci-title">{h.title}</span>
              {st > 1 && (
                <span className="ci-streak" title={'连续打卡 ' + st + ' 天'}>
                  <Flame size={11} style={{ verticalAlign: '-1px' }} />
                  {st}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 最近 14 天的打卡热力点 */
export function HabitHeat({ habit: h }: { habit: Habit }) {
  const out: ReactNode[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = D.addDays(D.today(), -i);
    const on = !!(h.log && h.log[d]);
    out.push(<i className={'heat-dot' + (on ? ' on' : '')} key={d} title={d + (on ? ' 已打卡' : '')} />);
  }
  return <div className="habit-heat">{out}</div>;
}

/** 可折叠区块的三角。用图标不用字符，字号变化时不会错位 */
export function Caret({ open }: { open: boolean }) {
  return (
    <ChevronRight
      size={14}
      className="td-caret"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}
    />
  );
}

/** 一天的任务负载档位（周视图表头、月视图格子共用同一套分档） */
export function loadLevel(mins: number): number {
  if (!mins) return 0;
  if (mins > 8 * 60) return 3;
  if (mins > 4 * 60) return 2;
  return 1;
}

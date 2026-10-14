/**
 * TaskRow.tsx —— 列表行 + 小胶囊 + 空状态
 */

import type { ReactNode } from 'react';
import { Repeat } from 'lucide-react';
import type { Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { repeatLabel } from '../../domain/repeat.ts';
import { CheckBtn, SelDot } from './CheckBtn.tsx';

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
  /**
   * 多选模式（2026-10-14）。null = 没在多选；false/true = 在多选、这条有没有被选。
   * 传了它就在行首画一个圈（选中画勾），点击行为也由 dispatch 改成切换选中。
   */
  sel?: boolean | null;
}

export function TaskRow({ task: t, bare, showDoneAt, extra, className, sel = null }: TaskRowProps) {
  const meta: ReactNode[] = [];
  const today = D.today();
  if (!bare) {
    if (t.time) meta.push(<span className="m-time" key="t">{t.time}</span>);
    /* 「今天」不写：今天页整页都是今天，已完成页的组标题也已经写了 —— 行里再写一遍
       只是占地方（窄屏那一行本来就只有 390px）。逾期 / 别的日子照写。 */
    if (t.date && t.date !== today) {
      const over = t.date < today && !t.done;
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
      className={'task-row task-el' + (t.done ? ' done' : '')
        + (className ? ' ' + className : '')
        + (sel === null ? '' : ' sel-mode' + (sel ? ' sel-on' : ''))}
      data-id={t.id}
      data-untimed={t.time ? undefined : '1'}
      data-sel={sel === null ? undefined : sel ? '1' : '0'}
    >
      {/* 多选时用选择圈**替换**勾选圈：两个圈并排既挤又分不清点哪个是哪个。
          勾选圈藏起来而不是不渲染 —— 位置留着，行高和多选前后完全一致，
          进出多选时列表不会跳一下。 */}
      {sel === null ? <CheckBtn id={t.id} on={!!t.done} /> : <SelDot id={t.id} on={sel} />}
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
      title={t.title}
    >
      {/* 月 / 周视图格子里唯一一个勾选入口。**必须是 <button>**：
          原先这里是 <span>，于是既进不了 Tab 序列、也没有按钮角色、
          读屏也念不出它是什么 —— 而另外五个同样的勾选都是 button。 */}
      <CheckBtn id={t.id} on={!!t.done} sm />
      {showTime && t.time && <span className="pill-time">{t.time}</span>}
      <span className="pill-title">{t.title}</span>
    </div>
  );
}

/* ============================== 空状态 ============================== */

export function Empty({ text, sub, icon }: { text: string; sub?: string; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-ico" aria-hidden="true">{icon}</div>}
      <div>{text}</div>
      {sub && <div className="empty-sub">{sub}</div>}
    </div>
  );
}

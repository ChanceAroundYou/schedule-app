/**
 * TaskRow.tsx —— 列表行 + 小胶囊 + 空状态
 */

import type { ReactNode } from 'react';
import type { CalColorKey, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { repeatLabel } from '../../domain/repeat.ts';
import { CheckBtn, SelDot } from './CheckBtn.tsx';
import { CompactCard } from '../calendar/TaskCard.tsx';
import { RepeatFlag } from './RepeatFlag.tsx';
export { RepeatFlag } from './RepeatFlag.tsx';

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
  /** 这条所属日程集的颜色 → `data-cal-color`；不传 = 不着色 */
  calColor?: CalColorKey;
}

export function TaskRow({ task: t, bare, showDoneAt, extra, className, sel = null, calColor }: TaskRowProps) {
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
      /* 只留文字（「每天」/「每周日、五、六」）。**不再在 meta 前也挂一枚循环图标**
         —— 标题末尾已经有 RepeatFlag 当路标，一行里两枚循环图标纯属重复
         （2026-10-25 截图核对时发现：标题后一个、meta 前一个，看着像两条任务）。 */
      meta.push(<span className="m-repeat" key="r">{repeatLabel(t.repeat)}</span>);
    }
    /* 有详细内容就给个标记 —— 它是「这条还有更多，点开看」的路标。
       有了下面那行摘要之后它看着冗余，但摘要是**截断**的：截断到看不出
       「后面还有没有」的时候，正是这个标记要说话的时候（用户 2026-10-15
       明确要「两者都要」）。 */
    if (t.note) meta.push(<span className="m-note" key="n" title="有详细内容">详细内容</span>);
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
      data-cal-color={calColor}
      data-untimed={t.time ? undefined : '1'}
      data-sel={sel === null ? undefined : sel ? '1' : '0'}
    >
      {/* 多选时用选择圈**替换**勾选圈：两个圈并排既挤又分不清点哪个是哪个。
          勾选圈藏起来而不是不渲染 —— 位置留着，行高和多选前后完全一致，
          进出多选时列表不会跳一下。 */}
      {sel === null ? <CheckBtn id={t.id} on={!!t.done} /> : <SelDot id={t.id} on={sel} />}
      <div className="row-main">
        <div className="row-title">{t.title}<RepeatFlag t={t} /></div>
        {/* 详细内容的摘要预览。**只有有内容的行才多出这一行** ——
            大多数任务只有标题，不该为「可能有」先占掉一格高度。 */}
        {!bare && !!t.note && <div className="row-note">{t.note}</div>}
        <Meta items={meta} />
      </div>
    </div>
  );
}

/* ============================== 小胶囊 ==============================
   `TaskCard variant="compact"`（`CompactCard`）的薄包装 —— 唯一渲染 `.task-pill` 的
   地方收进 TaskCard.tsx，DOM（`.pill-title/.pill-more/data-jump/
   data-untimed`/CheckBtn）一字不动，探针口径不变。周视图已切 `UntimedCard`，
   现在只剩月视图格子在用。 */

export function TaskPill({ task: t, moreSuffix, moreJumpDay, calColor }: {
  task: Task; moreSuffix?: number;
  /**
   * 只给尾巴上的 `+N` 用：点它 → 跳到那一天的**日视图**（"还有 N 条，
   * 去日视图看全"）。**胶囊本体不跳** —— 点任务条 = 开这条任务的详情抽屉
   * （2026-10-26 用户改；之前是整条胶囊跳日视图，2026-10-19 的旧口径）。
   * 委托里 `[data-jump]` 排在 `.task-el` 前面，所以它只盖住自己那一小块。
   */
  moreJumpDay?: string;
  calColor?: CalColorKey;
}) {
  return <CompactCard t={t} moreSuffix={moreSuffix} moreJumpDay={moreJumpDay} calColor={calColor} />;
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

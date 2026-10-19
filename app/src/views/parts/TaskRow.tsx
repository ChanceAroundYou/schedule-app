/**
 * TaskRow.tsx —— 列表行 + 小胶囊 + 空状态
 */

import type { ReactNode } from 'react';
import { Repeat } from 'lucide-react';
import type { Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { repeatLabel } from '../../domain/repeat.ts';
import { CheckBtn, SelDot } from './CheckBtn.tsx';
import { useDraggableEvent } from '../../ui/dndkit.tsx';

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
      data-untimed={t.time ? undefined : '1'}
      data-sel={sel === null ? undefined : sel ? '1' : '0'}
    >
      {/* 多选时用选择圈**替换**勾选圈：两个圈并排既挤又分不清点哪个是哪个。
          勾选圈藏起来而不是不渲染 —— 位置留着，行高和多选前后完全一致，
          进出多选时列表不会跳一下。 */}
      {sel === null ? <CheckBtn id={t.id} on={!!t.done} /> : <SelDot id={t.id} on={sel} />}
      <div className="row-main">
        <div className="row-title">{t.title}</div>
        {/* 详细内容的摘要预览。**只有有内容的行才多出这一行** ——
            大多数任务只有标题，不该为「可能有」先占掉一格高度。 */}
        {!bare && !!t.note && <div className="row-note">{t.note}</div>}
        <Meta items={meta} />
      </div>
    </div>
  );
}

/* ============================== 小胶囊 ============================== */

export function TaskPill({ task: t, showTime, moreSuffix, jumpDay }: {
  task: Task; showTime?: boolean; moreSuffix?: number;
  /**
   * 传了它就给这一行挂 `data-jump`：点整条任务 → 跳到那一天的**日视图**
   * （月视图专用，2026-10-19 用户要求：点格子里的任务 = 去看那一天）。
   * 委托里 `[data-jump]` 排在 `.task-el` **前面**，所以它会盖住「点行开抽屉」。
   * 勾选圈走 `[data-act]`（第 1 步），不受影响，宽屏照旧能点圈。
   */
  jumpDay?: string;
}) {
  /* 周视图全天行 / 月视图格子共用这一个胶囊，两处都要能拖：
     · 拖进周视图时间列 → 松手生成定时块（默认 1 小时，15 分钟吸附）；
     · 拖到月视图别的格子 → 改期（定时任务保时间，见 ui/dnd/timeline.ts）。
     落点计算全在那边，这里只把 dnd-kit 的拖拽柄接上。TaskPill 只有这两个
     使用处，无条件启用是安全的（列表行走的是 useSortableItem，另一套）。 */
  const drag = useDraggableEvent(t.id);
  return (
    <div
      className={'task-pill task-el' + (t.done ? ' done' : '')}
      ref={drag.ref}
      style={drag.style}
      {...drag.attributes}
      {...drag.listeners}
      data-id={t.id}
      data-untimed={t.time ? undefined : '1'}
      data-jump={jumpDay}
      title={t.title}
    >
      {/* 月 / 周视图格子里唯一一个勾选入口。**必须是 <button>**：
          原先这里是 <span>，于是既进不了 Tab 序列、也没有按钮角色、
          读屏也念不出它是什么 —— 而另外五个同样的勾选都是 button。 */}
      <CheckBtn id={t.id} on={!!t.done} sm />
      {showTime && t.time && <span className="pill-time">{t.time}</span>}
      <span className="pill-title">{t.title}</span>
      {/* 窄屏月视图专用：这一行是格子里**最后一条可见的**，尾巴上挂 "+N" 表示
          还有 N 条没显示出来（参考图 Google 日历就是「公司+2」这样）。
          +N 挂在行内而不是单独占一行 —— 省下的高度能多显示一行文字。
          它不用自己挂 data-jump：外面这条胶囊已经有，点哪儿都跳同一天。 */}
      {moreSuffix ? (
        <span className="pill-more" title={`还有 ${moreSuffix} 条`}>+{moreSuffix}</span>
      ) : null}
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

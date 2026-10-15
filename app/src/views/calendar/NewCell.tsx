/**
 * NewCell.tsx —— 日历空白处「就地新建」
 *
 * 点日程表里任意一个空格子 → 就地出现一个输入框，**日期与时间由格子的位置决定**
 * （哪个格子落在哪一带 → 落到温泉的那个日期 + 时间）。回车保存、Esc 取消。
 * 日 / 周 / 月三个视图共用这一个组件，只有外框的定位不同 —— 定位由父级算好
 * 从 `style` 传进来（日视图按百分比、周视图按 px，两套分母不一样）。
 *
 * ⚠️ **不在它上面挂 onClick**，理由同 AGENTS.md「点击事件必须走委托」：
 * 这块的点击会被 `#content` 上那一个监听器接着。`data-act="draft"` 是给那边的
 * 早退信号 —— 否则「点输入框」会被当成「又点了一次空白」，草稿被重设。
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DraftSeed, LocalState } from '../../domain/types.ts';
import * as store from '../../data/store.ts';

/**
 * 这个区域的草稿 —— 不是它名下的那个就不渲染。
 *
 * zone id 是 dnd 那边的命名（`timeline:2026-10-15` / `allday:…` / `week:…` /
 * `day:…`），点击派发器那边写的是同一套（见 app/clickDispatch.ts 的 openDraft）。
 * 一天在三个视图里名字不同，所以「这一天有没有草稿」天然是分区域的，不会串。
 */
export function draftOn(ui: LocalState['ui'], zoneId: string): DraftSeed | null {
  return ui.draft && ui.draft.zone === zoneId ? ui.draft : null;
}

/**
 * 视图里真正放的那个东西 —— 按 `zoneId` 认领自己的草稿，认到了才渲染。
 *
 * 五个地方用同一段（日视图的时间轴与全天区、周视图的列与未定时格、月视图的格子），
 * 差别只有**几何**（由各自的父级算好从 `style` 传进来）与要不要绝对定位。
 * 收成一段是因为「回车落成任务、清空草稿」这件事五处完全一致 —— 复制五遍的话，
 * 改一处就漏四处。
 */
export function NewCellSlot({
  state, zoneId, className, style,
}: {
  state: LocalState;
  zoneId: string;
  className?: string;
  style?: CSSProperties;
}) {
  const seed = draftOn(state.ui, zoneId);
  if (!seed) return null;
  return (
    <NewCell
      className={className}
      style={style}
      onCommit={(title) => {
        store.addTask({ title, date: seed.date, time: seed.time });
        store.setUi({ draft: null });
        /* 不开抽屉：那条卡片已经竖在刚才那个位置上了，看得见就等于建好了。
           想补备注、设重复，再点它一次 —— 抽屉是「补细节」的地方，
           不承担「确定日期时间」。 */
      }}
      onCancel={() => store.setUi({ draft: null })}
    />
  );
}

export function NewCell({
  className, style, onCommit, onCancel,
}: {
  className?: string;
  /** 位置。日视图是百分比（top/height），周视图是 px */
  style?: CSSProperties;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  /* Enter / Esc / 失焦三个出口都可能触发同一个动作（Esc → 卸载 → 失焦）。
     用一个闸门拦住第二次，否则「取消」会被当成「提交空串再取消」走两遍。 */
  const settled = useRef(false);

  // 一出现就聚焦 —— 用户点格子的意图就是「要在这打字」
  useEffect(() => { ref.current?.focus(); }, []);

  const settle = (fn: () => void) => {
    if (settled.current) return;
    settled.current = true;
    fn();
  };

  const commit = () => {
    const v = text.trim();
    settle(() => (v ? onCommit(v) : onCancel()));
  };

  return (
    <textarea
      ref={ref}
      data-act="draft"
      className={'new-cell' + (className ? ' ' + className : '')}
      style={style}
      rows={1}
      value={text}
      placeholder="写点什么，回车保存"
      aria-label="新建任务"
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          settle(onCancel);
        }
      }}
    />
  );
}

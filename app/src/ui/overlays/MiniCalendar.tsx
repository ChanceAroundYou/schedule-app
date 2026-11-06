/**
 * MiniCalendar —— 月历格子
 *
 * 独立可复用组件（需求 4）。两处在用，各自带自己的口径：
 *   · `ui/WhenPop.tsx` —— 快速添加「日期 + 时间」面板的日期层（挑任务哪天做）
 *   · `ui/Shell.tsx` 的 JumpPop —— 顶栏「找日期」（跳到某一天）
 * 两处的密度短横是同一个 `jumpLoad`，所以那个指示只有一处实现。
 *
 * **纯展示**：月份、高亮值、翻月、点某天全部由 props 传进来，组件自己不碰
 * state，也不认识「任务」「日程集」这些概念 —— 它只知道一串 ISO 日期。
 */

import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as D from '../../domain/date.ts';

export interface MiniCalendarProps {
  /** 当前显示月份的 1 号 */
  month: string;
  /** 高亮哪个格子（默认值 / 已选值）。null = 不高亮 */
  value: string | null;
  /** 给「今天」描边 */
  todayIso: string;
  /** 那天的未完成数，画淡底 + 底部短横（口径由调用方给，两处共用同一份） */
  loadOf: (iso: string) => number;
  /** 翻月 */
  onMonth?: (iso: string) => void;
  /** 点某天 */
  onPick?: (iso: string) => void;
  /**
   * 谁负责响应点击（2026-11-06 加）。
   *
   *   · `'jump'`（默认，原有行为）：格子带 `data-jump`，自己调 `onPick`。
   *   · `'habit'`：打了卡页那套约定 —— 格子改成 `data-act="habit-day"`、
   *     翻月键带 `data-delta`，**不挂任何回调**，全交给 `#content` 上的
   *     点击委托。
   *
   * 为什么不是一律改成委托：`WhenPop` 和顶栏「找日期」都在弹层里，
   * 它们的 `onPick` 还要顺手关面板、改光标，不是单纯写一个 state。
   * 保留两条路，才不至于为了打卡页把另外两处一起推翻。
   */
  act?: 'jump' | 'habit';
}

export function MiniCalendar({ month, value, todayIso, loadOf, onMonth, onPick, act = 'jump' }: MiniCalendarProps) {
  const days = D.monthMatrix(month);
  const curMonth = D.parseISO(month).getMonth();
  const habit = act === 'habit';
  /** 翻月键：habit 模式下不带回调，只带 data-* 交给委托 */
  const navBtn = (delta: number, label: string, glyph: ReactNode) => (
    habit
      ? (
        <button className="jp-nav" type="button" aria-label={label} title={label}
          data-act="habit-cal-month" data-delta={delta}>{glyph}</button>
      )
      : (
        <button className="jp-nav" type="button" aria-label={label} title={label}
          onClick={() => onMonth?.(D.addMonths(month, delta))}>{glyph}</button>
      )
  );
  return (
    <>
      <div className="jp-head">
        {navBtn(-1, '上个月', <ChevronLeft size={14} />)}
        <span className="jp-label">
          {D.parseISO(month).getFullYear()} 年 {D.parseISO(month).getMonth() + 1} 月
        </span>
        {navBtn(1, '下个月', <ChevronRight size={14} />)}
      </div>

      <div className="jp-week">
        <span>一</span><span>二</span><span>三</span><span>四</span>
        <span>五</span><span>六</span><span>日</span>
      </div>

      <div className="jp-grid">
        {days.map((d) => {
          const out = D.parseISO(d).getMonth() !== curMonth;
          const n = loadOf(d);
          // 类名对不上等于没写：CSS 里是 `.jp-cell`，不是 `.jp-day`
          return (
            <button
              // 日期密度用**淡底 + 底部短横**，不用圆点 —— 圆点在 1x 屏上几乎看不见
              className={'jp-cell' + (out ? ' out' : '')
                + (d === todayIso ? ' today' : '')
                + (d === value ? ' cur' : '')
                + (n ? ' has' + (n >= 6 ? ' lv3' : n >= 3 ? ' lv2' : '') : '')}
              key={d}
              {...(habit
                ? { 'data-act': 'habit-day', 'data-date': d }
                : { 'data-jump': d, onClick: () => onPick?.(d) })}
              title={D.fmtFull(d) + ' · ' + (n ? n + ' 项待办' : '空闲')}
            >{D.parseISO(d).getDate()}</button>
          );
        })}
      </div>
    </>
  );
}

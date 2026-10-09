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

import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as D from '../domain/date.ts';

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
  onMonth: (iso: string) => void;
  /** 点某天 */
  onPick: (iso: string) => void;
}

export function MiniCalendar({ month, value, todayIso, loadOf, onMonth, onPick }: MiniCalendarProps) {
  const days = D.monthMatrix(month);
  const curMonth = D.parseISO(month).getMonth();
  return (
    <>
      <div className="jp-head">
        <button className="jp-nav" type="button" aria-label="上个月" title="上个月" onClick={() => onMonth(D.addMonths(month, -1))}>
          <ChevronLeft size={14} />
        </button>
        <span className="jp-label">
          {D.parseISO(month).getFullYear()} 年 {D.parseISO(month).getMonth() + 1} 月
        </span>
        <button className="jp-nav" type="button" aria-label="下个月" title="下个月" onClick={() => onMonth(D.addMonths(month, 1))}>
          <ChevronRight size={14} />
        </button>
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
              data-jump={d}
              title={D.fmtFull(d) + ' · ' + (n ? n + ' 项待办' : '空闲')}
              onClick={() => onPick(d)}
            >{D.parseISO(d).getDate()}</button>
          );
        })}
      </div>
    </>
  );
}

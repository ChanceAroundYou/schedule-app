/**
 * MonthView.tsx —— 月视图
 *
 * 窄屏（手机）下这一页是「一屏画完、不滚」的：行数只算**含当月某天的那些周**
 * （见 domain/date.ts 的 monthWeeks —— 10 月是 5 行，不再多画一整行 11/2–11/8），
 * 行高由 flex 均分剩余高度。格子高度确定 → 能塞几行文字是算得出的：
 * `domain/layout.ts` 的 monthCellCapacity，那几个常数与 responsive.css 窄屏那段同源。
 *
 * 格子里一行一条任务（放不下走省略号），塞不下的在**下方用一排点**表示，
 * 一个点 = 一条没显示出来的任务；格子内口径是「未完成在前（按时间），已完成在后」。
 * 宽屏格子够宽（≈250px），照旧直接列任务、照旧灰色邻月 —— 用户要求只改手机端。
 *
 * ⚠️ 这里零回调：点邻月日期跳月走 `data-jump-month`、点任务开抽屉走 `.task-el`、
 *   点空格子新建走 `[data-zone-id]`，全由 `#content` 上那一个委托处理
 *   （见 app/clickDispatch.ts 与 AGENTS.md「点击事件必须走委托」）。
 * ⚠️ 窄屏那一行的勾选圈是 CSS 省掉的（47px 宽放不下圈 + 字），想勾完成要点开
 *   抽屉 —— 这是窄屏的取舍，不是漏了。
 */

import { useRef } from 'react';
import type { LocalState, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { dayLoad, tasksOn } from '../../domain/model.ts';
import { monthCellCapacity } from '../../domain/layout.ts';
import { TaskPill, loadLevel } from '../parts.tsx';
import { useDroppableZone } from '../../ui/dndkit.tsx';
import { NewCellSlot } from './NewCell.tsx';
import { useIsNarrow, useElementHeight } from '../../ui/hooks.ts';

const MONTH_CELL_MAX = 8;
/** 窄屏那一行最多画几个点，再多就写成 +N */
const MAX_DOTS = 4;

/** 42 天摊成 7 行（宽屏路径） */
function chunk7(days: string[]): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));
  return rows;
}

/** 格子内口径：未完成在前（按时间），已完成在后 —— 只在月视图这一处用 */
function cellOrder(list: Task[]): Task[] {
  const open = list.filter((t) => !t.done);
  const done = list.filter((t) => t.done);
  return [...open, ...done];
}

/**
 * 这一格显示几条、下面该画几个点。
 *
 * 先按「不放点」算能放几行；真有溢出才改用「留点位」的口径 —— 少掉的条数
 * 正好就是点的个数，所以点那一行永远画得下。
 * 传入的两个 room 由调用方算，**已经把草稿那一行扣掉了**（见 MonthView 里
 * 逐格调用 monthCellCapacity 的地方），这里不再自己减 —— 减两次会少显示一行。
 */
function cellCounts(ts: Task[], roomPlain: number, roomWithDots: number): { shown: Task[]; more: number } {
  if (ts.length <= roomPlain) return { shown: ts, more: 0 };
  const room = Math.max(0, roomWithDots);
  return { shown: ts.slice(0, room), more: ts.length - room };
}

function MonthCell({ state, d, curMonth, today, anchorIso, narrow, shown, more }: {
  state: LocalState; d: string; curMonth: number; today: string; anchorIso: string;
  narrow: boolean; shown: Task[]; more: number;
}) {
  const zone = useDroppableZone(`day:${d}`);
  const dt = D.parseISO(d);
  const out = dt.getMonth() !== curMonth;
  const load = dayLoad(state, d);
  const lv = loadLevel(load.mins);
  /* 邻月的格子照画、照能点：点数字跳到那个月（见 clickDispatch 的 data-jump-month）。
     基准必须是**完整日期** —— addMonths 先 parseISO，给它 "2026-10" 会算出
     NaN-NaN-NaN。用当月的 1 号当基准最稳（月运算不会被"日"顶超）。 */
  const monthJump = out ? D.addMonths(D.monthStart(anchorIso), dt.getMonth() - curMonth) : undefined;

  return (
    <div
      className={'month-cell' + (out ? ' out' : '') + (d === today ? ' today' : '') + (lv ? ' lv' + lv : '')}
      ref={zone.ref}
      data-zone-id={`day:${d}`}
      data-date={d}
    >
      <div className="cell-head">
        <span
          className={'cell-date' + (load.count ? ' busy' : '')}
          data-jump={out ? undefined : d}
          data-jump-month={monthJump}
          title={out ? '看 ' + D.fmtMD(d) + ' 所在的那个月' : '看这一天的日程'}
        >{dt.getDate()}</span>
        {d === today && <span className="cell-today">今天</span>}
        {!!load.mins && (
          <span className="cell-load" title={'已排 ' + D.fmtDuration(load.mins)}>
            {D.shortLoad(load.mins)}
          </span>
        )}
      </div>
      <div className="cell-tasks">
        {shown.map((t) => (
          <TaskPill key={t.id} task={t} showTime />
        ))}
        {/* 点空格子 → 任务就建在这一天（月视图不带时间） */}
        <NewCellSlot state={state} zoneId={`day:${d}`} />
        {more > 0 && (narrow ? (
          <div className="cell-more" data-jump={d} title={'查看 ' + D.fmtMD(d) + ' 的完整日程'}>
            {Array.from({ length: Math.min(more, MAX_DOTS) }).map((_, i) => <i key={i} className="more-dot" />)}
            {more > MAX_DOTS && <span className="more-n">+{more - MAX_DOTS}</span>}
          </div>
        ) : (
          <div className="cell-more" data-jump={d} title={'查看 ' + D.fmtMD(d) + ' 的完整日程'}>
            还有 {more} 项 ›
          </div>
        ))}
      </div>
    </div>
  );
}

export function MonthView({ state, iso }: { state: LocalState; iso: string }) {
  const narrow = useIsNarrow();
  const gridRef = useRef<HTMLDivElement>(null);
  const h = useElementHeight(gridRef);
  /* 窄屏只画含当月某天的那些周（10 月是 5 行）；宽屏照旧整 6 周 */
  const weeks = narrow ? D.monthWeeks(iso) : chunk7(D.monthMatrix(iso));
  const curMonth = D.parseISO(iso).getMonth();
  const today = D.today();
  /* 窄屏是 flex 均分 → 每格高确定（网格高减行间距再除行数）。首帧量不到
     （h=0）先按「能显示 2 行」算，ResizeObserver 下一帧重渲染修正。 */
  const cellH = narrow ? (h > 0 ? (h - (weeks.length - 1) * 1) / weeks.length : 62) : 0;

  return (
    <div className="month-view">
      <div className="month-head">
        {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
          <div className="month-head-cell" key={w}>周{w}</div>
        ))}
      </div>
      <div className="month-grid" ref={gridRef}>
        {weeks.map((row) => row.map((d) => {
          const ts = cellOrder(tasksOn(state, d));
          /* 草稿那一行必须显式预留，否则输入框会把内容顶出格子（窄屏 overflow:hidden）。
             逐格算：只有开着草稿的那一格才扣。 */
          const draftHere = !!state.ui.draft && state.ui.draft.zone === `day:${d}`;
          const roomPlain = narrow ? monthCellCapacity(cellH, false, draftHere) : MONTH_CELL_MAX;
          const roomWithDots = narrow ? monthCellCapacity(cellH, true, draftHere) : MONTH_CELL_MAX;
          const { shown, more } = cellCounts(ts, roomPlain, roomWithDots);
          return (
            <MonthCell
              key={d} state={state} d={d} curMonth={curMonth} today={today}
              anchorIso={iso} narrow={narrow} shown={shown} more={more}
            />
          );
        }))}
      </div>
    </div>
  );
}
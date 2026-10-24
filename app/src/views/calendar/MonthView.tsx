/**
 * MonthView.tsx —— 月视图
 *
 * 这一页**宽窄屏都是「一屏画完、不滚」**的：行数只算**含当月某天的那些周**
 * （见 domain/date.ts 的 monthWeeks —— 10 月是 5 行，不再多画一整行 11/2–11/8；
 * 2026-10-22 起宽屏也走这条，纯下月的空白行宽窄都不画），行高由 flex 均分剩余
 * 高度。格子高度确定 → 窄屏能塞几行文字是算得出的：`domain/layout.ts` 的
 * monthCellCapacity，那几个常数与 responsive.css 窄屏那段同源。
 *
 * 格子里一行一条任务（标题放不下**直接裁掉**，不用省略号 —— 省略号要占整整一个
 * 汉字宽，去掉它一行能多显示一个字）。**窄屏**塞不下的在**最后一条可见文字尾巴上**
 * 挂一个 "+N"（参考图 Google 日历：公司+2）—— 行内的，不单独占一行，省下的
 * 高度能多显示一行。**宽屏不截断**（2026-10-22 用户：显示不完就格内滚动看全部）：
 * 全部渲染，溢出交给 `.cell-tasks` 自己滚（浮条滚动条，不占格内宽度）。
 * 格子内口径是「未完成在前（按时间），已完成在后」。
 * 宽屏照旧灰色邻月格（`.out`）—— 邻月格照画、照能点。
 *
 * ⚠️ 这里零回调，全由 `#content` 上那一个委托处理（见 app/clickDispatch.ts
 *   与 AGENTS.md「点击事件必须走委托」）：
 *   · 点任务（含 "+N"）= `data-jump` → 那一天的**日视图**（不是开抽屉）；
 *   · 点月份数字 = `data-jump` → 那一天的日视图；
 *   · 点**空白处** = `data-jump`（挂在整个格子上）→ 那一天的日视图；
 *   · 点邻月数字 = `data-jump-month` → 那一个月（邻月格子不挂 data-jump，不挡它）；
 *   · 月视图**不提供就地新建**（`data-no-draft`）—— 格子太挤。
 * ⚠️ 窄屏那一行的勾选圈是 CSS 省掉的（45px 宽放不下圈 + 字），想勾完成要点开
 *   抽屉；时间也放不下 —— 这两个都是窄屏取舍，不是漏了。
 */

import { useRef } from 'react';
import type { LocalState, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { dayLoad, tasksOn } from '../../domain/model.ts';
import { monthCellCapacity } from '../../domain/layout.ts';
import { TaskPill, loadLevel } from '../parts.tsx';
import { useDroppableZone } from '../../ui/dndkit.tsx';
import { useIsNarrow, useElementHeight } from '../../ui/hooks.ts';

/** 格子内口径：未完成在前（按时间），已完成在后 —— 只在月视图这一处用 */
function cellOrder(list: Task[]): Task[] {
  const open = list.filter((t) => !t.done);
  const done = list.filter((t) => t.done);
  return [...open, ...done];
}

/**
 * 这一格显示几条、还剩几条没显示（挂在最后一条尾巴上成 "+N"）。
 *
 * `room` 由调用方算，**已经把草稿那一行扣掉了**（见 MonthView 里逐格调用
 * monthCellCapacity 的地方）—— 这里不再自己减，减两次会少显示一行。
 * 溢出时少掉的那几条正好就是 N，所以 "+N" 永远数得上来。
 */
function cellCounts(ts: Task[], room: number): { shown: Task[]; more: number } {
  if (ts.length <= room) return { shown: ts, more: 0 };
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
      /* 月视图**不提供「点空白处就地新建」**（用户 2026-10-19：格子本来就挤），
         改成**点空白处 = 去看那一天的日视图**（同日再次要求，与点任务同一条路）。
         `data-zone-id` 还得留着 —— 拖拽落点（dnd/timeline.ts）靠它找 DOM；
         `data-no-draft` 只让 clickDispatch 的 draftSeedFrom 别在这儿开草稿框。
         ⚠️ `data-jump` 只挂在本月的格子上：邻月格子挂了会把「点邻月数字跳那个月」
         （第 2.1 步 data-jump-month）挡在前面那一步之外。 */
      data-no-draft="1"
      data-jump={out ? undefined : d}
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
        {/* 最后一条可见的挂 "+N"（more > 0 时）—— 行内的，不单独占一行。
            ⚠️ 只有窄屏走这套：宽屏格子不截断（全部渲染 + `.cell-tasks` 格内滚动，
            2026-10-22 用户「显示不完就滚着看全部」），没有 more 可言。
            点这一行 = 去看那一天的**日视图**（jumpDay），不是开任务抽屉
            —— 用户 2026-10-19 明确要求。 */}
        {shown.map((t, i) => (
          <TaskPill
            key={t.id} task={t} jumpDay={d}
            moreSuffix={narrow && i === shown.length - 1 && more > 0 ? more : undefined}
          />
        ))}
      </div>
    </div>
  );
}

export function MonthView({ state, iso }: { state: LocalState; iso: string }) {
  const narrow = useIsNarrow();
  const gridRef = useRef<HTMLDivElement>(null);
  const h = useElementHeight(gridRef);
  /* 只画含当月某天的那些周（10 月是 5 行）。2026-10-22 起宽屏也走这条 ——
     以前宽屏死画 6 周，10 月末尾多一整行纯下月（11/2–11/8）的空白行。 */
  const weeks = D.monthWeeks(iso);
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
          /* 月格 `data-no-draft` 根本不开草稿（clickDispatch 见之返回 null），
             无需预留草稿行 —— 传默认值 false。 */
          /* 窄屏格子限高：算得出能塞几条（monthCellCapacity），超出的在最后一条
             尾巴上挂 "+N"。宽屏**不截断**（2026-10-22 用户：显示不完就格内滚动
             看全部）—— 全部渲染，溢出交给 `.cell-tasks` 自己滚（calendar.css）。 */
          const { shown, more } = narrow
            ? cellCounts(ts, monthCellCapacity(cellH))
            : { shown: ts, more: 0 };
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
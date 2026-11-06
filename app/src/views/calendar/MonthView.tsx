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
 *   与 AGENTS.md「点击事件必须走委托」）。**点击分三档**（2026-10-26 用户改）：
 *   · 点**日期数字** = `data-jump` → 那一天的日视图；
 *   · 点**格子空白处** = 就地弹出新建输入框（`day:<日期>` 这一块由 NewCellSlot
 *     认领），日期跟着格子走、时间未定 —— 打不出字就回车落库、Esc 取消；
 *   · 点**任务条** = 开这条任务的详情抽屉（不再是跳日视图，同日用户改）；
 *     `+N` 尾巴例外，点它 = 去看那一天（它的意思是「还有 N 条，去日视图看」）；
 *   · 点邻月数字 = `data-jump-month` → 那一个月；
 *   · **邻月格子点空白不弹输入框**（`data-no-draft`，同日用户定：灰格里
 *     误触新建更烦）；邻月格子本来也不挂 `data-jump`。
 * ⚠️ 窄屏那一行的勾选圈是 CSS 省掉的（45px 宽放不下圈 + 字），想勾完成要点开
 *   抽屉；时间也放不下 —— 这两个都是窄屏取舍，不是漏了。
 *
 * 上下滑翻月（2026-11-01 用户）：整页包在 `.month-swipe > .month-track` 里，
 * 手指纵向拖时由 app/monthSwipe.ts 直接写 `--mdrag` 让 track 跟手位移，
 * 上下各挂一页**静态预览**（MonthGhost，见下）—— 视图这边只订阅「是否在滑」
 * 一个布尔量，中间态一次 React 更新都没有。
 */

import { useRef } from 'react';
import type { LocalState, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { dayLoad, tasksOn, openFirst } from '../../domain/model.ts';
import { colorOf, creatorOf } from '../../domain/people.ts';
import { monthCellCapacity } from '../../domain/layout.ts';
import { TaskPill, loadLevel } from '../parts.tsx';
import { draftOn, NewCellSlot } from './NewCell.tsx';
import { useDroppableZone } from '../../ui/dndkit.tsx';
import { useIsNarrow, useElementHeight } from '../../ui/hooks.ts';
import { useMonthSwipeActive } from '../../app/monthSwipe.ts';

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
      /* 点击分档见文件头。两个标记各管一件事：
         · 本月的格子**不再挂 `data-jump`** —— 那会让「点空白」先跳日视图，
           轮不到第 4 步的草稿逻辑；跳转改由里面的 `.cell-date`（日期数字）承担。
         · `data-no-draft` 只留在**邻月格子**上：灰格子点空白不弹输入框
           （2026-10-26 用户定），点数字照旧跳那个月。
         `data-zone-id` / `data-date` 必须留 —— 拖拽落点与草稿种子都靠它们。 */
      data-no-draft={out ? '1' : undefined}
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
        {/* 就地新建的草稿框（2026-10-26）：认领 `day:<日期>` 这一块。
            放在任务条**前面** —— 刚点出来的输入框就在格子上方、离手指最近，
            打完字的落库日期由这一格的 `data-date` 决定（时间未定）。
            邻月格子不会走到这里：那边 `data-no-draft` 让 draftSeedFrom 直接返回 null，
            不会有草稿认领，渲染出来也是个 null。 */}
        <NewCellSlot state={state} zoneId={`day:${d}`} />
        {shown.map((t, i) => (
          <TaskPill
            key={t.id} task={t} moreJumpDay={d}
            calColor={colorOf(state.cals, t.calId)}
            /* 来源 tag：**窄屏不画**（2026-11-06 用户第二版口径：
               「移动端的月视图和周视图不显示归属标记」）。
               手机上一格只有 48px，胶囊里只剩 4 个字的位置，一枚圈就要吃掉两个 ——
               宽屏照画。日视图不受这条限制（那里的卡片是整宽）。 */
            creator={state.ui.showCreatorTag && !narrow
              ? creatorOf(state.users, t.createdBy, state.meId) : null}
            showRepeatMark={state.ui.showRepeatMark}
            moreSuffix={narrow && i === shown.length - 1 && more > 0 ? more : undefined}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 邻月预览 —— 上下滑翻月时从上下边缘露出来的那一页（见 app/monthSwipe.ts）。
 *
 * 刻意**不复用 MonthView**：那是真视图，每格都注册 `day:<日期>` 放置区、
 * 每条胶囊都注册拖拽 id；同一个 DOM 里挂三份就是三套同名 —— dnd-kit 的落点
 * 会错位（一拖之后任务飞到别的日子）。所以这里只画"样子"：日期 + 几条标题，
 * 不带 data-zone-id / data-jump / 任何监听，外层 `pointer-events: none`。
 * 它只在手指按住的那一两百毫秒里存在，样式沿用 `.month-cell / .cell-head /
 * .cell-date / .task-pill`，观感与真视图一致。
 */
function MonthGhost({ state, iso }: { state: LocalState; iso: string }) {
  const weeks = D.monthWeeks(iso);
  const curMonth = D.parseISO(iso).getMonth();
  const today = D.today();
  return (
    <div className="month-view month-ghost" aria-hidden="true">
      <div className="month-head">
        {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
          <div className="month-head-cell" key={w}>周{w}</div>
        ))}
      </div>
      <div className="month-grid">
        {weeks.map((row) => row.map((d) => {
          const dt = D.parseISO(d);
          const out = dt.getMonth() !== curMonth;
          /* 预览不截断也不滚：格子 overflow:hidden，多出来的自己就没了。
             取前 5 条够占满一格（窄屏一格也就 2~4 条）。 */
          const ts = openFirst(tasksOn(state, d)).slice(0, 5);
          return (
            <div className={'month-cell' + (out ? ' out' : '') + (d === today ? ' today' : '')} key={d}>
              <div className="cell-head">
                <span className="cell-date">{dt.getDate()}</span>
              </div>
              <div className="cell-tasks">
                {ts.map((t) => (
                  <div className="task-pill" key={t.id} data-cal-color={colorOf(state.cals, t.calId)}>
                    <span className="pill-title">{t.title}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        }))}
      </div>
    </div>
  );
}

export function MonthView({ state, iso }: { state: LocalState; iso: string }) {
  const narrow = useIsNarrow();
  const gridRef = useRef<HTMLDivElement>(null);
  const h = useElementHeight(gridRef);
  /* 上下滑翻月：手势进行中才挂邻月预览（用户 2026-11-01）。
     位移由 app/monthSwipe.ts 直接写 `.month-track` 的 `--mdrag`，不经过 React。 */
  const swiping = useMonthSwipeActive();
  /* 只画含当月某天的那些周（10 月是 5 行）。2026-10-22 起宽屏也走这条 ——
     以前宽屏死画 6 周，10 月末尾多一整行纯下月（11/2–11/8）的空白行。 */
  const weeks = D.monthWeeks(iso);
  const curMonth = D.parseISO(iso).getMonth();
  const today = D.today();
  /* 窄屏是 flex 均分 → 每格高确定（网格高减行间距再除行数）。首帧量不到
     （h=0）先按「能显示 2 行」算，ResizeObserver 下一帧重渲染修正。 */
  const cellH = narrow ? (h > 0 ? (h - (weeks.length - 1) * 1) / weeks.length : 62) : 0;

  return (
    <div className="month-swipe">
      <div className="month-track">
        {swiping && (
          <div className="month-ghost-layer above">
            <MonthGhost state={state} iso={D.addMonths(iso, -1)} />
          </div>
        )}
        <div className="month-view">
          <div className="month-head">
            {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
              <div className="month-head-cell" key={w}>周{w}</div>
            ))}
          </div>
          <div className="month-grid" ref={gridRef}>
            {weeks.map((row) => row.map((d) => {
              /* 未完成在前、已完成在后（openFirst，2026-10-23 起三处视图共用同一口径） */
              const ts = openFirst(tasksOn(state, d));
              /* 这一格正开着草稿箱时，任务少显示一条给它让位（`reserveDraft`）。
                 不预留的话草稿框会把格子撑高、整屏行高跟着重排，点一下跳一下。
                 邻月格子永远没有草稿（data-no-draft），hasDraft 恒为 false。 */
              const hasDraft = !!draftOn(state.ui, `day:${d}`);
              /* 窄屏格子限高：算得出能塞几条（monthCellCapacity），超出的在最后一条
                 尾巴上挂 "+N"。宽屏**不截断**（2026-10-22 用户：显示不完就格内滚动
                 看全部）—— 全部渲染，溢出交给 `.cell-tasks` 自己滚（calendar.css）。 */
              const { shown, more } = narrow
                ? cellCounts(ts, monthCellCapacity(cellH, hasDraft))
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
        {swiping && (
          <div className="month-ghost-layer below">
            <MonthGhost state={state} iso={D.addMonths(iso, 1)} />
          </div>
        )}
      </div>
    </div>
  );
}
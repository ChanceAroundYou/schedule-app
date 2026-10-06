/**
 * Calendar.tsx —— 日 / 周 / 月三视图
 *
 * 类名与 DOM 结构照抄 legacy/views.js —— styles.css 就是按这套写的。
 * 契约里最容易被「顺手简化」掉、但一改就出 bug 的几条：
 *
 *   · `.allday-zone` 上的 data-drop + data-date 必须挂在**最外层**。
 *     它内部有 padding，挂到内层 `.allday-items` 上的话，拖到留白、
 *     任务之间的空隙、容器边缘时 closest('[data-drop]') 找不到 zone，
 *     drop 静默失败 —— 用户看到的就是「有的任务拖不动」。
 *   · 时间轴的占用底纹 `.tl-busy` 必须与方块**同列宽**，不能整条铺满，
 *     否则两个穿插任务叠在一起时整段时间被染色。
 *   · 月视图行高只写**下限**（minmax(下限, auto)），不均分：
 *     均分会在 1920×1080 下拉出大片空白，而且刚好铺满时
 *     scrollHeight === clientHeight，滚轮彻底失效。
 */

import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { LocalState, Task } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import { DAY_H, HOUR_H, layoutOverlap, timeRange, type Slot } from '../domain/layout.ts';
import { dayLoad, tasksOn, untimedOn } from '../domain/model.ts';
import { CheckBtn, TaskPill, loadLevel } from './parts.tsx';

/* ============================== 小工具 ============================== */

const pad2 = (n: number): string => (n < 10 ? '0' + n : String(n));

function hours24(): number[] {
  return Array.from({ length: 24 }, (_, h) => h);
}

/* ============================== 日视图 ============================== */

function DayView({ state, iso }: { state: LocalState; iso: string }) {
  const tasks = tasksOn(state, iso);
  const timed = tasks.filter((t) => t.time);
  // 已完成的未定时任务不再占日程位置 —— 它去了「今天 › 今天已完成」
  const allday = tasks.filter((t) => !t.time && !t.done);

  const slots: Slot<Task>[] = timed.map((t) => {
    const start = D.timeToMin(t.time) || 0;
    return { item: t, start, end: start + (t.duration || 60) };
  });
  const events = layoutOverlap(slots);

  const isToday = iso === D.today();
  const nowMin = D.nowMin();
  // 未定时任务多时排两列，省得把下面的时间轴挤出屏幕
  const cols = allday.length > 3 ? 2 : 1;

  return (
    <>
      <div className="allday-zone" data-drop="allday" data-date={iso}>
        <div className="allday-items" data-cols={cols} style={{ '--cols': cols } as CSSProperties}>
          {allday.map((t) => <TaskPill key={t.id} task={t} />)}
          {!allday.length && <div className="zone-empty">没有未定时间的任务</div>}
        </div>
      </div>

      <div className="tl-wrap">
        <div className="timeline" data-date={iso} data-drop="timeline" style={{ height: DAY_H }}>
          {hours24().map((h) => (
            <div className="tl-hour" key={h} style={{ top: h * HOUR_H }}>
              <span className="tl-label">{pad2(h)}:00</span>
            </div>
          ))}

          <div className="tl-layer">
            {events.map((e) => {
              const w = 100 / e.cols;
              return (
                <div
                  className="tl-busy"
                  key={e.item.id}
                  data-busy={e.item.id}
                  style={{
                    top: e.start / 1440 * DAY_H,
                    height: Math.max(2, (e.end - e.start) / 1440 * DAY_H),
                    left: `${e.col * w}%`,
                    width: `calc(${w}% - 4px)`,
                  }}
                />
              );
            })}
          </div>

          {isToday && (
            <div className="tl-now" style={{ top: nowMin / 1440 * DAY_H }}>
              <i />
              <span>{D.minToTime(nowMin)}</span>
            </div>
          )}

          <div className="tl-events">
            {events.map((e) => {
              const t = e.item;
              const top = e.start / 1440 * DAY_H;
              const hgt = Math.max(24, (e.end - e.start) / 1440 * DAY_H);
              const w = 100 / e.cols;
              const live = isToday && nowMin >= e.start && nowMin < e.end;
              // 方框不到两行高时省掉时间行，只留标题，避免挤成两半
              const roomy = hgt >= 46;
              return (
                <div
                  className={'tl-event task-el' + (t.done ? ' done' : '') + (live ? ' live' : '')}
                  key={t.id}
                  data-id={t.id}
                  draggable
                  title={`${t.title}　${timeRange(e.start, e.end - e.start)}　${D.fmtDuration(e.end - e.start)}`}
                  style={{ top, height: hgt, left: `${e.col * w}%`, width: `calc(${w}% - 4px)` }}
                >
                  <div className="ev-head">
                    <CheckBtn id={t.id} on={!!t.done} sm />
                    <span className="ev-title">{t.title}</span>
                  </div>
                  {roomy && <span className="ev-time">{timeRange(e.start, e.end - e.start)}</span>}
                  <span className="ev-resize ev-resize-top" data-act="resize-top" data-id={t.id} />
                  <span className="ev-resize" data-act="resize" data-id={t.id} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

/* ============================== 周视图 ============================== */

function weekEvents(state: LocalState, iso: string) {
  const slots: Slot<Task>[] = tasksOn(state, iso).filter((t) => t.time).map((t) => {
    const start = D.timeToMin(t.time) || 0;
    return { item: t, start, end: start + (t.duration || 60) };
  });
  return layoutOverlap(slots);
}

function WeekView({ state, iso }: { state: LocalState; iso: string }) {
  const start = D.weekStart(iso);
  const days = Array.from({ length: 7 }, (_, i) => D.addDays(start, i));
  const today = D.today();

  return (
    <div className="week-view" id="weekView">
      <div className="week-head" id="weekHead">
        <div className="week-head-gutter" />
        <div className="week-head-cols">
          {days.map((d, i) => {
            const load = dayLoad(state, d);
            const lv = loadLevel(load.mins);
            return (
              <button
                className={'week-head-cell' + (d === today ? ' today' : '') + (i >= 5 ? ' weekend' : '')}
                key={d}
                data-jump={d}
                title={'跳到 ' + D.fmtMD(d)}
              >
                <span className="wh-week">周{D.weekdayShort(d)}</span>
                <span className="wh-day">{D.parseISO(d).getDate()}</span>
                <span className={'wh-load lv' + lv}><i style={{ width: `${Math.min(100, load.mins / 480 * 100)}%` }} /></span>
                <span className="wh-count">{tasksOn(state, d).length}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 未定时单独一行、固定高度，保证下面各列的刻度线横向对齐 */}
      <div className="week-un-row">
        <div className="week-un-gutter">未定时</div>
        <div className="week-un-cols">
          {days.map((d) => {
            const un = untimedOn(state, d);
            return (
              <div className={'wun-cell' + (d === today ? ' today' : '')} key={d} data-drop="allday" data-date={d}>
                {un.length
                  ? un.map((t) => <TaskPill key={t.id} task={t} />)
                  : <span className="wun-empty" />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="week-grid">
        <div className="week-gutter">
          {hours24().map((h) => (
            <div className="wk-hour" key={h} style={{ top: h * HOUR_H }}>
              <span>{pad2(h)}:00</span>
            </div>
          ))}
        </div>
        <div className="week-cols">
          {days.map((d) => (
            <div className={'week-col' + (d === today ? ' today' : '')} key={d} data-drop="week" data-date={d}>
              {weekEvents(state, d).map((e) => {
                const t = e.item;
                const w = 100 / e.cols;
                return (
                  <div
                    className={'wk-event task-el' + (t.done ? ' done' : '')}
                    key={t.id}
                    data-id={t.id}
                    draggable
                    title={`${t.title} ${t.time} · ${D.fmtDuration(t.duration || 60)}`}
                    style={{
                      top: e.start / 1440 * DAY_H,
                      height: Math.max(20, (e.end - e.start) / 1440 * DAY_H),
                      left: `${e.col * w}%`,
                      width: `calc(${w}% - 3px)`,
                    }}
                  >
                    <span className="wk-time">{t.time}</span>
                    <span className="wk-title">{t.title}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================== 月视图 ============================== */

const MONTH_CELL_MAX = 8;

function MonthView({ state, iso }: { state: LocalState; iso: string }) {
  const days = D.monthMatrix(iso);
  const curMonth = D.parseISO(iso).getMonth();
  const today = D.today();

  return (
    <div className="month-view">
      <div className="month-head">
        {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
          <div className="month-head-cell" key={w}>周{w}</div>
        ))}
      </div>
      <div className="month-grid">
        {days.map((d) => {
          const dt = D.parseISO(d);
          const out = dt.getMonth() !== curMonth;
          const ts = tasksOn(state, d);
          const more = ts.length - Math.min(ts.length, MONTH_CELL_MAX);
          const load = dayLoad(state, d);
          const lv = loadLevel(load.mins);
          return (
            <div
              className={'month-cell' + (out ? ' out' : '') + (d === today ? ' today' : '') + (lv ? ' lv' + lv : '')}
              key={d}
              data-date={d}
              data-drop="day"
            >
              <div className="cell-head">
                <span
                  className={'cell-date' + (load.count ? ' busy' : '')}
                  data-jump={d}
                  title="看这一天的日程"
                >{dt.getDate()}</span>
                {d === today && <span className="cell-today">今天</span>}
                {!!load.mins && (
                  <span className="cell-load" title={'已排 ' + D.fmtDuration(load.mins)}>
                    {D.shortLoad(load.mins)}
                  </span>
                )}
              </div>
              <div className="cell-tasks">
                {ts.slice(0, MONTH_CELL_MAX).map((t) => (
                  <TaskPill key={t.id} task={t} showTime />
                ))}
                {more > 0 && (
                  <div className="cell-more" data-jump={d} title={'查看 ' + D.fmtMD(d) + ' 的完整日程'}>
                    还有 {more} 项 ›
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================ 高度 / 滚动 ============================ */

const MONTH_ROW_MIN = 104;
const MONTH_ROW_MAX = 132;
const MONTH_HEAD_H = 30;

/** 量出内容区减去内边距的净高。不写 calc(100vh - N)：工具栏 / 缩放 / 系统字号都会让 N 猜错 */
function availHeight(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  return el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
}

/**
 * 视图尺寸 + 滚动位置。
 *
 * 滚动位置必须在**渲染阶段**读：React 是先跑完整棵树的 render、再统一改 DOM，
 * 所以 render 期间 DOM 还是旧的，这时读到的才是重绘前的位置。
 * 放进 effect 读到的已经是新内容的 scrollTop（被清零了），永远存成 0。
 */
export function useViewLayout(
  contentRef: React.RefObject<HTMLElement | null>,
  key: string,
  nav: string,
  view: string,
): void {
  const saved = useRef({ scroll: 0, week: 0, key: '' });
  const el = contentRef.current;

  if (el) {
    saved.current.scroll = el.scrollTop;
    const g = el.querySelector<HTMLElement>('.week-view');
    saved.current.week = g ? g.scrollTop : 0;
  }

  useLayoutEffect(() => {
    const host = contentRef.current;
    if (!host) return;

    const fit = () => {
      const wv = host.querySelector<HTMLElement>('.week-view');
      if (wv) {
        const head = wv.querySelector('.week-head');
        // 表头实测高度写成变量：下面那行 sticky 的 top 取的就是它，写死必错
        if (head) wv.style.setProperty('--week-head-h', head.getBoundingClientRect().height + 'px');
        wv.style.height = Math.max(420, availHeight(host)) + 'px';
      }
      const grid = host.querySelector<HTMLElement>('.month-grid');
      if (grid) {
        const row = Math.round(Math.max(
          MONTH_ROW_MIN,
          Math.min(MONTH_ROW_MAX, (availHeight(host) - MONTH_HEAD_H) / 6),
        ));
        grid.style.gridTemplateRows = '';
        // minmax(下限, auto)：下限保证尽量占满一屏，auto 让内容多的行自己长高 → 能滚
        grid.style.gridAutoRows = `minmax(${row}px, auto)`;
      }
    };

    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
    // 每次渲染都重跑：切视图 / 改窗口宽高都要重算，而这里是纯读写的便宜操作
  });

  useEffect(() => {
    const host = contentRef.current;
    if (!host) return;

    if (key === saved.current.key) {
      // 同一页面内的增删改保持原位 —— 勾选、拖动排序时画面不该突然跳走
      host.scrollTop = saved.current.scroll;
      const g = host.querySelector<HTMLElement>('.week-view');
      if (g) g.scrollTop = saved.current.week;
      return;
    }
    saved.current.key = key;

    if (nav === 'calendar' && view === 'day') {
      host.scrollTop = Math.max(0, D.nowMin() / 1440 * DAY_H - 160);
    } else if (nav === 'calendar' && view === 'week') {
      host.scrollTop = 0;
      const g = host.querySelector<HTMLElement>('.week-view');
      // 早上别一上来就是半夜：9 点前先定位到 7:00
      if (g) {
        const anchor = D.nowMin() < 7 * 60 ? 7 * 60 : D.nowMin();
        g.scrollTop = Math.max(0, anchor / 1440 * DAY_H - 40);
      }
    } else {
      host.scrollTop = 0;
    }
  }, [contentRef, key, nav, view]);
}

/* ============================== 分发 ============================== */

export function CalendarView({ state }: { state: LocalState }) {
  const ui = state.ui;
  if (ui.view === 'day') return <DayView state={state} iso={ui.cursor} />;
  if (ui.view === 'week') return <WeekView state={state} iso={ui.cursor} />;
  return <MonthView state={state} iso={ui.cursor} />;
}

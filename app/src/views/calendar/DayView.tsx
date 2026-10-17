/**
 * DayView.tsx —— 日视图
 *
 * **定时 / 未定时是同一套系统**（2026-10-11 用户裁决：「彻底统一进同一套系统和
 * 逻辑，复用同一套组件，只是位置不同和有没有时间」）。统一的是三样：
 *
 *   1. **一个卡片组件** `TaskCard`。勾选圈、标题、把手、done / dragging 样式
 *      只有一份；差别全在父级算好的 `style` / `cls` / `timeText` 里 ——
 *      有 `time` 的按时间轴百分比定位，没有的按未定时网格槽位定位。
 *   2. **一个拖拽 hook** `useClampedDraggableEvent`。两个方向都钳在各自容器内，
 *      所以卡片不会横向飘出面板（未定时原先用不带钳制的那个，于是横向是自由的）。
 *   3. **一个堆叠上下文 + 不裁剪**。`.allday-zone` 与 `.tl-wrap` 都不建堆叠上下文、
 *      都不 `overflow: clip`，唯一个堆叠上下文是 `.day-panel`（`z-index: 0`）。
 *      拖起来的卡片 `z-index: 9` 在这个空间里必胜 —— 从上拖到下、从下拖到上头
 *      都不会被另一个区遮挡或裁掉。
 *
 *   > 这三个症状（拖下来被挡、向上被分割线挡）**不是算法问题**，是「两个容器
 *   > 各自 clip、各自 z-index」的直接后果。所以修法是把容器合成一个，
 *   > 不是在某一个里面调坐标。
 */

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { DraftSeed, LocalState, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { layoutOverlap, minToPct, pctRange, spanOf, timeRange, windowOf, type DayWindow, type Slot } from '../../domain/layout.ts';
import { tasksOn } from '../../domain/model.ts';
import { CheckBtn } from '../parts.tsx';
import { useClampedDraggableEvent, useDroppableZone, useDragSession } from '../../ui/dndkit.tsx';
import { pad2, hours24, type LayoutEvent } from './shared.ts';
import { draftOn, NewCellSlot } from './NewCell.tsx';

/** 未定时区最多露几卡。两行 × 三列 = 6 —— 用户 2026-10-11 定的格子。
 *  超出的一律不渲染：区域高度**固定两块**，多渲染只会溢出到时间轴上盖住它。
 *  静默截断等于丢数据，所以末尾补一行「还有 N 个」。 */
const UNTIMED_MAX = 6;

/**
 * 日视图的卡片。**定时和未定时共用这一个组件** —— 位置由父级给的 `style`
 * 决定，有没有第二行时间由 `timeText` 决定，其余完全一致。
 */
function TaskCard({
  t, cls, style, timeText, noteText, title, resizable,
}: {
  t: Task;
  /** 模式与状态类（定时 / 未定时 / done / live）—— 由父级按数据拼 */
  cls: string;
  /** 位置：定时给四件套（top/height/left/width），未定时只给高度 */
  style: CSSProperties;
  /** 第二行的时间段文案。未定时传 null —— 它没有时间 */
  timeText: string | null;
  /** 详细内容的摘要。同 timedText 的门道：位置不够就传 null */
  noteText: string | null;
  title: string;
  /** 上下沿的拖拽把手。未定时卡片没有起止时间，给不了 */
  resizable: boolean;
}) {
  /* 两个方向都走**带钳制**的那个 hook：横向不许飘出容器，纵向跟着指针走。 */
  const drag = useClampedDraggableEvent(t.id);
  return (
    <div
      className={cls + (drag.isDragging ? ' dragging' : '')}
      ref={drag.ref}
      style={{ ...drag.style, ...style }}
      {...drag.attributes}
      {...drag.listeners}
      data-id={t.id}
      title={title}
    >
      <div className="ev-head">
        <CheckBtn id={t.id} on={!!t.done} sm />
        <span className="ev-title">{t.title}</span>
      </div>
      {timeText && <span className="ev-time">{timeText}</span>}
      {noteText && <span className="ev-note">{noteText}</span>}
      {resizable && (
        <>
          <span
            className="ev-resize ev-resize-top" data-act="resize-top" data-id={t.id}
            tabIndex={0} aria-label={'调整「' + t.title + '」的开始时间，方向键上下微调'}
          />
          <span
            className="ev-resize" data-act="resize" data-id={t.id}
            tabIndex={0} aria-label={'调整「' + t.title + '」的结束时间，方向键上下微调'}
          />
        </>
      )}
    </div>
  );
}

/**
 * 定时卡片。**内容与定位分开放**：文案、类名、四件套位置在这里算好，
 * 再交给共用的 `TaskCard` 渲染 —— 这样「两种卡片是同一套」就不是一句空话，
 * 而是真的只有一处 DOM。
 */
function TimedCard({ e, isToday, nowMin, win, isDragSrc }: { e: LayoutEvent; isToday: boolean; nowMin: number; win: DayWindow; isDragSrc: boolean }) {
  const t = e.item;
  /* 纵向一律走**百分比**：时间轴高度由容器决定（锁单屏），写死 px 会在
     窗口一缩放就整体错位。完全在窗外的整条不画，跨过窗沿的按窗沿截断。 */
  const box = pctRange(e.start, e.end, win);
  if (!box) return null;
  const w = 100 / e.cols;
  const live = isToday && nowMin >= e.start && nowMin < e.end;
  /* 时间段那行只有块够高才画。判据跟着窗口走（收窄时间窗 = 每小时更高），
     所以不能再拿写死的 px 比 —— 用百分比跟最小可读高度比。 */
  const roomy = box.height >= 3.4;
  const hasEnd = t.duration != null;
  return (
    <TaskCard
      t={t}
      cls={'task-el task-el--timed' + (t.done ? ' done' : '') + (live ? ' live' : '') + (isDragSrc ? ' dragging' : '')}
      style={{ top: box.top + '%', height: Math.max(1.2, box.height) + '%', left: `${e.col * w}%`, width: `${w}%` }}
      timeText={roomy ? (hasEnd ? timeRange(e.start, e.end - e.start) : D.minToTime(e.start)) : null}
      /* 详细内容也只在块够高时才露一行 —— 判据与时间行共用同一个 `roomy`：
         同一张卡要不要多出一行是**按空间算的**，写第二行会把标题挤没，
         那不如不写。完整内容仍在抽屉里。 */
      noteText={roomy && t.note ? t.note : null}
      title={`${t.title}　${timeRange(e.start, e.end - e.start)}　${D.fmtDuration(e.end - e.start)}`}
      resizable={hasEnd}
    />
  );
}

/**
 * 草稿框在时间轴上的位置 —— **高度给的是默认时长那一段**（`D.durOf(null)` 是
 * 60 分钟），所以「框占多大，回车之后那条任务就正好占多大」，所见即所得。
 *
 * 起点同样是百分比：时间轴的高度由容器说了算（锁单屏），写 px 会一缩放就错位。
 * 分钟已经在点击那一刻对齐到 15 分钟了（`yToMin`），这里不再取整 ——
 * 二次取整会让框与真正的那条卡差出半格。
 */
function draftBox(seed: DraftSeed, win: DayWindow): CSSProperties {
  const min = D.timeToMin(seed.time) ?? win.from;
  const top = minToPct(Math.max(win.from, Math.min(win.to, min)), win) ?? 0;
  const h = Math.min(D.durOf(null), win.to - min);
  return { top: top + '%', height: Math.max(1.2, (h / spanOf(win)) * 100) + '%' };
}

export function DayView({ state, iso }: { state: LocalState; iso: string }) {
  const tasks = tasksOn(state, iso);
  const timed = tasks.filter((t) => t.time);
  // 已完成的未定时任务不再占日程位置 —— 它去了「今天 › 今天已完成」
  const allday = tasks.filter((t) => !t.time && !t.done);

  /* 时间窗由设置决定（默认整天）。窗外的事件整条不画，小时线也只画窗内的。 */
  const win = windowOf(state.ui);

  const slots: Slot<Task>[] = timed.map((t) => {
    const start = D.timeToMin(t.time) || 0;
    return { item: t, start, end: start + D.durOf(t.duration) };
  });
  const events = layoutOverlap(slots);

  const isToday = iso === D.today();
  const nowMin = D.nowMin();

  const timelineZone = useDroppableZone(`timeline:${iso}`);
  const alldayZone = useDroppableZone(`allday:${iso}`);
  const { activeId } = useDragSession();

  /* 就地新建的草稿落在哪一区 —— 两区的 zone id 不同，天然互斥 */
  const draftTl = draftOn(state.ui, `timeline:${iso}`);
  const draftAllday = draftOn(state.ui, `allday:${iso}`);

  /* 只画窗内的小时线。`h * HOUR_H` 那套写死的像素在锁定单屏之后必错。
     **按「每小时多少像素」定疏密**：同样 24 小时，大屏每小时 27px、
     手机每小时 12px，按小时数分档（>22 → 3）会让默认的整天视图永远停在
     最疏那一档。判据换成像素后，只有真的挤在一起才跳档。 */
  const totalHours = (win.to - win.from) / 60;
  const [tlH, setTlH] = useState(0);
  const tlRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = tlRef.current;
    if (!el) return;
    const measure = () => setTlH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pxPerHour = tlH > 0 ? tlH / totalHours : 40;
  /* 阈值跟着**实际像素**走，不跟着小时数走。整天 24 小时在常见桌面高度
     （时间轴 500–700px）下是 21–29px/h，旧判据 `>22 小时 → step3`会让默认
     的整天视图永远停在最疏那档（用户报过「密度太疏」）。
     20px/h 以下才跳 step2：那时标签已经挤到 20px 一格，隔行画才读得清。 */
  const step = pxPerHour < 14 ? 3 : pxPerHour < 20 ? 2 : 1;
  /* 含 24:00 —— 一天最后一条线。少了它，把 dayTo 设成 22:00 时时间轴
     底部就光秃秃的没有结束线（用户 2026-10-11）。`<=` 而非 `<`。 */
  const hours = hours24().filter((h) => h * 60 >= win.from && h * 60 <= win.to && h % step === 0);
  /* 窗外就不画「现在」那条线 —— 它落在窗外的位置，画出来是贴边的一条假线 */
  const nowPct = minToPct(nowMin, win);

  /* ---- 未定时网格：两行，第 3 个起三列 ---- */
  const cols = allday.length > 2 ? 3 : 1;
  const shown = allday.slice(0, UNTIMED_MAX);
  const hidden = allday.length - shown.length;
  /* 卡片高度 = 一小时（时间轴上的一小时像素数）。**用掉 2px 当上下边距**：
     用户 2026-10-11 要求「卡片内部上下各留 1px，不占额外空间但变窄一点」——
     用高度收，不用 margin（margin 会把固定两行的区域撑破，第三行溢出去
     盖住时间轴）。卡片之间于是有 2px 的缝，肉眼几乎看不出。 */
  const cardH = pxPerHour > 0 ? pxPerHour : 40;
  const cardStyle: CSSProperties = { height: cardH - 2, marginBlock: 1 };

  return (
    <>
      <div className="day-panel">
        <div
          className="allday-zone" ref={alldayZone.ref}
          data-zone-id={`allday:${iso}`} data-date={iso}
        >
          <div className="allday-items" data-cols={cols} style={{ '--cols': cols } as CSSProperties}>
            {shown.map((t) => (
              <TaskCard
                key={t.id}
                t={t}
                cls={'task-el task-el--untimed' + (t.done ? ' done' : '')}
                style={cardStyle}
                timeText={null}
                /* 未定时卡是一行高度的小药丸，塞不进第二行 ——
                   它的详细内容只在列表与抽屉里露面 */
                noteText={null}
                title={t.title}
                resizable={false}
              />
            ))}
            {/* 点全天区任何一个空位 → 它就长在这一格里（未定时 → 不落时间） */}
            <NewCellSlot state={state} zoneId={`allday:${iso}`} />
            {!!hidden && <div className="zone-more">还有 {hidden} 个未定时间的任务</div>}
            {/* 空提示与草稿框不同时出现：正要往这里建东西的时候，
                「没有未定时间的任务」这句话是句废话 */}
            {!allday.length && !draftAllday && <div className="zone-empty">没有未定时间的任务</div>}
          </div>
        </div>

        <div className="tl-wrap">
          <div
            className="timeline" ref={(el) => { tlRef.current = el; timelineZone.ref(el); }} data-zone-id={`timeline:${iso}`}
            data-date={iso} data-from={win.from} data-to={win.to}
          >
          {hours.map((h) => (
            <div className="tl-hour" key={h} style={{ top: ((h * 60 - win.from) / spanOf(win)) * 100 + '%' }}>
              <span className="tl-label">{pad2(h)}:00</span>
            </div>
          ))}

          <div className="tl-layer">
            {events.map((e) => {
              const w = 100 / e.cols;
              const box = pctRange(e.start, e.end, win);
              if (!box) return null;
              return (
                <div
                  className={'tl-busy' + (activeId === e.item.id ? ' drag-src' : '')}
                  key={e.item.id}
                  data-busy={e.item.id}
                  style={{
                    top: box.top + '%',
                    height: Math.max(0.3, box.height) + '%',
                    left: `${e.col * w}%`,
                    width: `calc(${w}% - 4px)`,
                  }}
                />
              );
            })}
          </div>

          {/* 当前时间线：**只要一条线**（用户 2026-10-17：「不要显示具体
              的时间，只是有一条线就够了」）。圆点和时刻文字都去掉了，
              只剩一根贯穿时间轴的细线，颜色用 --ok（深绿，主题无关）。 */}
          {isToday && nowPct !== null && (
            <div className="tl-now" style={{ top: nowPct + '%' }} />
          )}

          <div className="tl-events">
            {events.map((e) => (
              <TimedCard key={e.item.id} e={e} isToday={isToday} nowMin={nowMin} win={win} isDragSrc={activeId === e.item.id} />
            ))}
          </div>

          {/* 草稿框挂在卡片层之后 —— 同 z 序下后来者在上，省掉一层 z-index */}
          {draftTl && (
            <NewCellSlot
              state={state} zoneId={`timeline:${iso}`}
              className="new-cell--abs" style={draftBox(draftTl, win)}
            />
          )}
        </div>
        </div>
      </div>
    </>
  );
}

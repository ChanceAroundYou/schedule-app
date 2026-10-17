/**
 * DayView.tsx —— 日视图
 *
 * **定时 / 未定时是同一套系统**（2026-10-11 用户裁决：「彻底统一进同一套系统和
 * 逻辑，复用同一套组件，只是位置不同和有没有时间」）。统一的是三样：
 *
 *   1. **一个卡片组件** `TaskCard`。勾选圈、标题、把手、done / dragging 样式
 *      只有一份；差别全在父级算好的 `style` / `cls` / `timeText` 里 ——
 *      有 `time` 的按时间轴百分比定位，没有的按未定时网格槽位定位。
 *   2. **一张卡上的拖拽开关**。日视图里的卡片只在时间轴上下挪，横向是锁死的；
 *      周视图要能跨天拖，同一个开关不能两个值 —— 所以由父级给（见 TaskCard.tsx）。
 *   3. **一个堆叠上下文 + 不裁剪**。`.allday-zone` 与 `.tl-wrap` 都不建堆叠上下文、
 *      都不 `overflow: clip`，唯一个堆叠上下文是 `.day-panel`（`z-index: 0`）。
 *      拖起来的卡片 `z-index: 9` 在这个空间里必胜 —— 从上拖到下、从下拖到上头
 *      都不会被另一个区遮挡或裁掉。
 *
 *   > 这三个症状（拖下来被挡、向上被分割线挡）**不是算法问题**，是「两个容器
 *   > 各自 clip、各自 z-index」的直接后果。所以修法是把容器合成一个，
 *   > 不是在某一个里面调坐标。
 * ## 卡片搬走了（2026-10-17）
 *
 * `TaskCard` / `TimedCard` / `draftBox` 现在在 **`TaskCard.tsx`**，周视图也用它们；
 * 时间轴「每小时多少像素 / 刻度要不要抽稀」在 **`metrics.ts`** —— 周视图锁成一屏
 * 之后，这两件事两边必须一致，抄第二份必然只有一份跟着改。
 */

import { useRef, type CSSProperties } from 'react';
import type { LocalState, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import {
  coverWindow, layoutOverlap, minToPct, pctRange, spanOf, timeRange, windowOf,
  type Slot,
} from '../../domain/layout.ts';
import { tasksOn } from '../../domain/model.ts';
import { useDroppableZone, useDragSession } from '../../ui/dndkit.tsx';
import { pad2 } from './shared.ts';
import { draftOn, NewCellSlot } from './NewCell.tsx';
import { useDragCreate } from './dragCreate.ts';
import { TaskCard, TimedCard, draftBox } from './TaskCard.tsx';
import { useTimelineMetrics } from './metrics.ts';

/** 未定时区最多露几卡。两行 × 三列 = 6 —— 用户 2026-10-11 定的格子。
 *  超出的一律不渲染：区域高度**固定两块**，多渲染只会溢出到时间轴上盖住它。
 *  静默截断等于丢数据，所以末尾补一行「还有 N 个」。 */
const UNTIMED_MAX = 6;

export function DayView({ state, iso }: { state: LocalState; iso: string }) {
  const tasks = tasksOn(state, iso);
  const timed = tasks.filter((t) => t.time);
  // 已完成的未定时任务不再占日程位置 —— 它去了「今天 › 今天已完成」
  const allday = tasks.filter((t) => !t.time && !t.done);

  /* 时间窗由设置决定（默认整天）。**再按内容自动往外让一圈**（coverWindow）——
     设置在 8–20 点、却有任务排在窗外时，宁可格子矮一点也不让那条任务消失。 */
  const winSetting = windowOf(state.ui);
  const slots: Slot<Task>[] = timed.map((t) => {
    const start = D.timeToMin(t.time) || 0;
    return { item: t, start, end: start + D.durOf(t.duration) };
  });
  const win = coverWindow(winSetting, slots);
  const events = layoutOverlap(slots);

  const isToday = iso === D.today();
  const nowMin = D.nowMin();

  const timelineZone = useDroppableZone(`timeline:${iso}`);
  const alldayZone = useDroppableZone(`allday:${iso}`);
  const { activeId } = useDragSession();

  /* 在时间轴上「按住拉一段时间」→ 松手就是一条带时长的草稿。
     只认时间轴那一区：全天区没有纵向的时间刻度，无处可拉。
     坐标就取 zone 元素自己 —— 它的 rect 正是这根时间轴。 */
  const drag = useDragCreate({
    win,
    zoneAt: (target) => {
      const z = target.closest<HTMLElement>('[data-zone-id]');
      if (!z || z.dataset.zoneId !== `timeline:${iso}`) return null;
      return { zone: `timeline:${iso}`, date: iso, frame: z };
    },
  });
  const dragBox = drag.range ? pctRange(drag.range.start, drag.range.end, win) : null;

  /* 就地新建的草稿落在哪一区 —— 两区的 zone id 不同，天然互斥 */
  const draftTl = draftOn(state.ui, `timeline:${iso}`);
  const draftAllday = draftOn(state.ui, `allday:${iso}`);

  /* 刻度疏密跟周视图同一套：见 metrics.ts。
     `tlRef` 一份两用：既给 metrics 量高度，又挂 dnd 的落点区（timelineZone）。 */
  const tlRef = useRef<HTMLDivElement | null>(null);
  const { pxPerHour, hours } = useTimelineMetrics(win, tlRef);
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
            className="timeline" ref={(el) => { tlRef.current = el; timelineZone.ref(el); }}
            data-zone-id={`timeline:${iso}`}
            data-date={iso} data-from={win.from} data-to={win.to}
            onPointerDown={drag.onPointerDown}
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

          {/* 拉时间段的预览框：跟着橡皮筋长，松手就照这段开草稿 */}
          {drag.range && dragBox && (
            <div className="drag-range" style={{ top: dragBox.top + '%', height: dragBox.height + '%' }}>
              <span>{timeRange(drag.range.start, drag.range.end - drag.range.start)}</span>
            </div>
          )}
        </div>
        </div>
      </div>
    </>
  );
}

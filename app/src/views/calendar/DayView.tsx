/**
 * DayView.tsx —— 日视图
 *
 * **定时 / 未定时是同一套系统**（2026-10-11 用户裁决：「彻底统一进同一套系统和
 * 逻辑，复用同一套组件，只是位置不同和有没有时间」）。统一的是三样：
 *
 *   1. **一个卡片组件** `TaskCard`。勾选圈、标题、把手、done / dragging 样式
 *      只有一份；差别全在父级给的 `style` / `variant` / `timeText` 里 ——
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
import type { LocalState } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import {
  coverWindow, dayTimeline, minToPct, pctRange, spanOf, untimedBlanks, untimedRowPx, windowOf,
} from '../../domain/layout.ts';
import { tasksOn, untimedOn, openFirst } from '../../domain/model.ts';
import { useDroppableZone, useDragSession } from '../../ui/dndkit.tsx';
import { draftOn, NewCellSlot } from './NewCell.tsx';
import { useDragCreate } from './dragCreate.ts';
import { UntimedCard, TimedCard, draftBox } from './TaskCard.tsx';
import { TimeGutter, NowLine, NowBall, DragRangePreview, BlankRow } from './timeline.tsx';
import { useTimelineMetrics } from './metrics.ts';
import { useElementHeight, isNarrowNow } from '../../ui/hooks.ts';


export function DayView({ state, iso }: { state: LocalState; iso: string }) {
  const tasks = tasksOn(state, iso);
  const timed = tasks.filter((t) => t.time);
  /* 已完成的未定时任务**也留在日程上**（2026-10-23 用户：和定时任务统一 ——
     勾完不消失、留在原处变灰，用 openFirst 排到未完成后面，与月视图格子同一口径）。
     以前这里写的是 `!t.time && !t.done`，勾完就看不见了。 */
  const allday = openFirst(untimedOn(state, iso));

  /* 时间窗由设置决定（默认整天）。**再按内容自动往外让一圈**（coverWindow）——
     设置在 8–20 点、却有任务排在窗外时，宁可格子矮一点也不让那条任务消失。 */
  const winSetting = windowOf(state.ui);
  const events = dayTimeline(timed);
  const win = coverWindow(winSetting, events);

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
  /* 就地新建的草稿落在哪一区 —— 两区的 zone id 不同，天然互斥 */
  const draftTl = draftOn(state.ui, `timeline:${iso}`);
  const draftAllday = draftOn(state.ui, `allday:${iso}`);

  /* 刻度疏密跟周视图同一套：见 metrics.ts。
     `tlRef` 一份两用：既给 metrics 量高度，又挂 dnd 的落点区（timelineZone）。 */
  const tlRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { hours } = useTimelineMetrics(win, tlRef);
  const panelH = useElementHeight(panelRef) || 752;
  /* 未定时行高 = 这一屏上 1 小时定时卡的高；zone 高度按 visibleRows 自适应，
     迭代收敛（panelH 稳定，不随 zone 反馈）—— 避免把时间轴压成 0。 */
  let tlH = panelH * 0.7;
  let rowH = 0;
  let unVisible = 3.2;
  for (let i = 0; i < 8; i++) {
    rowH = untimedRowPx(tlH, spanOf(win));
    if (rowH <= 0) { rowH = 0; break; }
    unVisible = Math.max(1, Math.min(3.2, Math.floor(260 / rowH)));
    const zoneH = unVisible * rowH + (unVisible - 1) * 1 + 6;
    tlH = Math.max(120, panelH - zoneH);
  }
  if (rowH <= 0) rowH = 0;
  /* 窗外就不画「现在」那条线 —— 它落在窗外的位置，画出来是贴边的一条假线 */
  const nowPct = minToPct(nowMin, win);

  /* ---- 未定时网格 ----
   * **桌面从左到右排（3 列），窄屏一条一行**（用户 2026-10-22：手机屏太窄，
   *  三列只能看见半个标题）。列数由这里算，CSS 只负责照 `--cols` 铺格子 ——
   *  渲染的孔位数量必须和列数同源，否则窄屏会多出一堆空行。
   *
   * **末尾永远留一整行空白**（`blanks`）：点它就是「再加一条未定时任务」。
   *  以前这里是画一个虚线的「＋」格，但真机上点它没反应（草稿其实开了，
   *  只是被键盘一顶、界面上看不出变化），用户明确要求换掉 —— 空白行本身就是
   *  最自然的入口，而且它走的还是「点区域空白处开草稿」那条老路。 */
  const narrow = isNarrowNow();
  const cols = narrow ? 1 : 3;
  /* **一条都不截断**（2026-10-22 用户：要全部显示，不要「还有 N 个」）。
     区域高度由 CSS 的 max-height 兜住，超出在那区里自己滚 —— 时间轴高度不受影响。 */
  const shown = allday;
  /* 凑满「当前行 + 一整行」：n=1/3 列 → 6 格（整行空白）；n=4 → 3 + 3 格。
     算式收进 domain（`untimedBlanks`），周视图同款，改一处两边一起变。 */
  const blanks = untimedBlanks(shown.length, cols);

  return (
    <>
      <div className="day-panel" ref={panelRef}>
        <div
          className="allday-zone" ref={alldayZone.ref}
          data-zone-id={`allday:${iso}`} data-date={iso}
          style={rowH > 0 ? ({ '--row-hour': `${rowH}px`, '--un-visible': unVisible } as CSSProperties) : undefined}
        >
          <div className="allday-items" data-cols={cols} style={{ '--cols': cols } as CSSProperties}>
            {shown.map((t) => (
              <UntimedCard key={t.id} t={t} title={t.title} />
            ))}
            {/* 点全天区任何一个空位 → 它就长在这一格里（未定时 → 不落时间） */}
            <NewCellSlot state={state} zoneId={`allday:${iso}`} />
            {/* **永远多留一整行空白**。它没有文字、没有边框 —— 就是一块可点的空地，
                点下去开草稿（见 clickDispatch 的第 4 步）。
                草稿开着时少铺一格：输入框自己占了一个孔位，高度不该跟着跳。 */}
            <BlankRow n={Math.max(0, blanks - (draftAllday ? 1 : 0))} cls="allday-blank" />
            {/* 空提示与草稿框不同时出现：正要往这里建东西的时候，
                「没有未定时间的任务」这句话是句废话 */}
            {!allday.length && !draftAllday && <div className="zone-empty">没有未定时间的任务</div>}
          </div>
        </div>

        <div className="tl-wrap">
          {/* 骨架与 3 日 / 周视图**同一套**（2026-10-25）：`.timeline` 是两列 grid，
              左列刻度列 `.tl-gutter`（与周视图同一个类、同一条 CSS 规则，宽度都是
              `--tl-gutter-w`）、右列轴体 `.tl-axis`（落点区 + NFC 卡片层）。
              `data-from` / `data-to` 在两处都留着：探针按 `.timeline` 读，
              拖拽 / 点空白按 zone 读。 */}
          <div
            className="timeline"
            data-from={win.from} data-to={win.to}
            style={{ '--wk-hours': spanOf(win) / 60 } as CSSProperties}
          >
            <div className="tl-gutter">
              <TimeGutter hours={hours} win={win} />
              {/* 绿球在刻度列里（见 timeline.tsx 的 NowBall）——
                  它有一半本来就在这一列，放进这层才不会被窄屏的 sticky 盖住 */}
              {isToday && <NowBall pct={nowPct} win={win} />}
            </div>
            <div
              className="tl-axis" ref={(el) => { tlRef.current = el; timelineZone.ref(el); }}
              data-zone-id={`timeline:${iso}`}
              data-date={iso} data-from={win.from} data-to={win.to} data-timeline=""
              onPointerDown={drag.onPointerDown}
            >
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
                  只剩一根贯穿时间轴的细线，颜色用 --ok（深绿，主题无关）。
                  窗外不画（`NowLine` 收到 null 返回 null）—— 落在窗外的位置，
                  画出来是贴边的一条假线。球在刻度列里（见上面的 NowBall）。 */}
              {isToday && <NowLine pct={nowPct} win={win} />}

              <div className="tl-events">
                {events.map((e) => (
                  <TimedCard key={e.item.id} e={e} isToday={isToday} nowMin={nowMin} win={win} boxH={tlH} />
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
              <DragRangePreview range={drag.range} win={win} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

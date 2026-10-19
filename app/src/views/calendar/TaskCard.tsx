/**
 * TaskCard.tsx —— 日 / 周两视图**共用**的那张任务卡
 *
 * ## 为什么单开一个文件（2026-10-17）
 *
 * 原先这张卡写在 `DayView.tsx` 里，周视图另有一套 `.wk-event` 紧凑块。
 * 两套并存的结果是：日视图能就地勾选、能拖上下沿改时长、会随时间窗自动隐藏
 * 第二行；周视图三样都没有，改一处就要问「另一处要不要跟着改」。
 * 用户明确要「样式上更多复用日视图」，于是卡片本体搬到这里，两个视图都从这里拿。
 *
 * ## 分工
 *
 * 父级负责**数据**（传进来的 `style` / `cls` / `timeText`），这里负责**样子**：
 * 勾选圈 + 标题一行、时间段一行、备注一行、上下沿的拉伸把手。
 * 「两种卡片是同一套」不是口号 —— 真的只有这一段 DOM。
 */

import type { CSSProperties } from 'react';
import type { DraftSeed, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import {
  minToPct, pctRange, spanOf, timeRange,
  type DayWindow,
} from '../../domain/layout.ts';
import { CheckBtn } from '../parts.tsx';
import { useDraggableEvent } from '../../ui/dndkit.tsx';
import type { LayoutEvent } from './shared.ts';

/**
 * 定时与未定时共用这一个组件 —— 位置由父级给的 `style` 决定，
 * 有没有第二行时间由 `timeText` 决定，其余完全一致。
 */
export function TaskCard({
  t, cls, style, timeText, noteText, title, resizable, lockX = true,
}: {
  t: Task;
  /** 模式与状态类（定时 / 未定时 / done / live）—— 由父级按数据拼 */
  cls: string;
  /** 位置：定时给四件套（top/height/left/width），未定时只给高度 */
  style: CSSProperties;
  /** 第二行的时间段文案。未定时传 null —— 它没有时间 */
  timeText: string | null;
  /** 详细内容的摘要。同 timeText 的门道：位置不够就传 null */
  noteText: string | null;
  title: string;
  /** 上下沿的拖拽把手。未定时卡片没有起止时间，给不了 */
  resizable: boolean;
  /** 横向锁死。**日视图必须锁**（同一天里只在时间轴上下挪），
      周视图不锁 —— 7 列并排时让它横着跟不上手，就等于跨天拖不动。 */
  lockX?: boolean;
}) {
  const drag = useDraggableEvent(t.id);
  return (
    <div
      className={cls + (drag.isDragging ? ' dragging' : '')}
      ref={drag.ref}
      style={{
        ...drag.style,
        /* 只取位移，纵向跟手；横向不锁的时候才有自由 */
        transform: lockX
          ? `translate3d(0px, ${drag.y}px, 0px)`
          : `translate3d(${drag.x}px, ${drag.y}px, 0px)`,
        ...style,
      }}
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
 * 再交给共用的 `TaskCard` 渲染。
 */
export function TimedCard({
  e, isToday, nowMin, win, isDragSrc, lockX,
}: {
  e: LayoutEvent;
  isToday: boolean;
  nowMin: number;
  win: DayWindow;
  isDragSrc: boolean;
  lockX?: boolean;
}) {
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
      style={{ top: box.top + '%', height: Math.max(1.2, box.height) + '%', left: `${e.col * w}%`, width: `calc(${w}% - 3px)` }}
      timeText={roomy ? (hasEnd ? timeRange(e.start, e.end - e.start) : D.minToTime(e.start)) : null}
      /* 详细内容也只在块够高时才露一行 —— 判据与时间行共用同一个 `roomy`：
         同一张卡要不要多出一行是**按空间算的**，写第二行会把标题挤没，
         那不如不写。完整内容仍在抽屉里。 */
      noteText={roomy && t.note ? t.note : null}
      title={`${t.title}　${timeRange(e.start, e.end - e.start)}　${D.fmtDuration(e.end - e.start)}`}
      /* **每条定时卡都带把手**（2026-10-19 用户报「没地方拖动改时长」）：
         以前 `resizable={hasEnd}` —— 没显式设过时长的任务一个把手都没有，
         而「点一下新建」的任务恰恰占大多数。时长是「默认 60 分钟」的含义，
         不是「不许改」的含义；拖把手就是把时长落定。 */
      resizable
      lockX={lockX}
    />
  );
}

/**
 * 就地新建的草稿框在时间轴上的位置 —— **高度给的是默认时长那一段**
 * （`D.durOf(null)` 是 60 分钟），所以「框占多大，回车之后那条任务就正好
 * 占多大」，所见即所得。
 *
 * 起点同样是百分比：时间轴的高度由容器说了算（锁单屏），写 px 会一缩放就错位。
 * 分钟已经在点击那一刻对齐到 15 分钟了（`yToMin`），这里不再取整 ——
 * 二次取整会让框与真正的那条卡差出半格。
 *
 * **框多大 = 任务多大**：在时间轴上拉出来的草稿自带时长（`seed.duration`，
 * 见 dragCreate.ts），就照那段画；点一下开的草稿没有，退回默认的一小时。
 */
export function draftBox(seed: DraftSeed, win: DayWindow): CSSProperties {
  const min = D.timeToMin(seed.time) ?? win.from;
  const top = minToPct(Math.max(win.from, Math.min(win.to, min)), win) ?? 0;
  const len = seed.duration && seed.duration > 0 ? seed.duration : D.durOf(null);
  const h = Math.min(len, win.to - min);
  return { top: top + '%', height: Math.max(1.2, (h / spanOf(win)) * 100) + '%' };
}

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
import { useLayoutEffect, useRef } from 'react';
import type { DraftSeed, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import {
  minToPct, pctRange, spanOf, timeRange,
  type DayWindow,
} from '../../domain/layout.ts';
import { CheckBtn, RepeatFlag } from '../parts.tsx';
import { useDraggableEvent } from '../../ui/dndkit.tsx';
import { useDragGhost } from '../../ui/dnd/lift.ts';
import { createPortal } from 'react-dom';
import { isNarrowNow } from '../../ui/hooks.ts';
import { useStackTop, setStackTop, type LayoutEvent } from './shared.ts';

/**
 * **标题按整行裁**（2026-10-22 九条第 9 条）：卡片能给内容的高度是任意像素，
 * 直接 overflow 会把最后一行拦腰切掉半截字。这里量出 ev-body 的实际可用高度，
 * 折算成「能放下几整个标题行」（行距也算在内），把标题的 max-height 钉在
 * 行高的整数倍上 —— 装不下一整行就整行不显示，也不留占位。
 *
 * 时间/备注那两行由 `roomy` 判定决定要不要渲染（见 TimedCard），这里再给它们
 * 预留 12px 一行的高度，免得标题把它们的位子吃掉后被拦腰切。
 *
 * 用 ResizeObserver 而不是窗口 resize：卡片高度跟着时间轴百分比走，
 * 时间窗一改、卡片没动窗口也变了；跟着自己尺寸走才准。
/**
 * 定时与未定时共用这一个组件 —— 位置由父级给的 `style` 决定，
 * 有没有第二行时间由 `timeText` 决定，其余完全一致。
 */
function useWholeLineClamp(
  bodyRef: { current: HTMLElement | null },
  followRows: number,
) {
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const title = el.querySelector<HTMLElement>('.ev-title');
    if (!title) return;
    const apply = () => {
      const lh = parseFloat(getComputedStyle(title).lineHeight) || 16;
      const room = el.clientHeight - followRows * 12;
      const lines = Math.max(1, Math.floor(Math.max(0, room) / lh));
      title.style.maxHeight = (lines * lh) + 'px';
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [followRows]);
}

export function TaskCard({
  t, cls, style, timeText, noteText, title, resizable, lockX = true, onClick,
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
  /** 层叠（三件以上重叠）里「压在下面」的卡用它翻层：stopPropagation 拦下
     #content 的点击分派，不让它顺手开详情。最上面的卡不传 = 点了照常开详情 */
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}) {
  const drag = useDraggableEvent(t.id);
  /* 未定时卡在限高可滚的区里（.allday-zone / .wun-cell）—— 拖出边界会被容器
     裁掉（用户 2026-10-23：「未定时的一拖就整个消失」）。拖起时把**分身**画到
     body 上（不受任何容器裁剪），本体原地隐身（占位不变、其余卡片不跳动，
     dnd 的位移保持纯指针位移）。见 ui/dnd/lift.ts。定时卡所在的时间轴不裁，
     保持原样。 */
  const isUntimed = cls.startsWith('task-el--untimed') || cls.includes('task-el--untimed');
  const ghost = useDragGhost(isUntimed && drag.isDragging);
  const bodyRef = useRef<HTMLDivElement>(null);
  /* 8e687d8 用 useWholeLineClamp（整行裁）；我们原来的 useCardFit 已被移除，
     这里还原为 theirs 的写法以保持构建通过。 */
  useWholeLineClamp(bodyRef, (timeText ? 1 : 0) + (noteText ? 1 : 0));
  /* 卡片内容：本体和分身各渲染一份（body 的 clamp ref 只属于本体） */
  const inner = (
    <>
      {/* 内容外面**必须再包一层**：卡片自己不能 overflow:hidden（那会切断
          跨边界的拖拽），但内容（标题换行 + 时间行）在矮卡里会顶出卡片底部 ——
          见 2026-10-20 窄屏周视图。裁剪交给 `.ev-body`，拖拽不受影响。 */}
      <div className="ev-body" ref={bodyRef}>
        <CheckBtn id={t.id} on={!!t.done} />
        <div className="ev-text">
          <span className="ev-title">{t.title}</span>
          {timeText && <span className="ev-time">{timeText}</span>}
          {noteText && <span className="ev-note">{noteText}</span>}
        </div>
      </div>
      {/* 循环角标挂在**卡片层**（右上角、绝对定位），不进 .ev-body ——
          2026-10-25 用户：不要挤标题的位置。corner=true 时绝对定位到卡片右上角。 */}
      <RepeatFlag t={t} corner />
    </>
  );
  return (
    <>
      <div
        className={cls + (drag.isDragging ? ' dragging' : '')}
        ref={(el) => { ghost.setNodeRef(el); drag.ref(el); }}
        style={{
          ...drag.style,
          /* 只取位移，纵向跟手；横向不锁的时候才有自由 */
          transform: lockX
            ? `translate3d(0px, ${drag.y}px, 0px)`
            : `translate3d(${drag.x}px, ${drag.y}px, 0px)`,
          ...style,
          /* 拖拽中本体**原地隐身**：占位不变（其余卡片不跳），分身替它出场 */
          ...(isUntimed && drag.isDragging ? { visibility: 'hidden' as const } : null),
        }}
        {...drag.attributes}
        {...drag.listeners}
        onClick={onClick}
        data-id={t.id}
        title={title}
      >
        <div className="ev-body" ref={bodyRef}>
          {inner}
        </div>
        {/* 循环角标挂在**卡片层**（右上角、绝对定位），不进 .ev-body ——
            2026-10-25 用户：不要挤标题的位置。corner=true 时绝对定位到卡片右上角。 */}
        <RepeatFlag t={t} corner />
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
      {/* 分身：createPortal 到 body —— 不在 .wun-cell / .allday-zone 里，
          不会被它们的 overflow 裁掉；pointer-events:none 不挡落点判定。
          timeline.ts 的引导线优先读分身的 rect（本体原地不动）。 */}
      {isUntimed && drag.isDragging && ghost.ghostRect && createPortal(
        <div
          className={cls + ' dragging drag-ghost'}
          style={{
            position: 'fixed', left: ghost.ghostRect.left, top: ghost.ghostRect.top,
            width: ghost.ghostRect.width, height: ghost.ghostRect.height, margin: 0,
            zIndex: 90, pointerEvents: 'none',
            transform: lockX
              ? `translate3d(0px, ${drag.y}px, 0px)`
              : `translate3d(${drag.x}px, ${drag.y}px, 0px)`,
          }}
          data-id={t.id}
          aria-hidden="true"
        >
          <div className="ev-body">{inner}</div>
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * 定时卡片。**内容与定位分开放**：文案、类名、四件套位置在这里算好，
 * 再交给共用的 `TaskCard` 渲染。
 */
export function TimedCard({
  e, isToday, nowMin, win, isDragSrc, boxH, lockX, mustShowTime,
}: {
  e: LayoutEvent;
  isToday: boolean;
  nowMin: number;
  win: DayWindow;
  isDragSrc?: boolean;
  boxH?: number;
  lockX?: boolean;
  mustShowTime?: boolean;
}) {
  const t = e.item;
  /* 纵向一律走**百分比**：时间轴高度由容器决定（锁单屏），写死 px 会在
     窗口一缩放就整体错位。完全在窗外的整条不画，跨过窗沿的按窗沿截断。 */
  const box = pctRange(e.start, e.end, win);
  if (!box) return null;
  const w = 100 / e.cols;
  const live = isToday && nowMin >= e.start && nowMin < e.end;
  /* 时间段那行只有块够高才画。判据跟着窗口走（收窄时间窗 = 每小时更高），
     所以不能再拿写死的 px 比 —— 用百分比跟最小可读高度比。
     **窄屏周视图的门槛高得多**（2026-10-20 用户：「有空间还是显示时间」）：
     那里字只有 10px、卡片又窄，时间行要占掉整整一行，所以得先保证标题还剩
     至少两行才把时间放出来。断点与 CSS 那条 `@media (max-width: 900px)` 同源
     （都走 `isNarrowNow`）。 */
  const narrow = isNarrowNow();
  const roomy = box.height >= (narrow ? 5.4 : 3.4);
  const hasEnd = t.duration != null;
  /* 上下把手各占 8px，卡还没把手高就别画了（2026-10-20 用户：「高度非常窄的把
     上下把手隐藏掉」）—— 盖住整张卡反而看不见标题，也根本抓不住。
     **门槛按端分档**：窄屏的卡只有 92px 宽、字更小，同样高度下把手更碍事；
     桌面那一档定得低（3.5%），保证 24h 窗口里的 1 小时任务（≈4.2%）仍有把手
     —— browser-smoke 有一条专门验「时间轴方块带上下两个把手」。 */
  const canResize = box.height >= (narrow ? 6 : 3.5);
  /* 上下各留**固定的 1.5px**：2026-10-22 九条回归，用户点名统一成
     `height: calc(高度% - 1.5px)` 的写法 —— 以前用 0.35% 的相对缝，窗一缩
     缝就跟着缩，手机上肉眼看不见；定值缝在任何窗口下都稳定可见。
     top 保持**纯数字百分比**（探针按 parseFloat(el.style.top) 读，掺 calc 会 NaN），
     缝全部让给 height/width 的 calc 尾数。 */
  const topPct = box.top;
  const hPct = Math.max(1.2, box.height);
  /* **三件以上重叠 → 整宽层叠**（方案 C，layoutOverlap 给的 stack）。
     几何：所有卡同宽（整宽再收掉层叠总错位），left 逐件右移 5px ——
     右边缘对齐，左边缘露出 5px 一档的「便签边」，看得出底下压着几件。
     纵向（top/height）分毫不动，时间映射与拖拽全不受影响。
     z：默认最早开始的在最上（i=0）；点压着的卡把它翻到最上（见下）。 */
  const st = e.stack;
  const topI = useStackTop(st ? st.key : '', st ? st.n : 1);
  const isTop = !st || st.i === topI;
  void boxH; void mustShowTime;
  return (
    <TaskCard
      t={t}
      cls={'task-el task-el--timed' + (t.done ? ' done' : '') + (live ? ' live' : '') + (isDragSrc ? ' dragging' : '')}
      style={{
        top: topPct + '%',
        height: `calc(${hPct}% - 1.5px)`,
        left: st ? `${st.i * 5}px` : `${e.col * w}%`,
        width: st
          ? `calc(100% - ${st.n * 5 - 5 + 1.5}px)`
          : `calc(${w}% - 1.5px)`,
        zIndex: st ? (isTop ? 8 : 1 + st.i) : undefined,
        /* 圆角按卡高收（见 calendar.css 的 .task-el--timed）：父级给了容器实高的
           `--tl-h`，这里给百分比高度，两者相乘就是这张卡真正的像素高。 */
        '--card-h': hPct,
      } as CSSProperties}
      onClick={st && !isTop
        ? (ev) => {
            /* 压在下面的卡：第一下只翻层（拦住 #content 的分派，别顺手开详情）；
               翻到最上以后再点，才是开详情 */
            ev.stopPropagation();
            setStackTop(st.key, st.i);
          }
        : undefined}
      timeText={roomy ? (hasEnd ? timeRange(e.start, e.end - e.start) : D.minToTime(e.start)) : null}
      /* 详细内容也只在块够高时才露一行 —— 判据与时间行共用同一个 `roomy`：
         同一张卡要不要多出一行是**按空间算的**，写第二行会把标题挤没，
         那不如不写。完整内容仍在抽屉里。 */
      noteText={roomy && t.note ? t.note : null}
      title={`${t.title}　${timeRange(e.start, e.end - e.start)}　${D.fmtDuration(e.end - e.start)}`}
      /* **每条定时卡都带把手**（2026-10-19 用户报「没地方拖动改时长」）：
         以前 `resizable={hasEnd}` —— 没显式设过时长的任务一个把手都没有，
         而「点一下新建」的任务恰恰占大多数。时长是「默认 60 分钟」的含义，
         不是「不许改」的含义；拖把手就是把时长落定。
         但**比把手还窄的卡不给**（2026-10-20 用户要求）—— 见上面的 canResize。 */
      resizable={canResize}
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

export function UntimedCard({ t, title, lockX, style }: { t: Task; title: string; lockX?: boolean; style?: CSSProperties }) {
  return <TaskCard t={t} cls={"task-el task-el--untimed" + (t.done ? " done" : "")} style={style ?? {}} timeText={null} noteText={null} title={title} resizable={false} lockX={lockX} />;
}

export function CompactCard({ t, moreSuffix, jumpDay }: { t: Task; moreSuffix?: number; jumpDay?: string }) {
  const drag = useDraggableEvent(t.id);
  const ghost = useDragGhost(drag.isDragging);
  const cls = "task-pill task-el" + (t.done ? " done" : "") + (drag.isDragging ? " dragging" : "");
  const inner = (
    <>
      <CheckBtn id={t.id} on={!!t.done} />
      <span className="pill-title">{t.title}</span>
      <RepeatFlag t={t} corner />
      {moreSuffix ? <span className="pill-more" title={`还有 ${moreSuffix} 条`}>+{moreSuffix}</span> : null}
    </>
  );
  return (
    <>
      <div className={cls} ref={(el) => { ghost.setNodeRef(el); drag.ref(el); }}
        style={{ ...drag.style, ...(drag.isDragging ? { visibility: "hidden" as const } : null) }}
        {...drag.attributes} {...drag.listeners} data-id={t.id}
        data-untimed={t.time ? undefined : "1"} data-jump={jumpDay}
        title={t.time ? t.title + "　" + t.time : t.title}>
        {inner}
      </div>
      {drag.isDragging && ghost.ghostRect && createPortal(
        <div className={cls + " dragging drag-ghost"} style={{ position: "fixed", left: ghost.ghostRect.left, top: ghost.ghostRect.top, width: ghost.ghostRect.width, height: ghost.ghostRect.height, margin: 0, zIndex: 90, pointerEvents: "none" }} data-id={t.id} aria-hidden="true">{inner}</div>,
        document.body,
      )}
    </>
  );
}

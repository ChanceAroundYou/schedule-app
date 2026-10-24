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
 * 父级负责**数据**（传进来的 `style` / `variant` / `timeText`），这里负责**样子**：
 * 勾选圈 + 标题一行、时间段一行、备注一行、上下沿的拉伸把手。
 * 「两种卡片是同一套」不是口号 —— 真的只有这一段 DOM。
 */

import type { CSSProperties } from 'react';
import { useLayoutEffect, useRef } from 'react';
import type { DraftSeed, Task } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import {
  minToPct, pctRange, spanOf, timeRange, CARD_SEAM,
  type DayWindow,
} from '../../domain/layout.ts';
import { CheckBtn } from '../parts/CheckBtn.tsx';
import { useDraggableEvent } from '../../ui/dndkit.tsx';
import { isNarrowNow } from '../../ui/hooks.ts';
import type { LayoutEvent } from './shared.ts';

/**
 * **标题按整行裁**（2026-10-22 九条第 9 条）：卡片能给内容的高度是任意像素，
 * 直接 overflow 会把最后一行拦腰切掉半截字。这里量出 ev-body 的实际可用高度，
 * 折算成「能放下几整个标题行」（行距也算在内），把标题的 max-height 钉在
 * 行高的整数倍上 —— 装不下一整行就整行不显示，也不留占位。
 *
 * 时间行 / 备注行**先占位再算标题**：这样卡片矮的时候宁可少一行标题，
 * 时间那行也留得住（2026-10-20 用户：「有空间还是显示时间」；
 * 2026-10-24 第四轮升级成「时长超过 1 小时就必须露出来」）。
 * 那两行的高度**量真实布局值**，不再用 `--fs-meta × 1.2` 去猜 ——
 * 卡装不下时压缩的是那一行自己的**行距**（`--ev-time-lh`，见 calendar.css），
 * 猜的值两头都对不上。
 *
 * 用 ResizeObserver 而不是窗口 resize：卡片高度跟着时间轴百分比走，
 * 时间窗一改、卡片没动窗口也变了；跟着自己尺寸走才准。
 */
function useWholeLineClamp(bodyRef: { current: HTMLElement | null }) {
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const title = el.querySelector<HTMLElement>('.ev-title');
    if (!title) return;
    const apply = () => {
      const title = el.querySelector<HTMLElement>('.ev-title');
      if (!title) return;
      const text = el.querySelector<HTMLElement>('.ev-text');
      const lh = parseFloat(getComputedStyle(title).lineHeight) || 16;
      const aux = Array.from(el.querySelectorAll<HTMLElement>('.ev-time, .ev-note'));
      /* 被 CSS `display:none` 掉的行 offsetHeight 为 0（窄屏周视图的摘要行就是），
         不给它占位。行距挂在 `.ev-text` 上（那一块才是逐行排的），不在 `.ev-body`。 */
      const gap = text ? (parseFloat(getComputedStyle(text).rowGap) || 0) : 0;
      const taken = aux.reduce((s, n) => s + n.offsetHeight + gap, 0);
      const room = el.clientHeight - taken;
      const lines = Math.max(1, Math.floor(Math.max(0, room) / lh));
      title.style.maxHeight = (lines * lh) + 'px';
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
}

export type TaskCardVariant = 'timed' | 'untimed' | 'compact';

/**
 * 类名拼装收口（P0-1）：调用方只给 variant + 状态，拼装只此一处。
 * compact = 月 pill（保留 .task-pill，探针 `month-measure` / `browser-cards` 靠它）。
 */
export function taskCardClass(
  t: Task,
  variant: TaskCardVariant,
  opts?: { live?: boolean; dragging?: boolean },
): string {
  const base = variant === 'compact' ? 'task-pill task-el' : `task-el task-el--${variant}`;
  return (
    base
    + (t.done ? ' done' : '')
    + (opts?.live ? ' live' : '')
    + (opts?.dragging ? ' dragging' : '')
  );
}

/**
 * **一张卡装得下两行文字吗**（2026-10-24 第四轮）—— 尺寸全部由令牌推出来，不写死像素。
 *
 * 时间行的规则是「时长 > 60 分钟就一定显示」，可窄屏周视图一小时的槽只有 ~21px：
 * 一行标题 + 一行时间在宽松行距下要 ~28px，物理上装不下。装不下时的顺序是
 * ① **压行距**（字号不动 —— 字号一变，相邻两张卡就成了两版皮肤，见 calendar.css 那段）；
 * ② 压完还装不下才给这张卡一个**最小高**：宁可画得比真实时长长一点，
 *    也不把「09:00–10:15」裁成半截。
 *
 * 令牌只在**会改动它们的那三个轴**换档时读一次：断点（--fs-title / --fs-meta）、
 * 风格档（--border-w 1↔2px）、明暗档。每张卡各读一遍是白干活（一天视图几十张卡）。
 */
type LineBudget = {
  /** 宽松行距下「标题 + 时间行 + 内外框」需要的卡高（含 border-box） */
  loosePx: number;
  /** 压行距后同样的卡高 */
  tightPx: number;
  /** 压行距时写进内联变量的两个行高（px） */
  titleLh: string;
  timeLh: string;
};
let budgetCache: { key: string; b: LineBudget } | null = null;

function lineBudget(narrow: boolean): LineBudget {
  const d = document.documentElement;
  const key = narrow + '|' + (d.dataset.style || '') + '|' + (d.dataset.theme || '');
  if (budgetCache && budgetCache.key === key) return budgetCache.b;
  const cs = getComputedStyle(d);
  const v = (name: string, fallback: number) => {
    const x = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(x) && x > 0 ? x : fallback;
  };
  const titleFs = v('--fs-title', 12.5);
  const timeFs = v('--fs-meta', 10.5);
  const frame = 2 * v('--card-pad-y', 1) + 2 * v('--border-w', 1);
  /* 宽松档 = CSS 里的实际行高（标题走 --task-line-sm，时间行走 1.15 倍字号）
     紧凑档 = 字号 × 1.1 / × 1.0 —— **字号一个字不动**，只把行与行之间的空收紧。
     压字号是另一条路，但它会让同一屏上两张卡字号不同（相邻两卡像两版皮肤，
     calendar.css 那段规矩就是这么写的），所以排在最后、现在不用。 */
  const looseTitle = v('--task-line-sm', 16);
  const tightTitle = titleFs * 1.1;
  const looseTime = timeFs * 1.15;
  const tightTime = timeFs * 1.0;
  const b: LineBudget = {
    loosePx: looseTitle + looseTime + frame,
    tightPx: tightTitle + tightTime + frame,
    titleLh: tightTitle.toFixed(2) + 'px',
    timeLh: tightTime.toFixed(2) + 'px',
  };
  budgetCache = { key, b };
  return b;
}

/**
 * 定时与未定时共用这一个组件 —— 位置由父级给的 `style` 决定，
 * 有没有第二行时间由 `timeText` 决定，其余完全一致。
 */
export function TaskCard({
  t, variant, live, style, timeText, noteText, title, resizable, lockX = true,
}: {
  t: Task;
  /** 定时 / 未定时 / 月 pill。类名拼装收进 taskCardClass，调用方不再拼字符串 */
  variant: TaskCardVariant;
  /** 「现在正进行」高亮。定时卡由 TimedCard 算好传进来，未定时/compact 恒 false */
  live?: boolean;
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
  const bodyRef = useRef<HTMLDivElement>(null);
  useWholeLineClamp(bodyRef);
  return (
    <div
      className={taskCardClass(t, variant, { live, dragging: drag.isDragging })}
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
 * 未定时卡。`TaskCard variant="untimed"` 的薄包装 —— 日/周两视图的未定时区共用。
 *
 * 未定时卡永远只有一行（勾选圈 + 标题）：没有时间行、没有备注行、不能拉伸改时长。
 * 高度不由调用方给 —— 卡高 = 所在容器的 `--row`（见 calendar.css 的 `.task-el--untimed`），
 * 日/周/窄屏各自的 `--row` 已对齐各自的字号档；调用方再传高度只会造出第四套口径
 * （之前 `height: 24` inline vs 日 20 vs 周 22 就是这么来的）。
 */
export function UntimedCard({
  t, title, lockX, style,
}: {
  t: Task;
  title: string;
  /** 日视图锁死（默认 true），周视图要跨天拖传 false */
  lockX?: boolean;
  /** 预留：联动 C 落地（P1-3）后由 JS 写高度；现在不传 */
  style?: CSSProperties;
}) {
  return (
    <TaskCard
      t={t}
      variant="untimed"
      style={style ?? {}}
      timeText={null}
      /* 未定时卡是一行高度的小药丸，塞不进第二行 ——
         它的详细内容只在列表与抽屉里露面 */
      noteText={null}
      title={title}
      resizable={false}
      lockX={lockX}
    />
  );
}

/**
 * 定时卡片。**内容与定位分开放**：文案、类名、四件套位置在这里算好，
 * 再交给共用的 `TaskCard` 渲染。
 */
export function TimedCard({
  e, isToday, nowMin, win, boxH, lockX,
}: {
  e: LayoutEvent;
  isToday: boolean;
  nowMin: number;
  win: DayWindow;
  /** 时间轴实测高（useTimelineMetrics/useElementHeight）。0 = 还没量到，退回旧百分比判据 */
  boxH?: number;
  lockX?: boolean;
}) {
  const t = e.item;
  /* 纵向一律走**百分比**：时间轴高度由容器决定（锁单屏），写死 px 会在
     窗口一缩放就整体错位。完全在窗外的整条不画，跨过窗沿的按窗沿截断。 */
  const box = pctRange(e.start, e.end, win);
  if (!box) return null;
  const w = 100 / e.cols;
  const live = isToday && nowMin >= e.start && nowMin < e.end;
  const narrow = isNarrowNow();
  /* P0-1：roomy/canResize 改用 px 行数（boxH/pxPerHour），不再用百分比魔法数。
     boxH<=0（首帧还没量到）退回旧百分比判据，保证首帧不断言失败。 */
  const pxH = boxH && boxH > 0 ? (box.height / 100) * boxH : -1;
  const roomy = pxH >= 0 ? pxH >= (narrow ? 34 : 22) : box.height >= (narrow ? 5.4 : 3.4);
  const hasEnd = t.duration != null;
  /* 时间行**只由时长决定**（2026-10-24 第三轮，用户定）：
     ≤ 60 分钟（含整 1 小时、含没设过时长的）→ 不显示时间；
     > 60 分钟 → **一定要显示**，不再看卡片够不够高（`roomy` 不管它了）。
     装不下不藏 —— 见下面那段：先压行距，压完还装不下才加长这张卡。
     ⚠️ 原先是三种画法（够高 → 显示范围 / 不够高 → 只显示开始时间 /
     太矮 → 干脆不显示）再加窄屏 CSS 一律 `display:none` —— 同一条时长在不同
     窗口下有四种样子，用户报的「周视图怎么始终没有时间」就是这么来的。
     时长与范围仍在 `title` 气泡和抽屉里，一处不缺。 */
  const durMin = hasEnd ? (e.end - e.start) : 60;
  const timeText = durMin > 60 ? timeRange(e.start, e.end - e.start) : null;
  /* 卡片装不装得下「标题 + 时间」两行（窄屏周视图一小时只有 ~21px，两行宽松行距要 ~28px）。
     顺序见 `lineBudget`：**先压行距**（字号一个字不动），压完还装不下才给这张卡
     一个最小高 —— 宁可画得比真实时长长一点，也不把时间裁成半截。
     ⚠️ 只加长**带时间行**的卡：≤ 1 小时那档没有第二行，卡高照旧纯跟时长走。
     pxH 还没量到（首帧）什么都不加，别让首帧就按错的尺寸落版。 */
  const budget = timeText ? lineBudget(narrow) : null;
  const avail = pxH > 0 ? pxH - CARD_SEAM : -1;
  const tight = !!budget && avail >= 0 && avail < budget.loosePx;
  const floorPx = budget ? (tight ? budget.tightPx : budget.loosePx) : 0;
  const grow = tight && avail < budget!.tightPx;
  const cardPx = pxH > 0 ? Math.max(pxH - CARD_SEAM, grow ? floorPx : 0) : 0;
  /* 上下把手各占 8px，卡还没把手高就别画了（2026-10-20 用户：「高度非常窄的把
     上下把手隐藏掉」）—— 盖住整张卡反而看不见标题，也根本抓不住。
     门槛：窄屏 38px / 桌面 22px；退回档 6% / 3.5%（browser-smoke 验 1h 任务有把手）。 */
  const canResize = pxH >= 0 ? pxH >= (narrow ? 38 : 22) : box.height >= (narrow ? 6 : 3.5);
  /* 上下各留**固定的 1.5px**：2026-10-22 九条回归，用户点名统一成
     `height: calc(高度% - 1.5px)` 的写法 —— 以前用 0.35% 的相对缝，窗一缩
     缝就跟着缩，手机上肉眼看不见；定值缝在任何窗口下都稳定可见。
     top 保持**纯数字百分比**（探针按 parseFloat(el.style.top) 读，掺 calc 会 NaN），
     缝全部让给 height/width 的 calc 尾数。 */
  const topPct = box.top;
  const hPct = Math.max(1.2, box.height);
  return (
    <TaskCard
      t={t}
      variant="timed"
      live={live}
      style={{
        top: topPct + '%',
        height: `calc(${hPct}% - ${CARD_SEAM}px)`,
        left: `${e.col * w}%`,
        /* 横向缝只给**重叠分列**的卡（2026-10-24 三问题统一）：单列时未定时卡是
           100% 宽，定时卡扣掉 1.5px 就比它窄一截，左右对不齐。两条卡并排时
           缝照留（不然同簇的两条糊在一起）。 */
        width: e.cols > 1 ? `calc(${w}% - ${CARD_SEAM}px)` : `${w}%`,
        /* 圆角按卡高收（见 calendar.css 的 .task-el--timed）：这里直接把这张卡
           真正的像素高给出去（百分比 × 容器实高 − 缝），与未定时卡的 `--row`
           同一个来源，两种卡的圆角才会一样。pxH 还没量到就不给，CSS 回落 20px。
           ⚠️ 被加长过的卡给的是**加长后**的高 —— 圆角跟着肉眼看到的那张卡走。 */
        '--card-px': cardPx > 0 ? cardPx + 'px' : undefined,
        /* 紧凑行距只给「装不下宽松两行」的卡（CSS 里的默认值不动别的卡） */
        '--ev-title-lh': tight ? budget!.titleLh : undefined,
        '--ev-time-lh': tight ? budget!.timeLh : undefined,
        minHeight: grow ? floorPx.toFixed(2) + 'px' : undefined,
      } as CSSProperties}
      timeText={timeText}
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
 * 月 pill（`TaskCard variant="compact"` 的薄包装 —— 唯一渲染 `.task-pill` 的地方）。
 *
 * 探针写死的口径（`month-measure` / `android-live-check` / `browser-smoke`）：
 * `.task-pill` / `.pill-title` / `.pill-more` / `data-jump` / `data-untimed` /
 * 宽屏 CheckBtn —— DOM 一律保留，只收类名拼装与拖拽。
 * ⚠️ `.pill-time` **已不再渲染**（2026-10-24 第三轮：月视图永远不显示时间），
 * 时间改挂在 `title` 气泡上。
 * 不走 `TaskCard` 主体那套 `.ev-body`：那是纵向两行的卡片语言，月格是单行文字行，
 * 硬套会把 `text-overflow: clip`（窄屏多看一个字）与 45px 整字宽量坏。
 */
export function CompactCard({ t, moreSuffix, jumpDay }: {
  t: Task; moreSuffix?: number;
  /**
   * 传了它就给这一行挂 `data-jump`：点整条任务 → 跳到那一天的**日视图**
   * （月视图专用，2026-10-19 用户要求：点格子里的任务 = 去看那一天）。
   * 委托里 `[data-jump]` 排在 `.task-el` **前面**，所以它会盖住「点行开抽屉」。
   * 勾选圈走 `[data-act]`（第 1 步），不受影响，宽屏照旧能点圈。
   */
  jumpDay?: string;
}) {
  /* 月视图格子专用：拖到别的格子 → 改期（定时任务保时间，见 ui/dnd/timeline.ts）。
     落点计算全在那边，这里只把 dnd-kit 的拖拽柄接上。 */
  const drag = useDraggableEvent(t.id);
  return (
    <div
      className={taskCardClass(t, 'compact', { dragging: drag.isDragging })}
      ref={drag.ref}
      style={drag.style}
      {...drag.attributes}
      {...drag.listeners}
      data-id={t.id}
      data-untimed={t.time ? undefined : '1'}
      data-jump={jumpDay}
      title={t.time ? t.title + '　' + t.time : t.title}
    >
      {/* 格子里唯一一个勾选入口。**必须是 <button>**（见 CheckBtn 头注释）；
          窄屏由 CSS 藏掉（格子净宽 46.86px，圈 + 5 个字就到边），想勾完成要点开抽屉。
          ⚠️ 这条与圈径无关 —— 圈跟着字号已经缩到 9.4px 了，窄屏**照样不画**
          （2026-10-24 用户确认：手机端月视图不加勾）。 */}
      <CheckBtn id={t.id} on={!!t.done} />
      {/* **月视图不显示时间**（2026-10-24 第三轮，用户定：日 / 周看时长决定，
          月视图永远不显示）：格子里那一行只有勾选圈 + 任务名（窄屏连圈都藏）。
          时间没丢 —— 挂在 `title` 气泡上，点开还是全的。 */}
      <span className="pill-title">{t.title}</span>
      {/* 窄屏月视图专用：这一行是格子里**最后一条可见的**，尾巴上挂 "+N" 表示
          还有 N 条没显示出来（参考图 Google 日历就是「公司+2」这样）。
          +N 挂在行内而不是单独占一行 —— 省下的高度能多显示一行文字。
          它不用自己挂 data-jump：外面这条胶囊已经有，点哪儿都跳同一天。 */}
      {moreSuffix ? (
        <span className="pill-more" title={`还有 ${moreSuffix} 条`}>+{moreSuffix}</span>
      ) : null}
    </div>
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

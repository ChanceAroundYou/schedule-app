/**
 * layout.ts —— 时间轴上的摆放：重叠分列 + 时间段文案
 *
 * 重叠按「重叠簇」分列，不是全天一起分。旧算法把全天所有事件塞进一个
 * colEnds，cols 取全天最大值，于是**任何**一段重叠都会让当天所有方块一起
 * 变半宽 —— 不重叠的任务也跟着变窄。日视图与周视图共用这一份，
 * 占用底纹与方块宽度必须严格一致（底纹 left/width 用同一组 col/cols 算）。
 */

import * as D from './date.ts';

export interface Slot<T> {
  item: T;
  start: number;
  end: number;
}

export interface Placed<T> extends Slot<T> {
  /** 第几列 */
  col: number;
  /** 这一簇共几列 */
  cols: number;
}

/**
 * 就地给每个事件补上 col / cols，返回按开始时间排好序的新数组。
 *
 * 先按「重叠簇」切分：和当前簇最后一个任务有交集就并入，否则另起一组。
 * 组内再贪心分列：找最靠左且已空闲的那一列。
 */
export function layoutOverlap<T>(slots: Slot<T>[]): Placed<T>[] {
  const events: Placed<T>[] = slots
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((s) => ({ ...s, col: 0, cols: 1 }));

  const clusters: { items: Placed<T>[]; end: number }[] = [];
  let cur: { items: Placed<T>[]; end: number } | null = null;

  for (const e of events) {
    if (cur && e.start < cur.end) {
      cur.items.push(e);
      if (e.end > cur.end) cur.end = e.end;
    } else {
      cur = { items: [e], end: e.end };
      clusters.push(cur);
    }
  }

  for (const cl of clusters) {
    const colEnds: number[] = [];
    for (const e of cl.items) {
      let placed = false;
      for (let i = 0; i < colEnds.length; i++) {
        if (e.start >= colEnds[i]) {
          e.col = i;
          colEnds[i] = e.end;
          placed = true;
          break;
        }
      }
      if (!placed) {
        e.col = colEnds.length;
        colEnds.push(e.end);
      }
    }
    const cols = Math.max(1, colEnds.length);
    for (const e of cl.items) e.cols = cols;
  }

  return events;
}

/** 时间段文案：09:30 – 10:30，跨零点标「次日」 */
export function timeRange(start: number, dur: number): string {
  const s = D.minToTime(start);
  const end = start + (dur || 0);
  const e = end >= 1440
    ? '次日 ' + D.minToTime(Math.max(0, end - 1440))
    : D.minToTime(Math.min(1439, end));
  return s + ' – ' + e;
}

/**
 * 同一份时间的**紧凑写法**：`09:30–10:30`、跨零点 `23:30–次日00:30`。
 * 卡片里用这个，抽屉 / 列表 / 气泡仍用完整写法 —— 省下来的正是那两个空格
 * 和那根长破折号：72px 的周视图列里，完整写法要 67px、可用只有 54px，
 * 尾巴被省略号吃掉 13px（实测，见踩坑 52）。**同一份时间两种写法，值不变。**
 */
export function timeRangeCompact(start: number, dur: number): string {
  const s = D.minToTime(start);
  const end = start + (dur || 0);
  const e = end >= 1440
    ? '次日' + D.minToTime(Math.max(0, end - 1440))
    : D.minToTime(Math.min(1439, end));
  return s + '–' + e;
}

/** 一天 24 小时的像素高度 */
export const HOUR_H = 64;
export const DAY_H = HOUR_H * 24;

/* ================= 日视图的可见时间窗 ================= */

/**
 * 日视图只看 `[from, to)` 这一段（分钟）。默认 0–1440 = 整天。
 *
 * 有了它，日视图就能**按比例**摆事件（百分比而不是像素），于是时间轴的高度
 * 由容器说了算 —— 锁成单屏不滚动、把时间窗收窄到白天，两件事共用同一份算法。
 */
export interface DayWindow {
  from: number;
  to: number;
}

export const FULL_DAY: DayWindow = { from: 0, to: 1440 };

/** 窗宽（分钟）。下限 1 小时 —— 收得太窄时间轴就没法看了 */
export const MIN_SPAN = 60;

export function windowOf(ui: { dayFrom: number; dayTo: number }): DayWindow {
  const from = Math.max(0, Math.min(1439, Math.round(ui.dayFrom) * 60));
  let to = Math.max(0, Math.min(1440, Math.round(ui.dayTo) * 60));
  if (to - from < MIN_SPAN) to = Math.min(1440, from + MIN_SPAN);
  return { from, to };
}

/**
 * 「窗外的任务也得看得见」—— 自动让窗。
 *
 * 时间窗是给**注意力**用的（白天那十几个小时才是人真正在用的时段），
 * 但它不该让任务凭空消失：夜里 23:30 那条一旦整个落在窗外，界面上就查无此事，
 * 用户只会以为它丢了。所以真正的渲染窗 = 设置窗 ∪ 这批任务占的时间范围：
 *
 *   · 任务都在窗里 → 窗口分毫不动，设置怎么说就怎么显示；
 *   · 有东西跑到外面 → 窗口**只往外让到刚好装下它**（向外取整到整点），
 *     不是一天到头全放开。代价是那几行格子矮一点，换来任务一条不少。
 *   · 跨零点（23:00 + 2 小时 = 25:00）的下端夹回 24:00。
 *
 * 日视图 / 周视图共用这一份；严守端点对称性 —— 任何一边忘了，
 * 两个视图就会「同一条任务一个看得见一个看不见」。
 */
export function coverWindow(w: DayWindow, spans: { start: number; end: number }[]): DayWindow {
  let from = w.from;
  let to = w.to;
  for (const s of spans) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) continue;
    const start = Math.max(0, Math.min(1439, s.start));
    const end = Math.max(start, Math.min(1440, s.end));
    /* `ceil` / `floor` 到整点，是为了让刻度线落在整点上 —— 差 7 分钟
       就让出整整一小时，宁可松一点也不要半格 */

    if (end > to) to = Math.min(1440, Math.ceil(end / 60) * 60);
    if (start < from) from = Math.max(0, Math.floor(start / 60) * 60);
  }
  if (to - from < MIN_SPAN) to = Math.min(1440, from + MIN_SPAN);
  return { from, to };
}

export function spanOf(w: DayWindow): number {
  return w.to - w.from;
}

/**
 * 纵坐标 → 分钟。`boxH` 是时间轴**实测**高度。
 *
 * 刻意收 boxH 而不是收一个写死的高度常量：日视图的高度是 JS 按可见区域算出来的
 * （见 Views.fitWeekHeight），任何写死的换算都会在窗口一缩放就错位。
 * 顺手也把结果收进窗内并对齐 15 分钟。
 */
export function yToMin(y: number, boxH: number, w: DayWindow): number {
  if (boxH <= 0) return w.from;
  const raw = w.from + (y / boxH) * spanOf(w);
  const snapped = Math.round(raw / 15) * 15;
  return Math.max(w.from, Math.min(w.to - 15, snapped));
}

/**
 * 吸附到**整点**（分钟 → 分钟）。
 *
 * 为什么只在手机上用：手机上格子比手指还细，按位置换算出来的时间常年是
 * 9:07、14:23 这种，用户想的是「9 点」「10 点」这种整数（用户 2026-10-17）。
 * 网页端格子够大、用户能瞄得准，15 分钟一档就够用了（见 yToMin），
 * 硬吸整点反而丢精度 —— 所以这个函数由调用方按窄屏决定要不要用。
 *
 * 规则：距离整点 ≤30 分钟归到那个整点，超过就归到下一个整点。
 * 等价于 `Math.round(min / 60) * 60`（24:00 那头收到 23:45）。
 */
export function snapToHour(min: number): number {
  return Math.max(0, Math.min(1425, Math.round(min / 60) * 60));
}

/* ================= 窄屏月视图格子：能塞几行文字 =================
   窄屏格子塞不下整条任务名，改成「一行一条 + 最后一条尾巴上挂 +N 表示没显示出来
   的条数」。+N 是**行内**的（不单独占一行），所以容量只由文字行决定。
   实际显示几行取决于格子实测高度，所以这里是纯算术，量高的活由 MonthView 做。
   这几个常数必须与 responsive.css 窄屏那段对得上（改一处要改另一处）。 */

/** 窄屏一行任务文字占的高度：胶囊 16（14 行高 + 0 内边距 + 2 上下边框）+ 行间距 2 = 18（窄屏月视图专用小档，见 responsive.css 的 `.cell-tasks .task-pill`） */
export const MONTH_LINE_H = 18;
/** 最后一行后面没有行间距，算最大行数时要把这 2px 还回去 */
const MONTH_LAST_ROW_NO_GAP = 2;
/** 日期那一行占的高度（窄屏数字圆 18 + 下边距 3 = 21；cell-load/cell-today 窄屏不显示） */
export const MONTH_CELL_HEAD_H = 21;
/** 格子上下内边距合计（窄屏 padding 3px 1px → 上下 3+3） */
export const MONTH_CELL_PAD_H = 6;
/** 就地新建那个输入框占的高度（16.3 行高 + 4 内边距 + 2 边框 + 2 行间距）。
    月格 `data-no-draft` 根本不开草稿，调用方恒传 false —— 常数保留作签名兼容。 */
export const MONTH_DRAFT_H = 24;

/**
 * 窄屏格子放得下几行任务文字。
 *
 * 只有一样要预留：草稿那一行（就地新建的输入框占一行，不预留它会把内容顶出格子）。
 * 最后一行后面没有行间距，那 2px 还回去。
 * 这些常数与 responsive.css 窄屏那段同源（2026-10-19 真机实测），改一处要改另一处。
 */
export function monthCellCapacity(cellH: number, reserveDraft = false): number {
  let avail = cellH - MONTH_CELL_PAD_H - MONTH_CELL_HEAD_H;
  if (reserveDraft) avail -= MONTH_DRAFT_H;
  avail += MONTH_LAST_ROW_NO_GAP;
  if (avail < MONTH_LINE_H) return 0;
  return Math.floor(avail / MONTH_LINE_H);
}

/** 分钟 → 纵向百分比（0–100）。窗外返回 null —— 窗外的东西不画 */
export function minToPct(min: number, w: DayWindow): number | null {
  if (min < w.from || min > w.to) return null;
  return (min - w.from) / spanOf(w) * 100;
}

/**
 * 一段时间段 → 纵向的 top / height（%），**跨过窗沿的按窗沿截断**。
 *
 * 完全在窗外才返回 null。跨沿的不能跟着消失 —— 07:00–09:00 那条在 08:00 起的
 * 窗里还露着后一小时，整条抹掉等于「这一小时明明有事，界面上却看不见」。
 *
 * 返回的 height 已经是最小可读高度之外的真实比例；太薄的由渲染层兜底。
 */
export function pctRange(start: number, end: number, w: DayWindow): { top: number; height: number } | null {
  const a = Math.max(start, w.from);
  const b = Math.min(end, w.to);
  if (b <= a) return null;
  const span = spanOf(w);
  return { top: (a - w.from) / span * 100, height: (b - a) / span * 100 };
}

/**
 * 「按住拉一段时间」的起止 —— 时间轴上拖出来的那一段（每天勾选的地方见
 * views/calendar/dragCreate.ts，那里只管事件，算式在这里）。
 *
 * `down` 是按下点、`cur` 是指针此刻的位置，两个进来之前都对齐过 15 分钟。
 * 出去的一定是 `[≥ 窗起点, ≥ start + 30 分钟]`，且不越出窗；
 * **向上拉也认** —— 往回拖等于「把开始时间往前推」，这是时间轴的常识。
 */
export const DRAG_MIN = 30;

export function dragRange(down: number, cur: number, w: DayWindow): { start: number; end: number } {
  let start: number;
  let end: number;
  if (cur >= down) {
    start = down;
    end = Math.max(cur, down + DRAG_MIN);
  } else {
    end = down;
    start = Math.min(cur, down - DRAG_MIN);
  }
  /* 收进窗内。`to` 可能是 1440（24:00），它是合法的结束点 */
  start = Math.max(w.from, Math.min(w.to - DRAG_MIN, start));
  end = Math.max(start + DRAG_MIN, Math.min(w.to, end));
  return { start, end };
}

/**
 * 未定时网格的空白新建位（P0-2，日/周共用）。
 *
 * **永远多留一整行空白**：点它就是「这一天再加一条未定时的」。
 * 以前日视图用 `blanks` 算式、周视图用 `.wun-blank` 一个格，两边各写各的；
 * 现在一处算：`count` = 已有卡数，`cols` = 列数（日视图窄屏 1 / 桌面 3，周视图恒 1）。
 * 草稿开着时调用方减 1（输入框自己占了一个孔位，见 DayView/WunCell）。
 */
export function untimedBlanks(count: number, cols: number): number {
  if (count <= 0) return 0;
  return (Math.ceil(count / cols) + 1) * cols - count;
}

/**
 * 未定时行高 = 这一屏上「一小时」那一段的像素高 − 卡缝（2026-10-24 三问题统一）。
 *
 * 以前未定时卡高由**行高**定（`--task-line-sm` + padding + 边框 = 20px），
 * 定时卡高由**时间槽**定（`calc(百分比 − 1.5px)`）—— 两套公式，1 小时卡与
 * 未定时卡永远对不齐（窄屏实测 22.28 vs 20，圆角与 padding 跟着各长各的）。
 * 挂到同一个小时单位上，两张卡的高与圆角（都按自身高的 30%）自动处处一致。
 *
 * ## 小时按**整天**摊开，不跟着时间窗收窄放大
 *
 * 这一行是**界面行**，不是时间槽：它跟屏幕高度走（容器高的 1/24），但时间窗收到
 * 08:00–11:00 时不跟着变成 205px —— 那样未定时区会撑到七八百像素，把日面板捅穿、
 * 定时卡被压扁到只剩 min-height（2026-10-24 browser-smoke 抓到：方块 12px、
 * 拖拽中卡片跑到面板外面）。默认整天窗口下，它与 1 小时定时卡**严格同高**，
 * 那正是三问题要的效果；窗收窄只是让定时卡变高，未定时行不动。
 *
 * ⚠️ **2026-10-25 撤回过一次「按这一屏的时间窗算」的改法**：理由写的是
 * 「tlH 是固定 640px，收窄时容器不会塌」—— **那句是错的**，`.timeline` 在日视图里
 * 是 `flex: 1` / `height: 100%`，跟着面板走。照那个公式，三小时窗下未定时卡
 * 算出 205px，正是本段第一句记着的那次事故。`domain.test.ts` 那条
 * 「时间窗收窄不许把未定时行撑大」当场报红，是对的。
 *
 * 返回 0 = 「还没量到容器 / 窗口非法」，调用方回落到 CSS 默认的 `--row`，首帧不塌。
 * 太矮的屏幕（一小时算出来比一行字还窄）由 CSS 那条 `max()` 兜底，不在这里夹。
 */
export const CARD_SEAM = 1.5;

/** 整天那档的跨度 —— 未定时行高的换算基准（见上面那段） */
const MAX_SPAN = FULL_DAY.to - FULL_DAY.from;

export function untimedRowPx(timelineH: number, spanMin: number, seam = CARD_SEAM): number {
  if (!Number.isFinite(timelineH) || timelineH <= 0) return 0;
  if (!Number.isFinite(spanMin) || spanMin < MIN_SPAN) return 0;
  /* 取 `max(spanMin, 整天)`：窗比整天窄时按整天算（见上面那段），窗比整天宽
     （不会发生，夹在 0–1440）时按窗算。
     回落：spanMin 非法 / 容器没量到时返回 0，调用方回落到 CSS 的 --row-natural。 */
  const v = (60 / Math.max(spanMin, MAX_SPAN)) * timelineH - seam;
  return v > 0 ? Math.round(v * 100) / 100 : 0;
}

/**
 * 当天定时事件摆放（P0-3，日/周共用）。
 *
 * `DayView 45-58 ≡ WeekView dayEvents` 那两份逐字代码收口到这里：
 * 过滤出有 `time` 的 → 转 `Slot`（`timeToMin` / `durOf`）→ `layoutOverlap` 分列。
 * 输入是任务数组（不是 `LocalState`）—— `tasksOn` 留在视图层，
 * 这里只做纯算术，保持 `domain/` 零 React / DOM / 网络，且不反向依赖 `model/`。
 */
export function dayTimeline<T extends { time: string | null | undefined; duration: number | null }>(
  tasks: T[],
): Placed<T>[] {
  const slots: Slot<T>[] = [];
  for (const t of tasks) {
    if (!t.time) continue;
    const start = D.timeToMin(t.time) || 0;
    slots.push({ item: t, start, end: start + D.durOf(t.duration) });
  }
  return layoutOverlap(slots);
}

/**
 * 浮层锚定定位：贴着 anchor 下沿弹出；下方放不下翻到 anchor 上方，
 * 右侧超出往左收。
 *
 * 同一段算式原本逐字抄在 DatePicker / TimePicker / WhenPop / useDrawer
 * 四处（各自只有依赖数组不同），改一处漏三处。收到这里之后**只测一次**：
 * 它是纯函数，不需要 DOM。
 */
export interface PlacePanelInput {
  anchor: { top: number; bottom: number; left: number };
  size: { w: number; h: number };
  viewport: { w: number; h: number };
  /** 与 anchor 的间距，默认 6 */
  gap?: number;
  /** 与视口边缘的最小留白，默认 8 */
  pad?: number;
}

export function placePanel(i: PlacePanelInput): { top: number; left: number } {
  const { anchor, size, viewport, gap = 6, pad = 8 } = i;
  let top = anchor.bottom + gap;
  let left = anchor.left;
  if (top + size.h > viewport.h - pad) top = Math.max(pad, anchor.top - size.h - gap);
  if (left + size.w > viewport.w - pad) left = Math.max(pad, viewport.w - size.w - pad);
  return { top, left };
}


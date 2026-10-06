/**
 * dnd.ts —— 拖放：排序用「让位洞」，时间轴用「落点线」
 *
 * 从 legacy/app.js 原样搬过来的，包括那些看着绕的细节 —— 它们每一条都是
 * 实测踩出来的。改动前请先读 legacy 的注释和项目 CLAUDE.md 的「四、3」。
 *
 * 两条不能退回的设计：
 *
 *   1. **排序是「让位洞」，不是插入线。** 其他条目实时、平滑地挪开，
 *      在光标处留出一个占位洞 `.drop-hole`。位置本身就是位置，
 *      不用一条线去暗示。旧版是静态插入线，拖起来「刻板」—— 线只在跨过
 *      格子边界时跳一下，中间一大段位移完全没有反馈。
 *
 *   2. **落点判定只看「光标落在哪一格」，不比较到各条线的远近。**
 *      用「最近线段」会串行：光标在格子中心时上方那条线反而更近，
 *      于是整片区域被判成同一档，左右拖动变得没准头。
 *
 * 时间轴仍是画线（`.tl-guide`），不改成洞 —— 时间轴是连续坐标不是列表，
 * 「让位」在那里没有对应概念。
 *
 * 实现上和 legacy 一样**不动 DOM 顺序**：让位全靠 transform，落库靠
 * (refId, pos)。所以 `zoneCells()` 读到的永远是拖动开始时的原始顺序，
 * 这也是为什么必须缓存 rawLayout。
 *
 * ---------------------------------------------------------------- 触屏
 *
 * 触屏没有 HTML5 拖拽，所以另开一条输入通路（`beginTouch` / `moveTouch` /
 * `endTouch`），**落点判定、让位、提交全部复用上面同一套**：只有「怎么拿到
 * 光标坐标、怎么把被拖元素画到手指下面」这两件事是触屏特有的。
 *
 * 手势是「长按提起 → 拖动 → 松手落下」：
 *
 *   - 长按 480ms（`LONG_PRESS_MS`）把行**提起来**（`.touch-drag`：抬起阴影 +
 *     脱离层级的 z-index），**此时还没开始拖**
 *   - 提起后手指移动超过 `TOUCH_SLOP` 才真的开始拖，元素跟手走
 *   - 提起后原地松手 → 交回给 `App.tsx` 弹原来那个长按操作层。
 *     **这条不能丢**：手机上没有 hover、没有右键，操作层是删任务/改期的唯一入口。
 *     代价是操作层现在要等松手才出现（原来按住就出）—— 没法两全，因为
 *     「按住不动」和「按住准备拖」在抬手之前无法区分
 *   - 拖动期间用非 passive 的 `touchmove` + `preventDefault()` 拦住页面滚动。
 *     必须在**第一个** touchmove 就拦，等判定完再拦就晚了：滚动一旦开始
 *     就收不回来
 *
 * 鼠标那一路完全不受影响（`pointerType === 'mouse'` 直接绕过）。
 */

import { useCallback, useEffect, useRef } from 'react';
import * as D from '../domain/date.ts';
import * as store from '../data/store.ts';
import { minToTime } from '../domain/date.ts';
import { DAY_H } from '../domain/layout.ts';
import { setDragging } from './dragState.ts';
import { toast } from './kit.tsx';

const ROW_SEL = '.task-row, .task-pill, .habit-row';
/** 上下各 84px 进入自动滚动区，最快每帧 17px */
const EDGE = 84;
const MAX_SCROLL = 17;
/** 提起之后要挪过这么多像素才算「在拖」，否则当成「按住没动」 */
const TOUCH_SLOP = 8;

interface Cell { el: HTMLElement; id: string; rect: DOMRect }
interface DropRef { id: string; pos: 'before' | 'after' }

/* ------------------------------------------------------------- 模块状态 */

let dragId: string | null = null;
let dragKind: 'task' | 'habit' = 'task';
let dragEl: HTMLElement | null = null;
let dragGrabY = 0;
let dropRef: DropRef | null = null;

/** 时间轴方块拖动前的 `top`，取消时要还回去（预览阶段改的就是它） */
let dragOrigTop: string | null = null;

/** 触屏那一路的会话状态。为 null 表示这次不是触屏拖动 */
let touch: {
  el: HTMLElement; startX: number; startY: number; moved: boolean;
} | null = null;

/** 提起后原地松手时回调（App 用来弹长按操作层） */
let tapHoldCb: ((id: string, kind: 'task' | 'habit') => void) | null = null;

/**
 * 这次触摸结束后要不要吞掉浏览器补的那套鼠标事件。
 *
 * 必须吞。抬手之后 Chrome 会在同一个位置补发 mousedown / mouseup / click，
 * 而这时候界面已经变了 —— 长按弹出来的操作层，遮罩正好铺在手指底下，
 * 于是那一下 click 打在遮罩上（`.sheet-mask` 的 onClick 就是关闭），
 * **浮层刚弹出来就被自己关掉**。拖完那一行也一样，会在落点上再点一下。
 *
 * 按规范 `preventDefault()` 掉 touchend 就能整串掐掉，所以这里只在
 * 「提起过」的时候吞 —— 普通轻点（点行开抽屉）不走这条路。
 *
 * 实测事件序列（探针打的日志，别再靠猜）：
 *   pointerup → pointerleave×N → mousedown:sheet-mask → mouseup:sheet-mask → click:sheet-mask
 */
let swallowCompat = false;

/** 拖动开始时量一次的原始布局，整段拖动过程复用 */
let rawLayout: Record<string, Cell[]> = {};
/** 当前的洞 + 上一次的落点 key（只有落点真变了才重新让位） */
let shiftAnim: { hole: HTMLElement; zone: HTMLElement; key: string; cells: Cell[] } | null = null;

let autoScrollRAF: number | null = null;
let autoScrollSpeed = 0;
let dragProbe: { clientX: number; clientY: number } | null = null;
let dragProbeZone: HTMLElement | null = null;

let scrollHost: HTMLElement | null = null;

/* --------------------------------------------------------------- 工具 */

function zoneKey(zone: HTMLElement): string {
  return (zone.dataset.scope || '') + '#' + (zone.dataset.date || '');
}

/**
 * 按**视觉 row-major** 排出条目。
 *
 * 含被拖元素自己（它确实占着格子）。不按 DOM 顺序 —— DOM 顺序等于
 * row-major 只在 grid 没改过 auto-flow 时成立。
 *
 * `kind === 'habit'` 决定取 `[data-habit]` 还是 `[data-untimed="1"]`：
 * **打卡列表也走这套排序**，别以为只有任务列表能拖。
 *
 * 项目的泳道列取 `[data-card]` —— 那些卡片**同时也是 `.task-el`**（否则
 * `onDragStart` 认不出它们，拖都拖不起来）。两个 data 属性各管一头：
 * `.task-el` 管「能不能拖」，`data-card` 管「在这个容器里算哪一格」。
 */
const KIND_SEL: Record<string, string> = {
  habit: '[data-habit]',
  project: '[data-card]',
};

function zoneCells(zone: HTMLElement): Cell[] {
  const sel = KIND_SEL[zone.dataset.kind ?? ''] || '[data-untimed="1"]';
  const cells: Cell[] = Array.from(zone.querySelectorAll<HTMLElement>(sel))
    .map((el) => ({ el, id: el.dataset.id || '', rect: el.getBoundingClientRect() }));

  const rows: { top: number; cells: Cell[] }[] = [];
  for (const c of cells) {
    let row = rows.find((r) => Math.abs(r.top - c.rect.top) < 4);
    if (!row) { row = { top: c.rect.top, cells: [] }; rows.push(row); }
    row.cells.push(c);
  }
  rows.sort((a, b) => a.top - b.top);
  const out: Cell[] = [];
  for (const r of rows) {
    r.cells.sort((a, b) => a.rect.left - b.rect.left);
    out.push(...r.cells);
  }
  return out;
}

/**
 * 拖动开始时量一次原始布局。
 *
 * 三个坑，缺一个量到的就不是真实位置：
 *   1) 要清掉上一轮遗留的 transform（否则量到位移后的坐标）
 *   2) 清 transform 后过渡动画还在跑 —— 元素要 180ms 才归位，立刻量依然是
 *      半路坐标。必须临时关掉 transition 强制同步归位
 *   3) 量完要恢复 transition，否则让位动画会失效
 *
 * 这三条都是实测踩出来的：症状是第二次拖动时整列被甩到容器外（x 变成
 * -306 / 1398），而第一次完全正常。
 */
function snapshotLayout(el: HTMLElement | null): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>(ROW_SEL));
  const dirty = rows.filter((x) => x.style.transform);

  if (dirty.length) {
    for (const x of dirty) { x.style.transition = 'none'; x.style.transform = ''; }
    void document.body.offsetHeight;
  }

  rawLayout = {};
  const home = el?.closest<HTMLElement>('[data-drop]');
  if (home) rawLayout[zoneKey(home)] = zoneCells(home);

  if (dirty.length) {
    for (const x of dirty) x.style.transition = '';
    void document.body.offsetHeight;
  }
}

/** 推断列数：同一行里最多有几个格子。按几何推断对 block 单列和 grid 多列都成立 */
function inferCols(cells: Cell[]): number {
  let max = 1;
  for (const a of cells) {
    let n = 0;
    for (const b of cells) if (Math.abs(b.rect.top - a.rect.top) < 4) n++;
    if (n > max) max = n;
  }
  return max;
}

interface Hit { cell: Cell; index: number }

/** 找出光标落在（或最近）的格子。格内距离为 0，格外按到矩形的距离 */
function cellUnder(e: { clientX: number; clientY: number }, cells: Cell[]): Hit | null {
  let best: Hit | null = null;
  let bestD = Infinity;
  for (let i = 0; i < cells.length; i++) {
    const r = cells[i].rect;
    const dx = e.clientX < r.left ? r.left - e.clientX : (e.clientX > r.right ? e.clientX - r.right : 0);
    const dy = e.clientY < r.top ? r.top - e.clientY : (e.clientY > r.bottom ? e.clientY - r.bottom : 0);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestD) { bestD = d; best = { cell: cells[i], index: i }; }
  }
  return best;
}

/**
 * 落点位次 k → 排序接口要的 (refId, pos)。
 * sibs 是「去掉自己之后」的列表，插到第 k 位 = 插到 sibs[k-1] 之后（k>0）。
 */
function refForIndex(cells: Cell[], k: number): DropRef | null {
  const sibs = cells.filter((c) => c.id !== dragId);
  if (k <= 0) return sibs.length ? { id: sibs[0].id, pos: 'before' } : null;
  const prev = sibs[Math.min(k, sibs.length) - 1];
  return prev ? { id: prev.id, pos: 'after' } : { id: null as unknown as string, pos: 'after' };
}

/** 网格行距 / 列距：从实际 rect 反推，不写死 —— 分列断点会改 gap */
function rowGap(cells: Cell[]): number {
  for (let i = 1; i < cells.length; i++) {
    const d = cells[i].rect.top - cells[i - 1].rect.top;
    if (d > 0.5) return d - cells[i - 1].rect.height;
  }
  return 0;
}
function colGap(cells: Cell[]): number {
  for (let i = 1; i < cells.length; i++) {
    const d = cells[i].rect.left - cells[i - 1].rect.left;
    if (d > 0.5) return d - cells[i - 1].rect.width;
  }
  return 0;
}

/**
 * 让位：被拖元素**留在原位压暗**，其余格子各挪一格给它让出位置。
 *
 * 必须自己算 transform，不能靠把洞插到兄弟节点之间 —— 洞是
 * position:absolute（脱离文档流），插在中间不会挤开任何行。之前就是这么写的，
 * 结果 DOM 顺序变了、落库也对，画面却一动不动，看起来就是「让位没生效」。
 *
 * 被拖元素不参与位移：它留在原地当「出处」的锚点，用户能同时看到「从哪来」
 * 和「到哪去」。让它也滑到目标格的话，它会和洞叠在同一位置，两份占位叠着、
 * 原位又空出来，比不做还乱。
 *
 * 方向必须**整段统一**，不能逐格算：原来按 `i < k ? i+1 : i-1` 逐格判断，
 * 符号是反的 —— 单列下相邻两格会挪到同一位置（画面上凭空少一条任务）。
 */
function shiftCells(cells: Cell[], k: number, cols: number): void {
  const selfIdx = cells.findIndex((c) => c.el === dragEl);

  for (const c of cells) {
    if (c.el !== dragEl && c.el.style.transform) c.el.style.transform = '';
  }
  if (selfIdx < 0 || selfIdx === k) return;

  const lo = Math.min(selfIdx, k);
  const hi = Math.max(selfIdx, k);
  const first = cells[0].rect;
  const dy = first.height + rowGap(cells);
  const step = k > selfIdx ? -1 : 1;

  cells.forEach((c, i) => {
    if (i === selfIdx || i < lo || i > hi) return;
    if (cols > 1) {
      const dx = first.width + colGap(cells);
      const target = i + step;
      const dCol = (target % cols) - (i % cols);
      const dRow = Math.floor(target / cols) - Math.floor(i / cols);
      c.el.style.transform = `translate(${dCol * dx}px,${dRow * dy}px)`;
    } else {
      c.el.style.transform = `translateY(${step * dy}px)`;
    }
  });
}

/**
 * 落点判定 + 让位。
 *
 * 判定与让位一律用 dragstart 时量的**原始布局**。绝不能用 zoneCells 的实时值：
 * 让位是加在元素上的 transform，getBoundingClientRect 读到的是位移后的坐标 ——
 * 拿它当基准，落点会整体偏掉一格（实测跨行拖动整列甩出容器）。
 */
function showDropGuide(e: { clientX: number; clientY: number }, zone: HTMLElement): DropRef | null {
  const cells = rawLayout[zoneKey(zone)] || zoneCells(zone);
  if (!cells.length) return null;

  const hit = cellUnder(e, cells);
  if (!hit) return null;
  const k = hit.index;
  const r = hit.cell.rect;

  /* 洞的位置 = 目标格。left / top **都得按容器坐标算** —— 只设 left 的话
     它会一直停在原处，视觉上「让位」根本没发生（这类 bug 很隐蔽：
     落库也对、DOM 也动，就是看不见） */
  const zr = zone.getBoundingClientRect();
  let anim = shiftAnim;
  if (!anim || !anim.hole.parentNode) {
    const hole = document.createElement('div');
    hole.className = 'drop-hole';
    zone.appendChild(hole);
    anim = { hole, zone, key: '', cells };
    shiftAnim = anim;
  }
  const hole = anim.hole;
  hole.style.left = `${r.left - zr.left}px`;
  hole.style.top = `${r.top - zr.top}px`;
  hole.style.height = `${r.height}px`;
  hole.style.width = `${r.width}px`;

  /* 只有落点真的变了才重新让位：dragover 每秒能触发几十次，
     每次都重算 transform 会让过渡动画一直重启，看起来反而更卡 */
  const key = `${zone.dataset.scope}|${k}|${cells.length}`;
  if (anim.key !== key) {
    anim.key = key;
    shiftCells(cells, k, inferCols(cells));
    // 触屏那一路元素是跟手走的，压暗它反而看不见自己在拖什么
    if (!touch) dragEl?.classList.add('drag-muted');
  }

  return refForIndex(cells, k);
}

/** 拖动结束 / 离开落点容器：收掉洞，让被让位的元素回到原位 */
function clearHole(): void {
  if (!shiftAnim) return;
  shiftAnim.hole.parentNode?.removeChild(shiftAnim.hole);

  /* 让位是加在元素上的 transform，复位时同样要处理过渡动画：不断 transition
     直接清，元素会用 180ms 滑回原位而不是立刻归位，拖动中途就会看到
     「列表先弹回去再重新让位」的抖动 */
  const moved = Array.from(document.querySelectorAll<HTMLElement>(ROW_SEL))
    .filter((el) => el.style.transform);
  if (moved.length) {
    for (const el of moved) { el.style.transition = 'none'; el.style.transform = ''; }
    void document.body.offsetHeight;
    for (const el of moved) el.style.transition = '';
  }

  /* 原始布局缓存也作废：下次拖动要重新量，
     否则会拿上一次让位后的坐标当基准 */
  rawLayout = {};
  shiftAnim = null;
  dragEl?.classList.remove('drag-muted');
}

function clearBusySrc(): void {
  document.querySelectorAll('.tl-busy.drag-src').forEach((x) => x.classList.remove('drag-src'));
}

/** clearHole 独立成函数，**不要**塞进 clearDropUI —— 后者每次 dragover 都会被调 */
function clearDropUI(): void {
  document.querySelectorAll('.tl-guide').forEach((x) => x.remove());
  clearHole();
}

/* -------------------------------------------------------- 边缘自动滚动 */

function edgeScrollSpeed(clientY: number): number {
  const h = window.innerHeight;
  if (clientY < EDGE) return -MAX_SCROLL * (1 - clientY / EDGE);
  if (clientY > h - EDGE) return MAX_SCROLL * (1 - (h - clientY) / EDGE);
  return 0;
}

/**
 * 用 requestAnimationFrame **持续**滚，不是在 dragover 里挪一点 ——
 * dragover 的触发频率跟着鼠标走，鼠标不动就不触发，滚动会一顿一顿的。
 *
 * 滚完位置变了，落点必须按新位置重算，否则洞会停在旧处 —— 用户明明看到
 * 列表已经滚到别处，指示却还指着原来那条。
 */
function runAutoScroll(): void {
  autoScrollRAF = null;
  if (!dragId || !autoScrollSpeed || !scrollHost) return;
  scrollHost.scrollTop += autoScrollSpeed;
  if (dragProbe && dragProbeZone?.isConnected) showDropGuide(dragProbe, dragProbeZone);
  autoScrollRAF = requestAnimationFrame(runAutoScroll);
}

function stopAutoScroll(): void {
  autoScrollSpeed = 0;
  if (autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
}

/* ------------------------------------------------------------ 时间轴 */

/** 时间轴落点：画一条线 + 时间徽章（只画线，不改整片底色） */
function drawTimeGuide(zone: HTMLElement, min: number): void {
  const line = document.createElement('div');
  line.className = 'tl-guide';
  line.style.top = `${min / 1440 * DAY_H}px`;
  const span = document.createElement('span');
  span.textContent = minToTime(min);
  line.appendChild(span);
  zone.appendChild(line);
}

/** 用方块顶部对齐光标算落点（不是中线） */
function timeGuideMin(zone: HTMLElement, e: { clientY: number }): number {
  const rect = zone.getBoundingClientRect();
  let topMin = e.clientY - rect.top - dragGrabY;
  topMin = Math.max(0, Math.min(DAY_H - 24, topMin));
  return Math.max(0, Math.min(1425, Math.round(topMin / DAY_H * 1440 / 15) * 15));
}

/** 周视图每一列也是一根时间轴（没有抓取偏移，按光标直接定位） */
function weekGuideMin(zone: HTMLElement, e: { clientY: number }): number {
  const r = zone.getBoundingClientRect();
  const min = Math.round((e.clientY - r.top) / DAY_H * 1440 / 15) * 15;
  return Math.max(0, Math.min(1425, min));
}

/**
 * 落点容器接不接受当前被拖的东西。
 *
 * 习惯和任务是两套实体，交叉拖放会写坏数据（习惯没有 date 字段等），
 * 所以直接判掉，不给任何视觉反馈 —— 让用户以为是拖不动。
 *
 * **最后那一行不要改成 `zone.dataset.kind === dragKind`。** 泳道列的
 * `data-kind` 是 `'project'`（说的是「这一格装的是项目泳道里的卡片」），
 * 而**被拖的是任务**（`dragKind === 'task'`）—— 那样写会把「拖进泳道列」
 * 整个判掉，正是这个功能本身。现在这个「两边是不是 habit」的写法
 * 恰好是对的：project 区收 task、不收 habit。
 */
function zoneAccepts(zone: HTMLElement): boolean {
  const kind = zone.dataset.drop;
  if (kind === 'timeline' || kind === 'week') return dragKind === 'task';
  if (kind === 'allday' || kind === 'day') return dragKind === 'task';
  return (zone.dataset.kind === 'habit') === (dragKind === 'habit');
}

/* --------------------------------------------------------------- 提交 */

function commitDrop(zone: HTMLElement, e: { clientX: number; clientY: number }): void {
  const id = dragId!;
  const kind = zone.dataset.drop;
  const task = store.get().tasks[id];
  const wasHabit = dragKind === 'habit';
  const date = zone.dataset.date || null;

  if (kind === 'timeline') {
    const min = timeGuideMin(zone, e);
    store.patchTask(id, { date, time: minToTime(min) });
    toast(`已改到 ${minToTime(min)}`);
    return;
  }

  if (kind === 'week') {
    const min = weekGuideMin(zone, e);
    store.patchTask(id, { date, time: minToTime(min) });
    toast(`已改到 ${D.fmtMD(date || '')} ${minToTime(min)}`);
    return;
  }

  const baseOrder = zoneCells(zone).map((c) => c.id);

  /* 泳道列：拖进来 = 换列。**不改归属**（归属在任务详情里选）——
     与下面那条「拖动只改顺序、不改日期」同源：拖动顺手把「搬家」也做掉，
     比什么都不做更让人措手不及。 */
  if (kind === 'proj') {
    const col = (zone.dataset.scope || '').split(':')[2];
    if (col === 'done') {
      // **不是直接写 done 字段**：重复任务要靠 toggleTask 推进系列
      if (task && !task.done) store.toggleTask(id);
    } else {
      // setTaskDoing 自己认得「从已完成拖出来」（先取消完成再置 doing）
      store.setTaskDoing(id, col === 'doing');
    }
    const label = col === 'done' ? '已完成' : col === 'doing' ? '进行中' : '待办';
    toast(`已移到「${label}」`);
    return;
  }

  let refId = dropRef?.id ?? null;
  // dropRef 是拖动过程中缓存的，容器重排后它可能已经不在序列里 ——
  // 那样就会退化成「插到最后」，看着像没生效
  if (refId && baseOrder.indexOf(refId) < 0) refId = baseOrder[baseOrder.length - 1] ?? null;
  const pos = dropRef?.pos ?? 'after';

  if (kind === 'list') {
    /* 跨作用域（拖到别的日期组 / 已完成区）也只改顺序，不改日期 ——
       「搬家」是改期按钮的职责，拖动顺手做掉会让人措手不及 */
    store.reorderWithin(wasHabit ? 'habit' : 'task', baseOrder, id, refId, pos);
    toast('顺序已调整');
    return;
  }

  // 全天区 / 月视图格子：未定时任务改期 + 落位；已定时的只改日期
  if (task && task.time) {
    if (!date) return;
    store.patchTask(id, { date });
    toast(`已改到 ${D.fmtMD(date)}`);
    return;
  }
  store.moveUntimed(id, date, refId, pos);
  toast(dropRef ? '顺序已调整' : (date ? `已改到 ${D.fmtMD(date)}` : '已移回待办箱'));
}

/* ------------------------------------------------ 落点更新（两条路共用） */

/**
 * 把「光标现在在哪」翻译成「落点变了没有」。
 *
 * 鼠标那一路由 dragover 直接给出 zone；触屏那一路要先自己 hit-test 找出
 * zone（见 `zoneAt`）。**除此之外两条路完全一样** —— 时间轴的预览、
 * 列表的让位洞、边缘自动滚动，都在这里。
 */
function applyDropAt(zone: HTMLElement, pt: { clientX: number; clientY: number }): void {
  const kind = zone.dataset.drop;

  /* 时间轴：方块顶部跟随光标，并画一条顶部引导线，整片不变色 */
  if (kind === 'timeline') {
    dropRef = null;
    clearDropUI();
    const min = timeGuideMin(zone, pt);
    const src = document.querySelector<HTMLElement>(`.tl-event[data-id="${dragId}"]`);
    // 触屏是先浮起来再飘到时间轴上的，那层 transform 要收掉，
    // 不然 top 和 translate 会叠一起（方块跑到两倍远的地方）
    if (src) { src.style.transform = ''; src.style.top = `${min / 1440 * DAY_H}px`; }
    drawTimeGuide(zone, min);
    return;
  }

  clearDropUI();
  // 已定时的任务拖到别处只改日期，不参与排序（泳道列例外：那里换的是**列**，
  // 与有没有时间无关 —— 挡掉的话带时间的任务在泳道里根本拖不动）
  const t = store.get().tasks[dragId!];
  if (dragKind === 'task' && t?.time && kind !== 'proj') { dropRef = null; return; }

  dragProbe = { clientX: pt.clientX, clientY: pt.clientY };
  dragProbeZone = zone;

  const ref = showDropGuide(pt, zone);
  dropRef = ref && ref.id ? ref : null;

  const sp = edgeScrollSpeed(pt.clientY);
  if (sp !== autoScrollSpeed) {
    autoScrollSpeed = sp;
    if (sp && !autoScrollRAF) autoScrollRAF = requestAnimationFrame(runAutoScroll);
    if (!sp && autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
  }
}

/**
 * 收尾：可选地把落点提交掉，然后把所有拖动痕迹清干净。
 *
 * 两条输入通路共用。**顺序有讲究**：commitDrop 会写 store，React 要等这一轮
 * 跑完才重绘，所以清 transform 必须排在这之后 —— 那时 DOM 还是旧节点，
 * 清得掉；等重绘完再清就晚了（行已经被换成新节点，残留的 inline transform
 * 会留在复用节点上，看着就是「拖完那行永远偏着」）。
 */
function finishDrag(commit: { zone: HTMLElement; clientX: number; clientY: number } | null): void {
  stopAutoScroll();

  // 时间轴预览改的是 src 的 top。取消（没落到任何容器上）要还回去，
  // 否则方块会僵在预览位置，直到下一次重绘才跳回来
  const src = dragId ? document.querySelector<HTMLElement>(`.tl-event[data-id="${dragId}"]`) : null;
  if (src && dragOrigTop !== null && !commit) src.style.top = dragOrigTop;
  dragOrigTop = null;

  if (commit && dragId) commitDrop(commit.zone, commit);

  // 浮起来的那个副本：clearHole 在「这次没有洞」时会提前返回，清不到它
  if (dragEl) { dragEl.classList.remove('touch-drag'); dragEl.style.transform = ''; }
  touch = null;

  document.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging'));
  document.body.classList.remove('dragging-active');

  dragId = null;
  dragEl = null;
  dropRef = null;
  dragGrabY = 0;
  dragProbe = null;
  dragProbeZone = null;
  clearDropUI();
  clearBusySrc();
  setDragging(false);
}

/* ------------------------------------------------------------ 触屏这条路 */

/**
 * 手指下面那个落点容器。
 *
 * 用 `elementsFromPoint` 而不是 `elementFromPoint`：被拖元素正浮在手指底下，
 * 单取最上面那个只会拿到它自己。整摞按顺序看，跳过它和它的子树，第一个
 * 能 `closest('[data-drop]')` 的就是落点。
 * （不用 `pointer-events:none` 让开：那会动到隐式指针捕获，得不偿失。）
 */
function zoneAt(x: number, y: number): HTMLElement | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (dragEl && (el === dragEl || dragEl.contains(el))) continue;
    const z = el.closest<HTMLElement>('[data-drop]');
    if (z) return z;
  }
  return null;
}

/**
 * 长按到点：把这一行「提起来」。返回 false = 提不起来（调用方走老路弹操作层）。
 *
 * 这一步**还不是拖动** —— 只是给用户一个「抓住了」的反馈，同时把
 * 原始布局量下来（`snapshotLayout` 必须在任何 transform 之前跑）。
 */
function beginTouch(el: HTMLElement, id: string, x: number, y: number): boolean {
  if (dragId) finishDrag(null);      // 上一轮没收干净就别接着用

  dragId = id;
  dragEl = el;
  dragKind = el.classList.contains('habit-row') ? 'habit' : 'task';

  const r = el.getBoundingClientRect();
  dragGrabY = y - r.top;
  snapshotLayout(el);

  touch = { el, startX: x, startY: y, moved: false };
  swallowCompat = true;
  el.classList.add('touch-drag');
  document.body.classList.add('dragging-active');
  setDragging(true);

  const src = document.querySelector<HTMLElement>(`.tl-event[data-id="${id}"]`);
  dragOrigTop = src ? src.style.top : null;
  // 拖走的那个时间段底纹先收起来，避免和落点线打架
  document.querySelector(`.tl-busy[data-busy="${id}"]`)?.classList.add('drag-src');
  return true;
}

function moveTouch(x: number, y: number): void {
  if (!touch || !dragId || !dragEl) return;

  const dx = x - touch.startX;
  const dy = y - touch.startY;
  if (!touch.moved && Math.abs(dx) < TOUCH_SLOP && Math.abs(dy) < TOUCH_SLOP) return;
  touch.moved = true;

  const zone = zoneAt(x, y);
  // 时间轴那一路是把方块搬过去（改 top），不能再叠一层 transform
  const floats = !(zone && zone.dataset.drop === 'timeline');
  dragEl.style.transform = floats ? `translate(${dx}px,${dy}px)` : '';

  if (!zone || !zoneAccepts(zone)) { clearDropUI(); stopAutoScroll(); return; }
  applyDropAt(zone, { clientX: x, clientY: y });
}

/** 松手。返回 true = 真的拖了（调用方不用再做别的） */
function endTouch(x: number, y: number): boolean {
  if (!touch) return false;
  const moved = touch.moved;
  const id = dragId;

  if (!moved) {
    // 提起又没动 —— 那就是「长按」本来的意思，交回去弹操作层
    const kind = dragKind;
    finishDrag(null);
    if (id) tapHoldCb?.(id, kind);
    return true;
  }

  const zone = zoneAt(x, y);
  const hit = zone && zoneAccepts(zone) ? zone : null;
  finishDrag(hit ? { zone: hit, clientX: x, clientY: y } : null);
  return true;
}

function cancelTouch(): void {
  if (!touch) return;
  touch = null;
  finishDrag(null);
}

/* ================================ hook ================================ */
export interface DragHandlers {
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  /**
   * 触屏长按到点、把这一行提起来。返回 false 表示提不起来，
   * 调用方应该走原来的老路（弹长按操作层）。
   */
  beginTouch: (el: HTMLElement, id: string, x: number, y: number) => boolean;
}

/**
 * 把拖放接到一个容器上（对应 legacy 的 #content）。
 *
 * 用**事件委托**而不是给每一行挂处理器：行是 React 渲染的，
 * 拖动过程中落库、重绘都会换掉节点，逐行挂会跟着一起丢。
 *
 * `onTapHold`：触屏提起后原地松手时回调 —— App 用它弹长按操作层。
 */
export function useDragLayer(
  containerRef: React.RefObject<HTMLElement | null>,
  onTapHold?: (id: string, kind: 'task' | 'habit') => void,
): DragHandlers {
  const container = useRef<HTMLElement | null>(null);
  container.current = containerRef.current;

  useEffect(() => {
    scrollHost = containerRef.current;
    return () => { scrollHost = null; };
  }, [containerRef]);

  /* 触屏这条路的监听器挂 window 上，不挂在容器上：
     手机上的指针事件带隐式捕获，target 一直是按下时那个元素，
     而那个元素可能在拖动过程中被重绘换掉 —— 挂容器迟早会漏事件。 */
  useEffect(() => {
    tapHoldCb = onTapHold ?? null;
    return () => { tapHoldCb = null; };
  }, [onTapHold]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (touch && e.pointerType !== 'mouse') moveTouch(e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent) => {
      if (!touch || e.pointerType === 'mouse') return;
      e.preventDefault();          // 别让抬手那一下再补一个 click
      endTouch(e.clientX, e.clientY);
    };
    const onCancel = () => cancelTouch();

    /* 拖动期间必须拦住页面滚动。**只要提起过就拦**，不等到判定出「在拖」：
       滚动一旦开始就收不回来，而浏览器自己的 touch slop 和我们这个差不多大，
       等到判定完再拦正好卡在边界上。提起本身已经是一次明确的意图了。 */
    const noScroll = (e: TouchEvent) => { if (touch) e.preventDefault(); };

    /* 抬手：把浏览器补的那套鼠标事件整串掐掉（见 swallowCompat 的说明）。
       读一次就清掉 —— 它只在这一个时刻有用 */
    const onTouchEnd = (e: TouchEvent) => {
      if (!swallowCompat) return;
      swallowCompat = false;
      e.preventDefault();
    };

    /* 新手势开始 = 上一轮无论怎么结束的都翻篇了。
       少了这一句会有一个很难查的残留：`pointercancel`（系统手势抢走、
       来电、切后台）走的是 cancelTouch，**不经过 touchend**，标记就留在
       true 上；下一次轻点抬手时 `preventDefault()` 把 click 吞掉，
       表现是「点一下没反应」，而且只在那一次异常之后发生。
       放在 touchstart 上不会误伤：普通轻点从头到尾没人把它设成 true。 */
    const onTouchStart = () => { swallowCompat = false; };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('touchstart', onTouchStart);
    window.addEventListener('touchmove', noScroll, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: false });
    window.addEventListener('touchcancel', onTouchEnd, { passive: false });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', noScroll);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  const beginTouchCb = useCallback(
    (el: HTMLElement, id: string, x: number, y: number) => beginTouch(el, id, x, y),
    [],
  );

  const onDragStart = useCallback((e: React.DragEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.task-el, .habit-row');
    if (!el) return;
    const id = el.dataset.id;
    if (!id) return;

    dragId = id;
    dragEl = el;
    dragKind = el.classList.contains('habit-row') ? 'habit' : 'task';

    const r = el.getBoundingClientRect();
    dragGrabY = e.clientY - r.top;

    snapshotLayout(el);
    document.body.classList.add('dragging-active');
    // 被拖的那一行加 .dragging（抬起 / 压暗的反馈）。**finishDrag 会清掉它** ——
    // 所以这里只管加，不用自己配对
    el.classList.add('dragging');
    setDragging(true);
    e.dataTransfer.effectAllowed = 'move';
    // Firefox 不设 data 就不启动拖拽
    e.dataTransfer.setData('text/plain', id);

    // 不要浏览器自带的半透明拖影：落点已经由让位洞 / 时间轴引导线表达了，
    // 再挂一个跟着鼠标的残影是两套互相打架的指示。用一张 1×1 透明图顶掉它
    const blank = document.createElement('canvas');
    blank.width = 1;
    blank.height = 1;
    e.dataTransfer.setDragImage(blank, 0, 0);

    // 拖走的那个时间段底纹先收起来，避免和落点线打架
    const src = document.querySelector<HTMLElement>(`.tl-event[data-id="${id}"]`);
    dragOrigTop = src ? src.style.top : null;
    document.querySelector(`.tl-busy[data-busy="${id}"]`)?.classList.add('drag-src');
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    const zone = (e.target as HTMLElement).closest<HTMLElement>('[data-drop]');
    if (!zone || !dragId || !zoneAccepts(zone)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    applyDropAt(zone, e);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    /* relatedTarget 为 null（拖出窗口）也要清，否则指示线会僵在原地 ——
       之前漏了这个判断，拖出列表后线还亮着 */
    const zone = (e.target as HTMLElement).closest<HTMLElement>('[data-drop]');
    if (zone && !zone.contains(e.relatedTarget as Node)) clearDropUI();
    if (!e.relatedTarget) stopAutoScroll();
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    const zone = (e.target as HTMLElement).closest<HTMLElement>('[data-drop]');
    if (!zone || !dragId) { finishDrag(null); return; }
    if (!zoneAccepts(zone)) { finishDrag(null); return; }
    e.preventDefault();
    finishDrag({ zone, clientX: e.clientX, clientY: e.clientY });
  }, []);

  const onDragEnd = useCallback(() => {
    // drop 已经收过尾了（dragId 被清空）；这里只兜没走到 drop 的情况
    if (dragId || touch) finishDrag(null);
  }, []);

  return { onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd, beginTouch: beginTouchCb };
}

/** 时间轴上的落点要用抓取偏移（光标相对方块顶部的位置），外部别自己去算 */
export const dragGrabOffset = (): number => dragGrabY;

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

interface Cell { el: HTMLElement; id: string; rect: DOMRect }
interface DropRef { id: string; pos: 'before' | 'after' }

/* ------------------------------------------------------------- 模块状态 */

let dragId: string | null = null;
let dragKind: 'task' | 'habit' = 'task';
let dragEl: HTMLElement | null = null;
let dragGrabY = 0;
let dropRef: DropRef | null = null;

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
 */
function zoneCells(zone: HTMLElement): Cell[] {
  const sel = zone.dataset.kind === 'habit' ? '[data-habit]' : '[data-untimed="1"]';
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
    dragEl?.classList.add('drag-muted');
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
 */
function zoneAccepts(zone: HTMLElement): boolean {
  const kind = zone.dataset.drop;
  if (kind === 'timeline' || kind === 'week') return dragKind === 'task';
  if (kind === 'allday' || kind === 'day') return dragKind === 'task';
  return (zone.dataset.kind === 'habit') === (dragKind === 'habit');
}

/* --------------------------------------------------------------- 提交 */

function commitDrop(zone: HTMLElement, e: React.DragEvent): void {
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

/* ================================ hook ================================ */

export interface DragHandlers {
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}

/**
 * 把拖放接到一个容器上（对应 legacy 的 #content）。
 *
 * 用**事件委托**而不是给每一行挂处理器：行是 React 渲染的，
 * 拖动过程中落库、重绘都会换掉节点，逐行挂会跟着一起丢。
 */
export function useDragLayer(containerRef: React.RefObject<HTMLElement | null>): DragHandlers {
  const container = useRef<HTMLElement | null>(null);
  container.current = containerRef.current;

  useEffect(() => {
    scrollHost = containerRef.current;
    return () => { scrollHost = null; };
  }, [containerRef]);

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
    setDragging(true);
    e.dataTransfer.effectAllowed = 'move';
    // Firefox 不设 data 就不启动拖拽
    e.dataTransfer.setData('text/plain', id);

    // 拖走的那个时间段底纹先收起来，避免和落点线打架
    document.querySelector(`.tl-busy[data-busy="${id}"]`)?.classList.add('drag-src');
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    const zone = (e.target as HTMLElement).closest<HTMLElement>('[data-drop]');
    if (!zone || !dragId || !zoneAccepts(zone)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const kind = zone.dataset.drop;

    /* 时间轴：方块顶部跟随光标，并画一条顶部引导线，整片不变色 */
    if (kind === 'timeline') {
      dropRef = null;
      clearDropUI();
      const min = timeGuideMin(zone, e);
      const src = document.querySelector<HTMLElement>(`.tl-event[data-id="${dragId}"]`);
      if (src) src.style.top = `${min / 1440 * DAY_H}px`;
      drawTimeGuide(zone, min);
      return;
    }

    clearDropUI();
    // 已定时的任务拖到别处只改日期，不参与排序
    const t = store.get().tasks[dragId];
    if (dragKind === 'task' && t?.time) { dropRef = null; return; }

    dragProbe = { clientX: e.clientX, clientY: e.clientY };
    dragProbeZone = zone;

    const ref = showDropGuide(e, zone);
    dropRef = ref && ref.id ? ref : null;

    const sp = edgeScrollSpeed(e.clientY);
    if (sp !== autoScrollSpeed) {
      autoScrollSpeed = sp;
      if (sp && !autoScrollRAF) autoScrollRAF = requestAnimationFrame(runAutoScroll);
      if (!sp && autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
    }
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
    stopAutoScroll();
    if (!zone || !dragId) return;
    if (!zoneAccepts(zone)) { clearDropUI(); return; }
    e.preventDefault();

    const id = dragId;
    commitDrop(zone, e);

    dragId = null;
    dragEl = null;
    dropRef = null;
    dragProbe = null;
    dragProbeZone = null;
    clearDropUI();
    clearBusySrc();
    document.body.classList.remove('dragging-active');
    setDragging(false);

    // 落库后行会被重绘，旧引用已经脱离文档，别留着
    void id;
  }, []);

  const onDragEnd = useCallback(() => {
    stopAutoScroll();
    dragId = null;
    dragEl = null;
    dropRef = null;
    dragGrabY = 0;
    dragProbe = null;
    dragProbeZone = null;
    document.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging'));
    document.body.classList.remove('dragging-active');
    clearDropUI();
    clearBusySrc();
    setDragging(false);
  }, []);

  return { onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd };
}

/** 时间轴上的落点要用抓取偏移（光标相对方块顶部的位置），外部别自己去算 */
export const dragGrabOffset = (): number => dragGrabY;

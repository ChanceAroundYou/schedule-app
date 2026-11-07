/**
 * flow.ts —— 每日流程的领域逻辑（纯函数，零 React / DOM / 网络）
 *
 * ## 它和另外三样东西的区别
 *
 *   打卡   「今天有没有做」，有空就做，不分先后
 *   日程   有明确日期 / 时段的安排，可以共享给别人
 *   待办箱 还没定日期的事
 *   每日流程：**今天按顺序推进的一串事**，参考时间可有可无，个人私有
 *
 * ## 模板与当天是两份文档
 *
 * `template` 是常用模板（每天共用一份），`YYYY-MM-DD` 是那天的清单。
 * 当天清单**首次打开那天时**从模板复制生成，之后各改各的：
 *   · 改模板只影响**之后**生成的日期（已生成的清单不许跟着变）
 *   · 改当天清单不动模板（今天的例外不该污染明年的每一天）
 *
 * 复制时保留模板项的 id：项的顺序由数组下标决定，id 只用来定位某一行。
 * 同一天里 id 唯一即可，跨文档重复没有意义。
 */

export interface FlowItem {
  id: string;
  title: string;
  /** 补充说明。空串 = 没有 */
  note: string;
  /**
   * 可选参考时间 "HH:mm"。
   * **不参与排序** —— 顺序才是这个功能的主语，时间只是给眼睛一个锚点。
   * null = 没填，照样能排在某两件之间。
   */
  at: string | null;
  /** 当天清单专用；模板里恒为 false */
  done: boolean;
  doneAt: number | null;
}

export interface FlowDoc {
  rev: number;
  items: FlowItem[];
}

/** 一天最多几项。与服务端 FLOW_MAX_ITEMS 同口径 */
export const FLOW_MAX_ITEMS = 200;

const TITLE_MAX = 120;
const NOTE_MAX = 500;

const isoDate = (v: unknown): string | null =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

/** 时间只认 "HH:mm"。自己手改的 localStorage 里什么都有，一律打回 null 而不是画个怪值 */
function cleanTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h >= 0 && h < 24 && mi >= 0 && mi < 60 ? v : null;
}

/**
 * 把服务端 / localStorage 里的任意形状收敛成合法项。
 *
 * 逐条过滤而不是整体丢弃：一份清单里有一条坏数据，不该让整天的流程消失。
 * 标题空的一律丢掉 —— 一行没有字的流程点不动也看不懂。
 */
export function normalizeItems(raw: unknown): FlowItem[] {
  if (!Array.isArray(raw)) return [];
  const out: FlowItem[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, TITLE_MAX) : '';
    if (!title) continue;
    const id = typeof o.id === 'string' && o.id ? o.id.slice(0, 64) : newId();
    // 同一个 id 出现两次会让「第几行」这件事失去意义，后一条直接跳过
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title,
      note: typeof o.note === 'string' ? o.note.slice(0, NOTE_MAX) : '',
      at: cleanTime(o.at),
      done: o.done === true,
      doneAt: typeof o.doneAt === 'number' && Number.isFinite(o.doneAt) ? o.doneAt : null,
    });
    if (out.length >= FLOW_MAX_ITEMS) break;
  }
  return out;
}

/** 文档形状归一：rev 认数字，items 走 normalizeItems */
export function normalizeDoc(raw: unknown): FlowDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.items)) return null;
  return {
    rev: typeof o.rev === 'number' && Number.isFinite(o.rev) ? o.rev : 0,
    items: normalizeItems(o.items),
  };
}

/** 生成一个稳定的本地 id。不用 crypto：旧 WebView 上不一定有，时间戳 + 随机足够 */
export function newId(): string {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 模板项 → 当天项：清掉完成状态，时间 / 说明照抄 */
export function fromTemplate(template: FlowItem[]): FlowItem[] {
  return template.map((t) => ({
    id: t.id || newId(),
    title: t.title,
    note: t.note,
    at: t.at,
    done: false,
    doneAt: null,
  }));
}

/** 新的一行。落在末尾，标题由用户输入 */
export function makeItem(title: string, at: string | null = null): FlowItem {
  return { id: newId(), title: title.trim().slice(0, TITLE_MAX), note: '', at, done: false, doneAt: null };
}

/** 移动一行。返回新数组；越界时原样返回（调用方据此跳过写入） */
export function moveItem(items: FlowItem[], id: string, to: number): FlowItem[] {
  const from = items.findIndex((x) => x.id === id);
  if (from < 0) return items;
  const dst = Math.max(0, Math.min(items.length - 1, to));
  if (dst === from) return items;
  const next = items.slice();
  const [row] = next.splice(from, 1);
  next.splice(dst, 0, row);
  return next;
}

/** 打勾 / 取消。完成时刻只在「刚勾上」时记，取消就清掉 */
export function toggleItem(items: FlowItem[], id: string, now = Date.now()): FlowItem[] {
  return items.map((x) => (x.id === id
    ? { ...x, done: !x.done, doneAt: x.done ? null : now }
    : x));
}

/** 改某一行的字段（标题 / 说明 / 参考时间） */
export function patchItem(items: FlowItem[], id: string, patch: Partial<Pick<FlowItem, 'title' | 'note' | 'at'>>): FlowItem[] {
  return items.map((x) => {
    if (x.id !== id) return x;
    const next = { ...x };
    if (patch.title !== undefined) {
      const t = patch.title.trim().slice(0, TITLE_MAX);
      if (!t) return x;          // 清空标题 = 不合法，保留原值而不是留一行空白
      next.title = t;
    }
    if (patch.note !== undefined) next.note = patch.note.slice(0, NOTE_MAX);
    if (patch.at !== undefined) next.at = cleanTime(patch.at);
    return next;
  });
}

export function removeItem(items: FlowItem[], id: string): FlowItem[] {
  return items.filter((x) => x.id !== id);
}

/** 进度：完成几项 / 共几项。用于页头那行小结 */
export function progressOf(items: FlowItem[]): { done: number; total: number } {
  let done = 0;
  for (const x of items) if (x.done) done += 1;
  return { done, total: items.length };
}

/** 当前该做的那一项：第一项没完成的。全做完 / 空清单都给 null */
export function currentItem(items: FlowItem[]): FlowItem | null {
  return items.find((x) => !x.done) ?? null;
}

export { isoDate };

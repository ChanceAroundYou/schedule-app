/**
 * flowCache.ts —— 每日流程的离线副本 + 待发送队列
 *
 * ## 为什么要本地这一层
 *
 * 每日流程是「打开就要能划掉一行」的东西。等网络回来才显示，等于在电梯里、
 * 地铁里用不了 —— 而本地副本 + 队列能保证：**点下去立刻算数，联网后补发**。
 *
 * ## 一致性口径
 *
 * 服务端是权威，但**本地未确认的写入优先**：
 *   · `pull()` 把服务端的结果合并进来，但某个 doc 还有待发项时，保留本地 items
 *     （只更新 rev）—— 否则「刚加的一行」会被服务端的旧快照当场擦掉；
 *   · `write()` 先改本地、入队、通知界面，再发请求（乐观更新）；
 *   · 成功后用服务端返回的 rev 对齐；失败就留在队列里，5 秒后重试。
 *
 * 队列是**按 doc 合并**的（同一天连改十下只发一份最新的），因为存的是整文档。
 * 这也是整文档方案的一个好处：不需要逐条 op 的幂等键。
 *
 * ## 账号隔离
 *
 * localStorage 的键带 userId。同一台设备换账号登录时，绝不能看到上一个人的
 * 流程表 —— 这是个人私有内容，串了就很难解释。
 */

import type { FlowDoc, FlowItem } from '../domain/flow.ts';
import { fromTemplate, normalizeDoc, normalizeItems } from '../domain/flow.ts';
import { fetchFlow, putFlow } from './api/flow.ts';

interface Pending {
  doc: string;
  items: FlowItem[];
  baseRev: number | null;
}

interface Cache {
  v: 1;
  template: FlowDoc | null;
  days: Record<string, FlowDoc>;
  pending: Pending[];
}

const KEY_PREFIX = 'schedule-flow-v1:';

/** 重试间隔。失败后隔一会儿再发，不做指数退避 —— 这是低频个人数据，简单可预期更重要 */
const RETRY_MS = 5000;

let uid: string | null = null;
let cache: Cache = empty();
let flushing = false;
let retryTimer: number | null = null;
const listeners = new Set<() => void>();

/**
 * 给 React 的那份只读视图。
 *
 * **必须是稳定引用**：`useSyncExternalStore` 每次渲染都拿它比对，若
 * `snapshot()` 每次都新建一个对象，React 会认定「外部状态一直在变」→
 * 无限重渲染（并打印 getSnapshot should be cached）。所以只在真正 emit 时重建。
 */
let view = { template: null as FlowDoc | null, days: {} as Record<string, FlowDoc>, pendingCount: 0 };

function empty(): Cache {
  return { v: 1, template: null, days: {}, pending: [] };
}

const keyOf = (): string => KEY_PREFIX + (uid || 'anon');

function read(): Cache {
  try {
    const raw = localStorage.getItem(keyOf());
    if (!raw) return empty();
    const o = JSON.parse(raw) as Partial<Cache>;
    const days: Record<string, FlowDoc> = {};
    if (o.days && typeof o.days === 'object') {
      for (const [k, v] of Object.entries(o.days)) {
        const d = normalizeDoc(v);
        if (d) days[k] = d;
      }
    }
    const pending: Pending[] = [];
    if (Array.isArray(o.pending)) {
      for (const p of o.pending) {
        if (!p || typeof p.doc !== 'string') continue;
        pending.push({
          doc: p.doc,
          items: normalizeItems(p.items),
          baseRev: typeof p.baseRev === 'number' ? p.baseRev : null,
        });
      }
    }
    return { v: 1, template: normalizeDoc(o.template), days, pending };
  } catch (_) {
    // 手改坏了 / 隐私模式禁用了 localStorage：当作空缓存继续跑，
    // 不能因为读不出来就白屏 —— 联网时还能从服务端重新拉回来
    return empty();
  }
}

function save(): void {
  try {
    localStorage.setItem(keyOf(), JSON.stringify(cache));
  } catch (_) { /* 配额满 / 隐私模式：内存里这份仍然可用，联网时照样能存到服务端 */ }
}

function emit(): void {
  // 只在 emit 时重建视图（理由见 view 的注释）
  view = { template: cache.template, days: cache.days, pendingCount: cache.pending.length };
  for (const fn of listeners) fn();
}

/** 切账号 / 首次进入时调一次。换人就把内存里那份换掉，别串到上一个人 */
export function attach(userId: string | null): void {
  const next = userId || null;
  if (next === uid) return;
  uid = next;
  cache = read();
  emit();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function snapshot(): { template: FlowDoc | null; days: Record<string, FlowDoc>; pendingCount: number } {
  return view;
}

export function getDoc(doc: string): FlowDoc | null {
  return doc === 'template' ? cache.template : (cache.days[doc] ?? null);
}

function pendingFor(doc: string): Pending | undefined {
  return cache.pending.find((p) => p.doc === doc);
}

/**
 * 写一份。**先本地、后网络**，调用方拿到的就是最终要显示的那份。
 *
 * 同一天已有待发项时直接替换它（保留最早的 baseRev）—— 队列里留一串
 * 中间态没有意义，服务端要的是「这一天现在长什么样」。
 */
export function write(doc: string, items: FlowItem[]): void {
  const clean = normalizeItems(items);
  const prev = getDoc(doc);
  const next: FlowDoc = { rev: prev?.rev ?? 0, items: clean };
  if (doc === 'template') cache.template = next;
  else cache.days[doc] = next;

  const old = pendingFor(doc);
  const entry: Pending = { doc, items: clean, baseRev: old ? old.baseRev : (prev?.rev ?? null) };
  cache.pending = old ? cache.pending.map((p) => (p.doc === doc ? entry : p)) : [...cache.pending, entry];

  save();
  emit();
  void flush();
}

/**
 * 打开某一天：没有当天文档、但模板有内容时，按模板生成一份。
 *
 * **生成时机就是「第一次打开这一天」**（用户 2026-11-07 确认的口径）：
 * 不跑定时任务、不预生成未来 —— 离线也能生成，而且「改模板不影响已经
 * 打开过的日期」自然成立。
 *
 * @returns 是否真的生成了（调用方据此决定要不要提示）
 */
export function ensureDay(date: string): boolean {
  if (cache.days[date]) return false;
  const tpl = cache.template;
  if (!tpl || !tpl.items.length) return false;
  write(date, fromTemplate(tpl.items));
  return true;
}

/** 把服务端的结果并进本地。有未确认写入的 doc 保留本地 items。 */
function merge(remote: { template: FlowDoc | null; days: Record<string, FlowDoc> }): void {
  if (remote.template) {
    const p = pendingFor('template');
    cache.template = p
      ? { rev: remote.template.rev, items: p.items }
      : { rev: remote.template.rev, items: remote.template.items };
  }
  for (const [day, doc] of Object.entries(remote.days)) {
    const p = pendingFor(day);
    cache.days[day] = p ? { rev: doc.rev, items: p.items } : { rev: doc.rev, items: doc.items };
  }
  save();
  emit();
}

/** 拉一次服务端。失败不抛给界面 —— 本地那份已经能用了 */
export async function pull(from: string, to: string): Promise<boolean> {
  if (!uid) return false;
  try {
    const r = await fetchFlow(from, to);
    merge({ template: r.template ? { rev: r.template.rev, items: normalizeItems(r.template.items) } : null,
      days: Object.fromEntries(Object.entries(r.days).map(([k, v]) => [k, { rev: v.rev, items: normalizeItems(v.items) }])) });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 依次把队列发完。
 *
 * 互斥：并发调用只跑一轮（和 CounterStore.flush 同一条理由 —— 两轮同时发
 * 同一天的两份，服务端会按到达顺序各存一次，rev 凭空多跳）。
 */
export async function flush(): Promise<void> {
  if (!uid || flushing) return;
  flushing = true;
  try {
    while (cache.pending.length) {
      const head = cache.pending[0];
      let out;
      try {
        out = await putFlow(head.doc, head.items, head.baseRev);
      } catch (_) {
        // 失败：留在队首，稍后重试。**不丢**，也不往前跳过 ——
        // 跳过会让后一份（更晚的状态）先落地，顺序就反了
        scheduleRetry();
        return;
      }
      // 期间用户又改了同一天：队首已被替换成新条目，这一份作废，别把它删掉
      if (cache.pending[0] !== head) continue;
      cache.pending.shift();

      const doc = head.doc === 'template' ? cache.template : cache.days[head.doc];
      // 只有当本地这份仍是「刚发出去的那份」时才用服务端 rev 对齐；
      // 否则说明又有新写入进来，那份自己会带新 rev
      if (doc && doc.items === head.items) {
        const aligned: FlowDoc = { rev: out.rev, items: out.items.length ? out.items : doc.items };
        if (head.doc === 'template') cache.template = aligned;
        else cache.days[head.doc] = aligned;
      }
      save();
      emit();
    }
  } finally {
    flushing = false;
  }
}

function scheduleRetry(): void {
  if (retryTimer != null) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void flush();
  }, RETRY_MS);
}

/** 供测试 / 排查用：清掉本地副本（不动服务端） */
export function resetLocal(): void {
  cache = empty();
  save();
  emit();
}

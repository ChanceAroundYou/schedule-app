/**
 * flow.ts —— 每日流程的读写（REST）
 *
 * 个人私有文档，**不走 op/sync 通道**：那份通道是日程集里的逐字段 LWW，
 * 而这里是「我一个人的整份顺序表」，用整文档保存 + rev 更贴近它的语义
 * （理由与取舍见 server/lib/db/flow.js 开头）。
 *
 * 离线副本与待发送队列不在这里 —— 见 data/flowCache.ts。这一层只负责
 * 「发一个请求，成功就返回服务端的那份」。
 */

import { req } from './request.ts';
import type { FlowItem } from '../../domain/flow.ts';

export interface FlowDocWire {
  rev: number;
  items: FlowItem[];
  updatedAt?: number;
}

export interface FlowPull {
  today: string;
  template: FlowDocWire | null;
  days: Record<string, FlowDocWire>;
}

/** 拉一段日期区间 + 模板。区间只按「今天前后几天」取，不整库拖 */
export async function fetchFlow(from: string, to: string): Promise<FlowPull> {
  const q = `flow?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const r = await req<FlowPull>('GET', q);
  return {
    today: typeof r?.today === 'string' ? r.today : from,
    template: r?.template ?? null,
    days: r?.days && typeof r.days === 'object' ? r.days : {},
  };
}

/** 存一份文档。`baseRev` 只用于让服务端判断「客户端手上这份是不是旧的」 */
export async function putFlow(doc: string, items: FlowItem[], baseRev: number | null): Promise<FlowDocWire> {
  const r = await req<FlowDocWire & { stale?: boolean }>('PUT', 'flow', { doc, baseRev, items });
  return { rev: typeof r?.rev === 'number' ? r.rev : 0, items: Array.isArray(r?.items) ? r.items : items };
}

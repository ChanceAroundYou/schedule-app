/**
 * sync-state.ts —— 游标与发件箱确认（同步引擎的本地一半）
 */
import { state, emit } from './core.ts';
import { persist } from './persist.ts';

/** 已经拉到哪了。changes.seq 是全局单调的，客户端只存这一个游标 */
export function setCursor(c: number): void {
  if (state.cursor === c) return;
  state.cursor = c;
  persist();
  emit();
}

/** 服务器确认收到了这几条 op —— 才把它们从发件箱里去掉 */
export function ackOps(opIds: string[]): void {
  if (!opIds.length) return;
  const drop = new Set(opIds);
  const before = state.outbox.length;
  state.outbox = state.outbox.filter((o) => !drop.has(o.opId));
  if (state.outbox.length !== before) { persist(); emit(); }
}
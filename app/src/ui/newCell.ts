/**
 * newCell.ts —— 就地新建草稿的写库入口（收进 ui/，views 不碰 data/store）。
 */
import * as store from '../data/store.ts';
import type { DraftSeed } from '../domain/types.ts';

export function commitDraftTask(title: string, seed: DraftSeed): string {
  const id = store.addTask({ title, date: seed.date, time: seed.time });
  /* 泳道列里点的草稿：落成即归项目、按列定 doing。一次 patch 带过去，
     不拆成 addTask + setTaskProject 两笔提交。 */
  if (seed.projectId) {
    store.patchTask(id, { projectId: seed.projectId, doing: seed.doing ?? false });
  }
  return id;
}

export function setDraftNull(): void {
  store.setUi({ draft: null });
}

/**
 * 结算上一条草稿，并把下一条（可以是 null）**一次性**换上。
 *
 * 为什么是一次：`setUi` 里是浅合并 + 同步 emit。分成「先清空、再设新的」两步，
 * React 会在两步之间把输入框卸掉 —— 键盘跟着收起、页面高度变回来，
 * 于是紧接着算落的点就落到了另一个坐标系里（实测 21:00 会落成 7:00）。
 * 合成一次状态更新，中间就没有这个空档。
 *
 * 有字就落成任务（用户 2026-10-17 确认：点别处时已经打的字不用再按回车），
 * 没字就丢掉。
 */
export function settleDraftAndSet(next: DraftSeed | null): void {
  const cur = store.get().ui.draft;
  if (!cur && !next) return;              // 本来就没草稿、也不开新的 → 别白 emit

  if (cur) {
    const el = document.querySelector<HTMLTextAreaElement>('.new-cell');
    const v = (el?.value ?? '').trim();
    if (v) commitDraftTask(v, cur);
  }
  /* 传新对象（不是同一个引用）：NewCell 靠 seed 的引用变化来清空上一处残留的字 */
  store.setUi({ draft: next ? { ...next } : null });
}

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

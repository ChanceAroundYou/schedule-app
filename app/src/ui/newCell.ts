/**
 * newCell.ts —— 就地新建草稿的写库入口（收进 ui/，views 不碰 data/store）。
 */
import * as store from '../data/store.ts';

export function commitDraftTask(
  title: string,
  seed: { date: string; time: string | null },
): string {
  return store.addTask({ title, date: seed.date, time: seed.time });
}

export function setDraftNull(): void {
  store.setUi({ draft: null });
}

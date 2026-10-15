/**
 * app/useNav.ts —— 换页与挪游标
 *
 * 两个动作都是「只改 store 的 ui，不改数据」，所以放在一个文件里 —— 它们
 * 共享那条「不写 nav」的约定，写在一起才不会漏。
 *
 * **`shift` 千万别顺手加 `nav: 'calendar'`**：方向键没有「换页」的意思。
 * 加上之后，在待办箱 / 已完成 / 打卡这几页按方向键会被强行拽到日历页，
 * 光标还停在原来那一页 —— 用户按了键、页面变了、然后内容没变。
 */
import { useCallback } from 'react';
import * as D from '../domain/date.ts';
import * as store from '../data/store.ts';

export function useNav() {
  const nav = useCallback((k: string) => {
    const cur = store.get().ui;
    const patch: Partial<typeof cur> = { nav: k };
    /* 换页一定退出多选（2026-10-14）。多选只在「逾期 / 待办箱 / 已完成」
       这三页有意义，而 dispatch 的判据是「ui.sel !== null」—— 不清掉的话，
       带着选中集跳到「今天」后，那里每一行都会被当成可选中，点了没反应
       （那几页根本没渲染选择圈）。 */
    if (cur.sel !== null) patch.sel = null;
    // 从别处切回「今天」时把游标拉回今天，否则还停在几天前翻过的位置
    if (k === 'today') patch.cursor = D.today();
    store.setUi(patch);
    if (k === 'calendar' && cur.cursor !== D.today() && cur.view !== 'month') {
      store.setUi({ cursor: D.today() });
    }
  }, []);

  const shift = useCallback((n: number) => {
    const ui = store.get().ui;
    const step = ui.view === 'month' ? 0 : n;
    const cursor = step
      ? D.addDays(ui.cursor, step * (ui.view === 'week' ? 7 : 1))
      : D.addMonths(ui.cursor, n);
    store.setUi({ cursor });
  }, []);

  return { nav, shift };
}
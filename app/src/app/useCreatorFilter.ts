/**
 * useCreatorFilter.ts —— 日程页创建者筛选的两件杂事
 *
 * 1. **失效收回**：人离开日程集 / 换了账号 / 本地偏好带着别人的 id 时，
 *    把 `ui.creator` 收回 `'all'`。
 *    不做这件事的表现是：切换日程集之后整张日历空着，而筛选器上写着一个
 *    用户根本想不起来什么时候选过的名字 —— 看起来像「任务全没了」。
 * 2. **换集即重置**：用户主动换了日程集，就把筛选收回「全部成员」。
 *    换集的意思是「我要看另一个集」，不是「继续按上一个人筛」；留着上一个
 *    集里的人才有的筛选，切过去多半是空的。
 *
 * 为什么用 `useEffect` 而不是在 `store.setUi` 里做：`store` 是数据层，看不到
 * 「当前这个人还认不认得」——那要读 `tasks` / `users`，属于界面关注点。
 */

import { useEffect, useRef } from 'react';
import type { LocalState } from '../domain/types.ts';
import * as store from '../data/store.ts';
import { creatorFilterValid } from '../ui/shell/creatorOptions.ts';

export function useCreatorFilter(state: LocalState): void {
  const lastCal = useRef<string | null>(state.ui.cal);

  // 换集 → 收回全部成员。只在**真的变了**时动手，首帧不算。
  useEffect(() => {
    const cur = state.ui.cal;
    if (lastCal.current !== cur) {
      lastCal.current = cur;
      if (state.ui.creator !== 'all') store.setUi({ creator: 'all' });
    }
  }, [state.ui.cal, state.ui.creator]);

  // 筛选项已经指不到任何人了 → 收回
  useEffect(() => {
    if (state.ui.creator === 'all') return;
    if (creatorFilterValid(state)) return;
    store.setUi({ creator: 'all' });
  }, [state]);
}

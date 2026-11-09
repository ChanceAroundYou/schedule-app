/**
 * CalIdentity.tsx —— 日程集「身份行」的**唯一渲染**
 *
 * 以前桌面下拉 / 移动弹窗（`CalRow`）与设置页标题行（`CalItem`）各画一遍：
 * 圆点同样式、名字同字号，但一行带「可编辑 / 只读」角标、另一行带星标和
 * 编辑删除，摆法越改越漂，而且**两边都没显示是谁建的**。用户 2026-11-09
 * 点名「复用还是不彻底」。
 *
 * 现在把「颜色圆点 + 集名 + 创建者昵称」这一截抽成同一个组件，两处都嵌它；
 * 各自剩下的操作控件（勾选圈 / 星标 / 铅笔 / 删除 / 折叠箭头）仍然归各自，
 * 因为那是两种不同场景下真正不同的东西。
 *
 * 颜色读 `displayColor()`：先看**我自己的**本地覆盖，再退到集默认值。
 * 昵称读 `ownerDisplayName()`：昵称优先，查不到就不画，绝不写「我建的」。
 */

import type { Cal, CalColorKey, LocalState } from '../../domain/types.ts';
import { colorOf, ownerDisplayName } from '../../domain/people.ts';
import { getCachedUser } from '../../data/api.ts';
import { cx } from '../cx.ts';

/** 一个集**在我这台设备上**该是什么颜色。任务卡 / 圆点 / 月视图全走这一处。 */
export function displayColor(state: LocalState, calId: string): CalColorKey {
  return colorOf(state.cals, calId, state.ui.calColors);
}

/** 创建者显示名。自己建的也是显示自己的昵称，不是「我建的」/「创建者」。 */
export function ownerLabel(state: LocalState, cal: Cal): string {
  const fallback = cal.ownerId === state.meId ? getCachedUser() : null;
  return ownerDisplayName(state.users, cal.ownerId, fallback);
}

export function CalIdentity({ state, cal, active = false }: {
  state: LocalState;
  cal: Cal;
  /** 是不是当前正在看的集（名字加重 + 主色） */
  active?: boolean;
}) {
  const owner = ownerLabel(state, cal);
  return (
    <>
      <span className="calrow-dot" data-cal-color={displayColor(state, cal.id)} aria-hidden="true" />
      <span className={cx('min-w-0 flex-1 truncate', active ? 'font-medium ci-name-active' : 'ci-name-idle')}>
        {cal.name}
      </span>
      {/* 昵称走 `data-owner` + CSS ::after，不写进 DOM 文本。
          十几处探针（browser-smoke / smoke 03·07·08·13·22 …）都拿这一行的
          `textContent.trim()` 当集名精确比对，把昵称塞进文本会集体误判。
          用生成内容既能看见昵称，又保住「这一行的文本 = 集名」这条老契约。
          title / aria-label 让悬停与读屏照样读得到名字。 */}
      {owner && (
        <span
          className="ci-owner max-w-[6rem] shrink-0 truncate text-[11px]"
          data-owner={owner}
          title={owner}
          aria-label={owner}
        />
      )}
    </>
  );
}

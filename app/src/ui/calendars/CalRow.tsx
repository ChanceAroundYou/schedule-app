/**
 * CalRow.tsx —— 日程集多选行（桌面下拉 / 移动弹窗共用）
 */

import type { Cal } from '../../domain/types.ts';
import { ROLE_LABEL } from '../../domain/types.ts';
import * as store from '../../data/store.ts';

/**
 * 一行一个集。桌面下拉多选与移动端弹窗面板**共用这一份** —— 两处各画一遍的
 * 下场是改了选中态忘了改另一边。
 *
 * 勾选只影响**显示**（见 ui/hooks.ts 的 useScopedState）；新东西落在 `ui.cal`，
 * 也就是最后一次点开的那个集 —— toggleCal 里顺手设好。
 *
 * 默认日程集（「我的日程」）也列出来 —— 它是真实存在的集，勾不勾是用户的
 * 自由。原先按「注册时自动建的」把它藏掉，那是在单选模型下的判断（它是
 * 兜底的那个，不用切过去）；多选之后这条理由不成立了。
 */
export function CalRow({ c, on }: { c: Cal; on: boolean }) {
  return (
    <button
      type="button"
      data-cal-row={c.id}
      onClick={() => store.toggleCal(c.id)}
      aria-pressed={on}
      className={
        'flex items-center gap-2 px-3 py-1.5 text-left text-[13px] transition '
        + (on
          ? 'calrow-row calrow-row-on font-medium'
          : 'calrow-row calrow-row-off')
      }
    >
      {/* 勾选圈走 CheckBtn 那套（命中区 ≥24，视觉不变），见 views/parts.tsx。
          这里用 span 而不是 input[type=checkbox]：整个按钮就是控件，
          再塞一个真 checkbox 会让 Tab 多停一格、读屏念两遍。 */}
      <span className={'check-btn' + (on ? ' on' : '')} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{c.name}</span>
      {c.role !== 'owner' && (
        <span className="shrink-0 px-1.5 py-px text-[10.5px] calrow-chip">
          {ROLE_LABEL[c.role]}
        </span>
      )}
    </button>
  );
}

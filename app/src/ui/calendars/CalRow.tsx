/**
 * CalRow.tsx —— 日程集多选行（桌面下拉 / 移动弹窗共用）
 *
 * 2026-11-09：这一行不再自己画「圆点 + 名字 + 角色角标」，改嵌 `CalIdentity`
 * —— 和设置页标题行**同一份**颜色圆点 / 名字 / 创建者昵称。两处剩下的差别
 * 只有各自真正该有的控件：这里是勾选圈，设置页是星标 / 改名 / 删除 / 折叠。
 * 角色不再写「可编辑 / 只读」这种词，直接显示建这个集的人的昵称。
 */

import type { Cal, LocalState } from '../../domain/types.ts';
import * as store from '../../data/store.ts';
import { cx } from '../cx.ts';
import { CalIdentity } from './CalIdentity.tsx';

/**
 * 一行一个集。桌面下拉多选与移动端弹窗面板**共用这一份** —— 两处各画一遍的
 * 下场是改了选中态忘了改另一边。
 *
 * 勾选只影响**显示**（见 ui/hooks.ts 的 useScopedState）；新东西落在 `ui.cal`，
 * 也就是最后一次点开的那个集 —— toggleCal 里顺手设好。
 *
 * 默认日程集（「我的日程」）也列出来 —— 它是真实存在的集，勾不勾是用户的
 * 自由。多选模型下没有理由把它藏掉。
 */
export function CalRow({ state, c, on }: { state: LocalState; c: Cal; on: boolean }) {
  return (
    <button
      type="button"
      data-cal-row={c.id}
      onClick={() => store.toggleCal(c.id)}
      aria-pressed={on}
      className={cx(
        /* 与设置页 `.ci-row` 同一套：40px 高、圆角、底色、左右内距。
           以前这边是 py-1.5 + px-3，看着比设置页那行矮一圈、边也不齐。 */
        'ci-row flex h-[40px] items-center gap-2 pl-3 pr-2 text-left text-[13px] transition',
        on ? 'calrow-row-on font-medium' : 'calrow-row-off',
      )}
    >
      {/* 勾选圈走 CheckBtn 那套（命中区 ≥24，视觉不变），见 views/parts.tsx。
          这里用 span 而不是 input[type=checkbox]：整个按钮就是控件，
          再塞一个真 checkbox 会让 Tab 多停一格、读屏念两遍。 */}
      <span className={'check-btn' + (on ? ' on' : '')} aria-hidden="true" />
      <CalIdentity state={state} cal={c} active={on} />
    </button>
  );
}
